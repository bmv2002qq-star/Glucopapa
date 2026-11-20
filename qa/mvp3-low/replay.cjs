'use strict';

const assert = require('node:assert/strict');
const {at, minute, iso, fromWeb, Rinfast} = require('../mvp3-calculators/fixture.cjs');
const low = fromWeb('modules/GFLOW_v0.4.0/GFForecastHypo_v0.3.0.js');
const alert = fromWeb('modules/GFLOW_v0.4.0/GFXDripLowAlert_v0.1.0.js');
const shared = fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
const lowHorizons = [15, 30, 60, 120];
const alertHorizons = [15, 30];
const steps = 72 * 12;
const limit = 3.9;
const phase = index => (index % 144) / 144;
const delayed = (index, ts) => ts + (index % 47 === 0 ? 10 : 0) * minute;
const fixtures = [
    {name: 'steady', glucose: () => 6},
    {name: 'oscillating', glucose: index => 5.2 + 2 * Math.sin(index * Math.PI / 37)},
    {name: 'factual_food_and_shot', glucose: index => 3.2 + 5 * Math.abs(2 * phase(index) - 1), events: true},
];

function evidence() {
    return {rows: new Map(), warnings: {tp: 0, fp: 0, tn: 0, fn: 0}, unavailable: 0};
}

function add(result, forecast, horizons, future, yes, meaningful) {
    if (!forecast.points.length) {
        result.unavailable++;
        return;
    }
    for (const horizon of horizons) {
        const point = forecast.points.find(row => row.horizonMin === horizon);
        if (!point || future(horizon) === undefined) continue;
        const it = result.rows.get(horizon) ?? {n: 0, abs: 0, sq: 0, sum: 0};
        const error = point.glucoseMmol - future(horizon);
        assert(Number.isFinite(error));
        it.n++;
        it.abs += Math.abs(error);
        it.sq += error * error;
        it.sum += error;
        result.rows.set(horizon, it);
    }
    if (meaningful) {
        const measuredLow = [5, 10, 15, 20, 25, 30].some(h => future(h) < limit);
        result.warnings[yes ? measuredLow ? 'tp' : 'fp' : measuredLow ? 'fn' : 'tn']++;
    }
}

function pack(result) {
    const rounded = number => Math.round(number * 1e4) / 1e4;
    const horizons = Array.from(result.rows, ([horizon, row]) => ({horizon, pairs: row.n,
        mae: rounded(row.abs / row.n), rmse: rounded(Math.sqrt(row.sq / row.n)), bias: rounded(row.sum / row.n)}));
    const {tp, fn, fp, tn} = result.warnings;
    return {horizons, ...result.warnings, sensitivity: tp + fn ? rounded(tp / (tp + fn)) : null,
        falseAlertRate: fp + tn ? rounded(fp / (fp + tn)) : null, unavailable: result.unavailable};
}

function run(fixture) {
    const sourceId = 'SYNTHETIC-LOW-' + fixture.name;
    const series = Array.from({length: steps + 1}, (_, index) => {
        const ts = at + index * 5 * minute;
        return {measuredAt: iso(ts), receivedAt: iso(delayed(index, ts)),
            glucoseMmol: fixture.glucose(index), sourceId, kind: 'observed'};
    });
    const opt = {settings: {isfMmolPerUnit: 3, carbRatioGPerUnit: 12}, sourceIsComplete: true, rinfastEngine: Rinfast};
    const fitted = evidence(), independentAlert = evidence();
    let aligned = 0, sharedLowBlocked = 0, maximumDifference = 0;
    for (let i = 8; i <= steps - 24; i++) {
        const now = series[i].measuredAt;
        const future = horizon => series[i + horizon / 5]?.glucoseMmol;
        let available = series.slice(i - 8, i + 1).filter(row => row.receivedAt <= now);
        if (fixture.events && i % 53 === 0) available = available.slice(0, -3);
        assert(available.every(row => row.measuredAt <= now && row.receivedAt <= now));
        const base = (i - i % 144) * 5 * minute + at;
        const injectionAt = base + 60 * minute;
        const mealAt = base + 75 * minute;
        const injections = fixture.events && iso(injectionAt) <= now
            ? [{id: 'qa-shot', status: 'confirmed', administeredAt: iso(injectionAt), insulinId: 'rinfast', units: 0.5}] : [];
        const meals = fixture.events && iso(mealAt) <= now
            ? [{id: 'qa-meal', status: 'confirmed', eatenAt: iso(mealAt), carbsG: 15, absorptionTauMin: 40}] : [];
        const request = {...opt, nowIso: now, readings: available, injections, meals};
        const forecast = low.predict(request);
        const globalForecast = shared.predict(request);
        const timeOnly = alert.predict({readings: available, nowIso: now, thresholdMmol: limit, horizonMin: 30});
        if (forecast.points.length && globalForecast.points.length) {
            const diff = Math.max(...forecast.points.map((row, n) => Math.abs(row.glucoseMmol - globalForecast.points[n].glucoseMmol)));
            maximumDifference = Math.max(maximumDifference, diff);
            aligned++;
        }
        if (forecast.points.length && globalForecast.code === 'LOW_GLUCOSE') sharedLowBlocked++;
        const notAlreadyLow = series[i].glucoseMmol >= limit;
        add(fitted, forecast, lowHorizons, future,
            forecast.points.some(row => row.horizonMin <= 30 && row.glucoseMmol < limit), notAlreadyLow);
        add(independentAlert, timeOnly, alertHorizons, future,
            timeOnly.status === 'RISK_WITHIN_WINDOW', notAlreadyLow);
    }
    assert(aligned > 0 && fitted.rows.size === 4 && independentAlert.rows.size === 2);
    return {case: fixture.name, hours: 72, sampleMinutes: 5, observations: series.length,
        LOW: pack(fitted), CGM_only: pack(independentAlert),
        sameInputs: {bothEligible: aligned, maxMmolDifference: maximumDifference, globalLowBlocked: sharedLowBlocked}};
}
const results = fixtures.map(run);
assert(results.some(row => row.sameInputs.globalLowBlocked > 0));
console.log(JSON.stringify({status: 'PASS', mode: 'SYNTHETIC_RESEARCH_ONLY', clinical: 'NOT_VALIDATED',
    validation: 'Measured and receipt timestamps are filtered before each forecast. Future samples are used only as outcomes.',
    cases: results}, null, 2));
