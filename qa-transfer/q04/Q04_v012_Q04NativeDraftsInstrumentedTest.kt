package org.glukopapa.v3.m00

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.Instant

/** Q04 native integration QA. Synthetic drafts only, never treatment records. */
@RunWith(AndroidJUnit4::class)
class Q04NativeDraftsInstrumentedTest {
    private val ctx get()=InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var helper:GfDbHelper
    private lateinit var drafts:GfV3Q04NutritionDrafts
    @Before fun before(){
        ctx.deleteDatabase("glukopapa_v3.db")
        helper=GfDbHelper(ctx)
        helper.writableDatabase.execSQL("UPDATE v3_meta SET profile_id='qa-q04',timezone='UTC' WHERE id=1")
        drafts=GfV3Q04NutritionDrafts(helper)
    }
    @After fun after(){helper.close();ctx.deleteDatabase("glukopapa_v3.db")}
    private fun command(kind:String,value:Any,revision:Long,key:String):String=JSONObject()
        .put("kind",kind).put("value",value).put("expectedRevision",revision)
        .put("idempotencyKey",key).toString()
    private fun plate()=JSONArray().put(JSONObject().put("kind","catalog")
        .put("foodId","gf:00042").put("amount",100.0))
    private fun count(table:String):Long=helper.readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM $table",null).use{c->c.moveToFirst();c.getLong(0)}

    private fun confirmedMealPlate(): JSONObject {
        val item=JSONObject().put("name","Гречка").put("unit","г")
            .put("amount",100.0).put("nutritionStatus","estimated")
            .put("carbs",20.0).put("protein",3.0).put("fat",1.0).put("kcal",105.0)
        val totals=JSONObject().put("count",1).put("amount",100.0).put("carbs",20.0)
            .put("protein",3.0).put("fat",1.0).put("kcal",105.0)
        return JSONObject().put("schema","GFPlate.v1").put("source","GFNutrition")
            .put("containsEstimatedValues",true)
            .put("items",JSONArray().put(item)).put("totals",totals)
    }

    private fun acceptedMealFacts(storage: GfV3Storage): GfV3Q04MealFacts {
        // Test-only activation simulates the registry state *after* delegated
        // technical acceptance. Production code never activates through JS.
        helper.writableDatabase.execSQL("UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1,write_roles_json='[\"mealFlow\"]' WHERE module_id='GFNutrition'")
        val native=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        return GfV3Q04MealFacts(native.bindInstalledAdapter("GFNutrition"))
    }
    private fun nativeStorage(): GfV3Storage=GfV3Storage(helper,
        ctx.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()},
        ctx.assets.open("db/writer_grants_v0.12.json").bufferedReader().use{it.readText()})
    private fun currentRevision():Long=helper.readableDatabase.rawQuery("SELECT revision FROM v3_meta WHERE id=1",null)
        .use{it.moveToFirst();it.getLong(0)}
    private val mealTime="2026-11-24T13:30:00Z"

    @Test fun actualMealRequiresNativeOwnerConfirmationAndAcceptedRegistry(){
        val storage=nativeStorage()
        val native=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        val facts=GfV3Q04MealFacts(native.bindInstalledAdapter("GFNutrition"))
        val plan=confirmedMealPlate(); val rev=currentRevision()
        try { facts.plan("q04-session-a01",plan,"q04-plan-a01",rev,mealTime);fail("unaccepted mealFlow writer") }
        catch(_:SecurityException){}
        try { facts.confirmActual("q04-session-a01",plan,plan,"q04-event-a01","q04-confirm-a01",rev,false,mealTime,mealTime);
            fail("owner confirmation bypass") }
        catch(_:SecurityException){}
        assertEquals(0L,count("v3_meal_sessions"));assertEquals(0L,count("v3_events"))
    }

    @Test fun acceptedNativeActualMealPublishesOneJournalFactAndIdempotentReplay(){
        val storage=nativeStorage()
        val facts=acceptedMealFacts(storage)
        val plate=confirmedMealPlate(); val startRev=currentRevision()
        val session="q04-session-b02"; val eventId="q04-event-b02"
        val plan=facts.plan(session,plate,"q04-plan-b02",startRev,mealTime)
        assertTrue(plan.getBoolean("created"));assertEquals(startRev+1,plan.getLong("revision"))
        val started=facts.start(session,plate,"q04-start-b02",plan.getLong("revision"),mealTime)
        assertTrue(started.getBoolean("created"));assertEquals(startRev+2,started.getLong("revision"))
        val result=facts.confirmActual(session,plate,plate,eventId,"q04-confirm-b02",started.getLong("revision"),true,mealTime,mealTime)
        assertTrue(result.getBoolean("created"));assertEquals(startRev+3,result.getLong("revision"))
        val replay=facts.confirmActual(session,plate,plate,eventId,"q04-confirm-b02",started.getLong("revision"),true,mealTime,mealTime)
        assertFalse(replay.getBoolean("created"))
        assertEquals(1L,count("v3_events"));assertEquals(1L,count("v3_meal_sessions"))
        assertEquals(3L,count("v3_meal_history"));assertEquals(3L,count("v3_extended_receipts"))
        assertEquals(0L,count("v3_write_receipts"))
        val journal=storage.readShellPort("journal").getJSONObject("data")
        val sessions=journal.getJSONArray("mealSessions")
        val events=journal.getJSONArray("events")
        assertEquals(1,sessions.length());assertEquals(1,events.length())
        assertEquals("completed",sessions.getJSONObject(0).getString("status"))
        assertEquals(20.0,sessions.getJSONObject(0).getJSONObject("actualPlate").getJSONObject("totals").getDouble("carbs"),0.001)
        assertEquals(eventId,events.getJSONObject(0).getString("eventId"))
        assertEquals(session,events.getJSONObject(0).getString("sessionId"))
        assertEquals("CONFIRMED_ACTUAL",events.getJSONObject(0).getString("provenance"))
        assertEquals(3L,helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM v3_extended_change_feed WHERE domain='mealSessions'",null)
            .use{it.moveToFirst();it.getLong(0)})
    }

    @Test fun confirmedActualMealSurvivesEncryptedBackupRestore(){
        val storage=nativeStorage();val facts=acceptedMealFacts(storage)
        val plate=confirmedMealPlate();val session="q04-session-backup-c03"
        val r0=currentRevision()
        val r1=facts.plan(session,plate,"q04-plan-c03",r0,mealTime).getLong("revision")
        val r2=facts.start(session,plate,"q04-start-c03",r1,mealTime).getLong("revision")
        val r3=facts.confirmActual(session,plate,plate,"q04-event-c03","q04-confirm-c03",r2,true,mealTime,mealTime).getLong("revision")
        val password="q04-meal-backup-passphrase".toCharArray()
        val encrypted=GfV3EncryptedSnapshot(ctx,helper).createEncrypted(password)
        drafts.save(command("allergens",JSONArray().put("milk"),r3,"q04-backup-modify-c03"))
        try {
            GfV3EncryptedSnapshot(ctx,helper).restoreEncrypted(encrypted,password,r3+1)
            val data=storage.readShellPort("journal").getJSONObject("data")
            assertEquals(1,data.getJSONArray("events").length())
            assertEquals("q04-event-c03",data.getJSONArray("events").getJSONObject(0).getString("eventId"))
            assertEquals(1,data.getJSONArray("mealSessions").length())
            assertEquals(20.0,data.getJSONArray("mealSessions").getJSONObject(0).getJSONObject("actualPlate").getJSONObject("totals").getDouble("carbs"),0.001)
            assertEquals(0L,count("v3_nutrition_drafts"))
        } finally {encrypted.fill(0); password.fill(' ')}
    }

    @Test fun actualMealRejectsUnsupportedVerificationClaim(){
        val storage=nativeStorage();val facts=acceptedMealFacts(storage)
        val plate=confirmedMealPlate();val rev=currentRevision()
        val r1=facts.plan("q04-session-d04",plate,"q04-plan-d04",rev,mealTime).getLong("revision")
        val r2=facts.start("q04-session-d04",plate,"q04-start-d04",r1,mealTime).getLong("revision")
        val bad=confirmedMealPlate().put("containsEstimatedValues",false)
        try {facts.confirmActual("q04-session-d04",plate,bad,"q04-event-d04","q04-confirm-d04",r2,true,mealTime,mealTime)
            fail("estimate falsely verified") }
        catch(_:IllegalArgumentException){}
        assertEquals(0L,count("v3_events"))
        assertEquals("in_progress",storage.readShellPort("journal").getJSONObject("data")
            .getJSONArray("mealSessions").getJSONObject(0).getString("status"))
    }

    @Test fun draftCommitsSingleRevisionNoMedicalFacts(){
        val response=drafts.save(command("plate",plate(),0,"q04:smoke-1"))
        assertTrue(response.getBoolean("recorded"));assertEquals(1L, response.getLong("revision"))
        assertEquals("USER_DRAFT_UNVERIFIED",response.getString("trustStatus"))
        assertEquals(1L,count("v3_nutrition_drafts"));assertEquals(1L,count("v3_nutrition_draft_change_feed"))
        assertEquals(1L,count("v3_audit"));assertEquals(0L,count("v3_events"))
        assertEquals(0L,count("v3_meal_sessions"))
        val read=drafts.read();assertEquals("GFStorage_NATIVE",read.getString("source"))
        assertEquals(1,read.getJSONObject("state").getJSONArray("plate").length())
    }
    @Test fun idempotencyRejectsReplayAndStaleRevision(){
        val raw=command("plate",plate(),0,"q04:smoke-2")
        val a=drafts.save(raw);val retry=drafts.save(raw)
        assertEquals(a.getLong("revision"),retry.getLong("revision"))
        assertTrue(retry.getBoolean("idempotent"));assertEquals(1L,count("v3_nutrition_draft_receipts"))
        try{drafts.save(command("allergens",JSONArray().put("milk"),0,"q04:smoke-3"));fail("stale accepted")}
        catch(_:IllegalArgumentException){}
        try{drafts.save(command("allergens",JSONArray().put("milk"),1,"q04:smoke-2"));fail("mismatched replay")}
        catch(_:IllegalArgumentException){}
        assertEquals(1L,count("v3_nutrition_drafts"))
    }
    @Test fun forgedVerificationRejected(){
        val badPlate=JSONArray().put(JSONObject().put("kind","catalog")
            .put("foodId","gf:00042").put("amount",50.0).put("verified",true))
        try{drafts.save(command("plate",badPlate,0,"q04:smoke-4"));fail("forge accepted")}
        catch(_:IllegalArgumentException){}
        assertEquals(0L,count("v3_nutrition_drafts"))
    }
    private fun legacyV7Envelope(pass:CharArray, forgedFingerprint:Boolean=false):ByteArray {
        val old=File(ctx.cacheDir,"q04-test-legacy-v7-${System.nanoTime()}.db")
        try {
            val db=SQLiteDatabase.openDatabase(old.absolutePath,null,SQLiteDatabase.CREATE_IF_NECESSARY)
            try {
                for(i in 1..7){
                    val script=ctx.assets.open("db/schema_v${i}.sql").bufferedReader().use{it.readText()}
                    script.lineSequence().filterNot{it.trim().startsWith("--")}.joinToString("\n")
                        .split(';').map{it.trim()}.filter{it.isNotEmpty()}.forEach(db::execSQL)
                }
                db.execSQL("UPDATE v3_meta SET profile_id='qa-q04',timezone='UTC' WHERE id=1")
                db.version=7
                val parts=ArrayList<String>()
                db.rawQuery("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY type,name",null).use{c->
                    while(c.moveToNext())parts.add(listOf(c.getString(0),c.getString(1),c.getString(2),c.getString(3)).joinToString("\u0000"))
                }
                val hash=MessageDigest.getInstance("SHA-256").digest(parts.joinToString("\n").toByteArray())
                    .joinToString(""){"%02x".format(it.toInt() and 255)}
                db.close()
                val sqlite=old.readBytes()
                val sha=MessageDigest.getInstance("SHA-256").digest(sqlite)
                    .joinToString(""){"%02x".format(it.toInt() and 255)}
                val manifest=JSONObject().put("format","GPV3-ENCRYPTED-SQLITE").put("formatVersion",2)
                    .put("app","org.glukopapa.v3.m00").put("createdAtUtc",Instant.now().toString())
                    .put("revision",0).put("sqliteUserVersion",7)
                    .put("schemaFingerprint",if(forgedFingerprint)"bad" else hash)
                    .put("sqliteBytes",sqlite.size).put("sqliteSha256",sha)
                    .put("method","SQLITE_VACUUM_INTO_WAL_SAFE").toString().toByteArray(Charsets.UTF_8)
                val container=ByteBuffer.allocate(4+manifest.size+sqlite.size).order(ByteOrder.BIG_ENDIAN)
                    .putInt(manifest.size).put(manifest).put(sqlite).array()
                return try{GfV3BackupCodec.encrypt(container,pass)}finally{container.fill(0);sqlite.fill(0)}
            } finally {if(db.isOpen)db.close()}
        } finally {old.delete()}
    }

    @Test fun legacyV7EncryptedBackupRestoresThroughIsolatedMigration(){
        val pass="q04-legacy-v7-qa-test".toCharArray()
        drafts.save(command("allergens",JSONArray().put("milk"),0,"q04:legacy-1"))
        val envelope=legacyV7Envelope(pass)
        try {
            val result=GfV3EncryptedSnapshot(ctx,helper).restoreEncrypted(envelope,pass,1)
            assertEquals(7,result.dbVersion) // source version unchanged; live store remains v8
            assertEquals(8,helper.readableDatabase.version)
            assertEquals(0L,count("v3_nutrition_drafts"))
            assertEquals(0L,count("v3_nutrition_draft_receipts"))
            assertEquals(0L,count("v3_nutrition_draft_change_feed"))
            assertEquals(0L,helper.readableDatabase.rawQuery("SELECT revision FROM v3_meta",null).use{c->c.moveToFirst();c.getLong(0)})
        } finally {envelope.fill(0)}
    }

    @Test fun forgedV7SchemaRejectedAndCurrentDraftKept(){
        val pass="q04-legacy-v7-qa-test".toCharArray()
        drafts.save(command("allergens",JSONArray().put("milk"),0,"q04:legacy-2"))
        val envelope=legacyV7Envelope(pass,true)
        try {
            try{GfV3EncryptedSnapshot(ctx,helper).restoreEncrypted(envelope,pass,1);fail("forged v7 accepted")}
            catch(_:IllegalArgumentException){}
            assertEquals(1L,count("v3_nutrition_drafts"))
            assertEquals("milk",drafts.read().getJSONObject("state").getJSONArray("allergens").getString(0))
        } finally {envelope.fill(0)}
    }

    @Test fun encryptedBackupRestoreWithNutritionDraft(){
        val pass="q04-qa-long-passphrase".toCharArray()
        drafts.save(command("allergens",JSONArray().put("gluten"),0,"q04:smoke-5"))
        val backup=GfV3EncryptedSnapshot(ctx,helper).createEncrypted(pass)
        drafts.save(command("allergens",JSONArray().put("milk"),1,"q04:smoke-6"))
        val result=GfV3EncryptedSnapshot(ctx,helper).restoreEncrypted(backup,pass,2)
        assertEquals(8,result.dbVersion)
        assertEquals("gluten",drafts.read().getJSONObject("state").getJSONArray("allergens").getString(0))
        backup.fill(0)
    }
}