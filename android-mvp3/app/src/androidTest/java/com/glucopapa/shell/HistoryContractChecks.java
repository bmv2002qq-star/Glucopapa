package com.glucopapa.shell;

import android.security.NetworkSecurityPolicy;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Synthetic responses on the emulator's private loopback, never a connection to a real follower. */
public final class HistoryContractChecks {
    public static String run(JSONObject persistedPoint) throws Exception {
        NetworkSecurityPolicy policy = NetworkSecurityPolicy.getInstance();
        check(policy.isCleartextTrafficPermitted("127.0.0.1"), "Missing IPv4 loopback cleartext exception");
        check(!policy.isCleartextTrafficPermitted() && !policy.isCleartextTrafficPermitted("localhost")
            && !policy.isCleartextTrafficPermitted("127.0.0.2")
            && !policy.isCleartextTrafficPermitted("192.168.0.2"), "Cleartext allowed on another host");

        long ts = persistedPoint.getLong("ts");
        JSONObject anchor = new JSONObject().put("status", "MEASUREMENT").put("measuredAtMs", ts)
            .put("receivedAtMs", System.currentTimeMillis()).put("mgdl", persistedPoint.getDouble("mgdl"));
        JSONObject matching = reading(ts, 108).put("direction", "FortyFiveDown");
        JSONObject older = reading(ts - 300_000, 104).put("direction", "Flat");
        JSONObject oldest = reading(ts - 600_000, 101);
        String history = new JSONArray().put(matching).put(older).put(oldest).put(older).toString();
        JSONObject accepted = exchange(anchor, "200 OK", "application/json; charset=UTF-8", "", history);
        check("HISTORY_READY".equals(accepted.optString("status")), "V1 loopback payload refused: " + accepted);
        JSONArray points = accepted.getJSONArray("items");
        check(accepted.getInt("anchorSgv") == 108 && accepted.getLong("anchorTs") == ts
            && points.length() == 2 && points.getJSONObject(0).getLong("measuredAtMs") == ts - 600_000
            && points.getJSONObject(0).isNull("direction")
            && "Flat".equals(points.getJSONObject(1).optString("direction")), "Loopback normalization differs");

        assertStatus("HISTORY_ANCHOR_MISMATCH", exchange(anchor, "200 OK", "application/json", "",
            new JSONArray().put(older).toString()));
        assertStatus("HISTORY_ANCHOR_MISMATCH", exchange(anchor, "200 OK", "application/json", "",
            new JSONArray().put(reading(ts, 107)).put(older).toString()));
        assertStatus("HISTORY_CONFLICT", exchange(anchor, "200 OK", "application/json", "",
            new JSONArray().put(matching).put(older).put(reading(ts - 300_000, 105)).toString()));
        assertStatus("HISTORY_INVALID", exchange(anchor, "200 OK", "text/html", "", history));
        assertStatus("HISTORY_HTTP_ERROR", exchange(anchor, "302 Found", "application/json",
            "Location: http://127.0.0.1:17581/\r\n", ""));
        assertStatus("HISTORY_TOO_LARGE", exchange(anchor, "200 OK", "application/json",
            "Content-Length: 262145\r\n", ""));
        assertStatus("HISTORY_INVALID", new JSONObject(GFNativeXDripHistory.parse(
            new JSONArray().put(matching).put(reading(System.currentTimeMillis() + 60_000, 110)).toString(),
            anchor, System.currentTimeMillis())));
        check(!GFNativeXDripHistory.validAnchor(new JSONObject(anchor.toString())
            .put("receivedAtMs", System.currentTimeMillis() - 120_000), System.currentTimeMillis()),
            "An expired ContentProvider receipt could authorize history");
        return accepted.toString();
    }

    private static JSONObject reading(long ts, int mgdl) throws Exception {
        return new JSONObject().put("date", ts).put("sgv", mgdl);
    }

    public static String runLatest(JSONObject lastStored) throws Exception {
        long ts = lastStored.getLong("ts") + 60_000;
        long now = System.currentTimeMillis();
        String iso = Instant.ofEpochMilli(ts).atOffset(ZoneOffset.ofHours(3))
            .format(DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSZ", java.util.Locale.ROOT));
        JSONObject row = reading(ts, 150).put("dateString", iso).put("units_hint", "mmol")
            .put("type", "sgv").put("device", "Follower").put("direction", "Flat").put("delta", -1.002);
        String sample = new JSONArray().put(row).toString();
        JSONObject live = exchange(null, "200 OK", "application/json", "", sample);
        assertStatus("MEASUREMENT", live);
        check(live.getLong("measuredAtMs") == ts && live.getInt("mgdl") == 150 &&
            "Follower".equals(live.getString("device")) && !live.getBoolean("stale") &&
            live.getDouble("deltaMgdl") == -1.002 && "Flat".equals(live.getString("direction")),
            "Current Web Service observation changed units or metadata");
        JSONObject old = new JSONObject(GFNativeXDripHistory.parseLatest(sample, now + 30 * 60_000));
        check(old.getBoolean("stale"), "Old Web Service value marked current");
        assertStatus("WEB_FUTURE_MEASUREMENT", new JSONObject(GFNativeXDripHistory.parseLatest(sample, ts - 1)));
        row.put("date", ts + 1);
        assertStatus("HISTORY_INVALID", new JSONObject(GFNativeXDripHistory.parseLatest(
            new JSONArray().put(row).toString(), now)));
        row.remove("date");
        assertStatus("MEASUREMENT", new JSONObject(GFNativeXDripHistory.parseLatest(
            new JSONArray().put(row).toString(), now)));
        return live.toString();
    }

    public static String runWindow() throws Exception {
        long now = System.currentTimeMillis();
        long latest = now - 60_000;
        long future = now + 120_000;
        JSONObject last = reading(latest / 1000, 154).put("type", "sgv").put("device", "Follower")
            .put("dateString", Instant.ofEpochMilli(latest).atOffset(ZoneOffset.ofHours(3)).toString())
            .put("units_hint", "mmol").put("direction", "Flat").put("delta", -1.001);
        JSONObject older = reading(latest - 300_000, 120);
        JSONArray input = new JSONArray().put(reading(future, 170)).put(older).put(last).put(older)
            .put(reading(latest - 600_000, 27)).put(reading(now - 25 * 3600_000L, 105));
        JSONObject result = exchange(null, "200 OK", "application/json", "", input.toString(), true);
        assertStatus("WEB_WINDOW_READY", result);
        JSONObject point = result.getJSONObject("latest");
        check(point.getLong("measuredAtMs") == latest && point.getInt("mgdl") == 154
            && result.getInt("futureCount") == 1 && result.getInt("invalidCount") == 1
            && result.getLong("futureMeasuredAtMs") == future && result.getJSONArray("items").length() == 1
            && result.getJSONArray("items").getJSONObject(0).getLong("measuredAtMs") == latest - 300_000,
            "Bounded Web Service window changed or admitted bad timestamps");
        JSONObject futureOnly = new JSONObject(GFNativeXDripHistory.parseWindow(
            new JSONArray().put(reading(future, 170)).toString(), now));
        assertStatus("WEB_FUTURE_MEASUREMENT", futureOnly);
        check(futureOnly.getLong("receivedAtMs") == now && !futureOnly.has("mgdl"), "A future point escaped diagnostics");
        assertStatus("HISTORY_CONFLICT", new JSONObject(GFNativeXDripHistory.parseWindow(input
            .put(reading(latest, 151)).toString(), now)));
        return result.toString();
    }

    private static JSONObject exchange(JSONObject anchor, String status, String type, String headers, String body)
        throws Exception {
        return exchange(anchor, status, type, headers, body, false);
    }

    private static JSONObject exchange(JSONObject anchor, String status, String type, String headers, String body,
                                       boolean window) throws Exception {
        ExecutorService serverWorker = Executors.newSingleThreadExecutor();
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
        try (ServerSocket server = new ServerSocket()) {
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 17580));
            server.setSoTimeout(4000);
            Future<?> response = serverWorker.submit(() -> {
                try (Socket client = server.accept()) {
                    client.setSoTimeout(3000);
                    BufferedReader reader = new BufferedReader(new InputStreamReader(
                        client.getInputStream(), StandardCharsets.US_ASCII));
                    String query = anchor == null && !window ? "1" : "288";
                    check(("GET /sgv.json?count=" + query + " HTTP/1.1").equals(reader.readLine()), "Unexpected HTTP request");
                    for (String line; (line = reader.readLine()) != null && !line.isEmpty();) { /* Skip headers. */ }
                    byte[] data = body.getBytes(StandardCharsets.UTF_8);
                    String length = headers.startsWith("Content-Length:") ? "" : "Content-Length: " + data.length + "\r\n";
                    OutputStream output = client.getOutputStream();
                    output.write(("HTTP/1.1 " + status + "\r\nContent-Type: " + type
                        + "\r\nConnection: close\r\n" + length + headers + "\r\n").getBytes(StandardCharsets.US_ASCII));
                    output.write(data);
                    output.flush();
                }
                return null;
            });
            JSONObject result = new JSONObject(window ? GFNativeXDripHistory.fetchWindow(timer)
                : anchor == null ? GFNativeXDripHistory.fetchLatest(timer) : GFNativeXDripHistory.fetch(anchor, timer));
            response.get(5, TimeUnit.SECONDS);
            return result;
        } finally {
            serverWorker.shutdownNow();
            timer.shutdownNow();
        }
    }

    private static void assertStatus(String expected, JSONObject reply) {
        check(expected.equals(reply.optString("status")), "Expected " + expected + ", received " + reply);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
