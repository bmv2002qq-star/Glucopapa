package org.glukopapa.v3.m00

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneOffset

/** Test-only wiring to native GFStorage. All rows and registry grants are synthetic fixtures. */
@RunWith(AndroidJUnit4::class)
class Q13HistoryPreflightInstrumentedTest {
    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val profile = "qa-q13-history"
    private val owner = GfV3Q13HistoryPreflight.OWNER
    private val end = Instant.parse("2024-08-31T12:00:00Z")
    private val scopes = GfV3Q13HistoryPreflight.domains.associateWith { "research" }

    private fun withStorage(block: (GfDbHelper, GfV3Storage) -> Unit) {
        ctx.deleteDatabase("glukopapa_v3.db")
        val helper = GfDbHelper(ctx)
        try {
            fun asset(name: String) = ctx.assets.open("db/$name").bufferedReader().use { it.readText() }
            val storage = GfV3Storage(helper, asset("module_catalog_v1.json"), asset("writer_grants_v0.12.json"))
            storage.initializeProfile(profile, "UTC", storage.revision())
            block(helper, storage)
        } finally {
            helper.close()
            ctx.deleteDatabase("glukopapa_v3.db")
        }
    }

    private fun grant(helper: GfDbHelper) {
        helper.writableDatabase.execSQL(
            "UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1,read_roles_json=? WHERE module_id=?",
            arrayOf("[\"research\"]", owner)
        )
    }

    @Test
    fun q13NativePreflightKeepsSixMonthBoundaryAcrossPagesAndExcludesForeignProfile() = withStorage { helper, storage ->
        grant(helper)
        val boundary = end.atOffset(ZoneOffset.UTC).minusMonths(6).toInstant()
        val db = helper.writableDatabase
        val insert = "INSERT INTO v3_cgm(observation_id,profile_id,measured_at_utc,glucose_mmol_l,source_device_id,provenance,quality,payload_json,created_revision) VALUES(?,?,?,6.5,'q13-fixture','synthetic','QA_ONLY','{}',1)"
        db.beginTransaction()
        try {
            db.compileStatement(insert).use { stmt ->
                fun add(id: String, profileId: String, utc: String) {
                    stmt.bindString(1, id)
                    stmt.bindString(2, profileId)
                    stmt.bindString(3, utc)
                    stmt.executeInsert()
                }
                add("before", profile, boundary.minusNanos(1).toString())
                add("after", profile, end.plusNanos(1).toString())
                add("foreign", "qa-q13-other-profile", boundary.toString())
                add("unplaced", profile, "unknown")
                for (i in 0 until 52_560) {
                    add("q13-$i", profile, boundary.plusSeconds(i * 300L).toString())
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        val revision = storage.revision()
        val result = GfV3Q13HistoryPreflight.run(storage, end)
        assertEquals(profile, result.stamp.profile)
        assertEquals(revision, result.stamp.revision)
        assertEquals("NOT_PROVEN", result.coverage)
        assertEquals(boundary, result.boundary)
        assertEquals(scopes.keys, result.counts.keys)
        val cgm = result.counts.getValue("cgm")
        assertEquals(106L, cgm.pages)
        assertEquals(52_561L, cgm.rows)
        assertEquals(52_560L, cgm.inSixMonths)
        assertEquals(1L, cgm.earlierContext)
        assertEquals(1L, cgm.unplaced)
        assertEquals(52_563L, cgm.sourceScanned)
        assertEquals(revision, storage.revision())
    }

    @Test
    fun q13NativePreflightRejectsMissingGrantAndSameRevisionRestoreBetweenDomains() = withStorage { helper, storage ->
        val denied = runCatching { GfV3Q13HistoryPreflight.run(storage, end) }.exceptionOrNull()
        assertTrue("Unaccepted owner must be denied", denied is SecurityException)
        assertEquals("NATIVE_MODULE_NOT_ACCEPTED", denied?.message)
        grant(helper)
        val revision = storage.revision()
        val pass = "q13-synthetic-restore".toCharArray()
        val codec = GfV3EncryptedSnapshot(ctx, helper)
        val data = codec.createEncrypted(pass)
        val native = storage.openNativeYearSession(owner, scopes, end)
        var closed = false
        try {
            val session = object : GfV3Q13HistoryPreflight.Session {
                override fun read(domain: String, pageSize: Int): JSONObject {
                    if (domain == "events") codec.restoreEncrypted(data, pass, revision)
                    return native.read(domain, pageSize)
                }

                override fun finish() = native.finish()

                override fun close() {
                    closed = true
                    native.close()
                }
            }
            val failure = runCatching { GfV3Q13HistoryPreflight.scan(session, end) }.exceptionOrNull()
            assertEquals("RESTORE_EPOCH_CHANGED", failure?.message)
            assertTrue("Failed scan must close the native session", closed)
            assertEquals(revision, storage.revision())
            assertTrue(GfV3Q13HistoryPreflight.run(storage, end).counts.values.all { it.rows == 0L })
        } finally {
            native.close()
            pass.fill('\u0000')
            data.fill(0)
        }
    }
}
