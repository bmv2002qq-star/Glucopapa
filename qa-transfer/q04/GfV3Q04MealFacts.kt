package org.glukopapa.v3.m00

import org.json.JSONObject
import java.time.Instant

/**
 * Q04 canonical meal fact producer for an explicit NATIVE owner-confirmed action only.
 * This component is intentionally NOT a JavascriptInterface. The UI/actual meal
 * confirmation flow is owned by the future trusted workflow module (Q17).
 * No insulin calculations or medical recommendations are created here.
 */
internal class GfV3Q04MealFacts(private val ownerPort: GfV3NativeModuleGateway.BoundPort) {
    fun recordActuallyEaten(
        actualPlate: JSONObject,
        eventId: String,
        idempotencyKey: String,
        expectedRevision: Long,
        ownerConfirmedInNativeUi: Boolean,
        occurredAtUtc: String = Instant.now().toString()
    ): JSONObject {
        if (!ownerConfirmedInNativeUi) throw SecurityException("Q04_ACTUAL_OWNER_CONFIRMATION_REQUIRED")
        if (!GfV3WriteContract.validId(eventId) || !GfV3WriteContract.validId(idempotencyKey))
            throw IllegalArgumentException("Q04_MEAL_EVENT_ID_INVALID")
        GfV3WriteContract.requireUtc(occurredAtUtc)
        GfV3PlateContract.validate(actualPlate, "ACTUAL")
        require(actualPlate.optString("source") == "GFNutrition") { "Q04_MEAL_SOURCE_INVALID" }
        // No exact manufacturer SKU/recipe has been substantiated in the current catalog.
        // An actually eaten meal can be confirmed without falsely verifying nutrition facts.
        require(actualPlate.getBoolean("containsEstimatedValues")) { "Q04_UNVERIFIED_FOOD_AS_VERIFIED" }
        return ownerPort.append(
            "actionWriter", idempotencyKey, expectedRevision,
            JSONObject().put("eventId",eventId)
                .put("eventType","meal").put("status","recorded")
                .put("occurredAtUtc",occurredAtUtc)
                .put("provenance","CONFIRMED_ACTUAL")
                .put("platePhase","ACTUAL")
                .put("nutritionVerification","ESTIMATED_NOT_SKU_VERIFIED")
                .put("plate",actualPlate)
        )
    }
}