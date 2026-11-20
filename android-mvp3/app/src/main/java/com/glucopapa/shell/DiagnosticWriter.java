package com.glucopapa.shell;

import android.webkit.JavascriptInterface;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/** Keeps trace I/O off the WebView bridge and the SQLite transaction. */
final class DiagnosticWriter {
    private static final Set<String> KINDS = new java.util.HashSet<>(java.util.Arrays.asList(
        "storage_commit", "forecast_attempt", "basal_review", "app_error", "cgm_rejected"));
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(128));
    private final DiagnosticRing ring;
    private volatile String status = "OK";

    DiagnosticWriter(DiagnosticRing ring) {
        this.ring = ring;
    }

    @JavascriptInterface public void record(String mode, String json) {
        if (!GFNativeStorage.acceptsMode(mode) || json == null || json.length() > 16_384) return;
        long at = System.currentTimeMillis();
        try {
            JSONObject event = new JSONObject(json);
            if (!KINDS.contains(event.optString("operation")) || event.optLong("sourceRevision", -1) < 0) return;
            worker.execute(() -> {
                try {
                    ring.append(mode, at, event);
                } catch (Exception failure) {
                    status = "TRACE_WRITE_FAILED";
                }
            });
        } catch (JSONException | java.util.concurrent.RejectedExecutionException failure) {
            status = "TRACE_QUEUE_FAILED";
        }
    }

    @JavascriptInterface public String status() {
        return status;
    }

    String flushStatus() {
        try {
            worker.submit(() -> {}).get(5, TimeUnit.SECONDS);
            return status;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return "TRACE_READ_INCOMPLETE";
        } catch (Exception unavailable) {
            return "TRACE_READ_INCOMPLETE";
        }
    }

    void close() {
        worker.shutdown();
    }
}
