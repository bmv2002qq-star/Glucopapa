package org.glukopapa.v3.m00

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest
import java.time.Instant

/**
 * New V3 domains. Kotlin-only: there is NO JavascriptInterface entry point.
 * Native adapter identity is fixed by the Android module installer, not by WebView JSON.
 * All changes, receipts, audit and change notification commit in one SQLite transaction.
 */
internal class GfV3DomainWriter(private val helper: GfDbHelper) {
    private val lock = Any()
    private val roleDomain = mapOf(
        "mealFlow" to "mealSessions", "conditionWriter" to "conditionPeriods",
        "settingsWriter" to "settings", "mealTimingPublisher" to "mealTiming", "syncWriter" to "syncInbox"
    )
    private fun hash(s: String) = MessageDigest.getInstance("SHA-256")
        .digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun validId(s: String) = GfV3WriteContract.validId(s)
    private fun requiredUtc(s: String) = GfV3WriteContract.requireUtc(s)

    private fun roleAllowed(db: SQLiteDatabase, module: String, role: String): Boolean {
        val bound=db.rawQuery("SELECT status,feature_enabled,write_roles_json FROM v3_module_registry WHERE module_id=?",arrayOf(module)).use { c ->
            if(!c.moveToFirst()) false else {
                val rs=JSONArray(c.getString(2));val roles=(0 until rs.length()).map(rs::getString).toSet()
                GfV3PortContract.nativeModuleWriteAllowed(role,c.getString(0)=="OWNER_INTEGRATION_ACCEPTED",c.getInt(1)==1,roles)
            }
        }
        val grant=db.rawQuery("SELECT 1 FROM v3_write_grants WHERE module_id=? AND role=? AND grant_status='OWNER_GRANTED_EXPERIMENTAL' AND implementation_status='PREPARED_NATIVE'", arrayOf(module,role)).use { it.moveToFirst() }
        return bound && grant && !module.startsWith("SYS-")
    }
    private fun checkKeyAcrossBoth(db:SQLiteDatabase,key:String):Boolean =
        db.rawQuery("SELECT 1 FROM v3_write_receipts WHERE idempotency_key=?",arrayOf(key)).use { it.moveToFirst() }
    private fun payloadId(role: String,p:JSONObject) = when(role) {
        "mealFlow" -> p.getString("sessionId")
        "conditionWriter" -> p.getString("periodId")
        "settingsWriter" -> p.getString("settingChangeId")
        "mealTimingPublisher" -> p.getString("timingId")
        "syncWriter" -> p.getString("inboxId")
        else -> error("UNSUPPORTED_ROLE")
    }

    fun append(module: String, role: String, key: String, expectedRevision: Long,
               payload: JSONObject, nativeTransportAuthenticated:Boolean=false): JSONObject = synchronized(lock) {
        require(role in roleDomain) { "WRITER_ROLE_NOT_IMPLEMENTED" }
        require(validId(key)) { "INVALID_IDEMPOTENCY_KEY" }
        val recordId=payloadId(role,payload)
        require(validId(recordId)) { "INVALID_RECORD_ID" }
        val domain=roleDomain.getValue(role)
        val fingerprint=hash(role+"|"+recordId+"|"+payload.toString())
        val db=helper.writableDatabase
        db.beginTransaction()
        try {
            if(!roleAllowed(db,module,role)) throw SecurityException("NATIVE_WRITER_PERMISSION_DENIED")
            val m=db.rawQuery("SELECT revision,profile_id,input_revision FROM v3_meta WHERE id=1",null).use { c ->
                if(!c.moveToFirst()) throw IllegalStateException("V3_META_MISSING")
                Triple(c.getLong(0),if(c.isNull(1))null else c.getString(1),c.getLong(2))
            }
            val profileId=m.second ?: throw IllegalStateException("PROFILE_UNCONFIGURED")
            val prior=db.rawQuery("SELECT profile_id,domain,record_id,fingerprint,revision FROM v3_extended_receipts WHERE idempotency_key=?",arrayOf(key)).use { c ->
                if(c.moveToFirst()) listOf(c.getString(0),c.getString(1),c.getString(2),c.getString(3),c.getLong(4).toString()) else null
            }
            if(prior!=null) {
                if(prior[0]!=profileId || prior[1]!=domain || prior[2]!=recordId || prior[3]!=fingerprint)
                    throw IllegalStateException("IDEMPOTENCY_CONFLICT")
                db.setTransactionSuccessful()
                return@synchronized JSONObject().put("created",false).put("revision",prior[4].toLong()).put("recordId",recordId)
            }
            if(checkKeyAcrossBoth(db,key)) throw IllegalStateException("IDEMPOTENCY_KEY_REUSED_ACROSS_DOMAINS")
            if(role=="mealTimingPublisher") {
                GfV3InputRevision.requireCalculated(expectedRevision,payload.getLong("sourceRevision"),m.third)
            } else GfV3WriteContract.requireExpectedRevision(expectedRevision,m.first)
            val next=m.first+1
            val now=Instant.now().toString()
            when(role) {
                "settingsWriter" -> {
                    val setting=payload.getString("settingKey")
                    require(setting in setOf("childProfile","nutritionReference","foodModel","activityPreferences","target","graphPreferences","syncPreferences","nutritionFavorites","measurement",GfV3SettingsModeContract.KEY)) { "UNKNOWN_SETTING_KEY" }
                    val value=payload.getJSONObject("value")
                    if(setting=="childProfile") GfV3ProfileContract.validate(value)
                    if(setting in setOf("childProfile","nutritionReference","target","foodModel","graphPreferences","activityPreferences",GfV3SettingsModeContract.KEY)) GfV3SettingsModeContract.validateSetting(setting,value)
                    val requestedZone=if(setting=="childProfile") GfV3SettingsModeContract.validateZone(value) else null
                    if(requestedZone!=null) {
                        db.execSQL("UPDATE v3_meta SET timezone=? WHERE id=1 AND profile_id=?",arrayOf(requestedZone,profileId))
                    }
                    if(payload.optString("effectiveAtUtc").isNotBlank()) requiredUtc(payload.getString("effectiveAtUtc"))
                    require(value.toString().length<=16384) { "SETTING_TOO_LARGE" }
                    if(setting=="measurement") {
                        val weight=value.getDouble("weightKg")
                        val height=value.getDouble("heightCm")
                        val at=value.getString("measuredAtUtc");requiredUtc(at)
                        require(weight.isFinite() && weight in 1.0..300.0 && height.isFinite() && height in 20.0..250.0) { "MEASUREMENT_OUT_OF_RANGE" }
                        db.insertOrThrow("v3_measurements",null,ContentValues().apply {
                            put("measurement_id",recordId);put("profile_id",profileId);put("measured_at_utc",at)
                            put("weight_kg",weight);put("height_cm",height)
                            put("source_module",module);put("created_revision",next)
                        })
                    }
                    val old=db.rawQuery("SELECT value_json FROM v3_profile_settings WHERE profile_id=? AND setting_key=?",arrayOf(profileId,setting)).use { c -> if(c.moveToFirst()) c.getString(0) else null }
                    val settingRow=ContentValues().apply {
                        put("profile_id",profileId);put("setting_key",setting);put("value_json",value.toString());put("updated_revision",next)
                    }
                    if(old==null) db.insertOrThrow("v3_profile_settings",null,settingRow)
                    else db.update("v3_profile_settings",settingRow,"profile_id=? AND setting_key=?",arrayOf(profileId,setting))
                    db.insertOrThrow("v3_setting_history",null,ContentValues().apply {
                        put("entry_id",recordId);put("profile_id",profileId);put("setting_key",setting)
                        if(old==null)putNull("old_value_json") else put("old_value_json",old)
                        put("new_value_json",value.toString());put("source_module",module)
                        put("changed_at_utc",now);put("effective_at_utc",payload.optString("effectiveAtUtc").takeIf { it.isNotBlank() } ?: now)
                        put("created_revision",next)
                    })
                }
                "mealFlow" -> {
                    val status=payload.getString("status")
                    require(status in setOf("planned","in_progress","completed","cancelled")) { "MEAL_STATUS_INVALID" }
                    require(!payload.isNull("plannedPlate")) { "MEAL_PLANNED_PLATE_REQUIRED" }
                    GfV3PlateContract.validate(payload.getJSONObject("plannedPlate"),"PLANNED")
                    val previous=db.rawQuery("SELECT session_status,payload_json FROM v3_meal_sessions WHERE session_id=? AND profile_id=?",arrayOf(recordId,profileId)).use { c ->
                        if(c.moveToFirst()) Pair(c.getString(0),c.getString(1)) else null
                    }
                    if(previous==null) {
                        require(status=="planned") { "MEAL_MUST_BEGIN_PLANNED" }
                    } else {
                        val storedOwner=db.rawQuery(
                            "SELECT source_module FROM v3_record_owners WHERE profile_id=? AND domain='mealSessions' AND record_id=?",
                            arrayOf(profileId,recordId)).use { c -> if(c.moveToFirst())c.getString(0) else null }
                        if(storedOwner!=module) throw SecurityException("MEAL_OWNER_MISMATCH")
                        require(JSONObject(previous.second).getJSONObject("plannedPlate").toString()==payload.getJSONObject("plannedPlate").toString()) { "MEAL_PLAN_IMMUTABLE" }
                        require(when(previous.first) {
                            "planned" -> status in setOf("in_progress","cancelled")
                            "in_progress" -> status in setOf("completed","cancelled")
                            else -> false
                        }) { "MEAL_TRANSITION_INVALID" }
                    }
                    if(status=="completed") {
                        require(payload.optBoolean("userConfirmed",false) && !payload.isNull("actualPlate")) { "ACTUAL_PLATE_CONFIRMATION_REQUIRED" }
                        GfV3PlateContract.validate(payload.getJSONObject("actualPlate"),"ACTUAL")
                        val ev=payload.getString("actualEventId")
                        require(validId(ev)) { "ACTUAL_MEAL_EVENT_ID_INVALID" }
                        val t=payload.getString("confirmedAtUtc");requiredUtc(t)
                        db.insertOrThrow("v3_events",null,ContentValues().apply {
                            put("event_id",ev);put("profile_id",profileId);put("event_type","meal")
                            put("event_status","recorded");put("occurred_at_utc",t)
                            put("payload_json",JSONObject().put("eventId",ev).put("eventType","meal")
                                .put("status","recorded").put("provenance","CONFIRMED_ACTUAL")
                                .put("occurredAtUtc",t).put("sessionId",recordId)
                                .put("actualPlate",payload.getJSONObject("actualPlate")).toString())
                            put("source_module",module);put("idempotency_key",key);put("created_revision",next)
                        })
                    }
                    val values=ContentValues().apply {
                        put("session_id",recordId);put("profile_id",profileId);put("session_status",status)
                        put("payload_json",payload.toString());put("created_revision",next)
                    }
                    if(previous==null) db.insertOrThrow("v3_meal_sessions",null,values)
                    else db.update("v3_meal_sessions",values,"session_id=? AND profile_id=?",arrayOf(recordId,profileId))
                    db.insertWithOnConflict("v3_record_owners",null,ContentValues().apply {
                        put("profile_id",profileId);put("domain","mealSessions")
                        put("record_id",recordId);put("source_module",module)
                    },SQLiteDatabase.CONFLICT_IGNORE)
                    // Append every state transition. Last-state projection remains in v3_meal_sessions.
                    db.insertOrThrow("v3_meal_history",null,ContentValues().apply {
                        put("session_id",recordId);put("profile_id",profileId);put("session_status",status)
                        put("payload_json",payload.toString());put("source_module",module)
                        put("changed_at_utc",now);put("created_revision",next)
                    })
                }
                "conditionWriter" -> {
                    val kind=payload.getString("kind")
                    require(kind in setOf("sport","illness")) { "CONDITION_KIND_INVALID" }
                    val op=payload.getString("operation")
                    require(op in setOf("start","end")) { "CONDITION_OPERATION_INVALID" }
                    val previous=db.rawQuery("SELECT kind,start_utc,end_utc,payload_json FROM v3_condition_periods WHERE period_id=? AND profile_id=?",arrayOf(recordId,profileId)).use { c ->
                        if(c.moveToFirst()) listOf(c.getString(0),c.getString(1),if(c.isNull(2))"" else c.getString(2),c.getString(3)) else null
                    }
                    if(op=="start") {
                        require(previous==null) { "PERIOD_ALREADY_STARTED" }
                        val start=payload.getString("startUtc");requiredUtc(start)
                        // Closed future periods can overlap too: checking active-only was insufficient.
                        val overlap=db.rawQuery("SELECT 1 FROM v3_condition_periods WHERE profile_id=? AND kind=? AND (end_utc IS NULL OR end_utc>?) LIMIT 1",arrayOf(profileId,kind,start)).use { it.moveToFirst() }
                        require(!overlap) { "PERIOD_OVERLAP" }
                        db.insertOrThrow("v3_record_owners",null,ContentValues().apply {
                            put("profile_id",profileId);put("domain","conditionPeriods")
                            put("record_id",recordId);put("source_module",module)
                        })
                        db.insertOrThrow("v3_condition_periods",null,ContentValues().apply {
                            put("period_id",recordId);put("profile_id",profileId);put("kind",kind)
                            put("start_utc",start);putNull("end_utc");put("payload_json",payload.toString());put("created_revision",next)
                        })
                    } else {
                        val storedOwner=db.rawQuery(
                            "SELECT source_module FROM v3_record_owners WHERE profile_id=? AND domain='conditionPeriods' AND record_id=?",
                            arrayOf(profileId,recordId)).use{c->if(c.moveToFirst())c.getString(0) else null}
                        if(storedOwner!=module) throw SecurityException("PERIOD_OWNER_MISMATCH")
                        require(previous!=null && previous[0]==kind && previous[2].isEmpty()) { "PERIOD_NOT_ACTIVE" }
                        val end=payload.getString("endUtc");requiredUtc(end)
                        require(Instant.parse(end).isAfter(Instant.parse(previous[1]))) { "PERIOD_END_BEFORE_START" }
                        val amended=JSONObject(previous[3]).put("endUtc",end)
                        db.update("v3_condition_periods",ContentValues().apply {
                            put("end_utc",end);put("payload_json",amended.toString());put("created_revision",next)
                        },"period_id=? AND profile_id=?",arrayOf(recordId,profileId))
                    }
                }
                "mealTimingPublisher" -> {
                    val time=payload.getString("calculatedAtUtc");requiredUtc(time)
                    val status=payload.getString("resultStatus")
                    val inputRev=payload.getLong("sourceRevision")
                    GfV3WriteContract.validateCalculated(status,inputRev,m.third,payload.getString("inputDigest"))
                    val minutes=if(payload.isNull("minutes"))null else payload.getInt("minutes")
                    require(status!="CALCULATED" || (minutes!=null && minutes in 0..240)) { "TIMING_MINUTES_INVALID" }
                    require(status=="CALCULATED" || minutes==null) { "TIMING_UNKNOWN_CANNOT_HAVE_MINUTES" }
                    val session=payload.optString("mealSessionId").takeIf{it.isNotBlank()}
                    if(session!=null)require(validId(session)) { "SESSION_ID_INVALID" }
                    db.insertOrThrow("v3_meal_timing",null,ContentValues().apply {
                        put("timing_id",recordId);put("profile_id",profileId)
                        if(session==null)putNull("meal_session_id") else put("meal_session_id",session)
                        put("calculated_at_utc",time);put("result_status",status)
                        if(minutes==null)putNull("minutes") else put("minutes",minutes)
                        put("source_revision",inputRev);put("input_digest",payload.getString("inputDigest"))
                        put("payload_json",payload.toString());put("created_revision",next)
                    })
                }
                "syncWriter" -> {
                    // This boolean is provided only by a native transport verifier, never by JSON.
                    require(nativeTransportAuthenticated) { "NATIVE_SYNC_AUTH_REQUIRED" }
                    val device=payload.getString("sourceDeviceId")
                    val sourceEvent=payload.getString("sourceEventId")
                    require(validId(device)&&validId(sourceEvent)) { "SYNC_SOURCE_INVALID" }
                    val received=payload.getString("receivedAtUtc");requiredUtc(received)
                    val type=payload.getString("sourceEventType")
                    require(type in setOf("cgm","event","settings")) { "SYNC_TYPE_INVALID" }
                    val item=payload.getJSONObject("data")
                    require(item.toString().length<=65536) { "SYNC_PACKET_TOO_LARGE" }
                    db.insertOrThrow("v3_sync_inbox",null,ContentValues().apply {
                        put("inbox_id",recordId);put("profile_id",profileId)
                        put("source_device_id",device);put("source_event_id",sourceEvent)
                        put("received_at_utc",received);put("source_event_type",type)
                        put("payload_json",item.toString());put("verification_status","NATIVE_AUTH_VERIFIED")
                        put("created_revision",next)
                    })
                    // Inbound sync is never silently converted to a confirmed injection or observed CGM.
                }
            }
            val nextInput=GfV3InputRevision.afterCommit(role!="mealTimingPublisher" && role!="syncWriter",next,m.third)
            val count=db.compileStatement("UPDATE v3_meta SET revision=?,input_revision=? WHERE id=1 AND revision=? AND input_revision=?").let { stmt ->
                try { stmt.bindLong(1,next);stmt.bindLong(2,nextInput);stmt.bindLong(3,m.first);stmt.bindLong(4,m.third);stmt.executeUpdateDelete() }
                finally { stmt.close() }
            }
            require(count==1) { "V3_REVISION_CONFLICT" }
            db.insertOrThrow("v3_extended_receipts",null,ContentValues().apply {
                put("idempotency_key",key);put("profile_id",profileId);put("domain",domain)
                put("record_id",recordId);put("fingerprint",fingerprint);put("revision",next);put("source_module",module)
            })
            db.insertOrThrow("v3_audit",null,ContentValues().apply {
                put("revision",next);put("domain",domain);put("record_id",recordId)
                put("action",role);put("source_module",module);put("at_utc",now)
            })
            db.insertOrThrow("v3_extended_change_feed",null,ContentValues().apply {
                put("revision",next);put("domain",domain);put("record_id",recordId)
                put("source_module",module);put("created_at_utc",now)
            })
            db.setTransactionSuccessful()
            JSONObject().put("created",true).put("recordId",recordId).put("revision",next).put("domain",domain)
        } finally { db.endTransaction() }
    }
}
