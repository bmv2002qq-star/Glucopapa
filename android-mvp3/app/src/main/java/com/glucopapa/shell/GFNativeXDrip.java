package com.glucopapa.shell;

import android.content.ContentProviderClient;
import android.content.Context;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/** Read-only client of the xDrip+ Android provider. No intent receiver, network or journal of its own. */
public final class GFNativeXDrip implements AutoCloseable {
    private static final String PACKAGE = "com.eveningoutpost.dexdrip";
    private static final String AUTHORITY = PACKAGE + ".contentprovider";
    private static final Uri BG = Uri.parse("content://" + AUTHORITY + "/bg");
    private static final List<String> DIRECTIONS = Arrays.asList("DoubleUp", "SingleUp", "FortyFiveUp",
        "Flat", "FortyFiveDown", "SingleDown", "DoubleDown", "NOT_COMPUTABLE");
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private CancellationSignal active;
    private String result = response("READING");
    private boolean closed;

    GFNativeXDrip(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Return the previous query immediately. The content resolver must never block JavaScript. */
    @JavascriptInterface public synchronized String pollLatest() {
        if (closed) return response("UNAVAILABLE");
        String previous = result;
        if (active == null) {
            CancellationSignal request = new CancellationSignal();
            active = request;
            Runnable timeout = () -> {
                synchronized (this) {
                    if (active != request) return;
                    result = response("PROVIDER_TIMEOUT");
                }
                request.cancel();
            };
            main.postDelayed(timeout, 5000);
            worker.execute(() -> {
                String next = read(request);
                main.removeCallbacks(timeout);
                synchronized (this) {
                    if (!closed && !request.isCanceled()) result = next;
                    active = null;
                }
            });
        }
        return previous;
    }

    @JavascriptInterface public synchronized String peekLatest() {
        return closed ? response("UNAVAILABLE") : result;
    }

    private String read(CancellationSignal cancellation) {
        try {
            ProviderInfo info = context.getPackageManager().resolveContentProvider(AUTHORITY, 0);
            if (info == null) return response("NO_PROVIDER");
            if (!PACKAGE.equals(info.packageName)) return response("UNEXPECTED_PROVIDER");
            try (ContentProviderClient provider = context.getContentResolver().acquireUnstableContentProviderClient(BG)) {
                if (provider == null) return response("NO_PROVIDER");
                // The upstream provider uses the read-only selection "bg" for its latest display reading.
                try (Cursor cursor = provider.query(BG, null, "bg", null, null, cancellation)) {
                    if (cursor == null || !cursor.moveToFirst()) return response("NO_MEASUREMENT");
                    return readMeasurement(cursor, System.currentTimeMillis());
                }
            }
        } catch (Exception error) {
            return response("PROVIDER_READ_FAILED");
        }
    }

    static String readMeasurement(Cursor cursor, long receivedAt) throws JSONException {
        int timestamp = cursor.getColumnIndex("timestamp");
        int estimate = cursor.getColumnIndex("mgdl");
        if (timestamp < 0 || estimate < 0 || cursor.getType(timestamp) != Cursor.FIELD_TYPE_INTEGER
                || (cursor.getType(estimate) != Cursor.FIELD_TYPE_FLOAT
                    && cursor.getType(estimate) != Cursor.FIELD_TYPE_INTEGER)) {
            return response("INVALID_MEASUREMENT");
        }
        long measuredAt = cursor.getLong(timestamp);
        double mgdl = cursor.getDouble(estimate);
        if (measuredAt < 946684800000L || measuredAt > receivedAt || !Double.isFinite(mgdl) || mgdl <= 0) {
            return response("INVALID_MEASUREMENT");
        }
        JSONObject data = new JSONObject().put("status", "MEASUREMENT").put("measuredAtMs", measuredAt)
            .put("receivedAtMs", receivedAt).put("mgdl", mgdl);
        int trend = cursor.getColumnIndex("delta_name");
        String direction = trend >= 0 && cursor.getType(trend) == Cursor.FIELD_TYPE_STRING
            ? cursor.getString(trend) : null;
        data.put("direction", direction != null && DIRECTIONS.contains(direction) ? direction : JSONObject.NULL);
        int stale = cursor.getColumnIndex("isstale");
        int freshness = stale >= 0 && cursor.getType(stale) == Cursor.FIELD_TYPE_INTEGER ? cursor.getInt(stale) : -1;
        data.put("stale", freshness == 0 ? Boolean.FALSE : freshness == 1 ? Boolean.TRUE : JSONObject.NULL);
        return data.toString();
    }

    private static String response(String status) {
        return "{\"status\":\"" + status + "\"}";
    }

    @Override public synchronized void close() {
        closed = true;
        // A local provider may stall or ignore cancellation. Never wait on it on the activity thread.
        worker.shutdownNow();
    }
}
