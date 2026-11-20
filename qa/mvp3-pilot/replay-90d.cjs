'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const {at, minute, iso, fromWeb, mutate, Storage} = require('../mvp3-calculators/fixture.cjs');
const CGM = fromWeb('integration/GFCgmEvidencePolicy_v0.1.0.js');

const days = 90;
const samplesPerDay = 288;
const first = at - days * 1440 * minute;
const sensor = 'SYNTHETIC-90D-REPLAY';
let clock = first;
let durable = null;
const driver = {
    load: () => durable && JSON.parse(durable),
    save(snapshot, previous) {
        assert.equal(durable ? JSON.parse(durable).revision : 0, previous);
        durable = JSON.stringify(snapshot);
    },
};
const open = () => Storage.createHost({driver, clock: () => iso(clock)});
const started = performance.now();
let host = open();
mutate(host, 'cgmAdapter', 'setSourceMetadata', {
    sourceType: 'synthetic', sourceDeviceId: sensor, samplingMinutes: 5, qualityScore: 1,
});
const readings = (from, count) => Array.from({length: count}, (_, offset) => {
    const index = from + offset;
    const ts = first + index * 5 * minute;
    return {ts, mmol: 5 + (index % 37) / 10, sourceDeviceId: sensor, receivedAt: iso(ts + minute)};
});

const reopenedAt = [];
// Use 15-day CGM batches. The historical journal is reloaded at three checkpoints.
for (let startDay = 0; startDay < days; startDay += 15) {
    const checkpoint = first + (startDay + 15) * 1440 * minute;
    const id = 'synthetic-90d-' + startDay;
    clock = checkpoint - 45 * minute;
    mutate(host, 'sport', 'startSport', {id: id + '-sport', start: iso(clock)});
    clock = checkpoint - 15 * minute;
    mutate(host, 'sport', 'finishSport', {id: id + '-sport', end: iso(clock)});
    clock = checkpoint;
    const batch = readings(startDay * samplesPerDay, 15 * samplesPerDay);
    mutate(host, 'cgmAdapter', 'ingestReadings', batch);
    const revision = host.diagnostics().revision;
    mutate(host, 'cgmAdapter', 'ingestReadings', batch.slice(-4).reverse());
    assert.equal(host.diagnostics().revision, revision);
    assert.throws(() => mutate(host, 'cgmAdapter', 'ingestReadings', [{...batch[0], mmol: 1.5}]));

    const injection = {id, insulinId: startDay % 2 === 0 ? 'rinfast' : 'levemir',
        units: 0.5, administeredAt: iso(clock - 10 * minute), injectionSite: {region: 'abdomen'}};
    mutate(host, 'actionWriter', 'recordInjection', injection);
    assert.equal(mutate(host, 'actionWriter', 'recordInjection', injection).idempotent, true);
    const view = CGM.inspect(host, {nowMs: clock});
    assert.equal(view.sourceStatus, 'SYNTHETIC');
    assert.equal(view.status, 'OK');
    assert.equal(view.readings.length, (startDay + 15) * samplesPerDay);
    assert.equal(CGM.inspect(host, {nowMs: clock + 25 * minute}).currentMmol, null);
    if ((startDay + 15) % 30 === 0) {
        const saved = durable;
        host = open();
        assert.equal(JSON.stringify(host.exportState()), saved);
        reopenedAt.push(startDay + 15);
    }
}

const state = host.exportState();
assert.equal(state.cgm.length, days * samplesPerDay);
assert.deepEqual(state.cgm.map(row => [row.ts, row.mmol]),
    readings(0, days * samplesPerDay).map(row => [row.ts, row.mmol]));
assert.equal(state.events.length, 6);
assert.equal(state.conditionPeriods.length, 6);
assert.equal(state.revision, 25);
process.stdout.write(JSON.stringify({
    status: 'PASS', fixture: 'SYNTHETIC_ONLY', virtualDays: days, cgm: state.cgm.length,
    confirmedInjections: state.events.length, sportSessions: state.conditionPeriods.length,
    reopenedAt, revision: state.revision, sha256: createHash('sha256').update(durable).digest('hex'),
    elapsedMs: Math.round(performance.now() - started),
}, null, 2) + '\n');
