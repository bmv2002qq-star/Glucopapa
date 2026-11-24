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

    @Test fun actualMealRequiresNativeOwnerConfirmationAndAcceptedRegistry(){
        val storage=GfV3Storage(helper,
            ctx.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()},
            ctx.assets.open("db/writer_grants_v0.11.json").bufferedReader().use{it.readText()})
        val gateway=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        val facts=GfV3Q04MealFacts(gateway.bindInstalledAdapter("GFNutrition"))
        val plate=confirmedMealPlate()
        try{facts.recordActuallyEaten(plate,"q04-meal-001","q04-meal-key-1",0,false); fail("native owner confirmation bypass")}
        catch(_:SecurityException){}
        try{facts.recordActuallyEaten(plate,"q04-meal-001","q04-meal-key-1",0,true); fail("unaccepted writer bypass")}
        catch(_:SecurityException){}
        assertEquals(0L,count("v3_events"))
        assertEquals(0L,count("v3_write_receipts"))
    }

    @Test fun acceptedNativeActualMealPublishesOneJournalFactAndIdempotentReplay(){
        // Test-only activation emulates a *previously accepted* installed GFNutrition.
        // Production code NEVER sets this registry status from JS or from this module.
        val storage=GfV3Storage(helper,
            ctx.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()},
            ctx.assets.open("db/writer_grants_v0.11.json").bufferedReader().use{it.readText()})
        helper.writableDatabase.execSQL("UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1,write_roles_json='[\"actionWriter\"]' WHERE module_id='GFNutrition'")
        val gateway=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        val facts=GfV3Q04MealFacts(gateway.bindInstalledAdapter("GFNutrition"))
        val plate=confirmedMealPlate()
        val beforeRev=helper.readableDatabase.rawQuery("SELECT revision FROM v3_meta WHERE id=1",null)
            .use{it.moveToFirst();it.getLong(0)}
        val id="q04-meal-actual-003"; val key="q04-meal-actual-key-003"
        val at="2026-11-24T12:00:00Z"
        val result=facts.recordActuallyEaten(plate,id,key,beforeRev,true,at)
        assertTrue(result.getBoolean("created"))
        val replay=facts.recordActuallyEaten(plate,id,key,beforeRev,true,at)
        assertFalse(replay.getBoolean("created"))
        assertEquals(1L,count("v3_events"));assertEquals(1L,count("v3_write_receipts"))
        helper.readableDatabase.rawQuery("SELECT event_type,event_status,source_module,payload_json,created_revision FROM v3_events WHERE event_id=?",arrayOf(id)).use{c->
            assertTrue(c.moveToFirst());assertEquals("meal",c.getString(0))
            assertEquals("recorded",c.getString(1));assertEquals("GFNutrition",c.getString(2))
            val payload=JSONObject(c.getString(3))
            assertEquals("CONFIRMED_ACTUAL",payload.getString("provenance"))
            assertEquals("ESTIMATED_NOT_SKU_VERIFIED",payload.getString("nutritionVerification"))
            assertEquals("ACTUAL",payload.getString("platePhase"))
            assertEquals(20.0,payload.getJSONObject("plate").getJSONObject("totals").getDouble("carbs"),0.0001)
            assertEquals(beforeRev+1,c.getLong(4))
        }
        val hasChange=helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM v3_change_feed WHERE domain='events' AND record_id=?",arrayOf(id))
            .use{it.moveToFirst();it.getLong(0)}
        assertEquals(1L,hasChange)
    }

    @Test fun actualMealRejectsUnsupportedVerificationClaim(){
        val storage=GfV3Storage(helper,
            ctx.assets.open("db/module_catalog_v1.json").bufferedReader().use{it.readText()},
            ctx.assets.open("db/writer_grants_v0.11.json").bufferedReader().use{it.readText()})
        val gateway=GfV3NativeModuleGateway(storage,GfV3NativeWriter(helper),GfV3CorrectionWriter(helper),helper)
        val facts=GfV3Q04MealFacts(gateway.bindInstalledAdapter("GFNutrition"))
        val plate=confirmedMealPlate().put("containsEstimatedValues",false)
        try{facts.recordActuallyEaten(plate,"q04-meal-002","q04-meal-key-2",0,true); fail("fake verified food passed")}
        catch(_:IllegalArgumentException){}
        assertEquals(0L,count("v3_events"))
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