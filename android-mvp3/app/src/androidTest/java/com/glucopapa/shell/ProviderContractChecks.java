package com.glucopapa.shell;

import android.database.MatrixCursor;
import org.json.JSONObject;

/** Cursor shape from the published provider contract, using only synthetic observations. */
public final class ProviderContractChecks {
    public static void run() throws Exception {
        long receipt = 1_794_993_000_000L;
        try (MatrixCursor cursor = new MatrixCursor(new String[]{"timestamp", "mgdl", "delta_name", "isstale"})) {
            cursor.addRow(new Object[]{receipt - 300_000, 108.09354, "FortyFiveDown", 0});
            cursor.addRow(new Object[]{receipt - 600_000, 105, "invalid", null});
            cursor.addRow(new Object[]{receipt + 1, 108, "Flat", 0});
            cursor.addRow(new Object[]{receipt - 300_000, "108", "Flat", 0});
            cursor.moveToFirst();
            JSONObject first = read(cursor, receipt);
            check("MEASUREMENT".equals(first.getString("status")) && first.getLong("measuredAtMs") == receipt - 300_000 &&
                first.getLong("receivedAtMs") == receipt && first.getDouble("mgdl") == 108.09354 &&
                "FortyFiveDown".equals(first.getString("direction")) && !first.getBoolean("stale"));
            cursor.moveToNext();
            JSONObject missing = read(cursor, receipt);
            check("MEASUREMENT".equals(missing.getString("status")) && missing.isNull("direction") && missing.isNull("stale"));
            cursor.moveToNext();
            check("INVALID_MEASUREMENT".equals(read(cursor, receipt).getString("status")));
            cursor.moveToNext();
            check("INVALID_MEASUREMENT".equals(read(cursor, receipt).getString("status")));
        }
    }

    private static JSONObject read(MatrixCursor cursor, long receipt) throws Exception {
        return new JSONObject(GFNativeXDrip.readMeasurement(cursor, receipt));
    }

    private static void check(boolean condition) {
        if (!condition) throw new IllegalStateException("Android xDrip+ Cursor contract differs");
    }
}
