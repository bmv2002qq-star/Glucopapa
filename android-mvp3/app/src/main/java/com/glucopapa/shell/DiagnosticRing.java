package com.glucopapa.shell;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/** Local diagnostic files only. Ordinary facts remain owned by GFStorage. */
final class DiagnosticRing {
    static final long DAY = 86_400_000L;
    static final long LIMIT = 4_194_304L;
    private final Path directory;

    static final class View {
        final List<JSONObject> traces = new ArrayList<>();
        int corruptSlots;
    }

    DiagnosticRing(Path directory) {
        this.directory = directory;
    }

    synchronized void append(String mode, long at, JSONObject trace) throws IOException, JSONException {
        if (!"local".equals(mode) && !"demo".equals(mode)) throw new IllegalArgumentException("TRACE_MODE");
        long day = Math.floorDiv(at, DAY);
        recover(day);
        Path file = slot((int)Math.floorMod(day, 3L));
        Path pending = temp(file);
        String header = day + "\n";
        boolean append = Files.exists(file) && dayOf(file) == day;
        if (Files.exists(file) && dayOf(file) > day) throw new IOException("TRACE_CLOCK_REVERSED");
        var record = new JSONObject(trace.toString()).put("mode", mode).put("at", Instant.ofEpochMilli(at).toString());
        byte[] row = (record.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        long existing = append ? Files.size(file) : header.length();
        if (existing + row.length > LIMIT) throw new IOException("TRACE_SLOT_LIMIT");
        try {
            try (var out = new FileOutputStream(pending.toFile())) {
                if (append) Files.copy(file, out);
                else out.write(header.getBytes(StandardCharsets.UTF_8));
                out.write(row);
                out.getFD().sync();
            }
            Files.move(pending, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(pending);
        }
    }

    synchronized View read(String mode, Instant from, Instant to, long maxRevision) throws IOException {
        long day = Math.floorDiv(to.toEpochMilli(), DAY);
        View out = new View();
        recover(day);
        for (long selected = day - 2; selected <= day; selected++) {
            Path file = slot((int)Math.floorMod(selected, 3L));
            if (!Files.exists(file)) continue;
            if (dayOf(file) == Long.MIN_VALUE || Files.size(file) > LIMIT || !complete(file)) {
                out.corruptSlots++;
                continue;
            }
            if (dayOf(file) != selected) continue;
            var records = new ArrayList<JSONObject>();
            try (var in = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                in.readLine();
                for (String line; (line = in.readLine()) != null; ) {
                    JSONObject trace = new JSONObject(line);
                    Instant at = Instant.parse(trace.getString("at"));
                    if (Math.floorDiv(at.toEpochMilli(), DAY) != selected)
                        throw new IOException("TRACE_WRONG_SLOT");
                    long revision = trace.getLong("sourceRevision");
                    if (mode.equals(trace.getString("mode")) && !at.isBefore(from) && !at.isAfter(to)
                            && revision >= 0 && revision <= maxRevision) records.add(trace);
                }
                out.traces.addAll(records);
            } catch (IOException | JSONException | RuntimeException corrupt) {
                out.corruptSlots++;
            }
        }
        return out;
    }

    private void recover(long day) throws IOException {
        Files.createDirectories(directory);
        for (int i = 0; i < 3; i++) {
            Path file = slot(i);
            Files.deleteIfExists(temp(file));
            if (!Files.exists(file)) continue;
            long stored = dayOf(file);
            if (stored != Long.MIN_VALUE && stored < day - 2) Files.delete(file);
        }
    }

    Path slot(int index) {
        return directory.resolve("trace-" + (index + 1) + ".log");
    }

    private static Path temp(Path file) {
        return file.resolveSibling(file.getFileName() + ".new");
    }

    private static boolean complete(Path file) {
        try (var in = new RandomAccessFile(file.toFile(), "r")) {
            if (in.length() == 0) return false;
            in.seek(in.length() - 1);
            return in.read() == '\n';
        } catch (IOException invalid) {
            return false;
        }
    }

    private static long dayOf(Path file) {
        try (var in = Files.newInputStream(file)) {
            var header = new StringBuilder();
            for (int c; (c = in.read()) != -1 && c != '\n'; ) {
                if (header.length() >= 20) return Long.MIN_VALUE;
                header.append((char)c);
            }
            return Long.parseLong(header.toString());
        } catch (IOException | NumberFormatException invalid) {
            return Long.MIN_VALUE;
        }
    }
}
