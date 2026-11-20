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
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
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

/** Read-only client for the two fixed queries to the local xDrip+ Web Service. */
public final class GFNativeXDripHistory implements AutoCloseable {
    private static final String ENDPOINT = "http://127.0.0.1:17580/sgv.json?count=288";
    private static final String LATEST_ENDPOINT = "http://127.0.0.1:17580/sgv.json?count=1";
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
    private String latestResult;
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
            worker.execute(() -> complete(anchor, requested, false));
            return status("HISTORY_FETCHING");
        } catch (JSONException invalid) {
            return status("HISTORY_NEEDS_PROVIDER");
        }
    }

    @JavascriptInterface public synchronized String requestLatest() {
        if (closed || !enabled.getAsBoolean()) return status("HISTORY_DISABLED");
        if (active) return status("HISTORY_BUSY");
        latestResult = null;
        active = true;
        int requested = generation;
        worker.execute(() -> complete(null, requested, true));
        return status("HISTORY_FETCHING");
    }

    private void complete(JSONObject anchor, int requested, boolean latest) {
        String payload = status("HISTORY_UNAVAILABLE");
        try {
            payload = latest ? fetchLatest(timer) : fetch(anchor, timer);
        } catch (RejectedExecutionException closing) {
            // The Activity closed before the connection timer was scheduled.
        } finally {
            synchronized (this) {
                if (!closed && generation == requested && enabled.getAsBoolean()) {
                    if (latest) latestResult = payload;
                    else result = payload;
                }
                active = false;
            }
        }
    }

    synchronized void suspend() {
        generation++;
        result = null;
        latestResult = null;
    }

    @JavascriptInterface public synchronized String takeLatest() {
        if (closed || !enabled.getAsBoolean()) {
            latestResult = null;
            return status("HISTORY_DISABLED");
        }
        String completed = latestResult;
        latestResult = null;
        return completed;
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
        return fetch(ENDPOINT, anchor, timer);
    }

    static String fetchLatest(ScheduledExecutorService timer) {
        return fetch(LATEST_ENDPOINT, null, timer);
    }

    private static String fetch(String endpoint, JSONObject anchor, ScheduledExecutorService timer) {
        HttpURLConnection connection = null;
        ScheduledFuture<?> timeout = null;
        long deadline = SystemClock.elapsedRealtime() + DEADLINE_MS;
        try {
            connection = (HttpURLConnection) new URL(endpoint).openConnection(Proxy.NO_PROXY);
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
                String json = bytes.toString(StandardCharsets.UTF_8.name());
                long now = System.currentTimeMillis();
                return anchor == null ? parseLatest(json, now) : parse(json, anchor, now);
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

    static String parseLatest(String text, long now) {
        try {
            JSONTokener json = new JSONTokener(text);
            Object value = json.nextValue();
            if (!(value instanceof JSONArray) || json.nextClean() != 0) return status("HISTORY_INVALID");
            JSONArray rows = (JSONArray) value;
            if (rows.length() == 0) return status("HISTORY_EMPTY");
            if (rows.length() != 1) return status("HISTORY_INVALID");
            JSONObject row = rows.getJSONObject(0);
            if (row.has("type") && !"sgv".equals(row.getString("type"))) return status("HISTORY_INVALID");
            // xDrip+ emits integer mg/dL independently of its glucose-display units.
            Object glucose = row.get("sgv");
            if (!(glucose instanceof Integer) || (Integer) glucose < 28 || (Integer) glucose > 540)
                return status("HISTORY_INVALID");
            long measured = observationTime(row);
            if (measured < 946684800000L) return status("HISTORY_INVALID");
            if (measured > now) return status("WEB_FUTURE_MEASUREMENT");
            String direction = row.optString("direction", "");
            String device = row.optString("device", "");
            double delta = row.optDouble("delta", Double.NaN);
            return new JSONObject().put("status", "MEASUREMENT").put("transport", "xdrip_loopback_live")
                .put("measuredAtMs", measured).put("receivedAtMs", now).put("mgdl", glucose)
                .put("stale", now - measured > TimeUnit.MINUTES.toMillis(15))
                .put("direction", GFNativeXDrip.knownDirection(direction) ? direction : JSONObject.NULL)
                .put("device", "Follower".equalsIgnoreCase(device) ? "Follower" : "xDrip+")
                .put("deltaMgdl", Double.isFinite(delta) ? delta : JSONObject.NULL).toString();
        } catch (JSONException | DateTimeParseException invalid) {
            return status("HISTORY_INVALID");
        }
    }

    private static long observationTime(JSONObject row) throws JSONException {
        Object epoch = row.opt("date");
        if (epoch != null && epoch != JSONObject.NULL && !(epoch instanceof Long))
            throw new JSONException("Invalid measurement time");
        if (!row.isNull("dateString")) {
            String iso = row.getString("dateString").replaceFirst("([+-]\\d{2})(\\d{2})$", "$1:$2");
            long parsed = OffsetDateTime.parse(iso).toInstant().toEpochMilli();
            if (epoch instanceof Long && (Long) epoch != parsed)
                throw new JSONException("Conflicting measurement times");
            return parsed;
        }
        if (epoch instanceof Long) return (Long) epoch;
        throw new JSONException("Missing measurement time");
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
