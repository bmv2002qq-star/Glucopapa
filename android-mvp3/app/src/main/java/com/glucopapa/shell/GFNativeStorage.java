package com.glucopapa.shell;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.ContentValues;
import android.webkit.JavascriptInterface;
import android.content.res.AssetManager;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import org.json.JSONObject;

/**
 * Experimental app-private SQLite implementation of the GFStorage snapshot driver.
 * Every write checks the persisted revision and replaces the snapshot in one
 * transaction. This is not a clinically validated medical-record database.
 * The JavaScript GFStorage schema v5 remains the authoritative data validator.
 */
public final class GFNativeStorage extends SQLiteOpenHelper {
    static final boolean RESEARCH_JOURNAL = "research".equals(BuildConfig.PRIVATE_SEED_SCOPE);
    private static final String DB_NAME = RESEARCH_JOURNAL ? "gfstorage_research_v5.db" : "gfstorage_v5.db";
    private static final int DB_VERSION = 2; // SQLite infrastructure, NOT GFStorage schema
    private static final int MAX_JSON_CHARS = 10_000_000;
    private static final String TABLE = "snapshots";
    private static final int CHUNK_CODEPOINTS = 65_536;

    private final AssetManager assets;

    public GFNativeStorage(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        assets = context.getAssets();
    }

    @JavascriptInterface public String seedScope() { return BuildConfig.PRIVATE_SEED_SCOPE; }

    @JavascriptInterface public String readPrivateSeed() {
        if ("none".equals(BuildConfig.PRIVATE_SEED_SCOPE)) return reply(true, "ABSENT", null, -1);
        try (InputStream input = assets.open("bootstrap/journal.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            for (int n; (n = input.read(buffer)) != -1;) {
                if (bytes.size() + n > MAX_JSON_CHARS) throw new IllegalStateException("PRIVATE_SEED_SIZE");
                bytes.write(buffer, 0, n);
            }
            String payload = bytes.toString(StandardCharsets.UTF_8.name());
            JSONObject value = checked(payload);
            checkProvenance(LOCAL_KEY, value);
            return reply(true, "FOUND", payload, value.getInt("revision"));
        } catch (Exception error) {
            return reply(false, "PRIVATE_SEED_READ_FAILED", null, -1);
        }
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE snapshots (mode_key TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, payload_sha256 TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        if (oldVersion != 1 || newVersion != 2) {
            throw new IllegalStateException("MIGRATION_REQUIRED: unknown native database version");
        }
        // SQLiteOpenHelper runs this migration inside the same transaction as user_version.
        db.execSQL("ALTER TABLE snapshots ADD COLUMN payload_sha256 TEXT");
        try (Cursor keys = db.query(TABLE, new String[]{"mode_key", "revision", "length(data)"},
                null, null, null, null, null)) {
            while (keys.moveToNext()) {
                String key = keys.getString(0);
                checkHistoricalKey(key);
                String payload = readChunks(db, key, keys.getInt(2));
                try {
                    if (checked(payload).getInt("revision") != keys.getInt(1)) {
                        throw new IllegalStateException("MIGRATION_REVISION_MISMATCH");
                    }
                } catch (Exception invalid) {
                    throw new IllegalStateException("MIGRATION_BAD_SNAPSHOT", invalid);
                }
                ContentValues update = new ContentValues();
                update.put("payload_sha256", digest(payload));
                if (db.update(TABLE, update, "mode_key=?", new String[]{key}) != 1) {
                    throw new IllegalStateException("MIGRATION_UPDATE_FAILED");
                }
            }
        }
    }

    private static final String LOCAL_KEY = "GFV2SHELL_DATA_v1_local";
    private static final String FIXTURE_KEY = "GFV2SHELL_DATA_v1_demo";

    static boolean acceptsMode(String mode) {
        return "local".equals(mode) || (BuildConfig.FIXTURE_JOURNAL && "demo".equals(mode));
    }
    private static void checkHistoricalKey(String key) {
        if (!LOCAL_KEY.equals(key) && !FIXTURE_KEY.equals(key))
            throw new IllegalArgumentException("DENIED_MODE_KEY");
    }
    private static void checkKey(String key) {
        if (!LOCAL_KEY.equals(key) && !(BuildConfig.FIXTURE_JOURNAL && FIXTURE_KEY.equals(key)))
            throw new IllegalArgumentException("DENIED_MODE_KEY");
    }
    private static void checkProvenance(String key, JSONObject snapshot) {
        if (!LOCAL_KEY.equals(key)) return;
        if (snapshot.has("privateHistory") != RESEARCH_JOURNAL)
            throw new IllegalArgumentException("DENIED_JOURNAL_SCOPE");
        JSONObject metadata = snapshot.optJSONObject("cgmMetadata");
        if (metadata != null && "synthetic".equals(metadata.optString("sourceType")))
            throw new IllegalArgumentException("DENIED_SYNTHETIC_SOURCE");
        org.json.JSONArray rows = snapshot.optJSONArray("cgm");
        if (rows == null) return;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && "synthetic".equals(row.optString("source")))
                throw new IllegalArgumentException("DENIED_SYNTHETIC_ROW");
        }
    }
    private static JSONObject checked(String json) throws Exception {
        if (json == null || json.length() < 20 || json.length() > MAX_JSON_CHARS)
            throw new IllegalArgumentException("INVALID_SNAPSHOT_SIZE");
        JSONObject object = new JSONObject(json);
        if (object.getInt("schemaVersion") != 5) throw new IllegalArgumentException("SCHEMA_MISMATCH");
        int rev = object.getInt("revision");
        if (rev < 0) throw new IllegalArgumentException("INVALID_REVISION");
        return object;
    }
    private static String reply(boolean ok,String code,String data,int revision) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok",ok);o.put("code",code);
            if (data != null) o.put("data",data);
            if (revision >= 0) o.put("revision",revision);
            return o.toString();
        } catch (Exception e) { return "{\"ok\":false,\"code\":\"ENCODING_FAILED\"}"; }
    }
    private static int currentRevision(SQLiteDatabase db,String key) {
        try(Cursor c=db.query(TABLE,new String[]{"revision"},"mode_key=?",new String[]{key},null,null,null)) {
            return c.moveToFirst()?c.getInt(0):-1;
        }
    }
    private static String readChunks(SQLiteDatabase db, String key, int count) {
        if (count <= 0 || count > MAX_JSON_CHARS) throw new IllegalStateException("INVALID_SNAPSHOT_SIZE");
        StringBuilder payload = new StringBuilder(count);
        for (int offset = 1; offset <= count; offset += CHUNK_CODEPOINTS) {
            try (Cursor chunk = db.rawQuery("SELECT substr(data, ?, ?) FROM snapshots WHERE mode_key=?",
                    new String[]{Integer.toString(offset), Integer.toString(CHUNK_CODEPOINTS), key})) {
                if (!chunk.moveToFirst()) throw new IllegalStateException("SNAPSHOT_CHUNK_MISSING");
                payload.append(chunk.getString(0));
            }
        }
        if (payload.length() > MAX_JSON_CHARS) throw new IllegalStateException("INVALID_SNAPSHOT_SIZE");
        return payload.toString();
    }

    private static String digest(String data) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(64);
            for (byte value : hash) {
                hex.append(Character.forDigit((value & 0xff) >>> 4, 16));
                hex.append(Character.forDigit(value & 15, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    @JavascriptInterface public synchronized String readSnapshot(String key) {
        try {
            checkKey(key);
            SQLiteDatabase db = getReadableDatabase();
            db.beginTransactionNonExclusive();
            try (Cursor cursor = db.query(TABLE, new String[]{"revision", "payload_sha256", "length(data)"},
                    "mode_key=?", new String[]{key}, null, null, null)) {
                String result;
                if (!cursor.moveToFirst()) {
                    result = reply(true, "ABSENT", null, -1);
                } else {
                    // A full TEXT value can exceed Android CursorWindow even when SQLite stored it successfully.
                    String payload = readChunks(db, key, cursor.getInt(2));
                    result = digest(payload).equals(cursor.getString(1))
                        ? reply(true, "FOUND", payload, cursor.getInt(0))
                        : reply(false, "SNAPSHOT_CHECKSUM_MISMATCH", null, -1);
                }
                db.setTransactionSuccessful();
                return result;
            } finally {
                db.endTransaction();
            }
        } catch (Exception error) {
            return reply(false, "READ_FAILED", null, -1);
        }
    }
    @JavascriptInterface public synchronized String importIfAbsent(String key,String json) {
        try {
            checkKey(key);
            JSONObject value=checked(json);
            checkProvenance(key,value);
            int incoming=value.getInt("revision");
            SQLiteDatabase db=getWritableDatabase();
            db.beginTransaction();
            try {
                if(currentRevision(db,key)>=0) { db.setTransactionSuccessful();return reply(true,"EXISTS",null,-1); }
                ContentValues row=new ContentValues();
                row.put("mode_key",key);row.put("revision",incoming);row.put("data",json);row.put("payload_sha256",digest(json));
                if(db.insertOrThrow(TABLE,null,row)<0) return reply(false,"IMPORT_FAILED",null,-1);
                db.setTransactionSuccessful();
                return reply(true,"IMPORTED",null,incoming);
            } finally { db.endTransaction(); }
        } catch (Exception e) { return reply(false,"IMPORT_FAILED",null,-1); }
    }

    @JavascriptInterface public synchronized String restoreOverPrivateSeed(String key, String json) {
        if (!LOCAL_KEY.equals(key) || !"main".equals(BuildConfig.PRIVATE_SEED_SCOPE))
            return reply(false, "DENIED_JOURNAL_SCOPE", null, -1);
        try {
            JSONObject incoming = checked(json);
            checkProvenance(key,incoming);
            JSONObject seed = new JSONObject(readPrivateSeed());
            if (!seed.optBoolean("ok") || !"FOUND".equals(seed.optString("code")))
                return reply(false, "PRIVATE_SEED_READ_FAILED", null, -1);
            int revision = incoming.getInt("revision");
            ContentValues row = new ContentValues();
            row.put("revision", revision);
            row.put("data", json);
            row.put("payload_sha256", digest(json));
            SQLiteDatabase db = getWritableDatabase();
            // The digest in the UPDATE is the compare-and-swap condition, under SQLite's write lock.
            int replaced = db.update(TABLE, row, "mode_key=? AND revision=? AND payload_sha256=?",
                new String[]{key, Integer.toString(seed.getInt("revision")), digest(seed.getString("data"))});
            return replaced == 1 ? reply(true, "IMPORTED", null, revision) : reply(true, "EXISTS", null, -1);
        } catch (Exception error) {
            return reply(false, "IMPORT_FAILED", null, -1);
        }
    }
    @JavascriptInterface public synchronized String writeIfRevision(String key,String json,int expectedRevision) {
        try {
            checkKey(key);
            JSONObject obj=checked(json);
            checkProvenance(key,obj);
            if(expectedRevision<0||obj.getInt("revision")!=expectedRevision+1)
                return reply(false,"INVALID_REVISION_TRANSITION",null,-1);
            SQLiteDatabase db=getWritableDatabase();
            db.beginTransaction();
            try {
                int persisted=currentRevision(db,key);
                if(persisted!=expectedRevision && !(persisted==-1&&expectedRevision==0))
                    return reply(false,"STALE_REVISION",null,persisted);
                if(persisted==-1 && expectedRevision!=0)
                    return reply(false,"MISSING_RECORD",null,-1);
                ContentValues values=new ContentValues();
                values.put("mode_key",key);values.put("revision",obj.getInt("revision"));values.put("data",json);values.put("payload_sha256",digest(json));
                if(db.insertWithOnConflict(TABLE,null,values,SQLiteDatabase.CONFLICT_REPLACE)<0)
                    return reply(false,"WRITE_FAILED",null,-1);
                db.setTransactionSuccessful();
                return reply(true,"SAVED",null,obj.getInt("revision"));
            } finally { db.endTransaction(); }
        } catch (Exception e) { return reply(false,"WRITE_FAILED",null,-1); }
    }
}
