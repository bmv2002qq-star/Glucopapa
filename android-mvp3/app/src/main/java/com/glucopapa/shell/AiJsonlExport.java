package com.glucopapa.shell;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Streams a bounded, de-identified reading of one GFStorage snapshot and one trace view. */
final class AiJsonlExport {
    static final String FILE_NAME = "Glucopapa_AI_Export.jsonl";
    private static final String SCHEMA = "glucopapa.ai-export/1";
    private static final Pattern VERSION = Pattern.compile("[0-9]{1,3}(\\.[0-9]{1,3}){1,3}");
    private final Map<String, String> aliases = new HashMap<>();

    static boolean supports(String period) {
        return "1d".equals(period) || "2d".equals(period) || "5d".equals(period)
            || "1m".equals(period) || "3m".equals(period) || "6m".equals(period);
    }

    static Instant since(Instant end, ZoneId zone, String period) {
        if (!supports(period)) throw new IllegalArgumentException("EXPORT_PERIOD");
        ZonedDateTime boundary = end.atZone(zone);
        int count = period.charAt(0) - '0';
        return (period.endsWith("d") ? boundary.minusDays(count) : boundary.minusMonths(count)).toInstant();
    }

    static ZoneId timezone(JSONObject state) {
        JSONObject profile = state.optJSONObject("profile");
        try {
            return ZoneId.of(profile == null ? "UTC" : profile.optString("timeZone", "UTC"));
        } catch (RuntimeException unknown) {
            return ZoneOffset.UTC;
        }
    }

    private static final class Entry {
        final String type, subtype, key;
        final Instant at;
        final JSONObject original;

        Entry(String type, String subtype, String key, Instant at, JSONObject original) {
            this.type = type;
            this.subtype = subtype;
            this.key = key;
            this.at = at;
            this.original = original;
        }
    }

    void write(OutputStream stream, JSONObject snapshot, DiagnosticRing.View trace, String traceStatus,
            Instant end, String period, String mode, String appVersion) throws Exception {
        if (snapshot.getInt("schemaVersion") != 5 || snapshot.getLong("revision") < 0)
            throw new IllegalArgumentException("EXPORT_SNAPSHOT");
        aliases.clear();
        ZoneId zone = timezone(snapshot);
        Instant start = since(end, zone, period);
        List<Entry> rows = collect(snapshot, trace, start, end);
        rows.sort(Comparator.comparing((Entry r) -> r.at).thenComparing(r -> r.type).thenComparing(r -> r.key));

        var counts = new LinkedHashMap<String, Integer>();
        var from = new HashMap<String, Instant>();
        var to = new HashMap<String, Instant>();
        var seen = new HashSet<String>();
        var compact = new ArrayList<Entry>();
        int duplicates = 0;
        for (Entry row : rows) {
            if (!seen.add(row.key)) { duplicates++; continue; }
            compact.add(row);
            counts.put(row.type, counts.getOrDefault(row.type, 0) + 1);
            from.putIfAbsent(row.type, row.at);
            to.put(row.type, row.at);
        }
        JSONObject coverage = new JSONObject();
        for (String kind : new String[]{"event","cgm","setting_change","forecast","forecast_assessment","trace","error"}) {
            counts.putIfAbsent(kind, 0);
            coverage.put(kind, new JSONObject().put("count", counts.get(kind))
                .put("firstAt", from.containsKey(kind) ? from.get(kind).toString() : JSONObject.NULL)
                .put("lastAt", to.containsKey(kind) ? to.get(kind).toString() : JSONObject.NULL));
        }
        JSONObject quality = snapshot.optJSONObject("cgmMetadata");
        JSONObject history = snapshot.optJSONObject("coverage");
        boolean historyDeclared = history != null && history.optBoolean("confirmedComplete", false)
            && timestamp(history, "startIso") != null && !timestamp(history, "startIso").isAfter(start)
            && timestamp(history, "endIso") != null && !timestamp(history, "endIso").isBefore(end);
        boolean incomplete = trace.corruptSlots > 0 || !"OK".equals(traceStatus) || duplicates > 0
            || !historyDeclared || quality == null || !Double.isFinite(quality.optDouble("qualityScore"))
            || quality.optDouble("qualityScore") < 0.8 || !continuousCgm(compact, start, end);
        var models = new HashSet<String>();
        for (Entry row : compact)
            if ("forecast".equals(row.type)) models.add(model(row.original.optJSONObject("payload")));
        var modelList = new ArrayList<>(models);
        java.util.Collections.sort(modelList);

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        line(stream, digest, new JSONObject().put("type", "manifest").put("schema", SCHEMA)
            .put("appVersion", appVersion).put("generatedAt", end.toString()).put("sourceRevision", snapshot.getLong("revision"))
            .put("mode", mode).put("timezone", zone.getId()).put("period", period).put("from", start.toString())
            .put("through", end.toString()).put("coverage", coverage).put("models", new JSONArray(modelList))
            .put("historyDeclaredComplete", historyDeclared)
            .put("cgmQualityScore", quality == null ? JSONObject.NULL : number(quality, "qualityScore"))
            .put("traceRetention", "last_three_utc_days").put("clinicalValidation", false));
        for (Entry row : compact) line(stream, digest, project(row));
        line(stream, null, new JSONObject().put("type", "footer").put("schema", SCHEMA)
            .put("counts", new JSONObject(counts)).put("sha256", hex(digest.digest()))
            .put("hashScope", "UTF-8 manifest and records including LF").put("incomplete", incomplete)
            .put("duplicatesSkipped", duplicates).put("corruptTraceSlots", trace.corruptSlots)
            .put("traceWritesIncomplete", !"OK".equals(traceStatus)));
        stream.flush();
    }

    private List<Entry> collect(JSONObject state, DiagnosticRing.View trace, Instant start, Instant end)
            throws JSONException {
        List<Entry> out = new ArrayList<>();
        add(out, state.optJSONArray("events"), "event", "injection", "administeredAt", start, end);
        add(out, state.optJSONArray("mealSessions"), "event", "meal", "startedAt", start, end);
        add(out, state.optJSONArray("conditionPeriods"), "event", "context", "start", start, end);
        add(out, state.optJSONArray("history"), "setting_change", "audit", "at", start, end);
        add(out, state.optJSONArray("orders"), "setting_change", "order", "effectiveFrom", start, end);
        add(out, state.optJSONArray("coefficients"), "setting_change", "coefficient", "effectiveFrom", start, end);
        add(out, state.optJSONArray("forecastAssessments"), "forecast_assessment", "forecast_assessment", "assessedAt", start, end);
        add(out, state.optJSONArray("forecasts"), "forecast", "forecast", "forecastAt", start, end);
        JSONArray cgm = state.optJSONArray("cgm");
        if (cgm != null) for (int i = 0; i < cgm.length(); i++) {
            JSONObject point = cgm.getJSONObject(i);
            Instant at = Instant.ofEpochMilli(point.getLong("ts"));
            Instant receipt = timestamp(point, "receivedAt");
            if (within(at, start, end) && (receipt == null || !receipt.isAfter(end))) {
                out.add(new Entry("cgm", "cgm", "cgm:" + point.optString("sourceDeviceId") + ":" + at, at, point));
            }
        }
        for (int i = 0; i < trace.traces.size(); i++) {
            JSONObject entry = trace.traces.get(i);
            Instant at = timestamp(entry, "at");
            if (within(at, start, end)) {
                String type = "app_error".equals(entry.optString("operation")) || "cgm_rejected".equals(entry.optString("operation"))
                    ? "error" : "trace";
                out.add(new Entry(type, type, "trace:" + i, at, entry));
            }
        }
        return out;
    }

    private void add(List<Entry> out, JSONArray array, String type, String subtype, String when, Instant start, Instant end)
            throws JSONException {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            JSONObject row = array.getJSONObject(i), data = row.optJSONObject("payload");
            if (data == null) data = row;
            if ("injection".equals(subtype) && !("insulin_injection".equals(row.optString("type"))
                && "confirmed".equals(row.optString("status")))) continue;
            if ("meal".equals(subtype) && row.optJSONObject("actualPlate") == null) continue;
            if ("audit".equals(subtype) && known(row,"domain","profile","coefficients","graphPreferences","coverage",
                "measurements","cgmMetadata","drugs","models","orders") == JSONObject.NULL) continue;
            Instant at = timestamp(data, when);
            if ("context".equals(subtype) && at != null && at.isBefore(start)) {
                Instant close = timestamp(row, "end");
                if (close == null || !close.isBefore(start)) at = start;
            }
            if (within(at, start, end)) out.add(new Entry(type, subtype,
                subtype + ":" + row.optString("id", Integer.toString(i)), at, row));
        }
    }

    private JSONObject project(Entry entry) throws JSONException {
        JSONObject row = entry.original;
        JSONObject out = new JSONObject().put("type", entry.type).put("subtype", entry.subtype)
            .put("at", entry.at.toString()).put("id", alias(entry.key));
        switch (entry.subtype) {
            case "injection":
                out.put("insulin", known(row, "insulinId", "rinfast", "rinfast-nik", "levemir"))
                   .put("units", number(row, "units"));
                if (row.optJSONObject("injectionSite") != null)
                    out.put("site", known(row.optJSONObject("injectionSite"), "region", "abdomen", "arm", "thigh", "buttock"));
                break;
            case "meal":
                JSONObject plate = row.getJSONObject("actualPlate");
                out.put("status", known(row, "status", "started","completed","cancelled"))
                   .put("endedAt", stamp(row, "completedAt")).put("composition", foodValues(plate.optJSONObject("totals")));
                JSONArray items = plate.optJSONArray("items"), result = new JSONArray();
                if (items != null) for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.getJSONObject(i);
                    result.put(foodValues(item).put("amount", number(item, "amount"))
                        .put("unit", known(item, "unit", "г","мл")).put("gi", number(item, "glycemicIndex")));
                }
                out.put("items", result);
                break;
            case "context":
                out.put("kind", known(row, "kind", "sport","illness","activity"))
                   .put("startedAt", stamp(row, "start")).put("endedAt", stamp(row, "end"));
                break;
            case "audit":
                out.put("revision", number(row, "revision")).put("domain", known(row, "domain", "profile","coefficients",
                    "graphPreferences","coverage","measurements","cgmMetadata","drugs","models","orders"));
                JSONObject changes = row.optJSONObject("changes"), compact = new JSONObject();
                if (changes != null) for (String key : new String[]{"illnessFactor","hypoActivityEnabled","exerciseGuidanceEnabled",
                        "coefficientModes","samplingMinutes","qualityScore","showRinfast","showTotal","rangeHours"}) {
                    JSONObject pair = changes.optJSONObject(key);
                    if (pair != null) compact.put(key, new JSONObject().put("before", setting(key,pair.opt("before")))
                        .put("after", setting(key,pair.opt("after"))));
                }
                out.put("changes",compact);
                break;
            case "order":
                out.put("insulin",known(row,"drugId","rinfast","levemir"))
                   .put("units",number(row,"units")).put("until",stamp(row,"effectiveUntil"))
                   .put("scheduleLocal",clock(row,"scheduleLocal"));
                break;
            case "coefficient":
                out.put("kind", known(row, "kind", "carb_g_per_u","isf_mmol_per_u","tdd_u","target_range_mmol"))
                   .put("until", stamp(row, "effectiveUntil")).put("value", number(row, "value"));
                JSONObject window = row.optJSONObject("windowLocal");
                if (window != null) out.put("window", new JSONObject().put("from", clock(window,"from")).put("to",clock(window,"to")));
                JSONObject range = row.optJSONObject("value");
                if (range != null) out.put("value",new JSONObject().put("low",number(range,"low")).put("high",number(range,"high")));
                break;
            case "cgm":
                out.put("source", alias("sensor:" + row.optString("sourceDeviceId"))).put("mmolL", number(row, "mmol"))
                   .put("receivedAt", stamp(row, "receivedAt")).put("valid", bool(row, "valid"))
                   .put("qualityFlag", known(row, "qualityFlag", "ok","invalid"))
                   .put("staleAtReceipt",bool(row,"staleAtReceipt"))
                   .put("provenance", known(row, "source", "xdrip_local","synthetic","device_recorded"));
                break;
            case "forecast":
                JSONObject f = row.getJSONObject("payload");
                out.put("modelId",model(f)).put("modelVersion",version(f,"version"))
                   .put("sourceTime",stamp(f,"sourceTime")).put("sourceRevision",number(f,"sourceRevision"))
                   .put("points", values(f.optJSONArray("points"), "horizonMin","glucoseMmol","lower","upper"));
                JSONObject input = f.optJSONObject("snapshot");
                if (input != null) out.put("source", alias("sensor:" + input.optString("sensorSourceId")));
                break;
            case "forecast_assessment":
                JSONObject assessment = row.getJSONObject("payload");
                out.put("forecast",alias("forecast:"+assessment.optString("forecastId")))
                    .put("checks", values(assessment.optJSONArray("checks"),"horizonMin","predictedMmol","actualMmol","absoluteErrorMmol","errorMmol"));
                break;
            default:
                out.put("operation", known(row, "operation","storage_commit","forecast_attempt","basal_review","app_error","cgm_rejected"))
                   .put("sourceRevision", number(row,"sourceRevision")).put("modelVersion",version(row,"modelVersion"))
                   .put("modelId",known(row,"modelId","GFForecast","GFLevemirReview","GFConsensus"))
                   .put("measuredAt",stamp(row,"measuredAt")).put("receivedAt",stamp(row,"receivedAt"))
                   .put("status",known(row,"status","OK","BLOCKED","UNAVAILABLE","EXPERIMENTAL","NOT_ESTIMABLE","FORMULA_SPEC_GAP"))
                   .put("code",known(row,"code","FORMULA_SPEC_GAP","SOURCE_NOT_TRUSTED","NO_SOURCE",
                       "MEAL_COVERAGE","INJECTION_COVERAGE","COEFFICIENT_UNKNOWN","STALE_CGM","REVISION_CHANGED","INPUT_READ_FAILED"))
                   .put("formula",known(row,"formula","OBSERVED_WINDOW_DELTA","GFFORECAST_V01"))
                   .put("baselineMmol",number(row,"baselineMmol")).put("slopeMmolMin",number(row,"slopeMmolMin"))
                   .put("eligibleWindows",number(row,"eligibleWindows"))
                   .put("points",values(row.optJSONArray("points"),"horizonMin","glucoseMmol","lower","upper"));
        }
        return out;
    }

    private String alias(String key) {
        return aliases.computeIfAbsent(key, ignored -> "ref-" + (aliases.size() + 1));
    }

    private static Object setting(String key, Object value) throws JSONException {
        if (value instanceof Number || value instanceof Boolean) return value;
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value;
            if ("illnessFactor".equals(key)) return new JSONObject().put("value",number(object,"value"));
            if ("coefficientModes".equals(key)) return new JSONObject().put("carb_g_per_u",known(object,"carb_g_per_u","manual","auto"))
                .put("isf_mmol_per_u",known(object,"isf_mmol_per_u","manual","auto"));
        }
        return JSONObject.NULL;
    }

    private static JSONArray values(JSONArray rows, String... keys) throws JSONException {
        var out = new JSONArray();
        if (rows != null) for (int i = 0; i < rows.length(); i++) {
            JSONObject source = rows.getJSONObject(i), compact = new JSONObject();
            for (String key : keys) compact.put(key, number(source, key));
            out.put(compact);
        }
        return out;
    }

    private static JSONObject foodValues(JSONObject input) throws JSONException {
        JSONObject out = new JSONObject();
        for (String field : new String[]{"carbs","fat","protein","kcal"})
            out.put(field, input == null ? JSONObject.NULL : number(input, field));
        return out;
    }

    private static String model(JSONObject input) {
        if (input == null || !input.has("modelId")) return "GFForecast";
        Object id = known(input, "modelId", "GFForecast","GFxDrip","GFAPSEnhancer","GFConsensus");
        return id instanceof String ? (String)id : "UNKNOWN";
    }

    private static Object number(JSONObject input, String key) {
        return input.opt(key) instanceof Number ? input.opt(key) : JSONObject.NULL;
    }

    private static Object bool(JSONObject input, String key) {
        return input.opt(key) instanceof Boolean ? input.opt(key) : JSONObject.NULL;
    }

    private static Object known(JSONObject input, String key, String... choices) {
        String raw = input.optString(key);
        for (String choice : choices) if (choice.equals(raw)) return choice;
        return JSONObject.NULL;
    }

    private static Object version(JSONObject input, String key) {
        String raw = input.optString(key);
        return VERSION.matcher(raw).matches() ? raw : JSONObject.NULL;
    }

    private static Object clock(JSONObject input, String key) {
        String raw = input.optString(key);
        return raw.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]") ? raw : JSONObject.NULL;
    }

    private static Object stamp(JSONObject input, String key) {
        Instant at = timestamp(input,key);
        return at == null ? JSONObject.NULL : at.toString();
    }

    private static Instant timestamp(JSONObject input, String key) {
        try { return Instant.parse(input.optString(key)); }
        catch (RuntimeException missing) { return null; }
    }

    private static boolean within(Instant at, Instant start, Instant end) {
        return at != null && !at.isBefore(start) && !at.isAfter(end);
    }

    private static boolean continuousCgm(List<Entry> ordered, Instant from, Instant end) {
        Instant previous = from;
        String source = null;
        for (Entry event : ordered) {
            if (!"cgm".equals(event.type)) continue;
            JSONObject point = event.original;
            if (!point.optBoolean("valid", true) || "invalid".equals(point.optString("qualityFlag"))
                    || !point.has("receivedAt") || point.isNull("receivedAt")) continue;
            String nextSource = point.optString("sourceDeviceId");
            if (nextSource.isEmpty() || (source != null && !source.equals(nextSource))
                    || event.at.isAfter(previous.plusSeconds(15 * 60))) return false;
            previous = event.at;
            source = nextSource;
        }
        return source != null && !end.isAfter(previous.plusSeconds(15 * 60));
    }

    private static void line(OutputStream stream, MessageDigest digest, JSONObject entry) throws IOException {
        byte[] bytes = (entry.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        stream.write(bytes);
        if (digest != null) digest.update(bytes);
    }

    private static String hex(byte[] bytes) {
        char[] alphabet = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            result[i*2] = alphabet[(bytes[i] >>> 4) & 15];
            result[i*2+1] = alphabet[bytes[i] & 15];
        }
        return new String(result);
    }
}
