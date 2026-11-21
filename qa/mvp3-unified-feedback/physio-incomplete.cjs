'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {gunzipSync} = require('node:zlib');
const {at, testJournal, mutate, Evidence} = require('../mvp3-calculators/fixture.cjs');

const input = process.argv[2];
assert(input, 'Pass the synthetic physio-cases.jsonl or .jsonl.gz from physio-stress.cjs');
const bytes = readFileSync(input);
const source = input.endsWith('.gz') ? gunzipSync(bytes) : bytes;
const cases = source.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const trajectories = cases.filter(row => row.lagMinutes === 0);

assert.equal(trajectories.length, 180);
assert.equal(new Set(trajectories.map(row => row.profile)).size, 30);
assert.equal(new Set(trajectories.filter(row => row.cohort === 'child').map(row => row.profile)).size, 10);

for (const trajectory of trajectories) {
    const host = testJournal();
    const kept = trajectory.input.slice(0, 2);
    const sensor = 'SYNTHETIC-PHYSIO';
    assert(kept.every(reading => reading.sourceDeviceId === sensor));
    mutate(host, 'cgmAdapter', 'setSourceMetadata', {
        sourceDeviceId: sensor, sourceType: 'synthetic', samplingMinutes: 5, qualityScore: 1,
    });
    mutate(host, 'cgmAdapter', 'ingestReadings', kept);
    const snapshot = host.exportState();
    for (const route of ['low', 'high', 'meal']) {
        const evidence = Evidence.inspect({host, route, nowMs: at});
        assert.equal(evidence.trace.trend.rateMmolPerMinute, null);
        assert(evidence.blockers.some(blocker => blocker.code === 'CGM_TREND_INCOMPLETE'));
        assert(evidence.blockers.some(blocker => blocker.code === 'CGM_SYNTHETIC'));
        assert.equal(evidence.result, null);
    }
    assert.deepEqual(host.exportState(), snapshot);
}

console.log(JSON.stringify({status: 'PASS', data: 'SYNTHETIC_ONLY', profiles: 30, childProfiles: 10,
    incompleteTrajectories: trajectories.length, routesChecked: ['low', 'high', 'meal'],
    clinical: 'NOT_VALIDATED'}, null, 2));
