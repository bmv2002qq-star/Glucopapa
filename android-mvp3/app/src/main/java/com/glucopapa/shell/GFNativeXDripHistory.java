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
    private enum Query { LATEST, WINDOW, ANCHORED_HISTORY }

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
            return start(anchor, Query.ANCHORED_HISTORY);
        } catch (JSONException invalid) {
            return status("HISTORY_NEEDS_PROVIDER");
        }
    }

    @JavascriptInterface public synchronized String requestLatest() {
        return start(null, Query.LATEST);
    }

    @JavascriptInterface public synchronized String requestWindow() {
        return start(null, Query.WINDOW);
    }

    private String start(JSONObject anchor, Query query) {
        if (closed || !enabled.getAsBoolean()) return status("HISTORY_DISABLED");
        if (active) return status("HISTORY_BUSY");
        if (query == Query.LATEST) latestResult = null;
        else result = null;
        active = true;
        int requested = generation;
        worker.execute(() -> complete(anchor, requested, query));
        return status("HISTORY_FETCHING");
    }

    private void complete(JSONObject anchor, int requested, Query query) {
        String payload = status("HISTORY_UNAVAILABLE");
        try {
            switch (query) {
                case LATEST: payload = fetchLatest(timer); break;
                case WINDOW: payload = fetchWindow(timer); break;
                case ANCHORED_HISTORY: payload = fetch(anchor, timer); break;
            }
        } catch (RejectedExecutionException closing) {
            // The Activity closed before the connection timer was scheduled.
        } finally {
            synchronized (this) {
                if (!closed && generation == requested && enabled.getAsBoolean()) {
                    if (query == Query.LATEST) latestResult = payload;
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
        return fetch(ENDPOINT, anchor, timer, Query.ANCHORED_HISTORY);
    }

    static String fetchLatest(ScheduledExecutorService timer) {
        return fetch(LATEST_ENDPOINT, null, timer, Query.LATEST);
    }

    static String fetchWindow(ScheduledExecutorService timer) {
        return fetch(ENDPOINT, null, timer, Query.WINDOW);
    }

    private static String fetch(
        String endpoint, JSONObject anchor, ScheduledExecutorService timer, Query query
    ) {
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
                switch (query) {
                    case LATEST: return parseLatest(json, now);
                    case WINDOW: return parseWindow(json, now);
                    default: return parse(json, anchor, now);
                }
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

    private static JSONArray entries(String text) throws JSONException {
        JSONTokener json = new JSONTokener(text);
        Object rows = json.nextValue();
        if (!(rows instanceof JSONArray) || json.nextClean() != 0)
            throw new JSONException("Expected one JSON array");
        return (JSONArray) rows;
    }

    static String parseLatest(String text, long now) {
        try {
            JSONArray rows = entries(text);
            if (rows.length() == 0) return status("HISTORY_EMPTY");
            if (rows.length() != 1) return status("HISTORY_INVALID");
            JSONObject row = observation(rows.getJSONObject(0), now);
            long measured = row.getLong("measuredAtMs");
            return measured > now ? future(measured, now, 1).toString() : row.toString();
        } catch (JSONException | DateTimeParseException invalid) {
            return status("HISTORY_INVALID");
        }
    }

    static String parseWindow(String text, long now) {
        try {
            JSONArray rows = entries(text);
            if (rows.length() == 0) return status("HISTORY_EMPTY");
            if (rows.length() > MAX_ROWS) return status("HISTORY_INVALID");
            TreeMap<Long, JSONObject> received = new TreeMap<>();
            long newestFuture = -1;
            int futureCount = 0;
            int invalidCount = 0;
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row;
                try {
                    row = observation(rows.getJSONObject(i), now);
                } catch (JSONException | DateTimeParseException invalid) {
                    invalidCount++;
                    continue;
                }
                long measured = row.getLong("measuredAtMs");
                if (measured > now) {
                    newestFuture = Math.max(newestFuture, measured);
                    futureCount++;
                    continue;
                }
                if (measured < now - HISTORY_MS) continue;
                JSONObject sameTime = received.putIfAbsent(measured, row);
                if (sameTime != null && !sameTime.toString().equals(row.toString()))
                    return status("HISTORY_CONFLICT");
            }
            if (received.isEmpty()) {
                if (futureCount > 0) return future(newestFuture, now, futureCount).toString();
                return status(invalidCount > 0 ? "HISTORY_INVALID" : "HISTORY_EMPTY");
            }
            JSONObject latest = received.pollLastEntry().getValue();
            JSONArray older = new JSONArray();
            for (JSONObject point : received.values()) {
                older.put(new JSONObject().put("measuredAtMs", point.getLong("measuredAtMs"))
                    .put("mgdl", point.getInt("mgdl")).put("direction", point.get("direction")));
            }
            return new JSONObject().put("status", "WEB_WINDOW_READY").put("latest", latest)
                .put("items", older).put("futureCount", futureCount).put("invalidCount", invalidCount)
                .put("futureMeasuredAtMs", futureCount > 0 ? newestFuture : JSONObject.NULL).toString();
        } catch (JSONException invalid) {
            return status("HISTORY_INVALID");
        }
    }

    private static JSONObject observation(JSONObject row, long now) throws JSONException {
        if (row.has("type") && !"sgv".equals(row.getString("type")))
            throw new JSONException("The row is not an SGV");
        // Display units are independent of the integer mg/dL field.
        Object glucose = row.get("sgv");
        if (!(glucose instanceof Integer) || (Integer) glucose < 28 || (Integer) glucose > 540)
            throw new JSONException("Invalid mg/dL observation");
        long measured = observationTime(row);
        String direction = row.optString("direction", "");
        double delta = row.optDouble("delta", Double.NaN);
        return new JSONObject().put("status", "MEASUREMENT").put("transport", "xdrip_loopback_live")
            .put("measuredAtMs", measured).put("receivedAtMs", now).put("mgdl", glucose)
            .put("stale", now - measured > TimeUnit.MINUTES.toMillis(15))
            .put("direction", GFNativeXDrip.knownDirection(direction) ? direction : JSONObject.NULL)
            .put("device", "Follower".equalsIgnoreCase(row.optString("device")) ? "Follower" : "xDrip+")
            .put("deltaMgdl", Double.isFinite(delta) ? delta : JSONObject.NULL);
    }

    private static JSONObject future(long measured, long received, int count) throws JSONException {
        return new JSONObject().put("status", "WEB_FUTURE_MEASUREMENT")
            .put("measuredAtMs", measured).put("receivedAtMs", received).put("futureCount", count);
    }

    private static long observationTime(JSONObject row) throws JSONException {
        long minimum = 946684800000L; // 2000-01-01 UTC
        long maximum = 4102444800000L; // 2100-01-01 UTC
        long epoch = -1;
        boolean seconds = false;
        if (!row.isNull("date")) {
            Object numeric = row.get("date");
            if (!(numeric instanceof Integer) && !(numeric instanceof Long))
                throw new JSONException("Invalid measurement time");
            epoch = ((Number) numeric).longValue();
            seconds = epoch >= minimum / 1000 && epoch <= maximum / 1000;
            if (seconds) epoch *= 1000;
            if (epoch < minimum || epoch > maximum) throw new JSONException("Invalid measurement epoch");
        }
        if (!row.isNull("dateString")) {
            String iso = row.getString("dateString").replaceFirst("([+-]\\d{2})(\\d{2})$", "$1:$2");
            OffsetDateTime dateTime = OffsetDateTime.parse(iso);
            long parsed = dateTime.toInstant().toEpochMilli();
            if (parsed < minimum || parsed > maximum) throw new JSONException("Invalid ISO measurement epoch");
            // A precision difference may account for the fractional part of the same second.
            if (epoch != -1 && epoch != parsed && !((seconds || !iso.contains(".")) && epoch / 1000 == parsed / 1000))
                throw new JSONException("Conflicting measurement times");
            return epoch == -1 || seconds ? parsed : epoch;
        }
        if (epoch != -1) return epoch;
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
