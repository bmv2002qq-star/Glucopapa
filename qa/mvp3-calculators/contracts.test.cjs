'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {at, minute, iso, fromWeb, mutate, archivedEngine, testJournal, addPlate,
    syntheticInputs, MealCalc, Rinfast, Evidence, Settings, sessionId, Storage} = require('./fixture.cjs');
const reference = archivedEngine();
const provider = fromWeb('integration/GFProviderCgm_v0.1.0.js');
const auditExport = fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');
const equalEnough = (actual, expected, tolerance) => assert(Math.abs(actual - expected) <= tolerance,
    'Expected ' + expected + ' ±' + tolerance + ', got ' + actual);
const withCase = (t, data) => t.diagnostic(JSON.stringify(data));

test('LOW, three manual volumes and independent arithmetic checkpoints', t => {
    const host = testJournal({glucose: 5, rate: -0.02});
    const input = syntheticInputs(host);
    assert.equal(input.status, 'READY');
    const base = {...input.referenceOptions, horizon: 30, goal: 6, fastCarbs: true, carbFactor: 1, carbsPer100: 10};
    const run = [30, 40, 60].map(volumeMl => ({volumeMl,
        output: reference.forecast({...base, carbs: volumeMl / 10, dose: 0})}));
    // Hand checks: linear CGM drift -0.30; at one time constant the archived fraction is 1 - e^(-1).
    const expected = [{meal: 0.284, predicted: 4.98}, {meal: 0.379, predicted: 5.08},
        {meal: 0.569, predicted: 5.27}];
    run.forEach(({output}, index) => {
        assert.equal(output.parts.g, 5);
        assert.equal(output.parts.trend, -0.3);
        assert.equal(output.parts.meal, expected[index].meal);
        assert.equal(output.predicted, expected[index].predicted);
        assert.equal(output.synthetic, true);
    });
    const proposal = reference.toyFoodGrams(base);
    equalEnough(proposal.grams, 137.1, 0.001);
    assert.equal(host.diagnostics().revision, input.revision);
    assert.deepEqual(host.connect('journal').read('mealSessions'), []);
    withCase(t, {fictional: true, revision: input.revision, expected, run, proposal});
});

test('HIGH, calculated zero is distinct from unknown; overlapping facts are never written by calculation', t => {
    const host = testJournal({glucose: 8, rate: 0});
    const fact = {id: 'fixture-shot', insulinId: 'rinfast', units: 0.5, administeredAt: iso(at - 40 * minute)};
    mutate(host, 'actionWriter', 'recordInjection', fact);
    const revision = host.diagnostics().revision;
    assert.equal(mutate(host, 'actionWriter', 'recordInjection', fact).idempotent, true);
    assert.equal(host.diagnostics().revision, revision);
    const input = syntheticInputs(host);
    const opts = {...input.referenceOptions, goal: 10, horizon: 120};
    assert.equal(opts.shots.length, 1);
    const zero = reference.toyCorrection(opts);
    assert.equal(zero.dose, 0);
    const missing = reference.toyCorrection({...opts, isf: null});
    assert.equal(missing, null);
    const manual = [0, 0.5, 1].map(dose => reference.forecast({...opts, dose, carbs: 0}));
    assert(manual[0].predicted > manual[1].predicted && manual[1].predicted > manual[2].predicted);
    assert(manual.every(v => v.parts.oldInsulin < 0));
    assert.equal(host.diagnostics().revision, revision);
    assert.equal(auditExport.collect(host).events.length, 1);
    withCase(t, {fictional: true, expected: {zero: 0, missing: null, manualDecreases: true}, zero, missing, manual});
});

test('Meal, exact arithmetic for two portions; correction is visible to journal and export', t => {
    const host = testJournal({glucose: 6.2});
    const {controller, plate} = addPlate(host);
    const calc = MealCalc.createCalculator(host, {rinfastEngine: Rinfast});
    const plan = calc.inspect(sessionId, {atIso: iso(at)});
    assert.equal(plan.researchArithmetic.unroundedEquivalentUnits, 2);
    assert.equal(plan.researchArithmetic.fromActualFood, false);
    assert.equal(plan.therapyRecommendation, null);

    controller.ready(sessionId);
    controller.startMeal(sessionId, iso(at - 40 * minute), {actuallyStarted: true});
    const actual = {...plate, items: plate.items.map(row => ({...row, amount: 50,
        carbs: 12, protein: 2.5, fat: 2, kcal: 76})),
        totals: {amount: 50, count: 1, carbs: 12, protein: 2.5, fat: 2, kcal: 76}};
    mutate(host, 'actionWriter', 'recordActualPlate', {sessionId, expectedVersion: controller.lookup(sessionId).version,
        plate: actual, opId: 'actual-fixture'});
    controller.finishMeal(sessionId, iso(at - 30 * minute), {confirmed: true});
    const fact = calc.inspect(sessionId, {atIso: iso(at)});
    assert.equal(fact.researchArithmetic.unroundedEquivalentUnits, 1);
    assert.equal(fact.researchArithmetic.fromActualFood, true);
    assert.deepEqual(auditExport.collect(host).mealSessions, host.connect('journal').read('mealSessions'));
    assert.equal(host.connect('journal').read('mealSessions').length, 1);
    assert.equal(host.connect('journal').read('events').length, 0);
    withCase(t, {fictional: true, expected: {plannedEquivalent: 2, actualEquivalent: 1, sessions: 1},
        plan: plan.researchArithmetic, actual: fact.researchArithmetic, revision: fact.storageRevision});
});

test('Research C/UK arithmetic is visible for a non-fictional profile and does not record a dose', () => {
    const host = testJournal({glucose: 6.2});
    const port = host.connect('settings');
    const settings = Settings.createSettingsService({settingsPort: port, clock: () => iso(at)});
    settings.saveProfile({timeZone: 'UTC', displayName: 'Локальный исследовательский профиль'}, port.getRevision());
    addPlate(host, {estimated: false});
    const revision = host.diagnostics().revision;
    const result = Evidence.mealCarbEquivalent(host, sessionId, iso(at));
    assert.equal(result.status, 'RESEARCH_CARB_EQUIVALENT');
    assert.equal(result.unroundedEquivalentUnits, 2);
    assert.equal(result.fromActualFood, false);
    assert.equal(result.therapeuticRecommendation, false);
    assert.equal(host.diagnostics().revision, revision);
    assert.deepEqual(host.connect('journal').read('events'), []);
});

test('Research C/UK requires a unique active manual coefficient, not a fabricated zero', () => {
    const host = testJournal({manual: false});
    addPlate(host, {estimated: false});
    const result = Evidence.mealCarbEquivalent(host, sessionId, iso(at));
    assert.equal(result.status, 'INPUT_INCOMPLETE');
    assert.equal(result.reason, 'COEFFICIENT_MODE');
    assert.equal(result.unroundedEquivalentUnits, null);
    const port=host.connect('settings');
    Settings.createSettingsService({settingsPort:port}).setCoefficientMode('carb_g_per_u','manual',port.getRevision());
    assert.equal(Evidence.mealCarbEquivalent(host, sessionId, iso(at)).unroundedEquivalentUnits,2);
    assert.equal(Evidence.mealCarbEquivalent(host, 'unknown-session', iso(at)).reason,'PLATE_CARBS_MISSING');
});

test('All routes separate synthetic/stale/absent CGM and unsupported coefficient modes', t => {
    const host = testJournal({glucose: 6, manual: false, coverage: false});
    addPlate(host, {gi: null});
    const before = host.exportState();
    const results = ['low', 'high', 'meal'].map(route => Evidence.inspect({route, host, nowMs: at, activeMeal: sessionId}));
    for (const result of results) {
        assert.equal(result.revision, before.revision);
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.result, null);
        assert(result.blockers.some(issue => issue.code === 'CGM_SYNTHETIC'));
        assert(result.blockers.some(issue => issue.code === 'JOURNAL_COVERAGE_UNKNOWN'));
        assert(result.blockers.some(issue => issue.code === 'FOOD_COVERAGE_MISSING'));
    }
    assert(results[2].blockers.some(issue => issue.code === 'COEFFICIENT_MODE' && issue.field === 'carb_g_per_u'));
    assert(results[2].uncertainties.some(issue => issue.code === 'PLATE_KINETICS_UNCERTAIN'));
    assert.equal(results[2].trace.plate.source, 'planned');
    assert.deepEqual(host.exportState(), before);
    const stale = Evidence.inspect({route: 'low', host, nowMs: at + 50 * minute});
    assert(stale.blockers.some(issue => issue.code === 'CGM_STALE'));
    assert.equal(stale.trace.glucose.observedMmol, null);
    const future = Evidence.inspect({route: 'high', host, nowMs: at - 10 * minute});
    assert(future.blockers.some(issue => issue.code === 'CGM_FUTURE_TIMESTAMP'));
    const absent = Evidence.inspect({route: 'high', host: testJournal(), nowMs: at});
    assert(absent.blockers.some(issue => issue.code === 'CGM_SOURCE_UNKNOWN'));
    withCase(t, {expected: 'BLOCKED with exact cause', results, stale: stale.blockers, future: future.blockers});
});

test('xDrip+ source provides measurements while the calculation scope stays blocked', () => {
    const host = testJournal();
    provider.ingest(host, 'local', {status: 'MEASUREMENT', measuredAtMs: at - 5 * minute,
        receivedAtMs: at, mgdl: 108.09354, direction: 'Flat', stale: false}, at);
    const result = Evidence.inspect({host, route: 'high', nowMs: at});
    assert.equal(result.trace.glucose.observedMmol, 6);
    assert.equal(result.trace.glucose.source, 'XDRIP_LOCAL');
    assert(result.blockers.some(issue => issue.code === 'XDRIP_MODEL_QUALITY_UNKNOWN'));
    assert.equal(result.result, null);
});

test('Race during reads discards all details; one route failure leaves other routes readable', () => {
    const host = testJournal({glucose: 7});
    const delayed = {getSchemaVersion: host.getSchemaVersion, connect(role) {
        if (role !== 'settings') return host.connect(role);
        const base = host.connect(role);
        return {...base, getRevision: () => base.getRevision() + 1};
    }};
    const mixed = Evidence.inspect({route: 'low', host: delayed, nowMs: at});
    assert.equal(mixed.trace, null);
    assert.equal(mixed.blockers[0].code, 'REVISION_CHANGED');

    const badPlate = {getSchemaVersion: host.getSchemaVersion, connect(role) {
        if (role === 'calculator') throw Error('TEST_PLATE_PORT_FAILED');
        return host.connect(role);
    }};
    assert.throws(() => Evidence.inspect({route: 'meal', host: badPlate, nowMs: at}), /TEST_PLATE_PORT_FAILED/);
    const high = Evidence.inspect({route: 'high', host: badPlate, nowMs: at});
    assert.equal(high.revision, host.diagnostics().revision);
    assert.equal(high.trace.iob.valueU, 0);
});

test('Midnight and DST resolve unique explicit coefficient slots using the profile zone', t => {
    const samples = [
        ['2026-11-19T20:59:00Z', 'Europe/Minsk', '18:00'],
        ['2026-11-19T21:00:00Z', 'Europe/Minsk', '00:00'],
        ['2026-03-29T00:59:00Z', 'Europe/Berlin', '00:00'],
        ['2026-03-29T01:01:00Z', 'Europe/Berlin', '00:00'],
        ['2026-10-25T00:29:00Z', 'Europe/Berlin', '00:00'],
        ['2026-10-25T01:29:00Z', 'Europe/Berlin', '00:00'],
    ];
    for (const [time, zone, slot] of samples) {
        const clock = Date.parse(time);
        const host = testJournal({clock, zone, glucose: 6});
        const result = Evidence.inspect({route: 'high', host, nowMs: clock});
        assert.equal(result.trace.coefficients.isf_mmol_per_u.window.from, slot);
        withCase(t, {time, zone, independentlyExpectedSlot: slot, actual: result.trace.coefficients.isf_mmol_per_u.window});
    }
});

test('Fixed coefficient history, data range, units and test mode are not bypassed', () => {
    const host = testJournal({glucose: 7});
    const port = host.connect('cgmAdapter'), base = port.getRevision();
    for (const mmol of [NaN, Infinity, -1, 0, 400]) {
        assert.throws(() => port.ingestReadings([{ts: at, mmol, sourceDeviceId: 'SYNTHETIC-CALC-QA'}], base));
    }
    assert.equal(port.getRevision(), base);
    const old = testJournal({glucose: 7, sourceType: 'device_recorded'});
    assert.equal(syntheticInputs(old).status, 'BLOCKED');
    const test = Storage.createHost({clock: () => iso(at)});
    assert.equal(Evidence.inspect({route: 'meal', host: test, nowMs: at}).trace.plate, null);
});

test('COMMON, former meals and injections enter the existing forecast once; plans have no effect', t => {
    const {study} = require('./research-forecast.cjs');
    const host = testJournal({glucose: 7.2});
    const empty = study(host);
    assert.equal(empty.status, 'RESEARCH_ONLY');
    assert(empty.forecast.points.every(point => point.glucoseMmol === 7.2));
    addPlate(host, {id: 'plan-only', gi: 74});
    assert.deepEqual(study(host).forecast.points, empty.forecast.points);
    const finish = (id, start, carbs) => {
        const {controller, plate} = addPlate(host, {id, carbs, gi: 62, estimated: false});
        controller.ready(id);
        controller.startMeal(id, iso(at - start * minute), {actuallyStarted: true});
        mutate(host, 'actionWriter', 'recordActualPlate', {sessionId: id, expectedVersion: controller.lookup(id).version,
            plate, opId: 'fact-' + id});
        controller.finishMeal(id, iso(at - (start - 10) * minute), {confirmed: true});
    };
    finish('fixture-meal-one', 45, 12);
    finish('fixture-meal-two', 30, 12);
    const meals = study(host);
    assert.equal(meals.status, 'RESEARCH_ONLY');
    assert.deepEqual(meals.forecast.snapshot.mealEvents, ['fixture-meal-one', 'fixture-meal-two']);
    // Medium preset has boundaries 120/240 minutes. For 12 g at ages 45 and 30, sums are 16.5 and 20.25.
    equalEnough(meals.cob.lowerG, 16.5, 1e-10);
    equalEnough(meals.cob.upperG, 20.25, 1e-10);
    assert.equal(meals.iob.valueU, 0);
    for (const [id, age] of [['one', 20], ['two', 80]]) {
        const fact = {id: 'fixture-shot-' + id, insulinId: 'rinfast', units: 0.5, administeredAt: iso(at - age * minute)};
        mutate(host, 'actionWriter', 'recordInjection', fact);
        mutate(host, 'actionWriter', 'recordInjection', fact);
    }
    const overlap = study(host);
    assert.equal(overlap.status, 'RESEARCH_ONLY');
    assert(overlap.iob.valueU > 0 && overlap.iob.valueU < 1);
    assert.deepEqual(overlap.forecast.snapshot.rinfastInjections, ['fixture-shot-one', 'fixture-shot-two']);
    assert.deepEqual(overlap.forecast.snapshot.mealEvents, meals.forecast.snapshot.mealEvents);
    assert.notDeepEqual(overlap.forecast.points, meals.forecast.points);
    assert.equal(overlap.forecast.clinicalUse, false);
    assert.equal(overlap.revision, host.diagnostics().revision);
    withCase(t, {expectedCOB: [16.5, 20.25], meals, overlap});
});

test('MUTATION detects sign, unit conversion, duplicate history and missing guard on frozen fixtures', t => {
    const context = syntheticInputs(testJournal({glucose: 8.5})).referenceOptions;
    const one = {type: 'insulin', insulinType: 'short', ts: at - 40 * minute, units: 0.5};
    const request = {...context, goal: 10, horizon: 120, shots: [one], dose: 0.5, carbs: 4, fastCarbs: true};
    const baseline = reference.forecast(request);
    const variants = [
        ['SIGN', 'R(-newDose*', 'R(newDose*', mutant => assert(mutant.forecast(request).parts.newInsulin < 0)],
        ['UNITS', 'amount*0.15*carbFactor', 'amount*15*carbFactor',
            mutant => assert.equal(mutant.forecast(request).parts.meal, baseline.parts.meal)],
        ['DOUBLE_COUNT', 'remainingEffect(prev,at,horizon', 'remainingEffect([...prev,...prev],at,horizon',
            mutant => assert.equal(mutant.forecast(request).parts.oldInsulin, baseline.parts.oldInsulin)],
        ['MISSING_GUARD', 'glucose===null||isf===null', 'glucose===null',
            mutant => assert.equal(mutant.forecast({...request, isf: null}).ok, false)],
    ];
    for (const [id, before, after, oracle] of variants) {
        oracle(reference);
        const mutant = archivedEngine(source => {
            assert.equal(source.split(before).length, 2, id);
            return source.replace(before, after);
        });
        assert.throws(() => oracle(mutant), assert.AssertionError);
        withCase(t, {id, status: 'PASS', mutationDetected: true});
    }
});

test('HIGH pen-step thresholds and all three CGM directions, archived synthetic arithmetic', t => {
    const checks = [];
    for (const [glucose, expected] of [[7.45, 0], [7.48, 0.5], [7.93, 0.5], [7.95, 1]]) {
        const context = syntheticInputs(testJournal({glucose})).referenceOptions;
        const result = reference.toyCorrection({...context, goal: 7, horizon: 120});
        assert.equal(result.dose, expected);
        checks.push({glucose, expected, actual: result.dose});
    }
    const previews = [-0.02, 0, 0.02].map(rate => {
        const context = syntheticInputs(testJournal({glucose: 8, rate})).referenceOptions;
        return reference.forecast({...context, horizon: 120, dose: 0, carbs: 0}).predicted;
    });
    assert.deepEqual(previews, [7.7, 8, 8.3]);
    withCase(t, {sample: 'FICTIONAL', expectedImpactOfHalfStepMmol: 0.474609375, checks, previews});
});

test('Existing food profiles separate GI classes and fat; no inferred protein-specific kinetics', t => {
    const autoProfile = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');
    for (const [gi, fat, protein, expected] of [[80, 1, 5, 'fast'], [62, 1, 5, 'medium'],
        [35, 1, 5, 'slow'], [80, 20, 5, 'fatty'], [80, 1, 20, 'fast']]) {
        const host = testJournal();
        const {plate} = addPlate(host, {gi, fat, protein, estimated: false});
        const actual = autoProfile.profilePlate(plate);
        assert.equal(actual.profile, expected);
        assert.equal(actual.recordedProteinG, protein);
        assert.equal(actual.allowDose, false);
        withCase(t, {gi, fat, protein, expected, actual: actual.profile});
    }
});

test('Sport, illness and basal context retain independent provenance and do not become short IOB', t => {
    const host = testJournal({glucose: 7});
    const before = Evidence.inspect({route: 'high', host, nowMs: at});
    assert.equal(before.trace.illness.active, false);
    assert.equal(before.trace.sportActive, false);
    assert.equal(before.trace.levemir.valueU, null);
    mutate(host, 'settings', 'addMeasurement', {id: 'fictional-measurement', measuredAt: iso(at), weightKg: 20});
    mutate(host, 'actionWriter', 'recordInjection', {id: 'fictional-basal', insulinId: 'levemir', units: 4,
        administeredAt: iso(at - 180 * minute)});
    mutate(host, 'context', 'openPeriod', {id: 'fictional-illness', kind: 'illness', start: iso(at - 50 * minute)});
    mutate(host, 'sport', 'startSport', {id: 'fictional-sport', start: iso(at - 5 * minute)});
    const active = Evidence.inspect({route: 'high', host, nowMs: at});
    assert.equal(active.trace.illness.effectiveFactor, null);
    assert.equal(active.trace.sportActive, true);
    assert.equal(active.trace.iob.valueU, 0);
    assert.equal(active.trace.levemir.status, 'MODEL_ESTIMATE');
    assert(active.trace.levemir.valueU > 0);
    const failedBasalPort = {getSchemaVersion: host.getSchemaVersion, connect(role) {
        if (role === 'levemir') throw Error('FIXTURE_BASAL_PORT_FAILURE');
        return host.connect(role);
    }};
    const degraded = Evidence.inspect({route: 'high', host: failedBasalPort, nowMs: at});
    assert.equal(degraded.trace.levemir.valueU, null);
    assert.equal(degraded.trace.iob.valueU, active.trace.iob.valueU);
    assert.equal(degraded.trace.glucose.observedMmol, active.trace.glucose.observedMmol);
    mutate(host, 'context', 'closePeriod', {id: 'fictional-illness', end: iso(at)});
    mutate(host, 'sport', 'finishSport', {id: 'fictional-sport', end: iso(at)});
    const closed = Evidence.inspect({route: 'high', host, nowMs: at});
    assert.equal(closed.trace.illness.status, 'OFF');
    assert.equal(closed.trace.sportActive, false);
    assert.equal(closed.trace.levemir.valueU, active.trace.levemir.valueU);
    assert.equal(closed.result, null);
    withCase(t, {before: before.trace, active: active.trace, closed: closed.trace});
});
