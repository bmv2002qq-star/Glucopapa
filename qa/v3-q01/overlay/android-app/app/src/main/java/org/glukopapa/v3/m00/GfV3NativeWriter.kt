package org.glukopapa.v3.m00

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

/**
 * Internal Kotlin-only transactional writer infrastructure. There is NO WebView method to invoke this class. Owner grants are recorded now;
 * medical writes operate through trusted installed Kotlin adapters only.
 */
internal class GfV3NativeWriter(private val helper: GfDbHelper) {
    private val mutex = Any()
    private val extended = GfV3DomainWriter(helper)

    private fun moduleHasWriteRole(db: SQLiteDatabase, moduleId: String, role: String): Boolean =
        db.rawQuery("SELECT status,feature_enabled,write_roles_json FROM v3_module_registry WHERE module_id=?",arrayOf(moduleId)).use { c ->
            if (!c.moveToFirst()) false
            else {
                val a=JSONArray(c.getString(2))
                val roles=(0 until a.length()).map(a::getString).toSet()
                val allowedByRegistry=GfV3PortContract.nativeModuleWriteAllowed(
                    role,c.getString(0)=="OWNER_INTEGRATION_ACCEPTED",c.getInt(1)==1,roles)
                // The explicit owner grant is necessary in addition to trusted native binding.
                val granted=db.rawQuery("SELECT 1 FROM v3_write_grants WHERE module_id=? AND role=? AND grant_status='OWNER_GRANTED_EXPERIMENTAL' AND implementation_status='PREPARED_NATIVE'",arrayOf(moduleId,role)).use { g -> g.moveToFirst() }
                allowedByRegistry && granted && !moduleId.startsWith("SYS-")
            }
        }

    private fun sha256(input: String): String = MessageDigest.getInstance("SHA-256")
        .digest(input.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /**
     * One atomic revision for each observed CGM, confirmed action, calculation, or
     * applied coefficient. Never accept a synthetic fixture as a real observation.
     * Inputs are structured and validated here, not arbitrary SQL submitted from JS.
     */
    fun append(
        trustedNativeModule: String,
        role: String,
        idempotencyKey: String,
        expectedRevision: Long,
        payload: JSONObject,
        nativeTransportAuthenticated: Boolean = false
    ): JSONObject = synchronized(mutex) {
        if(role in setOf("mealFlow","conditionWriter","settingsWriter","mealTimingPublisher","syncWriter"))
            return@synchronized extended.append(trustedNativeModule,role,idempotencyKey,expectedRevision,payload,nativeTransportAuthenticated)
        require(GfV3WriteContract.validId(idempotencyKey)) { "IDEMPOTENCY_KEY_INVALID" }
        val roleDomain=mapOf(
            "actionWriter" to "events", "cgmAdapter" to "cgm",
            "forecastWriter" to "forecasts", "coefficientWriter" to "settings"
        )
        val domain=roleDomain[role] ?: throw SecurityException("WRITE_ROLE_UNSUPPORTED")
        val recordId=when(role) {
            "actionWriter" -> payload.getString("eventId")
            "cgmAdapter" -> payload.getString("observationId")
            "forecastWriter" -> payload.getString("resultId")
            else -> payload.getString("coefficientId")
        }
        require(GfV3WriteContract.validId(recordId)) { "RECORD_ID_INVALID" }
        val fingerprint=sha256(role+"|"+recordId+"|"+payload.toString())
        val db=helper.writableDatabase
        db.beginTransaction()
        try {
            if(!moduleHasWriteRole(db,trustedNativeModule,role))throw SecurityException("NATIVE_WRITER_PERMISSION_DENIED")
            val meta=db.rawQuery("SELECT revision,profile_id,input_revision FROM v3_meta WHERE id=1",null).use { c ->
                if(!c.moveToFirst())throw IllegalStateException("V3_META_MISSING")
                Triple(c.getLong(0),if(c.isNull(1))null else c.getString(1),c.getLong(2))
            }
            val profileId=meta.second ?: throw IllegalStateException("PROFILE_UNCONFIGURED")
            val duplicate=db.rawQuery("SELECT profile_id,domain,record_id,fingerprint,revision FROM v3_write_receipts WHERE idempotency_key=?",arrayOf(idempotencyKey)).use { c ->
                if(c.moveToFirst())listOf(c.getString(0),c.getString(1),c.getString(2),c.getString(3),c.getLong(4).toString()) else null
            }
            if(duplicate!=null){
                if(duplicate[0]!=profileId||duplicate[1]!=domain||duplicate[2]!=recordId||duplicate[3]!=fingerprint)
                    throw IllegalStateException("IDEMPOTENCY_CONFLICT")
                db.setTransactionSuccessful()
                return@synchronized JSONObject().put("created",false).put("revision",duplicate[4].toLong()).put("recordId",recordId)
            }
            val otherReceipt=db.rawQuery("SELECT 1 FROM v3_extended_receipts WHERE idempotency_key=?",arrayOf(idempotencyKey)).use { it.moveToFirst() }
            if(otherReceipt)throw IllegalStateException("IDEMPOTENCY_KEY_REUSED_ACROSS_DOMAINS")
            if(role=="forecastWriter") {
                val sourceRevision=payload.getLong("sourceRevision")
                GfV3InputRevision.requireCalculated(expectedRevision,sourceRevision,meta.third)
            } else GfV3WriteContract.requireExpectedRevision(expectedRevision,meta.first)
            val next=meta.first+1
            val source=trustedNativeModule
            val occurred=when(role) {
                "actionWriter" -> {
                    val kind=payload.getString("eventType")
                    val status=payload.getString("status")
                    val t=payload.getString("occurredAtUtc")
                    GfV3WriteContract.validateRealEvent(kind,status,recordId,idempotencyKey,t)
                    // A calculation is never accepted as an actual action.
                    require(payload.optString("provenance") == "CONFIRMED_ACTUAL") { "ACTION_NOT_CONFIRMED" }
                    db.insertOrThrow("v3_events",null,ContentValues().apply {
                        put("event_id",recordId);put("profile_id",profileId);put("event_type",kind)
                        put("event_status",status);put("occurred_at_utc",t);put("payload_json",payload.toString())
                        put("source_module",source);put("idempotency_key",idempotencyKey);put("created_revision",next)
                    });t
                }
                "cgmAdapter" -> {
                    val t=payload.getString("measuredAtUtc")
                    val provenance=payload.getString("provenance")
                    val mmol=payload.getDouble("glucoseMmolL")
                    val device=payload.getString("sourceDeviceId")
                    GfV3WriteContract.validateObservedCgm(provenance,mmol,device,t)
                    require(payload.optString("quality").isNotBlank()) { "CGM_QUALITY_REQUIRED" }
                    db.insertOrThrow("v3_cgm",null,ContentValues().apply {
                        put("observation_id",recordId);put("profile_id",profileId);put("measured_at_utc",t)
                        put("glucose_mmol_l",mmol);put("source_device_id",device);put("provenance",provenance)
                        put("quality",payload.getString("quality"));put("payload_json",payload.toString());put("created_revision",next)
                    });t
                }
                "forecastWriter" -> {
                    val t=payload.getString("calculatedAtUtc")
                    val status=payload.getString("resultStatus")
                    val sourceRevision=payload.getLong("sourceRevision")
                    GfV3WriteContract.validateCalculated(status,sourceRevision,meta.third,payload.getString("inputDigest"))
                    GfV3WriteContract.requireUtc(t)
                    db.insertOrThrow("v3_forecasts",null,ContentValues().apply {
                        put("result_id",recordId);put("profile_id",profileId)
                        put("model_id",payload.getString("modelId"));put("model_version",payload.getString("modelVersion"))
                        put("result_status",status);put("source_revision",sourceRevision);put("calculated_at_utc",t)
                        put("input_digest",payload.getString("inputDigest"));put("payload_json",payload.toString());put("created_revision",next)
                    });t
                }
                "coefficientWriter" -> {
                    val kind=payload.getString("kind")
                    val slot=if(payload.isNull("slotId"))null else payload.getString("slotId")
                    val mode=payload.getString("mode")
                    val value=payload.getDouble("value")
                    val t=payload.getString("effectiveFromUtc")
                    val accepted=payload.optBoolean("ownerApproved",false)
                    require(accepted) { "COEFFICIENT_APPLICATION_NOT_APPROVED" }
                    require(kind in setOf("carb_g_per_u","isf_mmol_per_u","illness_factor","activity_factor")) { "COEFFICIENT_KIND_INVALID" }
                    require((kind in setOf("carb_g_per_u","isf_mmol_per_u") && slot in setOf("00-06","06-12","12-18","18-00")) ||
                        (kind in setOf("illness_factor","activity_factor") && slot==null)) { "COEFFICIENT_SLOT_INVALID" }
                    require(value.isFinite()&&value>0 && mode in setOf("manual","auto")) { "COEFFICIENT_VALUE_INVALID" }
                    GfV3WriteContract.requireUtc(t)
                    val old=db.rawQuery("SELECT value,mode FROM v3_coefficients WHERE profile_id=? AND kind=? AND COALESCE(slot_id,'__GLOBAL__')=? ORDER BY created_revision DESC LIMIT 1",arrayOf(profileId,kind,slot?:"__GLOBAL__")).use { c -> if(c.moveToFirst())Pair(c.getDouble(0),c.getString(1)) else null }
                    db.insertOrThrow("v3_coefficients",null,ContentValues().apply {
                        put("coefficient_id",recordId);put("profile_id",profileId);put("kind",kind);put("slot_id",slot)
                        put("value",value);put("mode",mode);put("source",source);put("effective_from_utc",t);put("created_revision",next)
                    })
                    db.insertOrThrow("v3_coefficient_history",null,ContentValues().apply {
                        put("history_id","hist-"+recordId);put("profile_id",profileId);put("coefficient_id",recordId)
                        put("kind",kind);put("slot_id",slot)
                        if(old==null)putNull("old_value") else put("old_value",old.first)
                        put("new_value",value)
                        if(old==null)putNull("old_mode") else put("old_mode",old.second)
                        put("new_mode",mode);put("applied_at_utc",t);put("source",source);put("created_revision",next)
                    });t
                }
                else -> error("UNREACHABLE_DOMAIN")
            }
            val now=Instant.now().toString()
            val newInputRevision=GfV3InputRevision.afterCommit(role!="forecastWriter",next,meta.third)
            val changed=db.compileStatement("UPDATE v3_meta SET revision=?,input_revision=? WHERE id=1 AND revision=? AND input_revision=?")
            val count=try { changed.bindLong(1,next);changed.bindLong(2,newInputRevision);changed.bindLong(3,meta.first);changed.bindLong(4,meta.third);changed.executeUpdateDelete() } finally {changed.close()}
            if(count!=1)throw IllegalStateException("V3_REVISION_CONFLICT")
            db.insertOrThrow("v3_write_receipts",null,ContentValues().apply {
                put("idempotency_key",idempotencyKey);put("profile_id",profileId);put("domain",domain)
                put("record_id",recordId);put("fingerprint",fingerprint);put("revision",next);put("source_module",source)
            })
            db.insertOrThrow("v3_audit",null,ContentValues().apply {
                put("revision",next);put("domain",domain);put("record_id",recordId)
                put("action",role);put("source_module",source);put("at_utc",now)
            })
            db.insertOrThrow("v3_change_feed",null,ContentValues().apply {
                put("revision",next);put("domain",domain);put("record_id",recordId)
                put("source_module",source);put("created_at_utc",now)
            })
            db.setTransactionSuccessful()
            JSONObject().put("created",true).put("revision",next).put("recordId",recordId)
                .put("occurredAtUtc",occurred).put("domain",domain)
        } finally { db.endTransaction() }
    }
}
