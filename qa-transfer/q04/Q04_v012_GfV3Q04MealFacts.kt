package org.glukopapa.v3.m00

import org.json.JSONObject
import java.time.Instant

/**
 * Trusted native-only Q04 GFPlate producer. A completed session and its meal event
 * are emitted atomically by GFStorage's existing mealFlow writer; Q03 then counts
 * carbs ONCE from the session and links the legacy event without double counting.
 * This is NEVER exposed as @JavascriptInterface.  The Q17 UI integration will
 * supply the owner's actual meal confirmation; no injection or dose is produced.
 */
internal class GfV3Q04MealFacts(private val bound: GfV3NativeModuleGateway.BoundPort) {
    private fun checkPlan(plan:JSONObject) {
        GfV3PlateContract.validate(plan,"PLANNED")
        require(plan.optString("source")=="GFNutrition") { "Q04_PLAN_SOURCE_INVALID" }
        require(plan.getBoolean("containsEstimatedValues")) { "Q04_PLAN_UNVERIFIED_AS_VERIFIED" }
    }
    private fun checkId(value:String) {
        require(GfV3WriteContract.validId(value)) { "Q04_MEAL_ID_INVALID" }
    }

    fun plan(sessionId:String, plannedPlate:JSONObject, idempotencyKey:String,
             expectedRevision:Long, startedAtUtc:String=Instant.now().toString()):JSONObject {
        checkId(sessionId);checkId(idempotencyKey);checkPlan(plannedPlate)
        GfV3WriteContract.requireUtc(startedAtUtc)
        return bound.append("mealFlow",idempotencyKey,expectedRevision,
            JSONObject().put("sessionId",sessionId).put("status","planned")
                .put("startedAtUtc",startedAtUtc).put("plannedPlate",plannedPlate))
    }

    fun start(sessionId:String, plannedPlate:JSONObject, idempotencyKey:String,
              expectedRevision:Long, startedAtUtc:String):JSONObject {
        checkId(sessionId);checkId(idempotencyKey);checkPlan(plannedPlate)
        GfV3WriteContract.requireUtc(startedAtUtc)
        return bound.append("mealFlow",idempotencyKey,expectedRevision,
            JSONObject().put("sessionId",sessionId).put("status","in_progress")
                .put("startedAtUtc",startedAtUtc).put("plannedPlate",plannedPlate))
    }

    fun confirmActual(sessionId:String, plannedPlate:JSONObject, actualPlate:JSONObject,
                      actualEventId:String, idempotencyKey:String, expectedRevision:Long,
                      ownerConfirmedInNativeUi:Boolean, startedAtUtc:String,
                      confirmedAtUtc:String=Instant.now().toString()):JSONObject {
        if (!ownerConfirmedInNativeUi) throw SecurityException("Q04_ACTUAL_OWNER_CONFIRMATION_REQUIRED")
        checkId(sessionId);checkId(actualEventId);checkId(idempotencyKey);checkPlan(plannedPlate)
        GfV3PlateContract.validate(actualPlate,"ACTUAL")
        require(actualPlate.optString("source")=="GFNutrition") { "Q04_ACTUAL_SOURCE_INVALID" }
        // The catalog has no fully substantiated SKU recipes. A confirmed action
        // must never falsely claim the food composition was label verified.
        require(actualPlate.getBoolean("containsEstimatedValues")) { "Q04_ACTUAL_UNVERIFIED_AS_VERIFIED" }
        GfV3WriteContract.requireUtc(startedAtUtc)
        GfV3WriteContract.requireUtc(confirmedAtUtc)
        return bound.append("mealFlow",idempotencyKey,expectedRevision,
            JSONObject().put("sessionId",sessionId).put("status","completed")
                .put("startedAtUtc",startedAtUtc).put("plannedPlate",plannedPlate)
                .put("actualPlate",actualPlate).put("actualEventId",actualEventId)
                .put("userConfirmed",true).put("confirmedAtUtc",confirmedAtUtc)
                .put("nutritionVerification","ESTIMATED_NOT_SKU_VERIFIED"))
    }
}