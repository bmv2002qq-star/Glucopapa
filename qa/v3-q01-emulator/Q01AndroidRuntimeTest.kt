package org.glukopapa.v3.m00

import android.content.ContentValues
import android.content.Context
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.action.ViewActions.click
import org.junit.runner.RunWith
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** QA-only Android emulator instrumentation, never shipped in the application APK.
 * The registry is modified ONLY inside a disposable emulator SQLite fixture.
 * A successful synthetic activation does not signify owner acceptance of Q01.
 */
@RunWith(AndroidJUnit4::class)
class Q01AndroidRuntimeTest {
    private fun app(): Context = ApplicationProvider.getApplicationContext()
    private fun jsonAssets(ctx: Context, name:String) = ctx.assets.open(name).bufferedReader().use { it.readText() }
    private fun storage(ctx:Context, db:GfDbHelper) = GfV3Storage(db,
        jsonAssets(ctx,"db/module_catalog_v1.json"),jsonAssets(ctx,"db/writer_grants_v0.11.json"))
    private fun reset(ctx:Context) { assertTrue("Disposable QA database must be clear", ctx.deleteDatabase("glukopapa_v3.db") || !ctx.getDatabasePath("glukopapa_v3.db").exists()) }
    private fun testAcceptedFixture(db:GfDbHelper) {
        val fields=ContentValues().apply {
            put("status","OWNER_INTEGRATION_ACCEPTED")
            put("feature_enabled",1)
            put("read_roles_json","[\"settings\"]")
            put("write_roles_json","[\"settingsWriter\",\"coefficientWriter\"]")
        }
        assertEquals("Expected exactly one GFSettings registry row",1,
            db.writableDatabase.update("v3_module_registry",fields,"module_id=?",arrayOf("GFSettings")))
    }
    private fun ownerSetting(snapshot:JSONObject,changeId:String,idempotency:String,key:String,value:JSONObject):JSONObject =
        JSONObject().put("type","GFSETTINGS_V3_OWNER_INTENT")
            .put("command","setting").put("role","settingsWriter")
            .put("ownerConfirmed",true).put("profileId",snapshot.getString("profileId"))
            .put("expectedRevision",snapshot.getLong("revision"))
            .put("idempotencyKey",idempotency)
            .put("payload",JSONObject().put("settingChangeId",changeId).put("settingKey",key)
                .put("value",value).put("effectiveAtUtc",Instant.now().toString()))

    @Test fun nativeGuardedSettingsPersistAndReadAfterReopen() {
        val ctx=app()
        reset(ctx)
        var db=GfDbHelper(ctx)
        var store=storage(ctx,db)
        assertEquals(3,store.schemaVersion())
        assertEquals(7,db.readableDatabase.version)
        val initial=store.revision()
        store.initializeProfile("profile-emulator-qa","Europe/London",initial)
        val gateway=GfV3NativeModuleGateway(store,GfV3NativeWriter(db),GfV3CorrectionWriter(db),db)
        val adapter=GfV3SettingsTrustedAdapter(gateway.bindInstalledAdapter("GFSettings"))
        try { adapter.readSettingsSnapshot();fail("Unaccepted GFSettings must be denied") }
        catch (e:SecurityException) { assertTrue(e.message.orEmpty().contains("NATIVE_MODULE_NOT_ACCEPTED")) }
        testAcceptedFixture(db) // TEST FIXTURE ONLY: not delivered to users, not modifying approved sources.
        val snap=adapter.readSettingsSnapshot()
        val setting=ownerSetting(snap,"q01-qa-target-0001","q01-qa-idempotent-0001", "target",
            JSONObject().put("mmolL",6.0).put("source","OWNER_MANUAL"))
        val applied=adapter.applyOwnerIntent(setting)
        assertEquals(snap.getLong("revision")+1,applied.getLong("revision"))
        val after=store.readShellPort("settings")
        assertTrue(after.getJSONObject("data").getJSONArray("preferences").toString().contains("target"))
        assertTrue(after.getJSONObject("data").getJSONArray("settingHistory").toString().contains("target"))
        assertTrue(store.changeFeed(snap.getLong("revision")).getJSONArray("changes").length()>0)
        val repeated=GfV3NativeWriter(db).append("GFSettings","settingsWriter","q01-qa-idempotent-0001",snap.getLong("revision"),setting.getJSONObject("payload"))
        assertEquals(false,repeated.getBoolean("created"))
        assertEquals(applied.getLong("revision"),store.revision())
        val conflict=ownerSetting(snap,"q01-qa-target-0002","q01-qa-idempotent-0002", "target",
            JSONObject().put("mmolL",7.0).put("source","OWNER_MANUAL"))
        try { adapter.applyOwnerIntent(conflict);fail("Old revision must be denied") }
        catch (e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains("V3_REVISION_CONFLICT"))}
        val cur=adapter.readSettingsSnapshot()
        val measurement=ownerSetting(cur,"q01-qa-weight-0003","q01-qa-idempotent-0003","measurement",
            JSONObject().put("weightKg",20.5).put("heightCm",121.0).put("measuredAtUtc","2026-11-20T12:00:00Z"))
        adapter.applyOwnerIntent(measurement)
        val revision=store.revision()
        assertTrue(store.readShellPort("settings").getJSONObject("data").getJSONArray("measurements").length()>0)
        db.close()
        db=GfDbHelper(ctx)
        store=storage(ctx,db)
        assertEquals(revision,store.revision())
        val reopened=store.readShellPort("settings").getJSONObject("data")
        assertTrue(reopened.getJSONArray("preferences").toString().contains("target"))
        assertTrue(reopened.getJSONArray("measurements").toString().contains("20.5"))
        val journal=store.readShellPort("journal")
        assertEquals(revision,journal.getLong("revision"))
        db.close()
    }

    /** Exercises the actual Android Activity/WebView/JS bridge rather than a JS mock. */
    @Test fun actualWebViewShellProfileAndUnacceptedGuard() {
        val ctx=app()
        reset(ctx)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun js(source:String):String {
                val answer=AtomicReference<String>("")
                val latch=CountDownLatch(1)
                scenario.onActivity { activity ->
                    val content=activity.findViewById<ViewGroup>(android.R.id.content)
                    val view=content.getChildAt(0) as WebView
                    view.evaluateJavascript(source) { json -> answer.set(json);latch.countDown() }
                }
                assertTrue("Timed out on real WebView JS: $source",latch.await(25,TimeUnit.SECONDS))
                return answer.get()
            }
            fun decoded(source:String):String=JSONTokener(js(source)).nextValue().toString()
            var ready=false
            repeat(30) {
                if(decoded("(function(){return String(!!window.GPV3V3Bridge&&!!window.GPV3V3Host&&!!document.getElementById('m00SetupTimeZone'))})()") == "true") {
                    ready=true;return@repeat
                }
                Thread.sleep(400)
            }
            assertTrue("Native bridge and settings setup must render",ready)
            assertEquals("3",js("GPV3V3Bridge.getSchemaVersion()"))
            val first=JSONObject(decoded("GPV3V3Bridge.readShellPort('settings')"))
            assertFalse(first.getBoolean("profileConfigured"))
            assertEquals("true",decoded("(function(){window.confirm=()=>true;const z=document.getElementById('m00SetupTimeZone');z.value='Europe/London';z.dispatchEvent(new Event('input',{bubbles:true}));z.parentNode.querySelector('button').click();return String(!!document.getElementById('q01SettingsFrame'))})()"))
            val profile=JSONObject(decoded("GPV3V3Bridge.readShellPort('settings')"))
            assertTrue(profile.getBoolean("profileConfigured"))
            assertEquals("Europe/London",profile.getJSONObject("data").getJSONObject("profile").getString("timeZone"))
            val r=decoded("(function(){const p=JSON.parse(GPV3V3Bridge.readShellPort('settings'));const intent={type:'GFSETTINGS_V3_OWNER_INTENT',command:'setting',role:'settingsWriter',ownerConfirmed:true,profileId:p.profileId,expectedRevision:p.revision,idempotencyKey:'q01-qa-denied-0001',payload:{settingChangeId:'q01-qa-denied-change-0001',settingKey:'target',value:{mmolL:6,source:'OWNER_MANUAL'}}};return GPV3V3Bridge.requestSettingsOwnerIntent(JSON.stringify(intent))})()")
            val result=JSONObject(r)
            assertEquals("CAPABILITY_DENIED",result.getJSONObject("error").getString("code"))
            assertEquals(profile.getLong("revision"),JSONObject(decoded("GPV3V3Bridge.readShellPort('settings')")).getLong("revision"))
            assertEquals("true",decoded("String(!!document.getElementById('q01SettingsFrame'))"))
        }
    }
    /** End-to-end: actual JS -> native owner dialog -> native installed port -> SQLite -> JS read.
     * Acceptance is a disposable emulator registry fixture; shipping registry stays NOT_ACCEPTED.
     */
    @Test fun webViewOwnerDialogSettingsSqliteAndCancellation() {
        val ctx=app()
        reset(ctx)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun js(source:String):String {
                val answer=AtomicReference<String>("")
                val latch=CountDownLatch(1)
                scenario.onActivity { activity ->
                    val content=activity.findViewById<ViewGroup>(android.R.id.content)
                    val view=content.getChildAt(0) as WebView
                    view.evaluateJavascript(source) { json -> answer.set(json);latch.countDown() }
                }
                assertTrue(latch.await(25,TimeUnit.SECONDS))
                return answer.get()
            }
            fun decoded(source:String):String=JSONTokener(js(source)).nextValue().toString()
            var available=false
            repeat(25) {
                if(decoded("String(!!window.GPV3V3Bridge)")=="true")available=true
                if(!available)Thread.sleep(400)
            }
            assertTrue("Real native bridge must be available",available)
            val started=JSONObject(decoded("GPV3V3Bridge.initializeProfile('Europe/London',GPV3V3Bridge.getRevision())"))
            assertEquals("PROFILE_CONFIGURED",started.getString("status"))
            val db=GfDbHelper(ctx)
            testAcceptedFixture(db) // ISOLATED EMULATOR ONLY
            fun request(value:Double,marker:String):JSONObject {
                val src="""(function(){const p=JSON.parse(GPV3V3Bridge.readShellPort('settings'));const intent={type:'GFSETTINGS_V3_OWNER_INTENT',command:'setting',role:'settingsWriter',ownerConfirmed:true,profileId:p.profileId,expectedRevision:p.revision,idempotencyKey:'q01-e2e-key-$marker',payload:{settingChangeId:'q01-e2e-change-$marker',settingKey:'target',value:{mmolL:$value,source:'OWNER_MANUAL'}}};return GPV3V3Bridge.requestSettingsOwnerIntent(JSON.stringify(intent))})()"""
                return JSONObject(decoded(src))
            }
            val queued=request(6.3,"confirm")
            assertEquals("PENDING",queued.getString("state"))
            onView(withText("Подтвердить")).inRoot(isDialog()).perform(click())
            var outcome:JSONObject?=null
            repeat(45) {
                if(outcome==null){
                    val result=JSONObject(decoded("GPV3V3Bridge.pollSettingsOwnerIntent('"+queued.getString("ticket")+"')"))
                    if(result.getString("state")=="FINISHED") outcome=result
                    else if(result.getString("state")=="REJECTED")fail("Native queue rejected: $result")
                    else Thread.sleep(100)
                }
            }
            assertNotNull("Native acceptance did not finish",outcome)
            assertTrue(outcome!!.getJSONObject("result").getBoolean("accepted"))
            val after=JSONObject(decoded("GPV3V3Bridge.readShellPort('settings')"))
            val preferences=after.getJSONObject("data").getJSONArray("preferences")
            val target=(0 until preferences.length()).map { preferences.getJSONObject(it) }
                .firstOrNull { it.getString("key")=="target" }
            assertNotNull("GFStorage settings projection must contain target",target)
            assertEquals(6.3,target!!.getJSONObject("value").getDouble("mmolL"),0.001)
            assertTrue(after.getJSONObject("data").getJSONArray("settingHistory").length()>0)
            val cancelled=request(7.4,"cancel")
            assertEquals("PENDING",cancelled.getString("state"))
            onView(withText("Отмена")).inRoot(isDialog()).perform(click())
            val final=JSONObject(decoded("GPV3V3Bridge.pollSettingsOwnerIntent('"+cancelled.getString("ticket")+"')"))
            assertEquals("CANCELLED",final.getString("state"))
            val afterCancel=JSONObject(decoded("GPV3V3Bridge.readShellPort('settings')"))
            assertEquals(after.getLong("revision"),afterCancel.getLong("revision"))
            db.close()
        }
    }


    /** Cross-component read regression: settings produced by the native module are
     * observed from the same SQLite revision by the M02 home and M01 journal.
     * No fake meal events are inserted and unknown actual totals stay null.
     */
    @Test fun q01SettingsReachM02AndM01FromOneNativeRevision() {
        val ctx=app()
        reset(ctx)
        val helper=GfDbHelper(ctx)
        val store=storage(ctx,helper)
        store.initializeProfile("profile-m02-link-qa","Europe/London",store.revision())
        testAcceptedFixture(helper)  // disposable emulator only
        val adapter=GfV3SettingsTrustedAdapter(
            GfV3NativeModuleGateway(store,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
                .bindInstalledAdapter("GFSettings"))
        var snap=adapter.readSettingsSnapshot()
        adapter.applyOwnerIntent(ownerSetting(snap,"q01-link-profile-0001","q01-link-key-0001","childProfile",
            JSONObject().put("displayName","QA profile").put("birthDate","2018-01-02")
                .put("sex","male").put("timeZone","Europe/London").put("allergies",org.json.JSONArray())))
        snap=adapter.readSettingsSnapshot()
        adapter.applyOwnerIntent(ownerSetting(snap,"q01-link-nutri-0002","q01-link-key-0002","nutritionReference",
            JSONObject().put("daily",JSONObject().put("protein",43.0).put("fat",53.0)
                .put("carbs",160.0).put("kcal",1700.0)).put("source","OWNER_MANUAL")))
        val revision=store.revision()
        val nativeSettings=store.readShellPort("settings")
        val nativeJournal=store.readShellPort("journal")
        assertEquals(revision,nativeSettings.getLong("revision"))
        assertEquals(revision,nativeJournal.getLong("revision"))
        assertEquals(nativeSettings.getString("profileId"),nativeJournal.getString("profileId"))
        assertEquals("Europe/London",nativeJournal.getJSONObject("data").getJSONObject("profile").getString("timeZone"))
        assertEquals(0,nativeJournal.getJSONObject("data").getJSONArray("events").length())
        helper.close()

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun js(source:String):String {
                val answer=AtomicReference<String>("")
                val latch=CountDownLatch(1)
                scenario.onActivity { activity ->
                    val web=activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
                    web.evaluateJavascript(source) { encoded ->answer.set(encoded); latch.countDown() }
                }
                assertTrue("WebView did not answer",latch.await(25,TimeUnit.SECONDS))
                return answer.get()
            }
            fun decoded(source:String):String=JSONTokener(js(source)).nextValue().toString()
            var ready=false
            for(i in 0 until 45) {
                val answer=decoded("String(!!window.GFM02HomeProjection&&!!window.GPV3V3Host&&!!window.GPV3M02Runtime)")
                if(answer=="true") {ready=true;break}
                Thread.sleep(400)
            }
            assertTrue("M02 home adapter must be running",ready)
            val result=JSONObject(decoded("JSON.stringify(GFM02HomeProjection.read(GPV3V3Host,Date.now()))"))
            assertEquals("OK",result.getString("status"))
            assertEquals(revision,result.getLong("revision"))
            assertEquals("profile-m02-link-qa",result.getString("profileId"))
            assertEquals("Europe/London",result.getString("zone"))
            assertEquals("SOURCE_NOT_VERIFIED",result.getString("nutritionStatus"))
            assertTrue("No observed meals must not become zero",result.isNull("nutrition"))
            val norm=result.getJSONObject("nutritionReference")
            assertEquals(43.0,norm.getDouble("protein"),0.0001)
            assertEquals(53.0,norm.getDouble("fat"),0.0001)
            assertEquals(160.0,norm.getDouble("carbs"),0.0001)
            assertEquals(1700.0,norm.getDouble("kcal"),0.0001)
            val text=decoded("String(document.getElementById('m02Nutrition').innerText)")
            assertTrue("M02 DOM must display the saved protein norm",text.contains("43"))
            assertTrue("M02 DOM must not invent actuals",text.contains("—"))
            val iframeReady=decoded("String(!!document.getElementById('q01SettingsFrame')&&!!document.getElementById('q01SettingsFrame').contentDocument)")
            assertEquals("true",iframeReady)
            var mounted=false
            for(i in 0 until 35) {
                if(decoded("String(!!document.getElementById('q01SettingsFrame')?.contentWindow?.GFSettingsV3UI?.readView())")=="true") {mounted=true;break}
                Thread.sleep(400)
            }
            assertTrue("Settings iframe must mount actual approved screen",mounted)
            val screen=JSONObject(decoded("JSON.stringify(document.getElementById('q01SettingsFrame').contentWindow.GFSettingsV3UI.readView())"))
            assertEquals(revision,screen.getLong("revision"))
            assertEquals("QA profile",screen.getJSONObject("profile").getString("displayName"))
            assertEquals("OWNER_MANUAL",screen.getJSONObject("nutritionReference").getString("source"))
        }
    }

    /** Invalid UI/native intents must be rejected atomically, even after native
     * registry is enabled ONLY within a disposable test fixture. */
    @Test fun invalidQ01IntentsNeverChangeRevisionOrSavedPreferences() {
        val ctx=app()
        reset(ctx)
        val helper=GfDbHelper(ctx)
        val store=storage(ctx,helper)
        store.initializeProfile("profile-negative-qa","Europe/London",store.revision())
        testAcceptedFixture(helper)
        val adapter=GfV3SettingsTrustedAdapter(
            GfV3NativeModuleGateway(store,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
                .bindInstalledAdapter("GFSettings"))
        val snap=adapter.readSettingsSnapshot()
        val baseline=snap.getLong("revision")
        val invalid=ownerSetting(snap,"q01-invalid-target","q01-invalid-key","target",
            JSONObject().put("mmolL",-0.1).put("source","OWNER_MANUAL"))
        try {adapter.applyOwnerIntent(invalid);fail("Negative target was saved")}
        catch(e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains("TARGET_INVALID"))}
        assertEquals(baseline,store.revision())
        val forged=ownerSetting(snap,"q01-forged-target","q01-forged-key","target",
            JSONObject().put("mmolL",6.3).put("source","OWNER_MANUAL"))
        forged.put("ownerConfirmed",false)
        try {adapter.applyOwnerIntent(forged);fail("Unconfirmed write was saved")}
        catch(e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains("OWNER_CONFIRMATION_REQUIRED"))}
        assertEquals(baseline,store.revision())
        val wrongProfile=ownerSetting(snap,"q01-wrong-profile","q01-wrong-key","target",
            JSONObject().put("mmolL",6.3).put("source","OWNER_MANUAL"))
        wrongProfile.put("profileId","profile-intruder")
        try {adapter.applyOwnerIntent(wrongProfile);fail("Cross-profile write was saved")}
        catch(e:IllegalArgumentException){assertTrue(e.message.orEmpty().contains("SETTINGS_PROFILE_CONFLICT"))}
        assertEquals(baseline,store.revision())
        val body=store.readShellPort("settings").getJSONObject("data")
        assertEquals(0,body.getJSONArray("settingHistory").length())
        assertEquals(0,body.getJSONArray("preferences").length())
        helper.close()
    }

}
