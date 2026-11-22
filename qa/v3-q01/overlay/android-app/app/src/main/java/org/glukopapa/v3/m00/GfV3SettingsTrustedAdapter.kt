package org.glukopapa.v3.m00

import org.json.JSONObject

/** The moduleId is fixed by the native installer at bindInstalledAdapter("GFSettings").
 * The adapter accepts intents from a trusted owner UI route, NEVER a JavascriptInterface.
 * A read-only JS screen cannot call this class or impersonate a module.
 */
internal class GfV3SettingsTrustedAdapter(private val boundPort: GfV3NativeModuleGateway.BoundPort) {
    private val timed = setOf("carb_g_per_u", "isf_mmol_per_u")
    private val slots = setOf("00-06", "06-12", "12-18", "18-00")

    fun readSettingsSnapshot(): JSONObject = boundPort.read("settings")

    fun applyOwnerIntent(intent: JSONObject): JSONObject {
        require(intent.getString("type") == "GFSETTINGS_V3_OWNER_INTENT") { "SETTINGS_INTENT_INVALID" }
        require(intent.getBoolean("ownerConfirmed")) { "OWNER_CONFIRMATION_REQUIRED" }
        val before = readSettingsSnapshot()
        require(before.getBoolean("profileConfigured")) { "PROFILE_UNCONFIGURED" }
        require(before.getString("profileId") == intent.getString("profileId")) { "SETTINGS_PROFILE_CONFLICT" }
        val expected = intent.getLong("expectedRevision")
        require(expected == before.getLong("revision")) { "V3_REVISION_CONFLICT" }
        val role = intent.getString("role")
        val payload = intent.getJSONObject("payload")
        val command = intent.getString("command")
        if(role == "settingsWriter" && command == "setting") {
            val key=payload.getString("settingKey")
            require(key in setOf("childProfile","nutritionReference","target","foodModel","graphPreferences","activityPreferences",GfV3SettingsModeContract.KEY)) { "SETTING_KEY_INVALID" }
            GfV3SettingsModeContract.validateSetting(key,payload.getJSONObject("value"))
            return boundPort.append(role,intent.getString("idempotencyKey"),expected,payload)
        }
        if(role == "coefficientWriter" && command == "coefficient") {
            require(payload.getBoolean("ownerApproved")) { "COEFFICIENT_OWNER_NOT_APPROVED" }
            val kind=payload.getString("kind")
            val slot = if(payload.isNull("slotId")) null else payload.getString("slotId")
            require((kind in timed && slot in slots) ||
                (kind in setOf("illness_factor","activity_factor") && slot == null)) { "COEFFICIENT_TIME_GRID_INVALID" }
            require(payload.getString("mode") == "manual" && payload.getString("source") == "OWNER_MANUAL") { "Q01_ONLY_MANUAL_COEFFICIENTS" }
            val rawValue=payload.get("value")
            require(rawValue is Number) { "COEFFICIENT_NUMBER_REQUIRED" }
            val value=rawValue.toDouble()
            require(value.isFinite() && value > 0.0 && value <= 500.0) { "COEFFICIENT_VALUE_OUT_OF_RANGE" }
            return boundPort.append(role,intent.getString("idempotencyKey"),expected,payload)
        }
        throw SecurityException("SETTINGS_ROLE_NOT_AUTHORIZED")
    }
}
