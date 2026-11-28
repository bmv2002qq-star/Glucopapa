package org.glukopapa.v3.m00

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * Q14 QA-only candidate: disposable native GFStorage database, actual restore fence
 * and Q02 codec. No registration, grants, treatment, production migration or JS bridge.
 * Only a nonnumeric diagnostic is persisted; it is never a clinical COB result.
 */
@RunWith(AndroidJUnit4::class)
class Q14NativeDiagnosticInstrumentedTest {
    private data class Stamp(val profile: String, val input: Long, val epoch: Long, val instance: String)
    private class Candidate(private val helper:GfDbHelper) {
        private val instance=UUID.randomUUID().toString()
        private fun context(db:SQLiteDatabase):Pair<String,Long> =
            db.rawQuery("SELECT profile_id,input_revision FROM v3_meta WHERE id=1",null).use {
                check(it.moveToFirst() && !it.isNull(0)){"Q14_PROFILE_MISSING"}
                it.getString(0) to it.getLong(1)
            }
        fun capture():Stamp {
            val (epoch,c)=GfV3RestoreFence.capture { context(helper.readableDatabase) }
            return Stamp(c.first,c.second,epoch,instance)
        }
        private fun checked(db:SQLiteDatabase,s:Stamp){
            check(s.instance==instance){"Q14_INSTANCE_CHANGED"}
            check(context(db)==(s.profile to s.input)){"Q14_CONTEXT_CHANGED"}
        }
        fun put(s:Stamp,key:String,reason:String,abort:Boolean=false):Boolean =
            GfV3RestoreFence.requireCurrent(s.epoch) {
                require(key.matches(Regex("qa-[a-z0-9-]{1,60}"))){"Q14_KEY_INVALID"}
                require(reason in setOf("PARAMETERS_UNVALIDATED","SOURCE_INCOMPLETE")){"Q14_REASON_INVALID"}
                val db=helper.writableDatabase
                db.beginTransaction()
                try {
                    checked(db,s)
                    val existing=db.rawQuery("SELECT profile_id,input_revision,epoch,instance,reason FROM qa_q14_diagnostic WHERE result_id=?",arrayOf(key)).use {
                        if(!it.moveToFirst()) null else listOf(it.getString(0),it.getLong(1).toString(),it.getLong(2).toString(),it.getString(3),it.getString(4))
                    }
                    val expected=listOf(s.profile,s.input.toString(),s.epoch.toString(),s.instance,reason)
                    if(existing!=null){
                        check(existing==expected){"Q14_REPLAY_CONFLICT"}
                        db.setTransactionSuccessful()
                        false
                    } else {
                        db.execSQL("INSERT INTO qa_q14_diagnostic(result_id,profile_id,input_revision,epoch,instance,reason) VALUES(?,?,?,?,?,?)",arrayOf(key,s.profile,s.input,s.epoch,s.instance,reason))
                        check(!abort){"Q14_TEST_ABORT"}
                        db.setTransactionSuccessful()
                        true
                    }
                } finally {db.endTransaction()}
            }
        fun read(s:Stamp,key:String):JSONObject =
            GfV3RestoreFence.requireCurrent(s.epoch) {
                val db=helper.readableDatabase
                db.beginTransaction()
                try {
                    checked(db,s)
                    val result=db.rawQuery("SELECT reason FROM qa_q14_diagnostic WHERE result_id=? AND profile_id=? AND input_revision=? AND epoch=? AND instance=?",arrayOf(key,s.profile,s.input.toString(),s.epoch.toString(),s.instance)).use {
                        if(!it.moveToFirst()) null else it.getString(0)
                    }
                    val out=JSONObject().put("status","UNKNOWN").put("reason",result ?: "NO_CURRENT_RESULT").put("cob",JSONObject.NULL).put("allowDose",false)
                    db.setTransactionSuccessful()
                    out
                } finally {db.endTransaction()}
            }
    }
    private fun isolated(block:(Context,GfDbHelper,GfV3Storage,GfV3NativeModuleGateway,Candidate)->Unit){
        val ctx=InstrumentationRegistry.getInstrumentation().targetContext
        ctx.deleteDatabase("glukopapa_v3.db")
        val helper=GfDbHelper(ctx)
        try{
            fun asset(n:String)=ctx.assets.open("db/$n").bufferedReader().use{it.readText()}
            val storage=GfV3Storage(helper,asset("module_catalog_v1.json"),asset("writer_grants_v0.12.json"))
            storage.initializeProfile("qa-q14-native","UTC",storage.revision())
            helper.writableDatabase.execSQL("CREATE TABLE qa_q14_diagnostic(result_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,input_revision INTEGER NOT NULL CHECK(input_revision>=0),epoch INTEGER NOT NULL CHECK(epoch>=0),instance TEXT NOT NULL,reason TEXT NOT NULL CHECK(reason IN ('PARAMETERS_UNVALIDATED','SOURCE_INCOMPLETE')))")
            val gateway=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
            block(ctx,helper,storage,gateway,Candidate(helper))
        }finally{helper.close();ctx.deleteDatabase("glukopapa_v3.db")}
    }
    private fun count(h:GfDbHelper,t:String)=h.readableDatabase.rawQuery("SELECT COUNT(*) FROM "+t,null).use{check(it.moveToFirst());it.getLong(0)}
    private fun refused(code:String,action:()->Unit){
        val e=runCatching{action()}.exceptionOrNull()
        assertNotNull("Expected refusal "+code,e)
        assertTrue("Unexpected "+e,e?.message?.contains(code)==true)
    }
    @Test fun q14DiagnosticAtomicReplayAndNoMedicalWrite()=isolated{_,h,s,_,c->
        val stamp=c.capture();val before=s.revision();val events=count(h,"v3_events")
        assertTrue(c.put(stamp,"qa-one","PARAMETERS_UNVALIDATED"))
        assertFalse(c.put(stamp,"qa-one","PARAMETERS_UNVALIDATED"))
        refused("Q14_REPLAY_CONFLICT"){c.put(stamp,"qa-one","SOURCE_INCOMPLETE")}
        refused("Q14_TEST_ABORT"){c.put(stamp,"qa-abort","SOURCE_INCOMPLETE",true)}
        assertEquals(1L,count(h,"qa_q14_diagnostic"))
        val result=c.read(stamp,"qa-one")
        assertEquals("UNKNOWN",result.getString("status"));assertTrue(result.isNull("cob"));assertFalse(result.getBoolean("allowDose"))
        assertEquals(before,s.revision());assertEquals(events,count(h,"v3_events"))
        assertEquals(0L,count(h,"v3_forecasts"))
    }
    @Test fun q14RealSettingsChangeInvalidatesDiagnostic()=isolated{_,h,s,g,c->
        val stamp=c.capture();assertTrue(c.put(stamp,"qa-before","SOURCE_INCOMPLETE"))
        h.writableDatabase.execSQL("UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1,write_roles_json=?,read_roles_json=? WHERE module_id='GFSettings'",arrayOf("[\"settingsWriter\"]","[\"settings\"]"))
        g.bindInstalledAdapter("GFSettings").append("settingsWriter","qa-q14-setting-key",s.revision(),JSONObject().put("settingChangeId","qa-q14-setting").put("settingKey","foodModel").put("value",JSONObject().put("selectedModel","GFCOB").put("source","OWNER_MANUAL")).put("effectiveAtUtc",java.time.Instant.now().toString()))
        refused("Q14_CONTEXT_CHANGED"){c.read(stamp,"qa-before")}
        refused("Q14_CONTEXT_CHANGED"){c.put(stamp,"qa-before","SOURCE_INCOMPLETE")}
        assertEquals("NO_CURRENT_RESULT",c.read(c.capture(),"qa-before").getString("reason"))
    }
    @Test fun q14EncryptedRoundtripInvalidatesEvenAtSameRevision()=isolated{ctx,h,s,_,c->
        val stamp=c.capture();assertTrue(c.put(stamp,"qa-before","SOURCE_INCOMPLETE"))
        val backup=GfV3EncryptedSnapshot(ctx,h);val pass="qa-only-q14-backup-pass".toCharArray()
        val envelope=backup.createEncrypted(pass);val rev=s.revision()
        try {
            h.writableDatabase.execSQL("DELETE FROM qa_q14_diagnostic")
            assertEquals(0L,count(h,"qa_q14_diagnostic"))
            backup.restoreEncrypted(envelope,pass,rev,"qa-q14-roundtrip.gpv3")
            assertEquals(rev,s.revision());assertEquals(1L,count(h,"qa_q14_diagnostic"))
            refused("RESTORE_EPOCH_CHANGED"){c.read(stamp,"qa-before")}
            refused("RESTORE_EPOCH_CHANGED"){c.put(stamp,"qa-before","SOURCE_INCOMPLETE")}
            assertEquals("NO_CURRENT_RESULT",c.read(c.capture(),"qa-before").getString("reason"))
            assertEquals("NO_CURRENT_RESULT",Candidate(h).let{it.read(it.capture(),"qa-before").getString("reason")})
        }finally{pass.fill('\u0000');envelope.fill(0)}
    }
    @Test fun q14NoProductionRoleOrClinicalWrite()=isolated{_,h,s,g,c->
        assertFalse(GfV3PortContract.shellReadAllowed("cob"))
        assertFalse(GfV3PortContract.nativeModuleReadAllowed("cob",true,true,setOf("cob")))
        assertFalse(GfV3PortContract.nativeModuleWriteAllowed("cobPublisher",true,true,setOf("cobPublisher")))
        val before=s.revision()
        assertNotNull(runCatching{g.bindInstalledAdapter("GFMealAbsorption").read("cob")}.exceptionOrNull())
        refused("Q14_REASON_INVALID"){c.put(c.capture(),"qa-invalid","CALCULATED")}
        assertEquals(before,s.revision());assertEquals(0L,count(h,"qa_q14_diagnostic"))
    }
}
