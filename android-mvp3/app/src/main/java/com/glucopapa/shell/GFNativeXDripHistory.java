package com.glucopapa.shell;

import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** One explicitly requested, history-only batch from the V1 loopback endpoint. */
public final class GFNativeXDripHistory implements AutoCloseable {
    private static final String ENDPOINT = "http://127.0.0.1:17580/sgv.json?count=288";
    private static final int MAX_ROWS = 288;
    private static final int MAX_BYTES = 256 * 1024;
    private static final int DEADLINE_MS = 4500;
    private static final long HISTORY_MS = TimeUnit.HOURS.toMillis(24);
    private static final long ANCHOR_RECEIPT_MS = TimeUnit.MINUTES.toMillis(1);
    private final GFNativeXDrip provider;
    private final BooleanSupplier enabled;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private String result;
    private boolean active;
    private boolean closed;
    private int generation;

    GFNativeXDripHistory(GFNativeXDrip provider, BooleanSupplier enabled) {
        this.provider = provider;
        this.enabled = enabled;
    }

    @JavascriptInterface public synchronized String request() {
        if (closed || !enabled.getAsBoolean()) return status("HISTORY_DISABLED");
        if (active) return status("HISTORY_BUSY");
        result = null;
        try {
            JSONObject anchor = new JSONObject(provider.peekLatest());
            if (!validAnchor(anchor, System.currentTimeMillis())) return status("HISTORY_NEEDS_PROVIDER");
            active = true;
            int requested = generation;
            worker.execute(() -> complete(anchor, requested));
            return status("HISTORY_FETCHING");
        } catch (JSONException invalid) {
            return status("HISTORY_NEEDS_PROVIDER");
        }
    }

    private void complete(JSONObject anchor, int requested) {
        String payload = status("HISTORY_UNAVAILABLE");
        try {
            payload = fetch(anchor, timer);
        } catch (RejectedExecutionException closing) {
            // The Activity closed before the connection timer was scheduled.
        } finally {
            synchronized (this) {
                if (!closed && generation == requested && enabled.getAsBoolean()) result = payload;
                active = false;
            }
        }
    }

    synchronized void suspend() {
        generation++;
        result = null;
    }

    @JavascriptInterface public synchronized String take() {
        if (closed || !enabled.getAsBoolean()) {
            result = null;
            return status("HISTORY_DISABLED");
        }
        String completed = result;
        result = null;
        return completed;
    }

    @Override public synchronized void close() {
        closed = true;
        result = null;
        worker.shutdownNow();
        timer.shutdownNow();
    }

    static boolean validAnchor(JSONObject anchor, long now) {
        long measuredAt = anchor.optLong("measuredAtMs", -1);
        long receivedAt = anchor.optLong("receivedAtMs", -1);
        double mgdl = anchor.optDouble("mgdl", Double.NaN);
        return "MEASUREMENT".equals(anchor.optString("status")) && measuredAt >= now - HISTORY_MS &&
            measuredAt <= receivedAt && receivedAt <= now && now - receivedAt <= ANCHOR_RECEIPT_MS &&
            Double.isFinite(mgdl) && mgdl >= 1.5 * 18.01559 && mgdl <= 30 * 18.01559;
    }

    // Package-private so the instrumentation can assert the exact production transport.
    static String fetch(JSONObject anchor, ScheduledExecutorService timer) {
        if (!validAnchor(anchor, System.currentTimeMillis())) return status("HISTORY_NEEDS_PROVIDER");
        HttpURLConnection connection = null;
        ScheduledFuture<?> timeout = null;
        long deadline = SystemClock.elapsedRealtime() + DEADLINE_MS;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection(Proxy.NO_PROXY);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(2000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty("Connection", "close");
            HttpURLConnection request = connection;
            timeout = timer.schedule(request::disconnect, DEADLINE_MS, TimeUnit.MILLISECONDS);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return status("HISTORY_HTTP_ERROR");
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT).equals("application/json")) {
                return status("HISTORY_INVALID");
            }
            if (connection.getContentLengthLong() > MAX_BYTES) return status("HISTORY_TOO_LARGE");
            try (InputStream stream = connection.getInputStream()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int length; (length = stream.read(buffer)) != -1;) {
                    if (SystemClock.elapsedRealtime() >= deadline) return status("HISTORY_TIMEOUT");
                    if (bytes.size() + length > MAX_BYTES) return status("HISTORY_TOO_LARGE");
                    bytes.write(buffer, 0, length);
                }
                if (SystemClock.elapsedRealtime() >= deadline) return status("HISTORY_TIMEOUT");
                return parse(bytes.toString(StandardCharsets.UTF_8.name()), anchor, System.currentTimeMillis());
            }
        } catch (SocketTimeoutException timeoutError) {
            return status("HISTORY_TIMEOUT");
        } catch (IOException ioError) {
            return status(SystemClock.elapsedRealtime() >= deadline ? "HISTORY_TIMEOUT" : "HISTORY_UNAVAILABLE");
        } finally {
            if (timeout != null) timeout.cancel(false);
            if (connection != null) connection.disconnect();
        }
    }

    static String parse(String text, JSONObject anchor, long now) {
        if (!validAnchor(anchor, now)) return status("HISTORY_NEEDS_PROVIDER");
        try {
            JSONTokener json = new JSONTokener(text);
            Object value = json.nextValue();
            if (!(value instanceof JSONArray) || json.nextClean() != 0) return status("HISTORY_INVALID");
            JSONArray rows = (JSONArray) value;
            if (rows.length() == 0) return status("HISTORY_EMPTY");
            if (rows.length() > MAX_ROWS) return status("HISTORY_INVALID");
            long anchorTime = anchor.getLong("measuredAtMs");
            int anchorSgv = (int) anchor.getDouble("mgdl"); // xDrip+ casts Web Service sgv to int.
            boolean matched = false;
            Map<Long, JSONObject> history = new TreeMap<>();
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                Object date = row.get("date");
                Object sgv = row.get("sgv");
                if (!(date instanceof Long) || !(sgv instanceof Integer)) return status("HISTORY_INVALID");
                long ts = (Long) date;
                int mgdl = (Integer) sgv;
                if (ts < 946684800000L || ts > now || mgdl < 27 || mgdl > 540) return status("HISTORY_INVALID");
                if (ts == anchorTime) {
                    if (mgdl != anchorSgv) return status("HISTORY_ANCHOR_MISMATCH");
                    matched = true;
                }
                if (ts < now - HISTORY_MS || ts >= anchorTime || mgdl == 27) continue;
                String direction = row.optString("direction", "");
                JSONObject point = new JSONObject().put("measuredAtMs", ts).put("mgdl", mgdl)
                    .put("direction", GFNativeXDrip.knownDirection(direction) ? direction : JSONObject.NULL);
                JSONObject old = history.putIfAbsent(ts, point);
                if (old != null && !old.toString().equals(point.toString())) return status("HISTORY_CONFLICT");
            }
            if (!matched) return status("HISTORY_ANCHOR_MISMATCH");
            return new JSONObject().put("status", "HISTORY_READY").put("anchorTs", anchorTime)
                .put("anchorSgv", anchorSgv).put("receivedAtMs", now).put("items", new JSONArray(history.values())).toString();
        } catch (JSONException invalid) {
            return status("HISTORY_INVALID");
        }
    }

    private static String status(String status) {
        return "{\"status\":\"" + status + "\"}";
    }
}
