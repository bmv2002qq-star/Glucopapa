'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const web = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const fromWeb = file => require(path.join(web, file));
const Storage = fromWeb('modules/GFStorage_v0.5.10/src/gfstorage_core.js');
const CGM = fromWeb('integration/GFCgmEvidencePolicy_v0.1.0.js');
const Journal = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
const JournalAdapter = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal_storage_adapter.js');
const Settings = fromWeb('modules/GFSettings_v0.1.8/src/gfsettings.js');
const Export = fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');

const minute = 60_000;
const base = Date.parse('2026-11-18T12:00:00Z');
const time = ms => new Date(ms).toISOString();
const sensor = 'SYNTHETIC-QA';
const source = {sourceDeviceId: sensor, sourceType: 'synthetic', samplingMinutes: 5, qualityScore: 1};
const reading = (ts, mmol) => ({ts, mmol, sourceDeviceId: sensor, receivedAt: time(ts + minute)});

function fixture() {
    let state = null;
    let failSave = false;
    let now = base;
    const driver = {
        load: () => state ? JSON.parse(state) : null,
        save(next, previous) {
            if (failSave) throw Error('SYNTHETIC_WRITE_ERROR');
            assert.equal(state ? JSON.parse(state).revision : 0, previous);
            state = JSON.stringify(next);
        },
    };
    const reopen = () => Storage.createHost({driver, clock: () => time(now)});
    return {host: reopen(), reopen, clock: value => { now = value; }, fail: value => { failSave = value; }};
}

function call(host, actor, method, payload) {
    const port = host.connect(actor);
    return port[method](payload, port.getRevision());
}

function injection(id, ts, insulinId = 'rinfast') {
    return {id, insulinId, units: 0.5, administeredAt: time(ts), injectionSite: {region: 'abdomen'}};
}

test('1,000 distinct injection, CGM and sport facts use one schema-5 store', () => {
    const {host, reopen, clock} = fixture();
    call(host, 'cgmAdapter', 'setSourceMetadata', source);
    const expected = {events: [], cgm: [], periods: []};
    for (let i = 0; i < 1000; i++) {
        const ts = base + i * 40 * minute;
        const id = 'synthetic-' + i;
        clock(ts);
        switch (i % 3) {
        case 0: {
            const fact = injection(id, ts, i % 2 ? 'rinfast' : 'levemir');
            call(host, 'actionWriter', 'recordInjection', fact);
            const revision = host.diagnostics().revision;
            call(host, 'actionWriter', 'recordInjection', fact);
            assert.equal(host.diagnostics().revision, revision);
            expected.events.push(id);
            break;
        }
        case 1: {
            const row = reading(ts, 6);
            call(host, 'cgmAdapter', 'ingestReadings', [row]);
            const revision = host.diagnostics().revision;
            call(host, 'cgmAdapter', 'ingestReadings', [row]);
            assert.equal(host.diagnostics().revision, revision);
            expected.cgm.push(ts);
            break;
        }
        case 2:
            call(host, 'sport', 'startSport', {id, start: time(ts)});
            clock(ts + 30 * minute);
            call(host, 'sport', 'finishSport', {id, end: time(ts + 30 * minute)});
            expected.periods.push(id);
            break;
        }
    }
    const snapshot = host.exportState();
    assert.equal(snapshot.revision, 1334);
    assert.deepEqual(snapshot.events.map(row => row.id), expected.events);
    assert.deepEqual(snapshot.cgm.map(row => row.ts), expected.cgm);
    assert.deepEqual(snapshot.conditionPeriods.map(row => row.id), expected.periods);
    assert.deepEqual(reopen().exportState(), snapshot);
    assert.equal(new Set(snapshot.history.map(row => row.revision)).size, snapshot.history.length);
    assert(snapshot.history.every((row, index, list) => index === 0 || row.revision === list[index - 1].revision + 1));

    const audit = JSON.parse(Export.exportJson(host));
    const journal = Journal.buildAll(JournalAdapter.connect(host).read());
    assert.equal(audit.events.length, expected.events.length);
    assert.deepEqual(journal.rows.filter(row => row.kind === 'injection').map(row => row.id).sort(), expected.events.slice().sort());
    assert.deepEqual(journal.rows.filter(row => row.kind === 'sport').map(row => row.id).sort(), expected.periods.slice().sort());
});

test('Failed writes, invalid units, malformed timestamps and conflicting IDs preserve the durable snapshot', () => {
    const {host, reopen, fail} = fixture();
    const first = injection('synthetic-confirmed', base - 30 * minute);
    const save = fact => call(host, 'actionWriter', 'recordInjection', fact);
    save(first);
    const state = host.exportState();
    for (const units of [null, undefined, '0.5', NaN, -1, 0]) {
        assert.throws(() => save({...first, id: 'bad-unit', units}));
    }
    for (const administeredAt of [null, 'UNKNOWN', 'INCOMPLETE', undefined, '2026-11-18', time(base + 2 * minute)]) {
        assert.throws(() => save({...first, id: 'bad-clock', administeredAt}));
    }
    assert.throws(() => save({...first, units: 1}));
    assert.throws(() => save({...first, id: 'nearby-different-id'}));
    assert.throws(() => host.connect('journal').recordInjection(first));
    fail(true);
    assert.throws(() => save(injection('synthetic-failed', base - 10 * minute)), /SYNTHETIC_WRITE_ERROR/);
    assert.deepEqual(host.exportState(), state);
    assert.deepEqual(reopen().exportState(), state);
    fail(false);
    save(injection('synthetic-retry', base - 10 * minute));
    assert.equal(reopen().exportState().revision, state.revision + 1);
});

test('Sport restart, activity and illness history keep one source of factual context', () => {
    const {host, reopen, clock} = fixture();
    for (const activity of ['low', 'usual', 'high']) {
        call(host, 'activityUi', 'setBaseLevel', activity);
        assert.equal(host.exportState().profile.activityBaseLevel, activity);
    }
    call(host, 'sport', 'startSport', {id: 'sport-1', start: time(base)});
    let reopened = reopen();
    assert.equal(reopened.exportState().conditionPeriods[0].end, null);
    assert.throws(() => call(reopened, 'activityUi', 'setBaseLevel', 'low'));
    clock(base + 30 * minute);
    call(reopened, 'sport', 'finishSport', {id: 'sport-1', end: time(base + 30 * minute)});
    const settingsPort = reopened.connect('settings');
    const settings = Settings.createSettingsService({settingsPort, clock: () => time(base + 30 * minute)});
    settings.setIllnessFactor(1.2, settingsPort.getRevision());
    call(reopened, 'context', 'openPeriod', {id: 'synthetic-illness', kind: 'illness', start: time(base + 30 * minute)});
    assert.equal(settings.getView(time(base + 30 * minute)).illness.effectiveFactor, 1.2);
    clock(base + 60 * minute);
    call(reopened, 'context', 'closePeriod', {id: 'synthetic-illness', end: time(base + 60 * minute)});
    reopened = reopen();
    const view = Settings.createSettingsService({settingsPort: reopened.connect('settings')});
    assert.equal(view.getView(time(base + 60 * minute)).illness.effectiveFactor, 1);
    assert.equal(reopened.exportState().profile.illnessFactor.value, 1.2);
    const rows = Journal.buildAll(JournalAdapter.connect(reopened).read()).rows;
    assert.equal(rows.filter(row => row.kind === 'sport').length, 1);
    assert.equal(rows.find(row => row.kind === 'sport').durationMinutes, 30);
    assert.equal(reopened.exportState().conditionPeriods[1].end, time(base + 60 * minute));
});

for (const [label, values] of Object.entries({stable: [6, 6, 6, 6], low: [6, 5, 4, 3.3], high: [6, 9, 12, 15]})) {
    for (const lag of [5, 10, 15, 30]) {
        test('SYNTHETIC CGM ' + label + ', last sample ' + lag + ' min ago', () => {
            const {host, reopen} = fixture();
            call(host, 'cgmAdapter', 'setSourceMetadata', source);
            assert.equal(CGM.inspect(host, {nowMs: base}).currentMmol, null);
            const rows = values.map((value, index) => reading(base - (lag + 5 * (3 - index)) * minute, value));
            call(host, 'cgmAdapter', 'ingestReadings', rows.slice().reverse());
            const revision = host.diagnostics().revision;
            call(host, 'cgmAdapter', 'ingestReadings', rows);
            assert.equal(host.diagnostics().revision, revision);
            assert.throws(() => call(host, 'cgmAdapter', 'ingestReadings', [{...rows[0], mmol: -1}]));
            assert.throws(() => call(host, 'cgmAdapter', 'ingestReadings', [{...rows[0], mmol: 7}]));

            call(host, 'actionWriter', 'recordInjection', injection('synthetic-event', rows.at(-1).ts));
            const persisted = reopen();
            const view = CGM.inspect(persisted, {nowMs: base});
            assert.equal(view.sourceStatus, 'SYNTHETIC');
            assert.equal(view.status, lag <= 15 ? 'OK' : 'STALE');
            assert.equal(view.currentMmol, lag <= 15 ? values.at(-1) : null);
            assert.equal(CGM.inspect(persisted, {nowMs: base - (lag + 1) * minute}).status, 'FUTURE_BLOCKED');
            assert.equal(CGM.inspect(persisted, {nowMs: null}).currentMmol, null);
            const diary = CGM.journalView(persisted, Journal, JournalAdapter, {nowMs: base});
            assert.equal(diary.rows[0].glucose.value, values.at(-1));
            assert.equal(diary.rows[0].glucose.source, 'synthetic');
            const expired = CGM.inspect(persisted, {nowMs: base + 90 * minute});
            assert.equal(expired.currentMmol, null);
            assert.equal(CGM.checkSafety(persisted, null, {nowMs: base}).insulinDoseDecisionAllowed, false);
        });
    }
}
