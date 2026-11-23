package org.glukopapa.v3.m00

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Q02. A user-visible export is an encrypted envelope, never an unencrypted JSON/SQLite file.
 * Snapshots are obtained via SQLite VACUUM INTO (atomic, WAL-aware consistent read).
 * Restore is transactionally applied to the existing schema; failed restore is rolled back.
 * This is a native-only owner-controlled adapter; it does not expose a database writer to JS.
 * Caller must quiesce other writers during restore; SAF/file-chooser is a separate adapter.
 */
internal class GfV3EncryptedSnapshot(private val ctx: Context, private val helper: GfDbHelper) {
    companion object {
        private val gate=Any()
        private const val FORMAT=2
        private const val MAX_DB=120*1024*1024
        private const val MAX_MANIFEST=32768
        private const val NAME_PREFIX="GlukoPapa-V3-"
        private const val NAME_SUFFIX=".gpv3"
        private fun digest(data:ByteArray):String = MessageDigest.getInstance("SHA-256")
            .digest(data).joinToString(""){ "%02x".format(it.toInt() and 255) }
        private fun requireValidFilename(s:String) {
            require(Regex("^GlukoPapa-V3-[0-9a-f-]{36}\\.gpv3$").matches(s)) {"Q02_BACKUP_NAME_INVALID"}
        }
        private fun quoted(s:String) = "'"+s.replace("'","''")+"'"
        private fun tableNames(db:SQLiteDatabase,source:String="main"):List<String> {
            require(source=="main"||source=="q02source")
            val names=mutableListOf<String>()
            db.rawQuery("SELECT name FROM $source.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY name",null).use{c->
                while(c.moveToNext())names.add(c.getString(0))
            }
            return names
        }
        private fun schemaFingerprint(db:SQLiteDatabase,source:String="main"):String {
            require(source=="main"||source=="q02source")
            val parts=ArrayList<String>()
            db.rawQuery("SELECT type,name,tbl_name,coalesce(sql,'') FROM $source.sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY type,name",null).use {c->
                while(c.moveToNext())parts.add(listOf(c.getString(0),c.getString(1),c.getString(2),c.getString(3)).joinToString("\u0000"))
            }
            return digest(parts.joinToString("\n").toByteArray(Charsets.UTF_8))
        }
        private fun version(db:SQLiteDatabase):Int = db.rawQuery("PRAGMA user_version",null).use{c->c.moveToFirst();c.getInt(0)}
        private fun revision(db:SQLiteDatabase):Long = db.rawQuery("SELECT revision FROM v3_meta WHERE id=1",null).use{c->
            require(c.moveToFirst()){"Q02_META_MISSING"};c.getLong(0)
        }
        private fun quickCheck(db:SQLiteDatabase) {
            db.rawQuery("PRAGMA quick_check",null).use { c ->
                require(c.moveToFirst() && c.getString(0)=="ok" && !c.moveToNext()) {"Q02_SQLITE_INTEGRITY_FAILED"}
            }
        }
    }

    private val backupDir:File get()=File(ctx.filesDir,"q02-encrypted").apply { if(!exists())check(mkdirs()) }
    private val tempDir:File get()=File(ctx.cacheDir,"q02-ephemeral").apply { if(!exists())check(mkdirs()) }

    data class Summary(val fileName:String,val revision:Long,val dbVersion:Int,val byteCount:Int,val createdAtUtc:String)

    /** The only plaintext SQLite temporary is in the app-private cache and is deleted in finally. */
    fun createEncrypted(passphrase:CharArray):ByteArray = synchronized(gate) {
        val scratch=File(tempDir,"snapshot-${UUID.randomUUID()}.db")
        try {
            require(passphrase.size>=12){"BACKUP_PASSPHRASE_TOO_SHORT"}
            val db=helper.writableDatabase
            require(!db.inTransaction()){"Q02_BACKUP_DURING_TRANSACTION"}
            db.execSQL("VACUUM INTO ?",arrayOf(scratch.absolutePath))
            require(scratch.isFile && scratch.length()>0 && scratch.length()<=MAX_DB){"Q02_SNAPSHOT_SIZE_INVALID"}
            val snapshot=scratch.readBytes()
            try {
                val v=SQLiteDatabase.openDatabase(scratch.absolutePath,null,SQLiteDatabase.OPEN_READONLY)
                val meta=try {
                    quickCheck(v)
                    val schema=version(v)
                    require(schema==7) {"Q02_SOURCE_SCHEMA_UNSUPPORTED"}
                    JSONObject().put("format","GPV3-ENCRYPTED-SQLITE").put("formatVersion",FORMAT)
                        .put("app","org.glukopapa.v3.m00").put("createdAtUtc",Instant.now().toString())
                        .put("revision",revision(v)).put("sqliteUserVersion",schema)
                        .put("schemaFingerprint",schemaFingerprint(v))
                        .put("sqliteBytes",snapshot.size).put("sqliteSha256",digest(snapshot))
                        .put("method","SQLITE_VACUUM_INTO_WAL_SAFE")
                } finally {v.close()}
                val manifest=meta.toString().toByteArray(Charsets.UTF_8)
                require(manifest.size in 2..MAX_MANIFEST){"Q02_MANIFEST_INVALID"}
                val payload=ByteBuffer.allocate(4+manifest.size+snapshot.size).order(ByteOrder.BIG_ENDIAN)
                    .putInt(manifest.size).put(manifest).put(snapshot).array()
                return@synchronized try{GfV3BackupCodec.encrypt(payload,passphrase)}finally{payload.fill(0)}
            } finally{snapshot.fill(0)}
        } finally {if(scratch.exists()) check(scratch.delete()) {"Q02_TEMP_ERASE_FAILED"}}
    }

    fun createLocalEncrypted(passphrase:CharArray):Summary = synchronized(gate) {
        val name=NAME_PREFIX+UUID.randomUUID()+NAME_SUFFIX
        val target=File(backupDir,name)
        val tmp=File(backupDir,".$name.partial")
        val encrypted=createEncrypted(passphrase)
        try {
            FileOutputStream(tmp).use { it.write(encrypted);it.fd.sync() }
            check(tmp.renameTo(target)) {"Q02_FINALIZE_FAILED"}
            val details=inspectEncrypted(encrypted,passphrase)
            return@synchronized Summary(name,details.revision,details.dbVersion,target.length().toInt(),details.createdAtUtc)
        } finally {
            encrypted.fill(0)
            if(tmp.exists())tmp.delete()
        }
    }

    fun listLocalEncrypted():List<String> = synchronized(gate) {
        (backupDir.listFiles()?:emptyArray()).filter{it.isFile && it.name.matches(Regex("^GlukoPapa-V3-[0-9a-f-]{36}\\.gpv3$"))}
            .sortedByDescending{it.lastModified()}.map{it.name}
    }

    fun restoreLocalEncrypted(fileName:String,passphrase:CharArray,expectedCurrentRevision:Long):Summary {
        requireValidFilename(fileName)
        val file=File(backupDir,fileName)
        require(file.isFile && file.length() in 1..(MAX_DB+MAX_MANIFEST+512).toLong()){"Q02_BACKUP_FILE_INVALID"}
        return restoreEncrypted(file.readBytes(),passphrase,expectedCurrentRevision,fileName)
    }

    /** Read-only decrypt/verify: no impact on current database (e.g. wrong passphrase). */
    fun inspectEncrypted(envelope:ByteArray,passphrase:CharArray):Summary = synchronized(gate) {
        val decoded=decode(envelope,passphrase)
        try {return@synchronized Summary("",decoded.manifest.getLong("revision"),decoded.manifest.getInt("sqliteUserVersion"),envelope.size,decoded.manifest.getString("createdAtUtc"))}
        finally{decoded.bytes.fill(0)}
    }

    private data class Decoded(val manifest:JSONObject,val bytes:ByteArray)
    private fun decode(envelope:ByteArray,passphrase:CharArray):Decoded {
        val clear=GfV3BackupCodec.decrypt(envelope,passphrase)
        try {
            require(clear.size>=4+16){"Q02_CONTAINER_TRUNCATED"}
            val n=ByteBuffer.wrap(clear,0,4).order(ByteOrder.BIG_ENDIAN).int
            require(n in 2..MAX_MANIFEST && clear.size>=4+n+16){"Q02_MANIFEST_LENGTH_INVALID"}
            val metadata=JSONObject(String(clear,4,n,Charsets.UTF_8))
            require(metadata.getString("format")=="GPV3-ENCRYPTED-SQLITE" && metadata.getInt("formatVersion")==FORMAT) {"Q02_FORMAT_UNSUPPORTED"}
            require(metadata.getString("app")=="org.glukopapa.v3.m00") {"Q02_WRONG_APPLICATION"}
            val size=clear.size-4-n
            require(size in 1..MAX_DB && metadata.getInt("sqliteBytes")==size) {"Q02_DB_SIZE_INVALID"}
            val bytes=clear.copyOfRange(4+n,clear.size)
            try {
                require(bytes.copyOfRange(0,16).contentEquals("SQLite format 3\u0000".toByteArray(Charsets.US_ASCII))) {"Q02_NOT_SQLITE"}
                require(metadata.getString("sqliteSha256")==digest(bytes)) {"Q02_DB_DIGEST_MISMATCH"}
                return Decoded(metadata,bytes)
            } catch(e:Exception){bytes.fill(0);throw e}
        } finally {clear.fill(0)}
    }

    /** A single SQLite transaction changes all module tables together or none at all.
     * Existing schema must match the verified backup; newer future schema versions must
     * introduce an explicit, separately audited migration rather than silently drop data.
     */
    fun restoreEncrypted(envelope:ByteArray,passphrase:CharArray,expectedCurrentRevision:Long,fileName:String=""):Summary = synchronized(gate) {
        val d=decode(envelope,passphrase)
        val stage=File(tempDir,"restore-${UUID.randomUUID()}.db")
        try {
            FileOutputStream(stage).use {it.write(d.bytes);it.fd.sync()}
            val source=SQLiteDatabase.openDatabase(stage.absolutePath,null,SQLiteDatabase.OPEN_READONLY)
            try {
                quickCheck(source)
                require(version(source)==d.manifest.getInt("sqliteUserVersion") && version(source)==7) {"Q02_SCHEMA_UNSUPPORTED"}
                require(schemaFingerprint(source)==d.manifest.getString("schemaFingerprint")) {"Q02_SCHEMA_MANIFEST_MISMATCH"}
                require(revision(source)==d.manifest.getLong("revision")) {"Q02_REVISION_MANIFEST_MISMATCH"}
                val db=helper.writableDatabase
                require(!db.inTransaction()) {"Q02_RESTORE_DURING_TRANSACTION"}
                require(revision(db)==expectedCurrentRevision) {"Q02_CURRENT_REVISION_CONFLICT"}
                require(version(db)==version(source) && schemaFingerprint(db)==schemaFingerprint(source)) {"Q02_CURRENT_SCHEMA_MISMATCH"}
                val mainTables=tableNames(db)
                require(mainTables==tableNames(source)) {"Q02_TABLE_SET_MISMATCH"}
                // PRAGMA foreign_keys must be changed before beginTransaction.
                val oldFk=db.isForeignKeyConstraintsEnabled
                db.setForeignKeyConstraintsEnabled(false)
                var attached=false
                try {
                    db.execSQL("ATTACH DATABASE ${quoted(stage.absolutePath)} AS q02source")
                    attached=true
                    require(schemaFingerprint(db)==schemaFingerprint(db,"q02source")) {"Q02_ATTACHED_SCHEMA_MISMATCH"}
                    db.beginTransaction()
                    try {
                        for(name in mainTables){
                            require(Regex("^[A-Za-z0-9_]+$").matches(name)) {"Q02_TABLE_NAME_INVALID"}
                            db.execSQL("DELETE FROM \"$name\"")
                            db.execSQL("INSERT INTO \"$name\" SELECT * FROM q02source.\"$name\"")
                        }
                        // sqlite_sequence is maintained when AUTOINCREMENT rows are reinserted;
                        // explicitly preserve counters that exceed MAX(pk).
                        val mainSeq=db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",null).use{it.moveToFirst()}
                        if(mainSeq){
                            db.execSQL("DELETE FROM main.sqlite_sequence")
                            db.execSQL("INSERT INTO main.sqlite_sequence(name,seq) SELECT name,seq FROM q02source.sqlite_sequence")
                        }
                        require(revision(db)==d.manifest.getLong("revision")) {"Q02_RESTORED_REVISION_MISMATCH"}
                        val fkErrors=db.rawQuery("PRAGMA foreign_key_check",null).use{it.count}
                        require(fkErrors==0){"Q02_FOREIGN_KEYS_INVALID"}
                        db.setTransactionSuccessful()
                    } finally {db.endTransaction()}
                } finally {
                    if(attached)db.execSQL("DETACH DATABASE q02source")
                    db.setForeignKeyConstraintsEnabled(oldFk)
                }
                return@synchronized Summary(fileName,d.manifest.getLong("revision"),d.manifest.getInt("sqliteUserVersion"),envelope.size,d.manifest.getString("createdAtUtc"))
            } finally {source.close()}
        } finally {
            d.bytes.fill(0)
            if(stage.exists())check(stage.delete()) {"Q02_TEMP_ERASE_FAILED"}
        }
    }
}
