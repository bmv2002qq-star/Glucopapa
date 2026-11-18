'use strict';

const {at, minute, iso, fromWeb, Rinfast, Evidence} = require('./fixture.cjs');
const forecast = fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
const autoProfile = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');

function study(host, nowMs = at) {
    const port = host.connect('research'), snapshot = port.getSnapshot();
    const provenance = globalThis.GFCgmEvidencePolicy.inspect(host, {nowMs});
    const stop = code => ({status: 'BLOCKED', code, forecast: null, revision: snapshot.revision});
    if (provenance.status !== 'OK' || provenance.sourceStatus !== 'SYNTHETIC' ||
        snapshot.profile.displayName !== 'ВЫМЫШЛЕННЫЙ РЕБЁНОК') return stop('SYNTHETIC_FIXTURE_REQUIRED');

    const profile = autoProfile.inspect({host, nowMs});
    if (profile.status !== 'RESEARCH_PROFILES_READY' && profile.code !== 'NO_COMPLETED_MEALS') {
        return stop(profile.code);
    }
    const historyDeclaration = {source: 'user_declared', confirmedComplete: true,
        startIso: iso(nowMs - 12 * 60 * minute), endIso: iso(nowMs), declaredAtIso: iso(nowMs)};
    const evidence = Evidence.inspect({host, route: 'meal', nowMs,
        cobOptions: {mealCoverageRevision: snapshot.revision, historyDeclaration, kineticsByMealId: profile.kineticsByMealId || {}}});
    const isf = evidence.trace?.coefficients.isf_mmol_per_u.value;
    const ratio = evidence.trace?.coefficients.carb_g_per_u.value;
    if (evidence.revision !== snapshot.revision || provenance.revision !== snapshot.revision ||
        profile.sourceRevision !== snapshot.revision || port.getRevision() !== snapshot.revision) return stop('REVISION_CHANGED');
    if (!Number.isFinite(isf) || !Number.isFinite(ratio) ||
        evidence.trace.cob.status !== 'RESEARCH_INTERVAL' || evidence.trace.iob.status !== 'MODEL_ESTIMATE') {
        return stop('FIXTURE_EVIDENCE_INCOMPLETE');
    }

    // The existing GFForecast accepts facts, not an aggregate COB input. Feeding both would count the same
    // meal twice. Its own appearance function is different from GFCOB, so the interval is recorded separately.
    const acceptedIds = new Set(profile.rows.map(row => row.mealId));
    const meals = snapshot.mealSessions.filter(row => acceptedIds.has(row.id)).map(row => ({
        id: row.id, status: 'confirmed', eatenAt: row.startedAt, carbsG: row.actualPlate.totals.carbs,
    }));
    const injections = snapshot.events.filter(row => row.type === 'insulin_injection' && row.status === 'confirmed');
    const request = {nowIso: iso(nowMs),
        readings: provenance.readings.map(row => ({measuredAt: iso(row.ts), receivedAt: row.receivedAt,
            glucoseMmol: row.mmol, sourceId: row.sourceDeviceId})),
        injections, meals, settings: {isfMmolPerUnit: isf, carbRatioGPerUnit: ratio},
        conditions: {illness: evidence.trace.illness.active, activity: evidence.trace.sportActive},
        sourceIsComplete: true, rinfastEngine: Rinfast};
    return {status: 'RESEARCH_ONLY', revision: snapshot.revision, clinical: 'NOT_VALIDATED',
        inputs: {injections, meals, settings: request.settings, readings: request.readings},
        cob: evidence.trace.cob, iob: evidence.trace.iob, profiles: profile.rows,
        modelGap: 'FORECAST_KINETICS_NOT_EQUIVALENT_TO_GFCOB',
        forecast: forecast.predict(request)};
}

module.exports = {study};
