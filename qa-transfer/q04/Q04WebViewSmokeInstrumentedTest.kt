package org.glukopapa.v3.m00

import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real Android 15 WebView smoke of approved Q04 HTML + native-only draft bridge.
 * A synthetic profile is used. It must not create a treatment event.
 */
@RunWith(AndroidJUnit4::class)
class Q04WebViewSmokeInstrumentedTest {
    private val instrument get()=InstrumentationRegistry.getInstrumentation()
    private val ctx get()=instrument.targetContext

    private fun js(web:WebView,code:String):String {
        val done=CountDownLatch(1)
        val value=AtomicReference<String>("null")
        instrument.runOnMainSync { web.evaluateJavascript(code) { value.set(it); done.countDown() } }
        assertTrue("Q04 JS timed out: $code",done.await(20,TimeUnit.SECONDS))
        return value.get()
    }

    private fun poll(web:WebView,code:String,expected:String) {
        repeat(75) {
            if(js(web,code)==expected)return
            Thread.sleep(1000)
        }
        fail("Q04 WebView not ready: $code expected $expected, got ${js(web,code)}")
    }

    @Test fun approvedNutritionHtmlUsesOnlyNativeDraftBridge() {
        ctx.deleteDatabase("glukopapa_v3.db")
        GfDbHelper(ctx).use { h ->
            h.writableDatabase.execSQL("UPDATE v3_meta SET profile_id='qa-q04-web',timezone='UTC' WHERE id=1")
        }
        val intent=Intent(ctx,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity=instrument.startActivitySync(intent) as MainActivity
        try {
            val web=activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
            instrument.runOnMainSync { web.loadUrl("https://appassets.androidplatform.net/q04/nutrition.html") }
            poll(web,"location.pathname","\"/q04/nutrition.html\"")
            poll(web,"document.readyState","\"complete\"")
            poll(web,"typeof GPV3Q04Drafts","\"object\"")
            assertEquals("\"undefined\"",js(web,"typeof GFStorageDemo_Nutrition_v040"))
            val nativeRaw=js(web,"GPV3Q04Drafts.readDraft()")
            val nativeJson=JSONObject(JSONArray("[$nativeRaw]").getString(0))
            assertEquals("GFStorage_NATIVE",nativeJson.getString("source"))
            assertTrue(nativeJson.getBoolean("profileConfigured"))
            assertEquals("USER_DRAFT_UNVERIFIED",nativeJson.getString("trustStatus"))
            val cmd=JSONObject().put("kind","allergens").put("value",JSONArray().put("gluten"))
                .put("expectedRevision",nativeJson.getLong("revision"))
                .put("idempotencyKey","q04:web-smoke-001")
            val savedRaw=js(web,"GPV3Q04Drafts.saveDraft(${JSONObject.quote(cmd.toString())})")
            val saved=JSONObject(JSONArray("[$savedRaw]").getString(0))
            assertTrue(saved.getBoolean("recorded"))
            assertEquals("USER_DRAFT_UNVERIFIED",saved.getString("trustStatus"))
            val afterRaw=js(web,"GPV3Q04Drafts.readDraft()")
            val after=JSONObject(JSONArray("[$afterRaw]").getString(0))
            assertEquals("gluten",after.getJSONObject("state").getJSONArray("allergens").getString(0))
            GfDbHelper(ctx).use { h ->
                h.readableDatabase.rawQuery("SELECT COUNT(*) FROM v3_events",null).use { c ->
                    assertTrue(c.moveToFirst())
                    assertEquals(0L,c.getLong(0))
                }
            }
        } finally {
            instrument.runOnMainSync { activity.finish() }
        }
    }
}