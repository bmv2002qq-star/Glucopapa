package org.glukopapa.v3.m00

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.action.ViewActions.click
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Test
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.runner.RunWith
import org.json.JSONObject
import java.security.MessageDigest
import java.nio.ByteBuffer
import java.nio.ByteOrder
import android.database.sqlite.SQLiteDatabase

/** No patient data: all database records in this test are artificial QA fixtures. */
@RunWith(AndroidJUnit4::class)
class Q02AndroidBackupTest {
    private val pass="Q02-test-passphrase-NOT-REAL-2026".toCharArray()
    private fun clickNative(label:String) {
        val device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val button=device.wait(Until.findObject(By.text(label)),15_000)
        assertNotNull("Native dialog action not visible: $label",button)
        button!!.click()
    }

    private fun ctx():Context=ApplicationProvider.getApplicationContext()
    private fun helper():GfDbHelper {
        val c=ctx(); c.deleteDatabase("glukopapa_v3.db")
        return GfDbHelper(c)
    }
    private fun store(h:GfDbHelper):GfV3Storage {
        val c=ctx()
        return GfV3Storage(h,c.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()},
            c.assets.open("db/writer_grants_v0.11.json").bufferedReader().use{it.readText()})
    }
    private fun scalar(h:GfDbHelper,sql:String):String=h.readableDatabase.rawQuery(sql,null).use{c->
        assertTrue(c.moveToFirst());c.getString(0)
    }
    private fun seed(h:GfDbHelper):Long {
        val s=store(h);s.initializeProfile("Q02TESTPROFILE","Europe/London",s.revision())
        val r=s.revision()
        h.writableDatabase.execSQL("INSERT INTO v3_profile_settings(profile_id,setting_key,value_json,updated_revision) VALUES(?,?,?,?)",
            arrayOf("Q02TESTPROFILE","target","{\"mmolL\":6.0,\"source\":\"OWNER_MANUAL\"}",r))
        h.writableDatabase.execSQL("INSERT INTO v3_measurements(measurement_id,profile_id,measured_at_utc,weight_kg,height_cm,source_module,created_revision) VALUES(?,?,?,?,?,?,?)",
            arrayOf("Q02_MEASURE_1","Q02TESTPROFILE","2026-11-22T10:00:00Z",20.5,121.0,"GFSettings",r))
        return r
    }
    private fun fails(target:String, fn:()->Unit) {
        try {fn();fail("Expected rejection $target")}
        catch(e:AssertionError) {throw e}
        catch(e:Exception) { /* known/unknown exception: verify invariants separately */ }
    }
    @Test fun encryptedBackupWALAndWholeDatabaseRoundTrip() {
        val h=helper();val rev=seed(h);val svc=GfV3EncryptedSnapshot(ctx(),h)
        try {
            val beforeTarget=scalar(h,"SELECT value_json FROM v3_profile_settings WHERE setting_key='target'")
            val beforeMeasure=scalar(h,"SELECT count(*) FROM v3_measurements")
            val envelope=svc.createEncrypted(pass)
            assertFalse("Medical JSON must never appear in encrypted file",String(envelope,Charsets.ISO_8859_1).contains("Q02TESTPROFILE"))
            assertFalse(String(envelope,Charsets.ISO_8859_1).contains("mmolL"))
            h.writableDatabase.execSQL("UPDATE v3_profile_settings SET value_json='{\"mmolL\":99}' WHERE setting_key='target'")
            h.writableDatabase.execSQL("DELETE FROM v3_measurements")
            h.writableDatabase.execSQL("UPDATE v3_meta SET revision=revision+1 WHERE id=1")
            val result=svc.restoreEncrypted(envelope,pass,rev+1)
            assertEquals(rev,result.revision)
            assertEquals(beforeTarget,scalar(h,"SELECT value_json FROM v3_profile_settings WHERE setting_key='target'"))
            assertEquals(beforeMeasure,scalar(h,"SELECT count(*) FROM v3_measurements"))
            assertEquals(rev.toString(),scalar(h,"SELECT revision FROM v3_meta WHERE id=1"))
            assertTrue("Temporary plaintext snapshot must be deleted",ctx().cacheDir.resolve("q02-ephemeral").listFiles()?.isEmpty() != false)
        }finally{h.close()}
    }
    @Test fun wrongPasswordTamperTruncationLeaveDatabaseUntouched() {
        val h=helper();val rev=seed(h);val svc=GfV3EncryptedSnapshot(ctx(),h)
        try {
            val envelope=svc.createEncrypted(pass)
            val before=scalar(h,"SELECT value_json FROM v3_profile_settings WHERE setting_key='target'")
            fails("bad passphrase"){svc.restoreEncrypted(envelope,"wrong-passphrase-long-enough".toCharArray(),rev)}
            fails("truncated"){svc.restoreEncrypted(envelope.copyOf(envelope.size-1),pass,rev)}
            fails("changed cipher"){svc.restoreEncrypted(envelope.copyOf().also{it[it.size-1]=(it.last().toInt() xor 1).toByte()},pass,rev)}
            fails("invalid header"){svc.restoreEncrypted(envelope.copyOf().also{it[0]=0},pass,rev)}
            assertEquals(rev.toString(),scalar(h,"SELECT revision FROM v3_meta WHERE id=1"))
            assertEquals(before,scalar(h,"SELECT value_json FROM v3_profile_settings WHERE setting_key='target'"))
            assertTrue(ctx().cacheDir.resolve("q02-ephemeral").listFiles()?.isEmpty() != false)
        }finally{h.close()}
    }
    @Test fun staleRevisionCannotOverwriteLiveData() {
        val h=helper();val rev=seed(h);val svc=GfV3EncryptedSnapshot(ctx(),h)
        try {
            val env=svc.createEncrypted(pass)
            fails("incorrect live CAS"){svc.restoreEncrypted(env,pass,rev-1)}
            assertEquals(rev.toString(),scalar(h,"SELECT revision FROM v3_meta WHERE id=1"))
            assertEquals("1",scalar(h,"SELECT count(*) FROM v3_measurements"))
        }finally{h.close()}
    }
    @Test fun privateFileCanBeSavedReadAndRestored() {
        val h=helper();val rev=seed(h);val svc=GfV3EncryptedSnapshot(ctx(),h)
        try {
            val s=svc.createLocalEncrypted(pass)
            assertEquals(rev,s.revision)
            assertTrue(s.fileName.endsWith(".gpv3"))
            assertTrue(svc.listLocalEncrypted().contains(s.fileName))
            h.writableDatabase.execSQL("DELETE FROM v3_measurements")
            h.writableDatabase.execSQL("UPDATE v3_meta SET revision=revision+1 WHERE id=1")
            svc.restoreLocalEncrypted(s.fileName,pass,rev+1)
            assertEquals("1",scalar(h,"SELECT count(*) FROM v3_measurements"))
            fails("path traversal"){svc.restoreLocalEncrypted("../../evil",pass,rev)}
        }finally{h.close()}
    }
    @Test fun q02ApprovedHtmlNativeOwnerCancelKeepsDatabaseUnchanged() {
        val context=ctx()
        context.deleteDatabase("glukopapa_v3.db")
        val dir=java.io.File(context.filesDir,"q02-encrypted")
        dir.listFiles()?.forEach { it.delete() } // Disposable test sandbox only.
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun js(source:String):String {
                val answer=AtomicReference<String>("")
                val latch=CountDownLatch(1)
                scenario.onActivity { act ->
                    val web=act.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as WebView
                    web.evaluateJavascript(source){result->answer.set(result);latch.countDown()}
                }
                assertTrue("Q02 WebView JavaScript must answer",latch.await(25,TimeUnit.SECONDS))
                return JSONTokener(answer.get()).nextValue().toString()
            }
            assertEquals("true",js("String(!!window.GPV3Q02Native)"))
            js("location.href='/q02/backup.html';'NAV' ")
            var loaded=false
            repeat(35) {
                if(!loaded){
                    loaded=js("String(!!document.getElementById('createPreview'))")=="true"
                    if(!loaded)Thread.sleep(180)
                }
            }
            assertTrue("Q02 approved HTML must be served by native route",loaded)
            val before=js("String(GPV3Q02Native.request('invalid-action'))")
            assertTrue("JS must not gain unchecked native backup API",before.contains("Q02_ACTION_REJECTED"))
            js("document.getElementById('createPreview').click();'CLICKED'")
            clickNative("Отмена")
            Thread.sleep(250)
            assertEquals("No plaintext or encrypted user backup on cancellation",0,dir.listFiles()?.size?:0)
            val rev=js("String(GPV3V3Bridge.getRevision())").toLong()
            assertTrue(rev>=0)
        }
    }

    @Test fun authenticatedInvalidForeignKeySnapshotRollsBackEveryTable() {
        val h=helper();val rev=seed(h);val svc=GfV3EncryptedSnapshot(ctx(),h)
        val backup=svc.createEncrypted(pass)
        val plain=GfV3BackupCodec.decrypt(backup,pass)
        val size=ByteBuffer.wrap(plain,0,4).order(ByteOrder.BIG_ENDIAN).int
        val manifest=JSONObject(String(plain,4,size,Charsets.UTF_8))
        val original=plain.copyOfRange(4+size,plain.size)
        val scratch=java.io.File(ctx().cacheDir,"q02-invalid-fk-synthetic.sqlite")
        scratch.writeBytes(original)
        try {
            val source=SQLiteDatabase.openDatabase(scratch.absolutePath,null,SQLiteDatabase.OPEN_READWRITE)
            source.setForeignKeyConstraintsEnabled(false)
            source.execSQL("INSERT INTO v3_write_grants(module_id,role,grant_status,implementation_status,granted_by) VALUES(?,?,?,?,?)",
                arrayOf("Q02_NONEXISTENT_MODULE","settingsWriter","OWNER_GRANTED_EXPERIMENTAL","PREPARED_NATIVE","OWNER_EXPLICIT_REQUEST_20261121"))
            source.close()
            val altered=scratch.readBytes()
            manifest.put("sqliteBytes",altered.size)
            manifest.put("sqliteSha256",MessageDigest.getInstance("SHA-256").digest(altered).joinToString(""){"%02x".format(it.toInt() and 255)})
            val meta=manifest.toString().toByteArray(Charsets.UTF_8)
            val payload=ByteBuffer.allocate(4+meta.size+altered.size).order(ByteOrder.BIG_ENDIAN)
                .putInt(meta.size).put(meta).put(altered).array()
            val authenticated=GfV3BackupCodec.encrypt(payload,pass)
            try {
                fails("Foreign key failure must roll back entire restore"){
                    svc.restoreEncrypted(authenticated,pass,rev)
                }
                assertEquals(rev.toString(),scalar(h,"SELECT revision FROM v3_meta WHERE id=1"))
                assertEquals("1",scalar(h,"SELECT count(*) FROM v3_measurements"))
                assertEquals("0",scalar(h,"SELECT count(*) FROM v3_write_grants WHERE module_id='Q02_NONEXISTENT_MODULE'"))
            }finally{payload.fill(0);altered.fill(0);authenticated.fill(0)}
        }finally{
            original.fill(0);plain.fill(0);scratch.delete();h.close()
        }
    }

}
