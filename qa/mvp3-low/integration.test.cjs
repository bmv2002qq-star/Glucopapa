'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const {at, minute, iso, web, fromWeb, mutate, testJournal, addPlate, Storage, Settings, Rinfast} =
    require('../mvp3-calculators/fixture.cjs');
fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
fromWeb('integration/GFMealActualPanel_v0.1.0.js');
const audit = fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');
const moduleRoot = 'modules/GFLOW_v0.4.0/';
const alert = fromWeb(moduleRoot + 'GFXDripLowAlert_v0.1.0.js');
const model = {
    RinfastEngine: Rinfast,
    GFXDripLowAlert: alert,
    GFForecastHypo: fromWeb(moduleRoot + 'GFForecastHypo_v0.3.0.js'),
    GFHypoScenario: fromWeb(moduleRoot + 'GFHypoScenario_v0.3.2.js'),
};
runInNewContext(readFileSync(path.join(web, moduleRoot, 'GFLOWCore_v0.4.0.js'), 'utf8'), model, {timeout: 1000});
globalThis.GFLOWCore = model.GFLOWCore;
const low = fromWeb('integration/GFLOWStorage_v0.4.1.js');
const archiveBridge = require('../../docs/mvp3-low/originals/GFLOWGFStorageBridge_v0.4.0.js');

function weigh(host) {
    const port = host.connect('settings');
    Settings.createSettingsService({settingsPort: port, clock: () => iso(at)})
        .addMeasurement({measuredAt: iso(at - minute), weightKg: 20, heightCm: 120}, port.getRevision());
}

test('LOW stops at missing evidence and offers no writer through the scoped read port', () => {
    const host = Storage.createHost({clock: () => iso(at)});
    const before = host.exportState();
    const view = low.inspect({host, nowMs: at});
    assert.equal(view.revision, 0);
    assert.equal(view.glucose.value, null);
    assert.equal(view.iob, null);
    assert.equal(view.food.lowerG, null);
    assert(view.blockers.includes('LOW_CANONICAL_PARITY_MISSING'));
    const port = host.connect('lowReview');
    assert.equal(port.confirmCompletedMeal, undefined);
    assert.throws(() => port.read('proposals'), /Нет доступа/);
    assert.deepEqual(host.exportState(), before);
});

test('Fresh low observation is independent of history, 3.9 is outside red and old readings keep age', () => {
    const patient = (glucose, delay) => testJournal({glucose, delay, coverage: false, sourceType: 'device_recorded'});
    for (const [value, good] of [[3, true], [3.9, false], [2.9, true]]) {
        const host = patient(value, 0);
        weigh(host);
        const view = low.inspect({host, nowMs: at});
        assert.equal(view.glucose.value, value);
        assert.equal(view.glucose.low, good);
        assert.equal(view.syntheticReference, null);
        assert(view.blockers.includes('JOURNAL_COVERAGE_UNKNOWN'));
    }
    for (const delay of [13, 15, 30]) {
        const view = low.inspect({host: patient(3, delay), nowMs: at});
        assert.equal(view.glucose.value, null);
        assert.equal(view.glucose.age, delay);
        assert.equal(view.glucose.low, false);
        assert.equal(view.code, 'CGM_STALE');
    }
});

test('Only the separate synthetic journal can expose the ISPAD arithmetic on confirmed synthetic input', () => {
    const host = testJournal({glucose: 3, coverage: false});
    weigh(host);
    const result = low.inspect({host, mode: 'demo', nowMs: at});
    assert.equal(result.glucose.low, true);
    assert.equal(result.syntheticReference.initialCarbsG, 6);
    const ordinary = low.inspect({host, mode: 'local', nowMs: at});
    assert.equal(ordinary.glucose.value, null);
    assert.equal(ordinary.syntheticReference, null);
});

test('Missing receipt timestamps and a changed revision cannot supply an observed or model value', () => {
    const original = testJournal({glucose: 3, sourceType: 'device_recorded'});
    const snapshot = structuredClone(original.exportState());
    delete snapshot.cgm.at(-1).receivedAt;
    const legacy = Storage.createHost({clock: () => iso(at), driver: {load: () => snapshot, save() {
        throw Error('A read must not persist');
    }}});
    const missing = low.inspect({host: legacy, nowMs: at});
    assert.equal(missing.glucose.value, null);
    assert.equal(missing.glucose.code, 'CGM_RECEIPT_MISSING');
    let change = true;
    const raced = {...original, connect(role) {
        if (role === 'graph' && change) {
            change = false;
            mutate(original, 'settings', 'updateProfile', {timeZone: 'Europe/Minsk'});
        }
        return original.connect(role);
    }};
    assert.equal(low.inspect({host: raced, nowMs: at}).code, 'REVISION_CHANGED');
});

test('Retrospective formula uses the original LOW core, a current GFStorage v5 projection and an independent analytic value', () => {
    const host = testJournal({glucose: 3});
    weigh(host);
    const snapshot = host.connect('lowReview').getSnapshot();
    const rates = low.selectCoefficients(snapshot.profile, snapshot.coefficients, iso(at));
    const before = host.exportState();
    const normalized = archiveBridge.fromProjection(snapshot, {
        nowIso: iso(at),
        resolveCoefficients: state => ({revision: state.revision, isfMmolPerUnit: rates.isf.value,
            carbRatioGPerUnit: rates.uk.value, validated: true, absorptionModel: 'GFForecast'}),
        resolveMealProfile: () => null,
        resolveCatalog: state => ({revision: state.revision, validated: true, catalog: {
            fixture: {name: 'SYNTHETIC PRODUCT', unit: 'мл', carbsPer100: 10.5, absorptionTauMin: 20}
        }}),
    });
    assert.equal(normalized.revision, snapshot.revision);
    for (const amount of [0, 57, 97]) {
        const result = model.GFLOWCore.evaluate(normalized, {productId: 'fixture', targetMmol: 6, amount, horizonMin: 120});
        assert.equal(result.status, 'MODEL_SCENARIO');
        for (const t of [0, 5, 15, 30, 60, 90, 120]) {
            const point = result.points.find(row => row.minute === t);
            const independent = 3 + amount * 0.105 * (3 / 12) * (1 - (1 + t / 20) * Math.exp(-t / 20));
            assert.equal(point.withoutMmol, 3);
            assert(Math.abs(point.withMmol - independent) < 0.011, [amount, t, point.withMmol, independent]);
        }
        assert.equal(result.clinicalUse, false);
    }
    assert.deepEqual(host.exportState(), before);
});

test('LOW reads the global selected model and keeps missing absorption and model parity explicit', () => {
    const host = testJournal({glucose: 4.4});
    const settings = host.connect('settings');
    settings.setMealAbsorptionModel('GFCOB', settings.getRevision());
    const view = low.inspect({host, mode: 'demo', nowMs: at});
    assert.equal(view.food.model.id, 'GFCOB');
    assert(view.blockers.includes('GFCOB_PORT_UNAVAILABLE'));
    assert(view.blockers.includes('PRODUCT_PROFILE_UNVERIFIED'));
    assert.equal(view.glucose.value, 4.4);
});

test('One manual confirmed portion creates one durable completed meal and an idempotent readback', () => {
    let disk = null, writes = 0;
    const driver = {load: () => disk, save: next => { disk = next; writes++; }};
    const host = Storage.createHost({clock: () => iso(at), driver});
    addPlate(host, {grams: 100, carbs: 19.9, gi: 49, estimated: false});
    const view = low.inspect({host, nowMs: at});
    assert.equal(view.products.length, 1);
    assert.equal(host.exportState().mealSessions[0].actualPlate, null);
    const pending = low.prepareFact({view, productKey: view.products[0].key, id: 'low-synthetic-meal',
        amount: 75, decidedAt: iso(at)});
    const initial = host.exportState();
    assert.throws(() => low.recordFact({host, confirmation: false, pending, expectedRevision: view.revision}), /подтверждение/);
    assert.deepEqual(host.exportState(), initial);
    low.recordFact({host, confirmation: true, pending, expectedRevision: view.revision});
    const durable = host.exportState();
    assert.equal(durable.revision, view.revision + 1);
    assert.equal(writes, 2);
    const one = durable.mealSessions.filter(row => row.status === 'completed');
    assert.equal(one.length, 1);
    assert.equal(one[0].actualPlate.totals.carbs, 14.925);
    assert.equal(one[0].actualPlate.items[0].glycemicIndex, 49);
    assert.equal(durable.events.length, 0);
    assert.deepEqual(JSON.parse(audit.exportJson(host)).mealSessions.find(row => row.id === one[0].id), one[0]);
    const cob = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js').inspect({host, nowMs: at});
    assert.equal(cob.sourceRevision, durable.revision);
    assert.equal(cob.rows.filter(row => row.mealId === one[0].id).length, 1);
    assert.equal(cob.rows.find(row => row.mealId === one[0].id).recordedCarbsG, 14.925);
    const rebooted = Storage.createHost({clock: () => iso(at), driver});
    assert.equal(low.recordFact({host: rebooted, confirmation: true, pending,
        expectedRevision: durable.revision}).idempotent, true);
    assert.deepEqual(rebooted.exportState(), durable);
    assert.equal(writes, 2);
    assert.throws(() => low.recordFact({host: rebooted, confirmation: true,
        pending: {...pending, eatenAt: iso(at - minute)}, expectedRevision: durable.revision}), /Повтор/);
});

test('A stale revision or driver failure never creates the meal or a partial audit operation', () => {
    let disk = null, broken = false;
    const driver = {load: () => disk, save: next => { if (broken) throw Error('SYNTHETIC_WRITE_FAILURE'); disk = next; }};
    const host = Storage.createHost({clock: () => iso(at), driver});
    addPlate(host, {estimated: false});
    const view = low.inspect({host, nowMs: at});
    const pending = low.prepareFact({view, productKey: view.products[0].key, id: 'low-retry-test',
        amount: 10, decidedAt: iso(at)});
    mutate(host, 'settings', 'updateProfile', {timeZone: 'Europe/Minsk'});
    const rev = host.diagnostics().revision;
    const before = host.exportState();
    assert.throws(() => low.recordFact({host, confirmation: true, pending, expectedRevision: view.revision}), /Конфликт ревизии/);
    broken = true;
    assert.throws(() => low.recordFact({host, confirmation: true, pending, expectedRevision: rev}), /SYNTHETIC_WRITE_FAILURE/);
    assert.deepEqual(host.exportState(), before);
    broken = false;
    low.recordFact({host, confirmation: true, pending, expectedRevision: rev});
    assert.equal(host.exportState().workflowLog.filter(row => row.sessionId === pending.sessionId).length, 1);
});
