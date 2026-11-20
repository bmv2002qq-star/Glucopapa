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

    private static JSONObject exchange(JSONObject anchor, String status, String type, String headers, String body)
        throws Exception {
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
                    check("GET /sgv.json?count=288 HTTP/1.1".equals(reader.readLine()), "Unexpected HTTP request");
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
            JSONObject result = new JSONObject(GFNativeXDripHistory.fetch(anchor, timer));
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
