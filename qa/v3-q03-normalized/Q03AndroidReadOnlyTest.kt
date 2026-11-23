package org.glukopapa.v3.m00

import android.content.ContentValues
import android.content.Context
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** QA-only Q03 on a disposable Android 15 emulator; no production writer or approval flags. */
@RunWith(AndroidJUnit4::class)
class Q03AndroidReadOnlyTest {
    private fun ctx():Context=ApplicationProvider.getApplicationContext()
    private fun clearTestJobs(){
        val jobs=ctx().getSystemService(Context.JOB_SCHEDULER_SERVICE) as android.app.job.JobScheduler
        jobs.cancel(GfV3AutoLocalBackup.PERIODIC_JOB_ID)
        jobs.cancel(GfV3AutoLocalBackup.INITIAL_JOB_ID)
    }
    @Before fun beforeCase()=clearTestJobs()
    @After fun afterCase()=clearTestJobs()
    private fun create():Pair<GfDbHelper,GfV3Storage> {
        val context=ctx()
        context.deleteDatabase("glukopapa_v3.db")
        val db=GfDbHelper(context)
        val catalog=context.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()}
        val grants=context.assets.open("db/writer_grants_v0.11.json").bufferedReader().use{it.readText()}
        val store=GfV3Storage(db,catalog,grants)
        store.initializeProfile("profile-q03-test","Europe/London",store.revision())
        return db to store
    }
    private fun plate()=JSONObject().put("schema","GFPlate.v1")
        .put("items",org.json.JSONArray().put(JSONObject().put("name","Гречка")
            .put("amount",100.0).put("unit","g").put("carbs",12.0).put("fat",2.0)
            .put("protein",3.0).put("kcal",72.0)))
        .put("totals",JSONObject().put("carbs",12.0).put("fat",2.0).put("protein",3.0).put("kcal",72.0))
    private fun fixture(db:GfDbHelper, revision:Long) {
        val writable=db.writableDatabase
        writable.beginTransaction()
        try {
            val event=JSONObject().put("eventId","legacy-meal-1").put("eventType","meal")
                .put("status","recorded").put("occurredAtUtc","2026-11-23T09:00:00Z")
                .put("sessionId","session-1")
            val session=JSONObject().put("sessionId","session-1").put("status","completed")
                .put("startedAtUtc","2026-11-23T09:00:00Z").put("actualPlate",plate())
            val cgm=JSONObject().put("observationId","cgm-1")
                .put("measuredAtUtc","2026-11-23T09:05:00Z").put("quality","good")
                .put("provenance","observed")
            writable.insertOrThrow("v3_events",null,ContentValues().apply{
                put("event_id","legacy-meal-1");put("profile_id","profile-q03-test")
                put("event_type","meal");put("event_status","recorded")
                put("occurred_at_utc","2026-11-23T09:00:00Z");put("payload_json",event.toString())
                put("source_module","GFMealFlow");put("idempotency_key","q03-fixture-event-1")
                put("created_revision",revision)
            })
            writable.insertOrThrow("v3_meal_sessions",null,ContentValues().apply{
                put("session_id","session-1");put("profile_id","profile-q03-test")
                put("session_status","completed");put("payload_json",session.toString());put("created_revision",revision)
            })
            writable.insertOrThrow("v3_cgm",null,ContentValues().apply{
                put("observation_id","cgm-1");put("profile_id","profile-q03-test")
                put("measured_at_utc","2026-11-23T09:05:00Z")
                put("glucose_mmol_l",6.0);put("source_device_id","q03-synthetic")
                put("provenance","observed");put("quality","good")
                put("payload_json",cgm.toString());put("created_revision",revision)
            })
            writable.execSQL("UPDATE v3_meta SET revision=?,input_revision=? WHERE id=1",arrayOf(revision,revision))
            writable.setTransactionSuccessful()
        }finally{writable.endTransaction()}
    }
    private fun eval(scenario:ActivityScenario<MainActivity>,source:String):String {
        val response=AtomicReference<String>("");val done=CountDownLatch(1)
        scenario.onActivity { activity->
            val web=(activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView)
            web.evaluateJavascript(source){json->response.set(json);done.countDown()}
        }
        assertTrue("WebView evaluation timed out",done.await(20,TimeUnit.SECONDS))
        return JSONTokener(response.get()).nextValue().toString()
    }
    private fun load(scenario:ActivityScenario<MainActivity>) {
        scenario.onActivity {activity ->
            val web=(activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView)
            web.loadUrl("https://appassets.androidplatform.net/q03/normalized-facts.html")
        }
        var ready=false
        repeat(50) {
            val result=eval(scenario,"String(!!window.GFNormalizedFactsV3 && !!document.getElementById('eventList'))")
            if(result=="true") {ready=true;return@repeat}
            Thread.sleep(150)
        }
        assertTrue("Q03 offline page and core must load in real WebView",ready)
    }
    @Test fun q03RoutesAreAllowlistedAndNetworkDisabled() {
        val base="appassets.androidplatform.net"
        assertEquals("text/html",GfV3LocalAssetRoutes.resolve("https",base,"/q03/normalized-facts.html",null,null)?.mime)
        assertEquals("application/javascript",GfV3LocalAssetRoutes.resolve("https",base,"/q03/gf_normalized_facts_v3.js",null,null)?.mime)
        assertEquals("application/javascript",GfV3LocalAssetRoutes.resolve("https",base,"/q03/q03_readonly_screen.js",null,null)?.mime)
        assertNull(GfV3LocalAssetRoutes.resolve("http",base,"/q03/normalized-facts.html",null,null))
        assertNull(GfV3LocalAssetRoutes.resolve("https",base,"/q03/normalized-facts.html","fake=1",null))
        assertNull(GfV3LocalAssetRoutes.resolve("https",base,"/q03/unknown.js",null,null))
    }
    @Test fun q03WebViewReadsOneStorageRevisionWithoutWrites() {
        val (db,store)=create()
        val before=store.revision()
        fixture(db,before+1)
        val revision=store.revision()
        val original=db.readableDatabase.rawQuery("SELECT payload_json FROM v3_events WHERE event_id='legacy-meal-1'",null)
            .use {c->assertTrue(c.moveToFirst());c.getString(0)}
        db.close()
        ActivityScenario.launch(MainActivity::class.java).use {scenario->
            load(scenario)
            val summary=JSONObject(eval(scenario,"JSON.stringify(GFNormalizedFactsV3.read(GPV3V3Bridge).summary)"))
            assertEquals(3,summary.getInt("sourceCount"))
            assertEquals(3,summary.getInt("normalizedCount"))
            assertEquals(1,summary.getInt("confirmedMealCount"))
            assertEquals(12.0,summary.getDouble("totalCarbsGrams"),0.0001)
            val pageCount=eval(scenario,"document.querySelector('#summary .metric strong').textContent")
            assertEquals("3",pageCount)
            val state=JSONObject(eval(scenario,"JSON.stringify(GFNormalizedFactsV3.read(GPV3V3Bridge))"))
            assertEquals(revision,state.getLong("revision"))
            assertEquals(0,state.getJSONArray("issues").length())
            scenario.onActivity{activity ->
                val web=activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
                assertFalse("Q03 cannot persist medical data in browser storage",web.settings.domStorageEnabled)
            }
        }
        val recheck=GfDbHelper(ctx())
        val unchanged=recheck.readableDatabase.rawQuery("SELECT payload_json FROM v3_events WHERE event_id='legacy-meal-1'",null)
            .use {c->assertTrue(c.moveToFirst());c.getString(0)}
        assertEquals(original,unchanged)
        assertEquals(revision,recheck.readableDatabase.rawQuery("SELECT revision FROM v3_meta WHERE id=1",null)
            .use{c->assertTrue(c.moveToFirst());c.getLong(0)})
        recheck.close()
    }
    @Test fun q03MissingProfileFailsClosedNoDemoRecords() {
        ctx().deleteDatabase("glukopapa_v3.db")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            load(scenario)
            val summary=eval(scenario,"document.querySelector('#summary .metric strong').textContent")
            assertEquals("—",summary)
            val warning=eval(scenario,"document.querySelector('#summary .metric').parentElement.nextElementSibling.textContent")
            assertTrue(warning.contains("Q03_PROFILE_MISMATCH"))
            assertEquals("0",eval(scenario,"String(document.querySelectorAll('#eventList article').length)"))
        }
    }
}
