package org.glukopapa.v3.m00

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.time.Instant

/** Baseline characterization ONLY. Passing the second test confirms gaps, not production readiness.
 * All records are synthetic nonnumeric INSUFFICIENT_DATA diagnostics in a disposable test DB.
 * No production adapter is installed or accepted and no treatment event is created.
 */
@RunWith(AndroidJUnit4::class)
class Q13WriterAuditInstrumentedTest {
    private fun isolated(block:(android.content.Context,GfDbHelper,GfV3Storage,GfV3NativeModuleGateway)->Unit){
        val ctx=InstrumentationRegistry.getInstrumentation().targetContext
        ctx.deleteDatabase("glukopapa_v3.db")
        val helper=GfDbHelper(ctx)
        try{
            fun asset(n:String)=ctx.assets.open("db/$n").bufferedReader().use{it.readText()}
            val storage=GfV3Storage(helper,asset("module_catalog_v1.json"),asset("writer_grants_v0.12.json"))
            storage.initializeProfile("qa-q13-writer","UTC",storage.revision())
            val gateway=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
            block(ctx,helper,storage,gateway)
        }finally{helper.close();ctx.deleteDatabase("glukopapa_v3.db")}
    }
    private fun activate(h:GfDbHelper,id:String,w:String,r:String){
        h.writableDatabase.execSQL("UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1,write_roles_json=?,read_roles_json=? WHERE module_id=?",arrayOf(w,r,id))
    }
    private fun input(h:GfDbHelper)=h.readableDatabase.rawQuery("SELECT input_revision FROM v3_meta WHERE id=1",null).use{assertTrue(it.moveToFirst());it.getLong(0)}
    private fun count(h:GfDbHelper,t:String)=h.readableDatabase.rawQuery("SELECT COUNT(*) FROM "+t,null).use{assertTrue(it.moveToFirst());it.getLong(0)}
    private fun state(h:GfDbHelper,s:GfV3Storage)=listOf(s.revision(),input(h),count(h,"v3_meal_timing"),count(h,"v3_extended_receipts"),count(h,"v3_audit"),count(h,"v3_extended_change_feed"),count(h,"v3_events"))
    private fun payload(id:String,rev:Long)=JSONObject().put("timingId",id).put("calculatedAtUtc",Instant.now().toString()).put("resultStatus","INSUFFICIENT_DATA").put("sourceRevision",rev).put("inputDigest","a".repeat(64)).put("minutes",JSONObject.NULL)
    private fun rejected(h:GfDbHelper,s:GfV3Storage,message:String,action:()->Unit){
        val before=state(h,s)
        val failure=runCatching{action()}.exceptionOrNull()
        assertNotNull("Expected refusal: "+message,failure)
        assertTrue("Unexpected failure: "+failure, failure?.message?.contains(message)==true)
        assertEquals(before,state(h,s))
    }
    @Test fun q13WriterNativeAuthorizationAndAtomicRevisionContract()=isolated{_,h,s,g->
        val owner=g.bindInstalledAdapter("GFMealTimingService")
        val rev=input(h)
        val p=payload("qa-timing-one",rev)
        rejected(h,s,"NATIVE_WRITER_PERMISSION_DENIED"){owner.append("mealTimingPublisher","qa-timing-key",rev,p)}
        activate(h,"GFMealTimingService","[\"mealTimingPublisher\"]","[\"mealTiming\"]")
        activate(h,"GFInjectionTimingStorage","[\"mealTimingPublisher\"]","[]")
        rejected(h,s,"NATIVE_WRITER_PERMISSION_DENIED"){g.bindInstalledAdapter("GFInjectionTimingStorage").append("mealTimingPublisher","qa-wrong-owner",rev,p)}
        rejected(h,s,"V3_SOURCE_REVISION_CONFLICT"){owner.append("mealTimingPublisher","qa-stale-key",rev+1,p)}
        rejected(h,s,"FORECAST_STATUS_INVALID"){owner.append("mealTimingPublisher","qa-status-key",rev,JSONObject(p.toString()).put("resultStatus","HISTORICAL_ESTIMATE"))}
        rejected(h,s,"UTC_REQUIRED"){owner.append("mealTimingPublisher","qa-time-key",rev,JSONObject(p.toString()).put("calculatedAtUtc","invalid"))}
        rejected(h,s,"TIMING_UNKNOWN_CANNOT_HAVE_MINUTES"){owner.append("mealTimingPublisher","qa-number-key",rev,JSONObject(p.toString()).put("minutes",0))}
        val before=state(h,s);val receipt=owner.append("mealTimingPublisher","qa-timing-key",rev,p)
        assertTrue(receipt.getBoolean("created"))
        assertEquals(listOf(before[0]+1,before[1],before[2]+1,before[3]+1,before[4]+1,before[5]+1,before[6]),state(h,s))
        val after=state(h,s)
        val repeat=owner.append("mealTimingPublisher","qa-timing-key",rev,p)
        assertFalse(repeat.getBoolean("created"));assertEquals(receipt.getLong("revision"),repeat.getLong("revision"));assertEquals(after,state(h,s))
        rejected(h,s,"IDEMPOTENCY_CONFLICT"){owner.append("mealTimingPublisher","qa-timing-key",rev,JSONObject(p.toString()).put("inputDigest","b".repeat(64)))}
        h.writableDatabase.execSQL("UPDATE v3_module_registry SET feature_enabled=0 WHERE module_id='GFMealTimingService'")
        rejected(h,s,"NATIVE_WRITER_PERMISSION_DENIED"){owner.append("mealTimingPublisher","qa-timing-key",rev,p)}
    }
    @Test fun q13WriterLegacyMissingContextAndStaleReplayReproduced()=isolated{ctx,h,s,g->
        activate(h,"GFMealTimingService","[\"mealTimingPublisher\"]","[\"mealTiming\"]")
        activate(h,"GFSettings","[\"settingsWriter\"]","[\"settings\"]")
        val owner=g.bindInstalledAdapter("GFMealTimingService")
        val rev=input(h);val before=state(h,s)
        val p=payload("qa-timing-unbound",rev).put("mealSessionId","qa-nonexistent").put("profileId","qa-foreign").put("inputDigest","z".repeat(16))
        // Expected legacy gaps, NOT a successful medical publication.
        assertTrue(owner.append("mealTimingPublisher","qa-unbound-key",rev,p).getBoolean("created"))
        h.readableDatabase.rawQuery("SELECT profile_id,meal_session_id,input_digest,minutes FROM v3_meal_timing WHERE timing_id='qa-timing-unbound'",null).use{
            assertTrue(it.moveToFirst());assertEquals("qa-q13-writer",it.getString(0));assertEquals("qa-nonexistent",it.getString(1));assertEquals("z".repeat(16),it.getString(2));assertTrue(it.isNull(3))
        }
        val rows=owner.read("mealTiming").getJSONObject("data").getJSONArray("results")
        assertEquals("qa-foreign",rows.getJSONObject(0).getString("profileId"))
        val stale=payload("qa-timing-pre-restore",rev)
        val epoch=GfV3RestoreFence.capture{s.revision()}.first
        val beforeRestore=s.revision()
        val backup=GfV3EncryptedSnapshot(ctx,h);val pass="qa-only-writer-test-pass".toCharArray()
        val envelope=backup.createEncrypted(pass)
        try{backup.restoreEncrypted(envelope,pass,beforeRestore,"qa-writer-restore.gpv3")}
        finally{pass.fill('\u0000');envelope.fill(0)}
        assertEquals(beforeRestore,s.revision());assertEquals(rev,input(h))
        assertTrue(GfV3RestoreFence.capture{s.revision()}.first!=epoch)
        assertTrue("Legacy raw append ignores the pre-restore epoch",owner.append("mealTimingPublisher","qa-restore-key",rev,stale).getBoolean("created"))
        g.bindInstalledAdapter("GFSettings").append("settingsWriter","qa-input-change",s.revision(),JSONObject().put("settingChangeId","qa-input-setting").put("settingKey","foodModel").put("value",JSONObject().put("selectedModel","GFCOB").put("source","OWNER_MANUAL")).put("effectiveAtUtc",Instant.now().toString()))
        assertTrue(input(h)>rev)
        rejected(h,s,"V3_SOURCE_REVISION_CONFLICT"){owner.append("mealTimingPublisher","qa-new-stale-key",rev,payload("qa-timing-new-stale",rev))}
        val after=state(h,s)
        assertFalse("Old receipt returned before input revision check",owner.append("mealTimingPublisher","qa-unbound-key",rev,p).getBoolean("created"))
        assertEquals(after,state(h,s))
        val read=owner.read("mealTiming");assertTrue(read.getLong("inputRevision")>rev)
        val saved=read.getJSONObject("data").getJSONArray("results")
        assertTrue((0 until saved.length()).any{saved.getJSONObject(it).getLong("sourceRevision")==rev})
        assertEquals(before[6],count(h,"v3_events"))
    }
}
