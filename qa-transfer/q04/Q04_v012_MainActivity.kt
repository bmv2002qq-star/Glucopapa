package org.glukopapa.v3.m00

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import android.view.ViewGroup
import java.io.ByteArrayInputStream

/** Offline V3 shell. Experimental write roles granted; native module adapters must be installed to use them. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var helper: GfDbHelper
    private lateinit var nativeModuleGateway: GfV3NativeModuleGateway
    private lateinit var editQueue: GfV3EditIntentQueue
    private lateinit var settingsQueue: GfV3SettingsOwnerIntentQueue
    private lateinit var backupOwnerUi:GfV3BackupOwnerUi
    private lateinit var nutritionDrafts:GfV3Q04NutritionDrafts
    private val origin = "https://appassets.androidplatform.net"
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        helper=GfDbHelper(applicationContext)
        val catalog=assets.open("db/module_catalog_v1.json").bufferedReader().use {it.readText()}
        val grants=assets.open("db/writer_grants_v0.12.json").bufferedReader().use { it.readText() }
        val v3=GfV3Storage(helper,catalog,grants)
        nativeModuleGateway=GfV3NativeModuleGateway(v3,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        // Independent Q02 native owner gateway; no direct JavaScript SQL or backup bytes.
        val q02Auto=GfV3AutoLocalBackup(applicationContext,helper)
        backupOwnerUi=GfV3BackupOwnerUi(this,GfV3EncryptedSnapshot(applicationContext,helper),q02Auto,v3) {
            web.loadUrl("$origin/") // restore success refreshes all M01/M02/Q01 views
        }
        nutritionDrafts=GfV3Q04NutritionDrafts(helper)
        GfV3AutoLocalBackup.schedule(applicationContext) // Android background 24h local backups
        // No module is bound automatically. Owner integration gate remains independent.
        editQueue=GfV3EditIntentQueue(GfV3OwnerResolver(helper)::resolve){description,finish->
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("Подтвердить исправление записи")
                    .setMessage(description)
                    .setPositiveButton("Подтвердить"){_,_->finish(true)}
                    .setNegativeButton("Отмена"){_,_->finish(false)}
                    .setOnCancelListener{finish(false)}.show()
            }
        }
        // Integration wiring is compiled but GFStorage controls enablement:
        // QA candidate registry remains NOT_ACCEPTED; owner approval is a separate gate.
        val settingsAdapter=GfV3SettingsTrustedAdapter(nativeModuleGateway.bindInstalledAdapter("GFSettings"))
        settingsQueue=GfV3SettingsOwnerIntentQueue(settingsAdapter){description,finish->
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("Подтвердить изменение настроек")
                    .setMessage(description)
                    .setPositiveButton("Подтвердить"){_,_->finish(true)}
                    .setNegativeButton("Отмена"){_,_->finish(false)}
                    .setOnCancelListener{finish(false)}.show()
            }
        }
        web=WebView(this).apply {
            layoutParams=ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled=true
            settings.domStorageEnabled=false // No second WebView storage for profile or medical data.
            settings.allowFileAccess=false
            settings.allowContentAccess=false
            settings.allowFileAccessFromFileURLs=false
            settings.allowUniversalAccessFromFileURLs=false
            settings.blockNetworkLoads=true
            settings.javaScriptCanOpenWindowsAutomatically=false
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient=object:WebViewClient(){
                override fun shouldOverrideUrlLoading(view:WebView?, request:WebResourceRequest?):Boolean =
                    request?.url?.let{ it.scheme!="https" || it.host!="appassets.androidplatform.net" || it.path!="/" && it.path!="/index.html" && it.path!="/q01/settings.html" && it.path!="/q02/backup.html" && it.path!="/q03/normalized-facts.html" && it.path!="/q04/nutrition.html" }?:true
                override fun shouldInterceptRequest(view:WebView?,request:WebResourceRequest?):WebResourceResponse? {
                    val u=request?.url ?: return blocked()
                    // loadDataWithBaseURL sets the offline origin but DOES NOT map
                    // subresource URLs to APK assets. Serve each allowlisted JS explicitly.
                    // Keep blockNetworkLoads=true and return no network fallbacks.
                    val route=GfV3LocalAssetRoutes.resolve(u.scheme,u.host,u.path,u.query,u.fragment)
                    if (route == null) return blocked()
                    return try {
                        WebResourceResponse(route.mime,"UTF-8",assets.open(route.assetPath))
                    } catch (_: java.io.IOException) { blocked() }
                }
                private fun blocked():WebResourceResponse = WebResourceResponse("text/plain","UTF-8",ByteArrayInputStream(ByteArray(0)))
            }
            // No QA/testing bridge is exposed to production WebView.
            addJavascriptInterface(GfV3Bridge(v3,editQueue,settingsQueue),"GPV3V3Bridge")
            addJavascriptInterface(GfV3Q02Bridge(backupOwnerUi),"GPV3Q02Native")
            addJavascriptInterface(GfV3Q04Bridge(nutritionDrafts),"GPV3Q04Drafts")
        }
        setContentView(web)
        val html=assets.open("www/index.html").bufferedReader().use{it.readText()}
        web.loadDataWithBaseURL("$origin/",html,"text/html","UTF-8",null)
    }
    @Deprecated("Back routed to WebView hash history on M00")
    override fun onBackPressed() { if(web.canGoBack())web.goBack() else super.onBackPressed() }
    override fun onDestroy() {
        editQueue.cancelPendingOnDestroy()
        settingsQueue.cancelPendingOnDestroy()
        backupOwnerUi.shutdown()
        web.removeJavascriptInterface("GPV3V3Bridge")
        web.removeJavascriptInterface("GPV3Q02Native")
        web.removeJavascriptInterface("GPV3Q04Drafts")
        web.destroy()
        helper.close()
        super.onDestroy()
    }
}