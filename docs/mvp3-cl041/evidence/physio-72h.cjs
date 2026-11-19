'use strict';
const {createRequire} = require('node:module');
const {resolve} = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = createRequire(resolve(process.argv[2], 'qa', 'mvp3-calculators', 'fixture.cjs'));
const assets = resolve(process.argv[2], 'android-mvp3/app/src/main/assets/www');
const {T1DPatientResearch} = source(resolve(assets, 'modules/GFPhysio_v0.1.2/gfphysio_core_v0.1.0.js'));
const profiles = source(resolve(assets, 'modules/GFPhysioProfiles_v0.2.0/gfphysio_profiles_v0.2.0.js'));
source(resolve(assets, 'modules/GFPhysioProfiles_v0.2.0/gfphysio_profiles_data_v0.2.0.js'));
const database = globalThis.GFPhysioProfilesDataV020;
assert.equal(profiles.validateDatabase(database), true);
assert.equal(database.profiles.length, 30);
assert.equal(database.profiles.filter(profile => profile.cohort === 'child').length, 10);
const output = [];
const started = performance.now();

function trajectory(params, substeps) {
    const patient = new T1DPatientResearch(params, {substeps});
    const checkpoints = [];
    let min = Infinity, max = -Infinity;
    for (let minute = 0; minute < 4320; minute++) {
        const phase = minute % 1440;
        const food = phase === 480 ? 20 : phase === 780 ? 25 : phase === 1140 ? 18 : 0;
        const pulse = phase === 470 || phase === 770 || phase === 1130 ? 0.3 : 0;
        const next = patient.step({CHO: food, insulin: patient.basal_U_min + pulse});
        assert.equal(next.t, minute + 1);
        assert.equal(next.state.length, 13);
        assert(next.state.every(Number.isFinite));
        // Material compartments are nonnegative. Insulin action relative to baseline can be signed.
        for (const i of [0,1,2,3,4,5,9,10,11,12]) assert(next.state[i] >= -1e-10);
        const calculated = next.state[12] / params.Vg / 18.0182;
        assert(Math.abs(calculated - next.BG_mmol_L) < 1e-10);
        min = Math.min(min, calculated);
        max = Math.max(max, calculated);
        if (next.t % 1440 === 0) checkpoints.push({time:next.t,state:next.state,mmol:calculated});
    }
    return {min,max,checkpoints};
}

for (const profile of database.profiles) {
    const choice = profiles.getSelectedParameters(database, {mode:'RESEARCH_SYNTHETIC_ONLY', selectedId:profile.id});
    assert(choice.researchOnly && !choice.individualized);
    const first = trajectory(choice.params, 40);
    const refined = trajectory(choice.params, 80);
    let maximumRelativeDelta = 0;
    for (const [i, checkpoint] of first.checkpoints.entries()) {
        for (const [state, actual] of checkpoint.state.entries()) {
            const expected = refined.checkpoints[i].state[state];
            maximumRelativeDelta = Math.max(maximumRelativeDelta, Math.abs(actual-expected)/Math.max(1,Math.abs(expected)));
        }
    }
    assert(maximumRelativeDelta < 1e-5, profile.id + ' failed refinement: ' + maximumRelativeDelta);
    output.push({profile:profile.id,cohort:profile.cohort,fixture:'SYNTHETIC',hours:72,
        steps:4320,substeps:[40,80],maximumRelativeDelta,...first});
}
fs.writeFileSync(resolve(process.argv[3], 'physio-72h-cases.jsonl'), output.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log(JSON.stringify({profiles:output.length, children:output.filter(x=>x.cohort==='child').length,
    trajectories:output.length * 2, minutes:output.length * 4320 * 2,
    maxRelativeDelta:Math.max(...output.map(x=>x.maximumRelativeDelta)), durationMs:Math.round(performance.now()-started),
    independentShortReference:'qa/mvp3-full/physio-checkpoints.json',clinical:'NOT_VALIDATED'}));
