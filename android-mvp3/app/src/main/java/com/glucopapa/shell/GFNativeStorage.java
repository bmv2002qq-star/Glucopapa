package com.glucopapa.shell;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.ContentValues;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;

/**
 * Experimental app-private SQLite implementation of the GFStorage snapshot driver.
 * Every write checks the persisted revision and replaces the snapshot in one
 * transaction. This is not a clinically validated medical-record database.
 * The JavaScript GFStorage schema v5 remains the authoritative data validator.
 */
public final class GFNativeStorage extends SQLiteOpenHelper {
    private static final String DB_NAME = "gfstorage_v5.db";
    private static final int DB_VERSION = 1; // SQLite infrastructure, NOT GFStorage schema
    private static final int MAX_JSON_CHARS = 10_000_000;
    private static final String TABLE = "snapshots";

    public GFNativeStorage(Context context) { super(context, DB_NAME, null, DB_VERSION); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE snapshots (mode_key TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        // Deliberately fail closed: never drop or replace user records on upgrade.
        throw new IllegalStateException("MIGRATION_REQUIRED: native database migration not implemented");
    }

    private static void checkKey(String key) {
        if (!"GFV2SHELL_DATA_v1_demo".equals(key) && !"GFV2SHELL_DATA_v1_local".equals(key))
            throw new IllegalArgumentException("DENIED_MODE_KEY");
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
    @JavascriptInterface public synchronized String readSnapshot(String key) {
        try {
            checkKey(key);
            SQLiteDatabase db = getReadableDatabase();
            try (Cursor c = db.query(TABLE,new String[]{"revision","data"},"mode_key=?",new String[]{key},null,null,null)) {
                if (!c.moveToFirst()) return reply(true,"ABSENT",null,-1);
                return reply(true,"FOUND",c.getString(1),c.getInt(0));
            }
        } catch (Exception e) { return reply(false,"READ_FAILED",null,-1); }
    }
    @JavascriptInterface public synchronized String importIfAbsent(String key,String json) {
        try {
            checkKey(key);
            JSONObject value=checked(json);
            int incoming=value.getInt("revision");
            SQLiteDatabase db=getWritableDatabase();
            db.beginTransaction();
            try {
                if(currentRevision(db,key)>=0) { db.setTransactionSuccessful();return reply(true,"EXISTS",null,-1); }
                ContentValues row=new ContentValues();
                row.put("mode_key",key);row.put("revision",incoming);row.put("data",json);
                if(db.insertOrThrow(TABLE,null,row)<0) return reply(false,"IMPORT_FAILED",null,-1);
                db.setTransactionSuccessful();
                return reply(true,"IMPORTED",null,incoming);
            } finally { db.endTransaction(); }
        } catch (Exception e) { return reply(false,"IMPORT_FAILED",null,-1); }
    }
    @JavascriptInterface public synchronized String writeIfRevision(String key,String json,int expectedRevision) {
        try {
            checkKey(key);
            JSONObject obj=checked(json);
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
                values.put("mode_key",key);values.put("revision",obj.getInt("revision"));values.put("data",json);
                if(db.insertWithOnConflict(TABLE,null,values,SQLiteDatabase.CONFLICT_REPLACE)<0)
                    return reply(false,"WRITE_FAILED",null,-1);
                db.setTransactionSuccessful();
                return reply(true,"SAVED",null,obj.getInt("revision"));
            } finally { db.endTransaction(); }
        } catch (Exception e) { return reply(false,"WRITE_FAILED",null,-1); }
    }
}
