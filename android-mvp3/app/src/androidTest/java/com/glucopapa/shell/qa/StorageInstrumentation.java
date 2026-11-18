package com.glucopapa.shell.qa;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import com.glucopapa.shell.GFNativeStorage;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

public final class StorageInstrumentation extends Instrumentation {
    private static final String DEMO = "GFV2SHELL_DATA_v1_demo";
    private static final String LOCAL = "GFV2SHELL_DATA_v1_local";
    private static final String DATABASE = "gfstorage_v5.db";
    private static final int EVENTS = 1000;
    private Bundle arguments;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        arguments = args;
        start();
    }

    @Override public void onStart() {
        Bundle output = new Bundle();
        try {
            check(Build.FINGERPRINT.contains("generic") || Build.HARDWARE.startsWith("ranchu"),
                "Expected an Android emulator");
            check("SYNTHETIC".equals(arguments.getString("fixture")), "Expected synthetic fixture");
            File directory = getTargetContext().getDir("synthetic-qa", Context.MODE_PRIVATE);
            Context testContext = isolatedContext(getTargetContext(), directory);
            String phase = arguments.getString("phase", "exercise");
            try (GFNativeStorage store = new GFNativeStorage(testContext)) {
                switch (phase) {
                    case "exercise": exercise(store, directory, getTargetContext()); break;
                    case "interrupt": interrupt(store); break;
                    case "reopen": reopen(store); break;
                    case "web":
                        output.putString("webview", new WebViewChecks(this).exercise("webview-qa.js", "").toString());
                        break;
                    case "stock":
                        String step = arguments.getString("step", "");
                        output.putString("webview", new WebViewChecks(this).exercise("stock-ui.js", step).toString());
                        if ("export".equals(step)) SystemClock.sleep(45_000);
                        break;
                    default: throw new IllegalArgumentException("Unknown phase");
                }
            }
            output.putString("stream", "\nQA_PASS " + phase + "\n");
            finish(Activity.RESULT_OK, output);
        } catch (Exception error) {
            output.putString("stream", "\nQA_FAIL " + Log.getStackTraceString(error) + "\n");
            finish(Activity.RESULT_CANCELED, output);
        }
    }

    private static Context isolatedContext(Context context, File directory) {
        return new ContextWrapper(context) {
            @Override public File getDatabasePath(String name) {
                return new File(directory, name);
            }
        };
    }

    private static void exercise(GFNativeStorage store, File directory, Context context) throws Exception {
        checkCode(store.readSnapshot(DEMO), "ABSENT");
        checkCode(store.readSnapshot(LOCAL), "ABSENT");
        checkCode(store.readSnapshot("other"), "READ_FAILED");
        checkCode(store.importIfAbsent(DEMO, "{\"schemaVersion\":4,\"revision\":0}"), "IMPORT_FAILED");

        JSONObject snapshot = new JSONObject().put("schemaVersion", 5).put("fixture", "SYNTHETIC");
        JSONArray events = new JSONArray();
        snapshot.put("events", events).put("revision", 0);
        checkCode(store.importIfAbsent(DEMO, snapshot.toString()), "IMPORTED");
        checkCode(store.importIfAbsent(DEMO, snapshot.toString()), "EXISTS");

        long start = SystemClock.elapsedRealtime();
        for (int revision = 1; revision <= EVENTS; revision++) {
            events.put(new JSONObject().put("id", "synthetic-" + revision)
                .put("sequence", revision).put("kind", revision % 3));
            snapshot.put("revision", revision);
            checkCode(store.writeIfRevision(DEMO, snapshot.toString(), revision - 1), "SAVED");
            if (revision % 100 == 0) {
                checkCode(store.writeIfRevision(DEMO, snapshot.toString(), revision - 1), "STALE_REVISION");
            }
        }
        long elapsed = SystemClock.elapsedRealtime() - start;
        checkCode(store.writeIfRevision(DEMO, snapshot.toString(), EVENTS), "INVALID_REVISION_TRANSITION");
        checkCode(store.readSnapshot(LOCAL), "ABSENT");
        SQLiteDatabase db = store.getWritableDatabase();
        db.execSQL("CREATE TRIGGER qa_abort BEFORE INSERT ON snapshots "
            + "WHEN NEW.revision = 1001 BEGIN SELECT RAISE(ABORT, 'synthetic write error'); END");
        snapshot.put("revision", EVENTS + 1);
        checkCode(store.writeIfRevision(DEMO, snapshot.toString(), EVENTS), "WRITE_FAILED");
        db.execSQL("DROP TRIGGER qa_abort");
        try {
            store.onUpgrade(db, 1, 2);
            throw new IllegalStateException("Missing migration must fail closed");
        } catch (IllegalStateException error) {
            check(error.getMessage().startsWith("MIGRATION_REQUIRED"), "Unexpected upgrade result");
        }
        reopen(store);

        store.close();
        File backup = new File(directory, "synthetic-backup.db");
        Files.copy(new File(directory, DATABASE).toPath(), backup.toPath());
        try (SQLiteDatabase copy = SQLiteDatabase.openDatabase(backup.toString(), null, SQLiteDatabase.OPEN_READONLY)) {
            check("ok".equals(DatabaseUtils.stringForQuery(copy, "PRAGMA quick_check", null)),
                "Closed backup integrity");
            check(DatabaseUtils.longForQuery(copy, "SELECT revision FROM snapshots", null) == EVENTS,
                "Closed backup revision");
        }
        File restored = new File(directory, "restored");
        check(restored.mkdir(), "Test restore directory must be fresh");
        Files.copy(backup.toPath(), new File(restored, DATABASE).toPath());
        try (GFNativeStorage recovered = new GFNativeStorage(isolatedContext(context, restored))) {
            reopen(recovered);
        }
        Log.i("GlucoPapaQA", "1000 SQLite CAS commits took " + elapsed + " ms; isolated backup reopens");
    }

    private static void interrupt(GFNativeStorage store) throws Exception {
        SQLiteDatabase db = store.getWritableDatabase();
        db.beginTransaction();
        try {
            JSONObject staged = read(store).put("revision", EVENTS + 1);
            checkCode(store.writeIfRevision(DEMO, staged.toString(), EVENTS), "SAVED");
            Log.i("GlucoPapaQA", "QA_PENDING_TRANSACTION");
            SystemClock.sleep(45_000);
            throw new IllegalStateException("Expected ADB to terminate the pending transaction");
        } finally {
            db.endTransaction();
        }
    }

    private static void reopen(GFNativeStorage store) throws Exception {
        JSONObject snapshot = read(store);
        JSONArray events = snapshot.getJSONArray("events");
        check(snapshot.getInt("revision") == EVENTS && events.length() == EVENTS, "Lost or partial events");
        for (int i = 1; i <= EVENTS; i++) {
            JSONObject event = events.getJSONObject(i - 1);
            check(event.getInt("sequence") == i && ("synthetic-" + i).equals(event.getString("id")),
                "Event order or identity differs at " + i);
        }
        check("ok".equals(DatabaseUtils.stringForQuery(store.getReadableDatabase(), "PRAGMA integrity_check", null)),
            "SQLite integrity_check failed");
    }

    private static JSONObject read(GFNativeStorage store) throws Exception {
        JSONObject reply = checkCode(store.readSnapshot(DEMO), "FOUND");
        return new JSONObject(reply.getString("data"));
    }

    private static JSONObject checkCode(String raw, String expected) throws Exception {
        JSONObject reply = new JSONObject(raw);
        check(expected.equals(reply.getString("code")), "Expected " + expected + ", received " + reply.getString("code"));
        return reply;
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
