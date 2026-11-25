package org.glukopapa.v3.m00

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.glukopapa.v3.m00.GfV3Q10Evidence as E

/** Offline read-only diagnostic execution. No writer, JavaScript bridge, network or storage. */
internal class GfV3Q10OfflineDiagnostics(context:Context) {
    private val ctx=context.applicationContext
    private val main=Handler(Looper.getMainLooper())
    companion object {
        const val VERSION="v0.3.7-qa"
        private val files=linkedMapOf(
            "sha256_ascii.js" to "51331e38f91047cf903b9ec0cba7010cab8ee4d9a937d3538c960e3c5c45f6c3",
            "GFSafety.js" to "08c5d18528a3a49fdc601cb1835fafa22849b33de23df5c8703850390f58efef",
            "GFSafetyV3DiagnosticAdapter.js" to "70b1246d0c7900e9072a3b49a6422422ab469a7d2d2ce13ecb9b46eb68658d28",
            "GFCgmEvidencePolicyV3.js" to "3ee2d9f2086636bab5243d8cad5b814a0e1a4ee44889f221e4fac90b9061efce")
        private val flags=listOf("forecastInputEligible","clinicalUseAllowed","insulinDoseDecisionAllowed","automaticInjectionAllowed")
        private val codePattern=Regex("[A-Z0-9_]{1,128}")
        fun failure(code:String):JSONObject=JSONObject().put("status","UNAVAILABLE").put("code",code)
            .put("runtimeVersion",VERSION).put("coreExecuted",false).put("nativeContractVersion",E.VERSION)
            .put("registryActivationContractVersion","v0.3.1").put("approvedDesignVersion","v0.2")
        private fun safeCode(s:String):String {require(codePattern.matches(s));return s}
        private fun codes(a:JSONArray):JSONArray {require(a.length()<=256);return JSONArray((0 until a.length()).map{safeCode(a.getString(it))})}
        private fun stampMatches(o:JSONObject,s:E.Stamp):Boolean =
            o.optString("profileId")==s.profile&&o.optLong("revision",-1)==s.revision&&
            o.optLong("inputRevision",-1)==s.inputRevision&&o.optInt("schemaVersion",-1)==s.schema
        private fun quote(s:String)=JSONObject.quote(s).replace("\u2028","\\u2028").replace("\u2029","\\u2029")
        internal fun decode(raw:String,s:E.Stamp):JSONObject {
            val out=JSONObject(JSONArray("[$raw]").getString(0))
            val d=out.getJSONObject("report");val p=out.getJSONObject("policy")
            require(out.getString("coreVersion")=="0.1.0"&&d.getString("version")=="0.3.5-qa"&&p.getString("version")=="0.3.6-qa")
            require(d.getString("status")=="BLOCKED")
            for(x in listOf(d,p)){for(k in flags)require(x.get(k)==false);require(x.has("qualityScore")&&x.isNull("qualityScore"));require(x.getString("cgmCoverage")=="NOT_PROVEN")}
            require(d.getString("mealCoverage")=="NOT_PROVEN"&&d.getString("insulinCoverage")=="NOT_PROVEN")
            require(p.has("currentMmol")&&p.isNull("currentMmol"))
            val ds=d.optJSONObject("stamp");val ps=p.optJSONObject("stamp")
            if(ds!=null)require(stampMatches(ds,s));if(ps!=null)require(stampMatches(ps,s))
            val donorStatus=d.optString("donorStatus","")
            val executed=ds!=null&&donorStatus in listOf("BLOCKED","CAUTION","DATA_OK")
            val policyStatus=p.getString("status");require(policyStatus in listOf("BLOCKED","ARCHIVED_ONLY","STALE","OBSERVED_ONLY"))
            val donorCodes=JSONArray()
            if(executed){val a=d.getJSONArray("donorIssues");require(a.length()<=256);for(i in 0 until a.length())donorCodes.put(safeCode(a.getJSONObject(i).getString("code")))}
            return JSONObject().put("status",if(executed)"CHECKED" else "INPUT_REJECTED")
                .put("runtimeVersion",VERSION).put("coreExecuted",executed).put("coreVersion","0.1.0")
                .put("projectionVersion","0.3.5-qa").put("policyVersion","0.3.6-qa")
                .put("nativeContractVersion",E.VERSION).put("registryActivationContractVersion","v0.3.1").put("approvedDesignVersion","v0.2")
                .put("donorStatus",if(executed)donorStatus else JSONObject.NULL).put("donorCodes",donorCodes)
                .put("projectionCodes",codes(d.getJSONArray("issues"))).put("policyStatus",policyStatus).put("policyCode",safeCode(p.getString("code")))
        }
    }
    fun inspect(snapshot:JSONObject,stamp:E.Stamp,checked:Instant):JSONObject {
        if(Looper.myLooper()==Looper.getMainLooper())return failure("MAIN_THREAD_DENIED")
        val script=try {
            val raw=snapshot.toString();require(raw.length<=8_000_000)
            val scripts=files.map{(name,expected)->
                val bytes=ctx.assets.open("q10-donor/$name").use{it.readBytes()}
                val hash=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)}
                require(hash==expected);bytes.toString(Charsets.UTF_8)
            }.joinToString("\n")
            val st=JSONObject().put("profileId",stamp.profile).put("revision",stamp.revision).put("inputRevision",stamp.inputRevision).put("schemaVersion",stamp.schema)
            scripts+"\n;JSON.stringify((()=>{const raw="+quote(raw)+",stamp=JSON.parse("+quote(st.toString())+"),now="+checked.toEpochMilli()+";return {report:GFSafetyV3DiagnosticAdapter.evaluate(raw,stamp,now,GFSafety),policy:GFCgmEvidencePolicyV3.inspect(raw,stamp,now),coreVersion:GFSafety.VERSION};})());"
        }catch(_:Exception){return failure("ASSET_OR_INPUT_INVALID")}
        val cancelled=AtomicBoolean(false);val latch=CountDownLatch(1)
        val result=AtomicReference<String?>();val holder=AtomicReference<WebView?>()
        fun cleanup(){holder.getAndSet(null)?.let{try{it.stopLoading();it.destroy()}catch(_:Exception){}}}
        fun complete(value:String?){if(!cancelled.get())result.set(value);cleanup();latch.countDown()}
        if(!main.post {
            if(cancelled.get()){latch.countDown();return@post}
            try {
                val w=WebView(ctx);holder.set(w)
                if(cancelled.get()){complete(null);return@post}
                w.settings.javaScriptEnabled=true;w.settings.allowFileAccess=false;w.settings.allowContentAccess=false
                w.settings.blockNetworkLoads=true;w.settings.domStorageEnabled=false;w.settings.cacheMode=WebSettings.LOAD_NO_CACHE
                w.settings.javaScriptCanOpenWindowsAutomatically=false;w.settings.setSupportMultipleWindows(false)
                w.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
                var started=false
                w.webViewClient=object:WebViewClient(){
                    override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest)=true
                    override fun shouldInterceptRequest(view:WebView,request:WebResourceRequest):WebResourceResponse=
                        WebResourceResponse("text/plain","UTF-8",ByteArrayInputStream(byteArrayOf()))
                    override fun onPageFinished(view:WebView,url:String){
                        if(started||cancelled.get())return;started=true
                        try{view.evaluateJavascript(script){value->complete(value)}}catch(_:Exception){complete(null)}
                    }
                    override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean{complete(null);return true}
                }
                w.loadDataWithBaseURL(null,"<html><body></body></html>","text/html","UTF-8",null)
            }catch(_:Exception){complete(null)}
        })return failure("DISPATCH_FAILED")
        val finished=try{latch.await(12,TimeUnit.SECONDS)}catch(_:InterruptedException){Thread.currentThread().interrupt();false}
        if(!finished){cancelled.set(true);main.post{cleanup()};return failure("EXECUTION_TIMEOUT")}
        return try{decode(result.get()?:error("NO_RESULT"),stamp)}catch(_:Exception){failure("RESULT_INVALID")}
    }
}
