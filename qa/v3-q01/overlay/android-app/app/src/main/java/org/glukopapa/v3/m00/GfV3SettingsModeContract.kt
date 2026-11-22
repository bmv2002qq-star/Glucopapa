package org.glukopapa.v3.m00

import org.json.JSONObject
import org.json.JSONArray
import java.time.ZoneId

/** Q01 additive proposal for approved M00; NOT installed until separate owner gate.
 * Mode preference does not activate auto-calculated coefficients (Q16 missing).
 */
internal object GfV3SettingsModeContract {
    const val KEY = "coefficientModeControls"
    private val kinds = setOf("carb_g_per_u", "isf_mmol_per_u")
    private val slots = setOf("00-06", "06-12", "12-18", "18-00")
    private fun keys(obj: JSONObject): Set<String> = obj.keys().asSequence().toSet()
    fun validate(json: JSONObject) {
        require(keys(json) == setOf("schema", "modes", "autoEngineStatus")) { "COEFFICIENT_MODE_KEYS_INVALID" }
        require(json.getInt("schema") == 1) { "COEFFICIENT_MODE_SCHEMA_INVALID" }
        require(json.getString("autoEngineStatus") == "NOT_CONNECTED_Q16") { "COEFFICIENT_AUTO_NOT_CONNECTED" }
        val groups = json.getJSONObject("modes")
        require(keys(groups) == kinds) { "COEFFICIENT_MODE_KINDS_INVALID" }
        kinds.forEach { kind ->
            val perSlot = groups.getJSONObject(kind)
            require(keys(perSlot) == slots) { "COEFFICIENT_MODE_SLOTS_INVALID" }
            slots.forEach { slot -> require(perSlot.getString(slot) in setOf("manual", "auto")) { "COEFFICIENT_MODE_INVALID" } }
        }
    }
    fun validateSetting(key: String, value: JSONObject) {
        fun exact(names: Set<String>) { require(keys(value)==names) { "SETTINGS_FIELDS_INVALID" } }
        when(key) {
            KEY -> validate(value)
            "childProfile" -> {
                require(keys(value).containsAll(setOf("displayName","birthDate","timeZone"))) { "PROFILE_FIELDS_MISSING" }
                require(keys(value).all { it in setOf("displayName","birthDate","timeZone","sex","allergies") }) { "PROFILE_UNKNOWN_FIELDS" }
                GfV3ProfileContract.validate(value)
                require(validateZone(value)!=null) { "PROFILE_ZONE_REQUIRED" }
                if(value.has("allergies")) {
                    val allergens=value.getJSONArray("allergies")
                    require(allergens.length()<=30) { "ALLERGIES_TOO_MANY" }
                    val names=(0 until allergens.length()).map { allergens.getString(it).trim() }
                    require(names.all { it.isNotBlank() && it.length<=120 } && names.map { it.lowercase() }.toSet().size==names.size) { "ALLERGIES_INVALID" }
                }
            }
            "nutritionReference" -> {
                require(keys(value) in setOf(setOf("daily","source"),setOf("daily","source","sourceVersion"))) { "NUTRITION_FIELDS_INVALID" }
                require(value.getString("source") in setOf("OWNER_MANUAL","HISTORICAL_UNVERIFIED")) { "NUTRITION_SOURCE_INVALID" }
                val daily=value.getJSONObject("daily")
                require(keys(daily)==setOf("protein","fat","carbs","kcal")) { "NUTRITION_DAILY_FIELDS_INVALID" }
                for(field in setOf("protein","fat","carbs","kcal")) {
                    val raw=daily.get(field)
                    require(raw is Number) { "NUTRITION_NUMBER_REQUIRED" }
                    val v=raw.toDouble()
                    require(v.isFinite() && v>0.0 && v<=(if(field=="kcal")10000.0 else 1000.0)) { "NUTRITION_DAILY_VALUE_INVALID" }
                }
            }
            "target" -> { exact(setOf("mmolL","source")); val raw=value.get("mmolL");require(raw is Number) { "TARGET_NUMBER_REQUIRED" };val v=raw.toDouble(); require(v.isFinite() && v in 2.0..30.0 && value.getString("source")=="OWNER_MANUAL") { "TARGET_INVALID" } }
            "foodModel" -> { exact(setOf("selectedModel","source"));require(value.getString("selectedModel") in setOf("GFForecast","GFCOB") && value.getString("source")=="OWNER_MANUAL") { "FOOD_MODEL_INVALID" } }
            "graphPreferences" -> { exact(setOf("showGFForecast","showGFxDrip")); require(value.get("showGFForecast") is Boolean && value.get("showGFxDrip") is Boolean) { "GRAPH_TOGGLE_TYPE_INVALID" } }
            "activityPreferences" -> {exact(setOf("activityLevel","source"));require(value.getString("activityLevel") in setOf("low","normal","high","sport") && value.getString("source")=="OWNER_MANUAL") { "ACTIVITY_PREF_INVALID" } }
            else -> throw IllegalArgumentException("SETTING_KEY_NOT_ALLOWED_Q01")
        }
    }
    fun validateZone(value: JSONObject): String? {
        if(!value.has("timeZone") || value.isNull("timeZone")) return null
        val zone = value.getString("timeZone")
        require(zone.isNotBlank() && zone.length <= 100) { "PROFILE_ZONE_INVALID" }
        try { ZoneId.of(zone) } catch (_:Exception) { throw IllegalArgumentException("PROFILE_ZONE_INVALID") }
        return zone
    }
}
