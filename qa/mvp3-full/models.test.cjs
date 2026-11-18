'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');

const web = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const fromWeb = file => require(path.join(web, file));
const profilePath = 'modules/GFPhysioProfiles_v0.2.0';
const Profiles = fromWeb(profilePath + '/gfphysio_profiles_v0.2.0.js');
fromWeb(profilePath + '/gfphysio_profiles_data_v0.2.0.js');
const database = globalThis.GFPhysioProfilesDataV020;
const {T1DPatientResearch} = fromWeb('modules/GFPhysio_v0.1.2/gfphysio_core_v0.1.0.js');
const Rinfast = fromWeb('shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
const Levemir = fromWeb('modules/Levemir_v0.1.2/levemir_engine.js');

function close(actual, expected, tolerance) {
    assert(Math.abs(actual - expected) <= tolerance, 'actual=' + actual + ', expected=' + expected);
}

function params(profile) {
    const selection = Profiles.getSelectedParameters(database, {
        mode: 'RESEARCH_SYNTHETIC_ONLY', selectedId: profile.id,
    });
    assert(selection.researchOnly && !selection.individualized && profile.synthetic);
    return selection.params;
}

test('30 original synthetic profiles and exactly 10 child profiles are complete', () => {
    assert.equal(Profiles.validateDatabase(database), true);
    assert.equal(database.profiles.filter(p => p.cohort === 'child').length, 10);
    for (const p of database.profiles) {
        const {age_years, weight_kg} = p.demographics;
        const result = Profiles.nearest(database, {ageYears: age_years, weightKg: weight_kg});
        assert.equal(result.eligibleForDosing, false);
        assert(result.exactAgeWeight);
    }
    assert.throws(() => Profiles.nearest(database, {ageYears: 7, weightKg: null}));
    assert.throws(() => Profiles.validateDatabase({...database, profiles: database.profiles.slice(1)}));
});

const scenarios = [
    {name: 'baseline', food: 0, pulse: 0},
    {name: 'low input', food: 0, pulse: 0, basalScale: 0.7},
    {name: 'high input', food: 0, pulse: 0, basalScale: 1.1},
    {name: 'food', food: 20, pulse: 0},
    {name: 'insulin pulse', food: 0, pulse: 0.5},
    {name: 'food and insulin', food: 20, pulse: 0.5},
    {name: 'spaced pulses', food: 5, pulse: 0.5, repeat: true},
    {name: 'interrupted meal', food: 2, pulse: 0},
    {name: 'large input', food: 75, pulse: 0.5},
];

function modelRun(patient, scenario, variant, steps, positions = new Set()) {
    const result = {};
    for (let minute = 0; minute < steps; minute++) {
        const food = minute === 30 ? scenario.food * variant : 0;
        const pulse = minute === 20 || (scenario.repeat && minute === 40) ? scenario.pulse * variant : 0;
        const next = patient.step({CHO: food, insulin: patient.basal_U_min * (scenario.basalScale ?? 1) + pulse});
        assert.equal(next.state.length, 13);
        assert(next.state.every(Number.isFinite));
        assert(Number.isFinite(next.BG_mmol_L));
        if (positions.has(next.t)) result[next.t] = next.state;
    }
    return result;
}

for (const profile of database.profiles) {
    for (const scenario of scenarios) {
        for (const variant of [0.5, 1, 1.5, 2]) {
            test(profile.id + ' SYNTHETIC ' + scenario.name + ' x' + variant, () => {
                const patient = new T1DPatientResearch(params(profile));
                const first = modelRun(patient, scenario, variant, 60, new Set([60]))[60];
                const second = modelRun(patient.reset(), scenario, variant, 60, new Set([60]))[60];
                assert.deepEqual(second, first);
            });
        }
    }
}

test('All 13 states match independent DOP853 checkpoints for 30 combined-input trajectories', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'physio-checkpoints.json'), 'utf8'));
    for (const profile of database.profiles) {
        const scenario = scenarios.find(item => item.name === 'food and insulin');
        const checkpoints = expected[profile.id];
        const times = new Set(Object.keys(checkpoints).map(Number));
        for (const [substeps, relative] of [[40, 2e-6], [160, 2e-9]]) {
            const model = new T1DPatientResearch(params(profile), {substeps});
            const actual = modelRun(model, scenario, 1, 90, times);
            for (const t of times) {
                actual[t].forEach((value, i) => {
                    const reference = checkpoints[t][i];
                    const tolerance = Math.max(1, Math.abs(reference)) * relative;
                    assert(Math.abs(value - reference) <= tolerance,
                        profile.id + ' t=' + t + ' state ' + i + ': ' + value + ' vs ' + reference);
                });
                close(actual[t][12] / model.params.Vg / 18.0182,
                    checkpoints[t][12] / model.params.Vg / 18.0182, 2e-8);
            }
        }
    }
});

const children = database.profiles.filter(p => p.cohort === 'child');
for (const [index, hours] of [24, 48, 72].entries()) {
    test(children[index].id + ' research trajectory ' + hours + ' virtual hours', () => {
        const patient = new T1DPatientResearch(params(children[index]));
        modelRun(patient, scenarios[5], 1, hours * 60);
        assert.equal(patient.time, hours * 60);
        assert.throws(() => patient.step({CHO: -1}));
        assert.throws(() => patient.step({insulin: NaN}));
        assert.equal(patient.time, hours * 60);
    });
}

test('RinFast model remaining fraction equals independent quadrature of normalized activity', () => {
    const profile = Rinfast.DEFAULT_PROFILE;
    const {diaMinutes: duration, peakMinutes: peak} = profile;
    const tau = peak * (duration - peak) / (duration - 2 * peak);
    const area = (from, to) => {
        const slices = 20_000;
        const width = (to - from) / slices;
        let total = 0;
        for (let i = 0; i < slices; i++) {
            const t = from + (i + 0.5) * width;
            total += t * (duration - t) * Math.exp(-t / tau);
        }
        return total * width;
    };
    const full = area(0, duration);
    for (const age of [0, 1, 10, 20, 60, 75, 120, 180, 299, 300]) {
        close(Rinfast.getCurve(age).remainingFraction, area(age, duration) / full, 3e-9);
    }
    assert(Rinfast.getCurve(peak).activityFractionPerMinute > Rinfast.getCurve(peak - 1).activityFractionPerMinute);
    assert(Rinfast.getCurve(peak).activityFractionPerMinute > Rinfast.getCurve(peak + 1).activityFractionPerMinute);
    assert.throws(() => Rinfast.getCurve(-1));
});

test('Levemir interpolates archived adult-study anchors and rejects extrapolation', () => {
    const anchors = [[0.1, 5.7], [0.2, 12.1], [0.4, 19.9], [0.8, 22.7], [1.6, 23.2]];
    const weight = 20;
    for (let i = 0; i < anchors.length; i++) {
        const [ratio, duration] = anchors[i];
        close(Levemir.estimateDuration(ratio * weight, weight).populationMeanDurationHours, duration, 1e-10);
        const next = anchors[i + 1];
        if (next) {
            close(Levemir.estimateDuration((ratio + next[0]) * weight / 2, weight).populationMeanDurationHours,
                (duration + next[1]) / 2, 1e-10);
        }
        close(Levemir.curve(0, duration).remainingFraction, 1, 0);
        close(Levemir.curve(duration, duration).remainingFraction, 0, 0);
    }
    assert.equal(Levemir.estimateDuration(0.5, weight).populationMeanDurationHours, null);
    assert.throws(() => Levemir.estimateDuration(2, null));
});
