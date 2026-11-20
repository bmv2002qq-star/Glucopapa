'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {runInNewContext} = require('node:vm');

const web = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const fromWeb = (name) => require(path.join(web, name));
const Storage = fromWeb('modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const MealCalc = fromWeb('modules/GFMealCalc_v0.1.4/src/gf_meal_calc.js');
const Controller = fromWeb('modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js');
const Settings = fromWeb('modules/GFSettings_v0.1.8/src/gfsettings.js');
const Rinfast = fromWeb('shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
fromWeb('shared/GFTimeGrid_v0.1.0.js');
fromWeb('modules/Levemir_v0.1.2/levemir_engine.js');
fromWeb('integration/GFCgmEvidencePolicy_v0.1.0.js');
fromWeb('integration/GFInsulinEvidenceGate_v0.1.0.js');
fromWeb('integration/GFCOBResearch_v0.1.1.js');
fromWeb('integration/GFModuleHub_v0.2.0.js');
const Evidence = fromWeb('integration/GFCalculationEvidence_v0.1.0.js');

const minute = 60_000;
const at = Date.parse('2026-11-19T12:00:00Z');
const iso = time => new Date(time).toISOString();
const sensor = 'SYNTHETIC-CALC-QA';
const sessionId = 'demo-meal-qa';
const mutate = (host, role, fn, value) => {
    const port = host.connect(role);
    return port[fn](value, port.getRevision());
};

function archivedEngine(mutateSource = source => source) {
    const html = readFileSync(path.join(web, 'approved/GFHighLow_v5_ORIGINAL_1to1.html'), 'utf8');
    const published = 'root.GF30Core=api;';
    const marker = html.indexOf(published);
    assert(marker > 0 && marker === html.lastIndexOf(published));
    const start = html.lastIndexOf('(function(root){', marker);
    const stopMarker = "})(typeof window!=='undefined'?window:globalThis);";
    const stop = html.indexOf(stopMarker, marker) + stopMarker.length;
    assert(start > 0 && stop > marker);
    const sandbox = {module: {exports: {}}};
    runInNewContext(mutateSource(html.slice(start, stop)), sandbox, {timeout: 1000, filename: 'GF30Core-archive'});
    return sandbox.module.exports;
}

function testJournal({clock = at, glucose = null, rate = 0, delay = 0, manual = true,
        coverage = true, sourceType = 'synthetic', zone = 'UTC'} = {}) {
    const host = Storage.createHost({clock: () => iso(clock)});
    const settingsPort = host.connect('settings');
    let seq = 0;
    const settings = Settings.createSettingsService({settingsPort, clock: () => iso(clock - 50 * 60 * minute),
        idFactory: prefix => prefix + '-' + (++seq)});
    settings.saveProfile({timeZone: zone, displayName: 'ВЫМЫШЛЕННЫЙ РЕБЁНОК'}, settingsPort.getRevision());
    for (const slot of globalThis.GFTimeGrid.SLOTS) {
        for (const [kind, value] of [['carb_g_per_u', 12], ['isf_mmol_per_u', 3]]) {
            settings.addCoefficient({kind, value, source: 'manual', windowLocal: {from: slot.from, to: slot.to}},
                settingsPort.getRevision());
        }
    }
    if (!manual) settings.setCoefficientMode('carb_g_per_u', 'auto', settingsPort.getRevision());
    if (coverage) mutate(host, 'actionWriter', 'setCoverage', {
        startIso: iso(clock - 49 * 60 * minute), endIso: iso(clock), confirmedComplete: true, declaredBy: 'parent',
    });
    if (glucose !== null) {
        mutate(host, 'cgmAdapter', 'setSourceMetadata', {sourceDeviceId: sensor, sourceType, samplingMinutes: 5, qualityScore: 1});
        mutate(host, 'cgmAdapter', 'ingestReadings', [15, 10, 5, 0].map(offset => ({
            ts: clock - (offset + delay) * minute, mmol: glucose - offset * rate, sourceDeviceId: sensor,
            receivedAt: iso(clock - offset * minute),
        })));
    }
    return host;
}

function addPlate(host, {grams = 100, carbs = 24, fat = 4, protein = 5, gi = 49, id = sessionId,
        amount = grams, unit = 'г', atMs = at, estimated = true} = {}) {
    const plate = {schema: 'GFPlate.v1', source: 'GFFoodOnly', createdAt: iso(atMs),
        containsEstimatedValues: estimated,
        items: [{kind: 'manual', foodId: null, name: 'SYNTHETIC FOOD', amount, unit, carbs, fat, protein,
            kcal: 4 * (carbs + protein) + 9 * fat, glycemicIndex: gi,
            glycemicIndexStatus: gi === null ? 'unknown' : 'verified',
            nutritionStatus: estimated ? 'estimated' : 'label_verified'}],
        totals: {amount, count: 1, carbs, fat, protein, kcal: 4 * (carbs + protein) + 9 * fat}};
    const controller = Controller.createController(host, {makeId: p => p + '-case-' + host.diagnostics().revision});
    controller.createFromFood(plate, id);
    return {controller, plate, id};
}

function syntheticInputs(host, nowMs = at) {
    const port = host.connect('calculator'), snapshot = port.getSnapshot();
    assert.equal(snapshot.profile.displayName, 'ВЫМЫШЛЕННЫЙ РЕБЁНОК');
    const evidence = globalThis.GFCgmEvidencePolicy.inspect(host, {nowMs});
    const revision = port.getRevision();
    assert.equal(evidence.revision, revision);
    if (evidence.sourceStatus !== 'SYNTHETIC' || evidence.status !== 'OK') return {status: 'BLOCKED', code: evidence.code};
    const readouts = Evidence.inspect({host, route: 'high', nowMs});
    const selected = readouts.trace?.coefficients.isf_mmol_per_u.value;
    if (!Number.isFinite(selected) || !Number.isFinite(readouts.trace?.trend.rateMmolPerMinute) ||
        readouts.trace?.iob.status !== 'MODEL_ESTIMATE') return {status: 'BLOCKED', code: 'FIXTURE_INPUTS_INCOMPLETE'};
    assert.equal(revision, readouts.revision);
    return {status: 'READY', revision, referenceOptions: {
        at: nowMs, glucose: evidence.currentMmol, readings: evidence.readings, isf: selected,
        timeZone: snapshot.profile.timeZone, diaMin: 300, illnessK: 1, activity: 'low',
        shots: snapshot.events.filter(row => row.type === 'insulin_injection' && row.status === 'confirmed' && row.insulinId === 'rinfast')
            .map(row => ({type: 'insulin', insulinType: 'short', units: row.units, ts: Date.parse(row.administeredAt)})),
    }};
}

module.exports = {at, minute, iso, web, fromWeb, mutate, archivedEngine, testJournal, addPlate,
    syntheticInputs, MealCalc, Settings, Evidence, Rinfast, sessionId, Storage};
