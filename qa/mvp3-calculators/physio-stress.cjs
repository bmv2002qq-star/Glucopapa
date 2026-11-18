'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {at, minute, iso, fromWeb, testJournal, mutate, Evidence} = require('./fixture.cjs');
const assets = 'modules/GFPhysioProfiles_v0.2.0/';
const Profiles = fromWeb(assets + 'gfphysio_profiles_v0.2.0.js');
fromWeb(assets + 'gfphysio_profiles_data_v0.2.0.js');
const database = globalThis.GFPhysioProfilesDataV020;
const {T1DPatientResearch} = fromWeb('modules/GFPhysio_v0.1.2/gfphysio_core_v0.1.0.js');

const out = path.resolve(process.argv[2] || 'qa-evidence');
fs.mkdirSync(out, {recursive: true});
const file = fs.openSync(path.join(out, 'physio-cases.jsonl'), 'w');
const completed = [];
const delays = [0, 5, 10, 15, 30];
const cases = [
    {name: 'basal', meals: [], pulseMinutes: [], delays},
    {name: 'small meal with previous injection', meals: [[10, 5]], pulseMinutes: [4], delays},
    {name: 'two overlapping meals and injections', meals: [[15, 18], [46, 25]], pulseMinutes: [10, 37], delays},
    {name: 'timing experiment A', meals: [[35, 18]], pulseMinutes: [15], delays},
    {name: 'timing experiment B', meals: [[35, 18]], pulseMinutes: [35], delays},
    {name: 'timing experiment C', meals: [[35, 18]], pulseMinutes: [55], delays},
];
const minutes = 90;
assert.equal(Profiles.validateDatabase(database), true);
assert.equal(database.profiles.length, 30);
assert.equal(database.profiles.filter(item => item.cohort === 'child').length, 10);

for (const profile of database.profiles) {
    const params = Profiles.getSelectedParameters(database, {mode: 'RESEARCH_SYNTHETIC_ONLY', selectedId: profile.id});
    assert(params.researchOnly && !params.individualized);
    for (const scenario of cases) {
        const patient = new T1DPatientResearch(params.params);
        const observed = [];
        for (let index = 0; index < minutes; index++) {
            const CHO = scenario.meals.find(row => row[0] === index)?.[1] || 0;
            const pulse = scenario.pulseMinutes.includes(index) ? 0.15 : 0;
            const next = patient.step({CHO, insulin: patient.basal_U_min + pulse});
            assert.equal(next.state.length, 13);
            assert(next.state.every(Number.isFinite) && Number.isFinite(next.BG_mmol_L));
            observed.push(next.BG_mmol_L);
        }
        // The same physiological trajectory feeds all variants. Delay changes timestamps of availability only.
        for (const lag of scenario.delays) {
            const lastIndex = minutes - 1 - lag;
            const values = [15, 10, 5, 0].map(offset => ({
                ts: at - (offset + lag) * minute,
                mmol: observed[lastIndex - offset],
                sourceDeviceId: 'SYNTHETIC-PHYSIO',
                receivedAt: iso(at - offset * minute),
            }));
            const outOfRange = values.some(row => row.mmol < 1.5 || row.mmol > 30);
            const host = testJournal();
            mutate(host, 'cgmAdapter', 'setSourceMetadata', {sourceDeviceId: 'SYNTHETIC-PHYSIO',
                sourceType: 'synthetic', samplingMinutes: 5, qualityScore: 1});
            let observation;
            if (outOfRange) {
                assert.throws(() => mutate(host, 'cgmAdapter', 'ingestReadings', values));
                observation = {status: 'EXPECTED_BLOCKED', code: 'OUTSIDE_GFSTORAGE_RANGE'};
            } else {
                mutate(host, 'cgmAdapter', 'ingestReadings', values);
                const evidence = Evidence.inspect({route: 'low', host, nowMs: at});
                const expectedAge = lag;
                assert.equal(evidence.trace.glucose.ageMinutes, expectedAge);
                assert.equal(evidence.trace.glucose.observedMmol, lag === 30 ? null : values.at(-1).mmol);
                assert.equal(evidence.result, null);
                observation = {status: 'PASS', revision: evidence.revision, expectedAge,
                    actualAge: evidence.trace.glucose.ageMinutes, result: evidence.result,
                    blockers: evidence.blockers.map(item => item.code)};
            }
            const result = {profile: profile.id, cohort: profile.cohort, scenario: scenario.name,
                meals: scenario.meals, pulseMinutes: scenario.pulseMinutes, lagMinutes: lag, input: values, observation};
            completed.push(result);
            fs.writeSync(file, JSON.stringify(result) + '\n');
        }
    }
}
fs.closeSync(file);
const summary = {mode: 'SYNTHETIC_ONLY', profiles: 30, states: 13, nativeTrajectories: 30 * cases.length,
    receiptVariants: completed.length, passed: completed.filter(row => row.observation.status === 'PASS').length,
    expectedBlocked: completed.filter(row => row.observation.status === 'EXPECTED_BLOCKED').length,
    lagPolicy: 'transport_offsets_only', extraAbsorption: false, clinical: 'NOT_VALIDATED',
    caveats: ['No validated sport, illness or Levemir model in this physiological solver',
        'The consumed output is the existing model BG channel. No extra CGM compartment was fitted.']};
fs.writeFileSync(path.join(out, 'physio-summary.json'), JSON.stringify(summary, null, 2) + '\n');
assert.equal(completed.length, 900);
console.log(JSON.stringify(summary));
