package org.glukopapa.v3.m00

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.Instant

/** Isolated QA only; no real producer grant or numeric COB. */
@RunWith(AndroidJUnit4::class)
class Q14Schema11InstrumentedTest {
    private val ctx get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val name="glukopapa_v3.db"
    private fun hash(b:ByteArray)=MessageDigest.getInstance("SHA-256").digest(b).joinToString(""){"%02x".format(it.toInt() and 255)}
    private fun fingerprint(db:SQLiteDatabase):String{
        val rows=mutableListOf<String>()
        db.rawQuery("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY type,name",null).use{c->while(c.moveToNext())rows.add((0..3).map{c.getString(it)}.joinToString("\u0000"))}
        return hash(rows.joinToString("\n").toByteArray(Charsets.UTF_8))
    }
    private fun num(db:SQLiteDatabase,sql:String)=db.rawQuery(sql,null).use{assertTrue(it.moveToFirst());it.getLong(0)}
    private fun integrity(db:SQLiteDatabase){
        db.rawQuery("PRAGMA integrity_check",null).use{assertTrue(it.moveToFirst());assertEquals("ok",it.getString(0));assertFalse(it.moveToNext())}
        db.rawQuery("PRAGMA foreign_key_check",null).use{assertEquals(0,it.count)}
    }
    private fun seed(file:File,collision:Boolean=false):String{
        file.parentFile?.mkdirs()
        val db=SQLiteDatabase.openOrCreateDatabase(file,null)
        try{
            for(i in 1..10)ctx.assets.open("db/schema_v"+i+".sql").bufferedReader().use{it.readText()}.lineSequence().filterNot{it.trim().startsWith("--")}.joinToString("\n").split(';').map{it.trim()}.filter{it.isNotEmpty()}.forEach(db::execSQL)
            db.version=10
            db.execSQL("UPDATE v3_meta SET profile_id='qa-profile',timezone='UTC',revision=8,input_revision=6 WHERE id=1")
            db.execSQL("INSERT INTO v3_extended_receipts VALUES('qa-key','qa-profile','settings','qa-record','hash',8,'GFSettings')")
            db.execSQL("INSERT INTO v3_extended_change_feed VALUES(8,'settings','qa-record','2026-01-01T00:00:00Z','GFSettings')")
            if(collision)db.execSQL("CREATE TABLE v3_meal_absorption(x INTEGER)")
            return fingerprint(db)
        }finally{db.close()}
    }
    private fun oldRows(db:SQLiteDatabase){
        db.rawQuery("SELECT * FROM v3_extended_receipts WHERE idempotency_key='qa-key'",null).use{c->assertTrue(c.moveToFirst());assertEquals(listOf("qa-key","qa-profile","settings","qa-record","hash","8","GFSettings"),(0..6).map{c.getString(it)});assertFalse(c.moveToNext())}
        db.rawQuery("SELECT * FROM v3_extended_change_feed WHERE revision=8",null).use{c->assertTrue(c.moveToFirst());assertEquals(listOf("8","settings","qa-record","2026-01-01T00:00:00Z","GFSettings"),(0..4).map{c.getString(it)});assertFalse(c.moveToNext())}
        assertEquals(8L,num(db,"SELECT revision FROM v3_meta WHERE id=1"))
        assertEquals(6L,num(db,"SELECT input_revision FROM v3_meta WHERE id=1"))
    }
    private fun insert(db:SQLiteDatabase,cob:Double?=null){
        db.execSQL("INSERT INTO v3_meal_absorption VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",arrayOf("qa-result","qa-profile","GFForecast","qa-v1",6,"2026-01-01T00:00:00Z","a".repeat(64),"UNKNOWN","PARAMETERS_UNVALIDATED",cob,9,"GFMealAbsorption"))
    }
    private fun reject(action:()->Unit){assertNotNull("Expected SQLite rejection",runCatching{action()}.exceptionOrNull() as? SQLiteException)}
    @Test fun q14Schema11RealFileUpgradeAndReopen(){
        ctx.deleteDatabase(name);seed(ctx.getDatabasePath(name))
        try{
            val h=GfDbHelper(ctx)
            val fp=try{val db=h.writableDatabase;assertEquals(11,db.version);oldRows(db);integrity(db);assertEquals(0L,num(db,"SELECT COUNT(*) FROM v3_meal_absorption"));fingerprint(db)}finally{h.close()}
            val r=GfDbHelper(ctx);try{assertEquals(fp,fingerprint(r.writableDatabase));oldRows(r.writableDatabase)}finally{r.close()}
            ctx.deleteDatabase(name);val f=GfDbHelper(ctx);try{assertEquals(fp,fingerprint(f.writableDatabase))}finally{f.close()}
        }finally{ctx.deleteDatabase(name)}
    }
    @Test fun q14Schema11CollisionRollback(){
        ctx.deleteDatabase(name);val before=seed(ctx.getDatabasePath(name),true)
        try{
            val h=GfDbHelper(ctx);try{reject{h.writableDatabase}}finally{h.close()}
            val old=SQLiteDatabase.openDatabase(ctx.getDatabasePath(name).absolutePath,null,SQLiteDatabase.OPEN_READWRITE)
            try{assertEquals(10,old.version);assertEquals(before,fingerprint(old));oldRows(old);integrity(old);old.execSQL("DROP TABLE v3_meal_absorption")}finally{old.close()}
            val r=GfDbHelper(ctx);try{assertEquals(11,r.writableDatabase.version);oldRows(r.writableDatabase)}finally{r.close()}
        }finally{ctx.deleteDatabase(name)}
    }
    @Test fun q14Schema11AuthenticatedV10AndV11Roundtrip(){
        ctx.deleteDatabase(name);val file=File.createTempFile("q14-v10-", ".db",ctx.cacheDir);file.delete()
        val pass="q14-synthetic-v10-passphrase".toCharArray();val h=GfDbHelper(ctx)
        try{
            val fp=seed(file);val raw=file.readBytes()
            val m=JSONObject().put("format","GPV3-ENCRYPTED-SQLITE").put("formatVersion",2).put("app","org.glukopapa.v3.m00").put("createdAtUtc",Instant.now().toString()).put("revision",8).put("sqliteUserVersion",10).put("schemaFingerprint",fp).put("sqliteBytes",raw.size).put("sqliteSha256",hash(raw)).put("method","SQLITE_VACUUM_INTO_WAL_SAFE").toString().toByteArray(Charsets.UTF_8)
            val clear=ByteBuffer.allocate(4+m.size+raw.size).order(ByteOrder.BIG_ENDIAN).putInt(m.size).put(m).put(raw).array()
            val enc=try{GfV3BackupCodec.encrypt(clear,pass)}finally{raw.fill(0);clear.fill(0)}
            val db=h.writableDatabase;val backup=GfV3EncryptedSnapshot(ctx,h);val schema=fingerprint(db)
            try{
                assertEquals(10,backup.inspectEncrypted(enc,pass).dbVersion)
                backup.restoreEncrypted(enc,pass,num(db,"SELECT revision FROM v3_meta WHERE id=1"))
                oldRows(db);assertEquals(schema,fingerprint(db));assertEquals(0L,num(db,"SELECT COUNT(*) FROM v3_meal_absorption"))
                db.beginTransaction()
                try{
                    insert(db)
                    db.execSQL("INSERT INTO v3_extended_receipts VALUES('qa-cob-key','qa-profile','mealAbsorption','qa-result','hash2',9,'GFMealAbsorption')")
                    db.execSQL("INSERT INTO v3_extended_change_feed VALUES(9,'mealAbsorption','qa-result','2026-01-01T00:00:00Z','GFMealAbsorption')")
                    db.execSQL("UPDATE v3_meta SET revision=9 WHERE id=1")
                    db.setTransactionSuccessful()
                }finally{db.endTransaction()}
                val epoch=GfV3RestoreFence.capture{0}.first;val fresh=backup.createEncrypted(pass)
                try{
                    assertEquals(11,backup.inspectEncrypted(fresh,pass).dbVersion)
                    db.execSQL("DELETE FROM v3_meal_absorption");backup.restoreEncrypted(fresh,pass,9)
                    assertEquals(9L,num(db,"SELECT revision FROM v3_meta WHERE id=1"));assertEquals(6L,num(db,"SELECT input_revision FROM v3_meta WHERE id=1"))
                    assertEquals(1L,num(db,"SELECT COUNT(*) FROM v3_meal_absorption WHERE publication_id='qa-result' AND cob_g IS NULL AND result_status='UNKNOWN'"))
                    assertEquals(1L,num(db,"SELECT COUNT(*) FROM v3_extended_receipts WHERE idempotency_key='qa-cob-key' AND domain='mealAbsorption'"))
                    assertEquals(1L,num(db,"SELECT COUNT(*) FROM v3_extended_change_feed WHERE revision=9 AND domain='mealAbsorption'"))
                    assertNotEquals(epoch,GfV3RestoreFence.capture{0}.first);assertEquals(schema,fingerprint(db));integrity(db)
                }finally{fresh.fill(0)}
            }finally{enc.fill(0)}
        }finally{pass.fill('\u0000');file.delete();h.close();ctx.deleteDatabase(name)}
    }
    @Test fun q14Schema11NoNumericAndSharedReceiptNamespace(){
        ctx.deleteDatabase(name);seed(ctx.getDatabasePath(name));val h=GfDbHelper(ctx)
        try{
            val db=h.writableDatabase;reject{insert(db,0.0)};reject{insert(db,12.0)};insert(db)
            reject{db.execSQL("UPDATE v3_meal_absorption SET result_status='CALCULATED'")}
            reject{db.execSQL("INSERT INTO v3_extended_receipts VALUES('qa-key','qa-profile','mealAbsorption','qa-result','hash',9,'GFMealAbsorption')")}
            assertEquals(1L,num(db,"SELECT COUNT(*) FROM v3_meal_absorption WHERE cob_g IS NULL AND result_status='UNKNOWN'"))
            oldRows(db);assertFalse(GfV3PortContract.nativeModuleWriteAllowed("cobPublisher",true,true,setOf("cobPublisher")));integrity(db)
        }finally{h.close();ctx.deleteDatabase(name)}
    }
}
