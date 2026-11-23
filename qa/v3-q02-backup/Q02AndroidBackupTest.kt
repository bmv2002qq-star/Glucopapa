package org.glukopapa.v3.m00

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.security.MessageDigest

/** No patient data: all database records in this test are artificial QA fixtures. */
@RunWith(AndroidJUnit4::class)
class Q02AndroidBackupTest {
    private val pass="Q02-test-passphrase-NOT-REAL-2026".toCharArray()
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
}
