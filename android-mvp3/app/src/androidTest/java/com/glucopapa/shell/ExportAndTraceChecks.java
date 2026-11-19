package com.glucopapa.shell;

import android.util.Log;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ExportAndTraceChecks {
    private static final long DAY = DiagnosticRing.DAY;
    private static final Instant END = Instant.parse("2026-11-02T14:00:00Z");
    private static final ZoneId ZONE = ZoneId.of("America/New_York");

    private ExportAndTraceChecks() {}

    public static JSONObject run(Path temporary) throws Exception {
        Path root = Files.createTempDirectory(temporary, "cl040-");
        DiagnosticRing ring = new DiagnosticRing(root.resolve("trace"));
        long day = Math.floorDiv(END.toEpochMilli(), DAY);
        long midnight = day * DAY;
        for (int n = 4; n >= 0; n--) {
            ring.append("local", midnight - n * DAY + 1_000, marker(n, 5));
            ring.append("demo", midnight - n * DAY + 2_000, marker(100 + n, 5));
        }
        ring.append("local", midnight + 3_000, marker(101, 6));
        DiagnosticRing.View view = ring.read("local", END.minusSeconds(5 * 86_400), END, 5);
        check(view.traces.size() == 3 && view.corruptSlots == 0, "Local view, revision and retention");
        for (int index = 0; index < 3; index++)
            check(view.traces.get(index).getInt("marker") == 2 - index, "Exact window rows");
        try (var files = Files.list(root.resolve("trace"))) {
            check(files.count() == 3, "Exactly three persistent slots");
        }

        check(AiJsonlExport.since(END, ZONE, "2d").equals(Instant.parse("2026-10-31T13:00:00Z")),
            "Two calendar days span 49 hours across autumn DST");
        check(AiJsonlExport.since(END, ZONE, "6m").equals(Instant.parse("2026-05-02T13:00:00Z")),
            "Six calendar months and applied timezone");

        Path today = ring.slot((int)Math.floorMod(day, 3L));
        Path pending = today.resolveSibling(today.getFileName() + ".new");
        Files.write(pending, "uncommitted partial".getBytes(StandardCharsets.UTF_8));
        DiagnosticRing reopened = new DiagnosticRing(root.resolve("trace"));
        check(reopened.read("local", Instant.EPOCH, END, 5).traces.size() == 3 && !Files.exists(pending),
            "Uncommitted staging file removed on reopening");
        Files.write(today, "{\"truncated\":".getBytes(StandardCharsets.UTF_8), StandardOpenOption.APPEND);
        DiagnosticRing.View damaged = reopened.read("local", Instant.EPOCH, END, 5);
        check(damaged.corruptSlots == 1 && damaged.traces.size() == 2, "Damaged slot separated");

        DiagnosticRing shared = new DiagnosticRing(root.resolve("concurrent"));
        shared.append("local", midnight - 1, marker(-1, 5));
        var tasks = new ArrayList<Callable<Void>>();
        for (int index = 0; index < 100; index++) {
            final int n = index;
            tasks.add(() -> { shared.append("local", midnight + n, marker(n, 5)); return null; });
        }
        long started = android.os.SystemClock.elapsedRealtime();
        var workers = Executors.newFixedThreadPool(8);
        try {
            for (var result : workers.invokeAll(tasks)) result.get();
        } finally {
            workers.shutdownNow();
        }
        long latency = android.os.SystemClock.elapsedRealtime() - started;
        DiagnosticRing.View concurrent = shared.read("local", Instant.EPOCH, END, 5);
        check(concurrent.traces.size() == 101 && concurrent.corruptSlots == 0, "Concurrent appends and UTC boundary");

        JSONObject state = snapshot();
        JSONArray samples = state.getJSONArray("cgm");
        String original = state.toString();
        var result = new JSONObject().put("fixture", "SYNTHETIC").put("ringSlots", 3)
            .put("concurrentRows", concurrent.traces.size()).put("traceWriteMs", latency);
        var periods = new JSONArray();
        for (String period : new String[]{"1d","2d","5d","1m","3m","6m"}) {
            Path target = root.resolve(period + ".jsonl");
            try (var out = new BufferedOutputStream(Files.newOutputStream(target))) {
                new AiJsonlExport().write(out, state, view, "OK", END, period, "local", "0.0.1");
            }
            periods.put(checkExport(target, period, samples.length()));
            Files.delete(target);
        }
        check(state.toString().equals(original), "Export leaves immutable source state identical");
        long[] written = {0};
        try {
            new AiJsonlExport().write(new OutputStream() {
                @Override public void write(int value) throws IOException {
                    if (++written[0] > 1024) throw new IOException("SYNTHETIC_DISK_FULL");
                }
            }, state, view, "OK", END, "1d", "local", "0.0.1");
            throw new IllegalStateException("Failed output must not report success");
        } catch (IOException error) {
            check("SYNTHETIC_DISK_FULL".equals(error.getMessage()), "Output error propagated");
        }
        result.put("periods", periods).put("projectedSourceUnchanged", true).put("injectedStreamFailure", true);
        Log.i("GlucoPapaQA", "CL040_TRACE_EXPORT " + result);
        return result;
    }

    private static JSONObject snapshot() throws Exception {
        JSONArray samples = new JSONArray();
        long start = AiJsonlExport.since(END, ZONE, "6m").toEpochMilli();
        for (long at = start; at < END.toEpochMilli(); at += 300_000) {
            samples.put(new JSONObject().put("ts", at).put("mmol", 6).put("sourceDeviceId", "private-sensor-id")
                .put("receivedAt", Instant.ofEpochMilli(at + 30_000).toString()).put("valid", true));
        }
        JSONArray events = new JSONArray();
        for (String status : new String[]{"confirmed","planned"}) {
            events.put(new JSONObject().put("type","insulin_injection").put("status",status)
                .put("insulinId","rinfast").put("units",0.5).put("id","private-id-" + status)
                .put("administeredAt", END.minusSeconds(3600).toString())
                .put("note","private-patient-note"));
        }
        return new JSONObject().put("schemaVersion",5).put("revision",5).put("events",events).put("cgm",samples)
            .put("cgmMetadata",new JSONObject().put("qualityScore",0.99))
            .put("profile",new JSONObject().put("timeZone",ZONE.getId())
                .put("displayName","private-patient-name").put("secret","private-token"))
            .put("coverage", new JSONObject().put("confirmedComplete",true)
                .put("startIso",Instant.ofEpochMilli(start).toString()).put("endIso",END.toString()));
    }

    private static JSONObject checkExport(Path path, String period, int totalSamples) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        JSONObject manifest, footer = null;
        int records = 0;
        try (var in = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String first = in.readLine();
            manifest = new JSONObject(first);
            check("manifest".equals(manifest.getString("type")), "Header is an independently parseable JSON object");
            check(manifest.getLong("sourceRevision") == 5 && period.equals(manifest.getString("period")), "Revision and period");
            digest.update((first + "\n").getBytes(StandardCharsets.UTF_8));
            for (String line; (line = in.readLine()) != null; ) {
                JSONObject row = new JSONObject(line);
                check(!line.contains("private-"), "Personal identifiers and note never exported");
                if ("footer".equals(row.getString("type"))) {
                    footer = row;
                    check(in.readLine() == null, "No records after footer");
                    break;
                }
                if ("event".equals(row.getString("type"))) check(row.getDouble("units") == 0.5, "Confirmed units");
                records++;
                digest.update((line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        }
        check(footer != null, "Footer must exist");
        var sha = new StringBuilder();
        for (byte b : digest.digest()) sha.append(String.format(Locale.ROOT, "%02x", b & 255));
        check(sha.toString().equals(footer.getString("sha256")), "Independent digest over line bytes");
        JSONObject counts = footer.getJSONObject("counts");
        int expectedTraces = "1d".equals(period) ? 1 : "2d".equals(period) ? 2 : 3;
        check(counts.getInt("trace") == expectedTraces && counts.getInt("event") == 1, "Trace window and confirmed-only facts");
        if ("6m".equals(period)) check(counts.getInt("cgm") == totalSamples && totalSamples > 50_000, "Full six-month compact samples");
        check(records == 1 + expectedTraces + counts.getInt("cgm"), "Counts match parsed records");
        return new JSONObject().put("period",period).put("records",records).put("bytes",Files.size(path))
            .put("counts",counts).put("sha256",sha.toString());
    }

    private static JSONObject marker(int n, long revision) throws Exception {
        return new JSONObject().put("marker",n).put("operation","forecast_attempt").put("sourceRevision",revision);
    }

    private static void check(boolean value, String info) {
        if (!value) throw new IllegalStateException(info);
    }
}
