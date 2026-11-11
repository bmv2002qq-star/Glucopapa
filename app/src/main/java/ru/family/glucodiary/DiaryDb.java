package ru.family.glucodiary;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.ContentValues;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Local-only store. No treatment recommendations are computed or stored. */
final class DiaryDb extends SQLiteOpenHelper {
    private final Context context;
    DiaryDb(Context c) { super(c, "glucofamily.db", null, 6); context = c.getApplicationContext(); }
    @Override public void onCreate(SQLiteDatabase d) {
        d.execSQL("CREATE TABLE food(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE, category TEXT NOT NULL, protein REAL NOT NULL, fat REAL NOT NULL, carbs REAL NOT NULL, kcal REAL NOT NULL, fiber REAL, source TEXT NOT NULL, code TEXT DEFAULT '')");
        d.execSQL("CREATE UNIQUE INDEX food_unique ON food(name,source)");
        d.execSQL("CREATE TABLE event(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT DEFAULT '', grams REAL DEFAULT 0, carbs REAL DEFAULT 0, protein REAL DEFAULT 0, fat REAL DEFAULT 0, kcal REAL DEFAULT 0, units REAL DEFAULT 0, insulinName TEXT DEFAULT '', note TEXT DEFAULT '', itemsJson TEXT DEFAULT '', status TEXT DEFAULT 'eaten', insulinType TEXT DEFAULT '', editHistory TEXT DEFAULT '[]', level TEXT DEFAULT '', durationMinutes REAL DEFAULT 0, carbType TEXT DEFAULT 'mixed', activityLevel TEXT DEFAULT '', fiber REAL, site TEXT DEFAULT '')");
        d.execSQL("CREATE INDEX event_timestamp ON event(ts)");
        d.execSQL("CREATE TABLE glucose(ts INTEGER PRIMARY KEY, mmol REAL NOT NULL, direction TEXT DEFAULT '', source TEXT DEFAULT 'xDrip+')");
        d.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        loadSeed(d);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE event ADD COLUMN itemsJson TEXT DEFAULT ''");
            db.execSQL("ALTER TABLE event ADD COLUMN status TEXT DEFAULT 'eaten'");
            db.execSQL("ALTER TABLE event ADD COLUMN insulinType TEXT DEFAULT ''");
        }
        if (oldVersion < 3) db.execSQL("ALTER TABLE event ADD COLUMN editHistory TEXT DEFAULT '[]'");
        if (oldVersion < 4) {
            db.execSQL("ALTER TABLE event ADD COLUMN level TEXT DEFAULT ''");
            db.execSQL("ALTER TABLE event ADD COLUMN durationMinutes REAL DEFAULT 0");
        }
        if (oldVersion < 5) {
            db.execSQL("ALTER TABLE event ADD COLUMN carbType TEXT DEFAULT 'mixed'");
            db.execSQL("ALTER TABLE event ADD COLUMN activityLevel TEXT DEFAULT ''");
            // Insert new catalog items without overwriting user additions or deleting history.
            loadSeed(db);
        }
        if (oldVersion < 6) {
            db.execSQL("ALTER TABLE food ADD COLUMN fiber REAL");
            db.execSQL("ALTER TABLE event ADD COLUMN fiber REAL");
            db.execSQL("ALTER TABLE event ADD COLUMN site TEXT DEFAULT ''");
            loadSeed(db);
        }
    }
    private void loadSeed(SQLiteDatabase db) {
        try (InputStream stream=context.getAssets().open("foods_seed.json")) {
            byte[] bytes = new byte[stream.available()]; int read=0; while (read<bytes.length) { int k=stream.read(bytes,read,bytes.length-read); if(k<0)break;read+=k; }
            JSONArray items=new JSONArray(new String(bytes,StandardCharsets.UTF_8));
            for(int i=0;i<items.length();i++) insertFood(db,items.getJSONObject(i));
        } catch(Exception e) { android.util.Log.e("GlucoFamily","Seed import failed",e); }
    }
    private long insertFood(SQLiteDatabase db, JSONObject obj) {
        ContentValues v=new ContentValues();
        v.put("name",obj.optString("name"));v.put("category",obj.optString("category","Другое"));
        v.put("protein",obj.optDouble("protein"));v.put("fat",obj.optDouble("fat"));
        v.put("carbs",obj.optDouble("carbs"));v.put("kcal",obj.optDouble("kcal"));
        if(obj.has("fiber")&&!obj.isNull("fiber"))v.put("fiber",obj.optDouble("fiber"));v.put("source",obj.optString("source","Источник не указан"));v.put("code",obj.optString("code",""));
        long result=db.insertWithOnConflict("food",null,v,SQLiteDatabase.CONFLICT_IGNORE);
        if (result==-1 && obj.has("fiber") && !obj.isNull("fiber")) {
            ContentValues fiber=new ContentValues();fiber.put("fiber",obj.optDouble("fiber"));
            db.update("food",fiber,"name=? AND source=? AND fiber IS NULL",new String[]{obj.optString("name"),obj.optString("source","Источник не указан")});
        }
        return result;
    }
    synchronized long addFood(JSONObject food) {
        if (!foodValidation(food)) return -1;
        return insertFood(getWritableDatabase(),food);
    }
    static boolean foodValidation(JSONObject x) {
        if (x.optString("name").trim().length()<2) return false;
        for (String k:new String[]{"carbs","protein","fat"}) if(!Double.isFinite(x.optDouble(k,Double.NaN))||x.optDouble(k)<0||x.optDouble(k)>100)return false;
        double kcal=x.optDouble("kcal",Double.NaN);
        return Double.isFinite(kcal)&&kcal>=0&&kcal<=900;
    }
    synchronized long addEvent(JSONObject e) {
        String type=e.optString("type"); if(!type.equals("meal")&&!type.equals("insulin")&&!type.equals("note")&&!type.equals("activity"))return -1;
        long ts=e.optLong("ts");if(ts<946684800000L||ts>System.currentTimeMillis()+(type.equals("meal")&&e.optString("status").equals("planned")?7L*86400000L:600000L))return -1;
        if(type.equals("activity") && (!isActivityLevel(e.optString("level")) || !Double.isFinite(e.optDouble("durationMinutes",Double.NaN)) || e.optDouble("durationMinutes")<1 || e.optDouble("durationMinutes")>720))return -1;
        if(type.equals("insulin") && (e.optDouble("units")<=0 || e.optDouble("units")>100 || e.optString("insulinName").isEmpty()))return -1;
        if(type.equals("meal") &&(e.optDouble("grams")<=0||e.optDouble("grams")>5000))return -1;
        ContentValues v=new ContentValues();for(String k:new String[]{"type","name","insulinName","note","itemsJson","status","insulinType","editHistory","level","carbType","activityLevel","site"})v.put(k,e.optString(k,""));
        for(String k:new String[]{"grams","carbs","protein","fat","kcal","units"})v.put(k,e.optDouble(k,0));v.put("ts",ts);
        if(e.has("fiber")&&!e.isNull("fiber"))v.put("fiber",e.optDouble("fiber"));
        v.put("durationMinutes",e.optDouble("durationMinutes",0));
        return getWritableDatabase().insert("event",null,v);
    }
    private static boolean isActivityLevel(String x) {return "Спокойный".equals(x)||"Активный".equals(x)||"Спорт".equals(x);}
    /** Parent-initiated correction of an existing fact, with an audit trail. No insulin dose is calculated. */
    synchronized boolean updateEvent(long id, JSONObject e) {
        if (id<=0 || e==null) return false;
        SQLiteDatabase db=getWritableDatabase();
        String originalType;
        try(Cursor c=db.rawQuery("SELECT type FROM event WHERE id=?",new String[]{Long.toString(id)})){
            if(!c.moveToFirst())return false;
            originalType=c.getString(0);
        }
        if(!originalType.equals(e.optString("type")))return false;
        String t=e.optString("type");
        String status=e.optString("status","eaten");
        if(t.equals("meal")&&!status.equals("planned")&&!status.equals("eaten")&&!status.equals("started"))return false;
        long ts=e.optLong("ts",0), now=System.currentTimeMillis();
        long future=(t.equals("meal")&&status.equals("planned"))?7L*86400000L:600000L;
        if(ts<946684800000L || ts>now+future)return false;
        ContentValues v=new ContentValues();v.put("ts",ts);
        if(t.equals("insulin")){
            String name=e.optString("insulinName", "").trim();
            String kind=e.optString("insulinType", "");
            double units=e.optDouble("units",Double.NaN);
            if(name.isEmpty()||name.length()>100||!kind.equals("short")&&!kind.equals("long")||!Double.isFinite(units)||units<=0||units>100)return false;
            v.put("insulinName",name);v.put("insulinType",kind);v.put("units",units);v.put("site",e.optString("site", ""));
        }else if(t.equals("meal")){
            for(String key:new String[]{"grams","carbs","protein","fat","kcal"}){
                double number=e.optDouble(key,Double.NaN);
                if(!Double.isFinite(number)||number<0||number>100000)return false;
                v.put(key,number);
            }
            if(e.optDouble("grams",0)<=0||e.optDouble("grams")>5000)return false;
            String items=e.optString("itemsJson", "[]");
            try { if(new JSONArray(items).length()>40)return false; } catch(Exception invalid){return false;}
            v.put("itemsJson",items);v.put("name",e.optString("name", "").substring(0,Math.min(180,e.optString("name","").length())));
            v.put("status",status);if(e.has("fiber")){if(e.isNull("fiber"))v.putNull("fiber");else v.put("fiber",e.optDouble("fiber"));}v.put("carbType",e.optString("carbType","mixed"));v.put("activityLevel",e.optString("activityLevel",""));v.put("note",e.optString("note","").substring(0,Math.min(1000,e.optString("note","").length())));
        }else if(t.equals("note")){
            String note=e.optString("note", "");
            if(note.length()>1000)return false;
            v.put("note",note);
        }else return false;
        // The audit list contains earlier values/reasons; it must stay present after every change.
        String history=e.optString("editHistory","");
        try{JSONArray log=new JSONArray(history);if(log.length()<1||log.length()>20)return false;}
        catch(Exception invalid){return false;}
        v.put("editHistory",history);
        return db.update("event",v,"id=?",new String[]{Long.toString(id)})==1;
    }
    synchronized void removeEvent(long id){getWritableDatabase().delete("event","id=?",new String[]{Long.toString(id)});}
    synchronized void setIll(boolean ill){set("ill",ill?"true":"false");set("illSince",ill?Long.toString(System.currentTimeMillis()):"0");}
    synchronized void set(String k,String val){ContentValues v=new ContentValues();v.put("key",k);v.put("value",val);getWritableDatabase().insertWithOnConflict("settings",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    synchronized String get(String k){try(Cursor c=getReadableDatabase().rawQuery("SELECT value FROM settings WHERE key=?",new String[]{k})){return c.moveToFirst()?c.getString(0):"";}}
    synchronized void addReading(long timestamp,double mmol,String direction){
        if(timestamp<946684800000L||timestamp>System.currentTimeMillis()+120000L||!Double.isFinite(mmol)||mmol<1||mmol>35)return;
        ContentValues v=new ContentValues();v.put("ts",timestamp);v.put("mmol",mmol);v.put("direction",direction);v.put("source","xDrip+");
        getWritableDatabase().insertWithOnConflict("glucose",null,v,SQLiteDatabase.CONFLICT_REPLACE);
        getWritableDatabase().execSQL("DELETE FROM glucose WHERE ts<?",new Object[]{System.currentTimeMillis()-93L*86400000L});
    }
    synchronized JSONObject getSnapshot(){
        JSONObject root=new JSONObject();try {
            root.put("foods",query("SELECT * FROM food ORDER BY name COLLATE NOCASE LIMIT 2600"));
            root.put("events",query("SELECT * FROM event ORDER BY ts DESC LIMIT 4000"));
            root.put("readings",query("SELECT * FROM glucose ORDER BY ts DESC LIMIT 30000"));
            root.put("ill","true".equals(get("ill")));root.put("illSince",num(get("illSince")));
            root.put("lastSync",num(get("lastSync")));
            root.put("glucoseInfo",get("glucoseInfo"));
            String profile = get("profile"); if(!profile.isEmpty())root.put("profile",new JSONObject(profile));
            String draft=get("draft");if(!draft.isEmpty()){
                JSONObject d=new JSONObject(draft);
                root.put("mealDraft",d.optJSONArray("mealDraft"));
                root.put("mealDraftTime",d.optString("mealDraftTime"));
            }
        } catch(Exception ignored){}return root;
    }
    private long num(String v){try{return Long.parseLong(v);}catch(Exception ignored){return 0;}}
    private JSONArray query(String sql){JSONArray arr=new JSONArray();try(Cursor c=getReadableDatabase().rawQuery(sql,null)){
        while(c.moveToNext()) {JSONObject row=new JSONObject();for(int i=0;i<c.getColumnCount();i++){
            String k=c.getColumnName(i);switch(c.getType(i)){
                case Cursor.FIELD_TYPE_INTEGER:row.put(k,c.getLong(i));break;
                case Cursor.FIELD_TYPE_FLOAT:row.put(k,c.getDouble(i));break;
                case Cursor.FIELD_TYPE_NULL:row.put(k,JSONObject.NULL);break;
                default:row.put(k,c.getString(i));}
        }arr.put(row);}
    }catch(Exception e){android.util.Log.e("GlucoFamily","Query failed",e);}return arr;}
    synchronized JSONObject glucoseNearest(long ts,long maxGap){
        try(Cursor c=getReadableDatabase().rawQuery(
            "SELECT ts,mmol,direction FROM glucose WHERE ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1",
            new String[]{Long.toString(ts-maxGap),Long.toString(ts+maxGap),Long.toString(ts)})){
            if(c.moveToFirst())return new JSONObject().put("ts",c.getLong(0)).put("mmol",c.getDouble(1)).put("direction",c.getString(2));
        }catch(Exception ignored){}
        return new JSONObject();
    }
    synchronized JSONArray eventsForPeriod(long startTs,long endTs){return query("SELECT * FROM event WHERE ts >= "+startTs+" AND ts < "+endTs+" ORDER BY ts ASC LIMIT 3000");}
    synchronized JSONArray eventsForReport(long minTs){return query("SELECT * FROM event WHERE ts>"+minTs+" ORDER BY ts ASC LIMIT 3000");}
    synchronized JSONArray glucoseForReport(long minTs){return query("SELECT * FROM glucose WHERE ts>"+minTs+" ORDER BY ts ASC LIMIT 10000");}
    synchronized int countFoods(){try(Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM food",null)){return c.moveToFirst()?c.getInt(0):0;}}
}
