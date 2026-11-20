'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');

const web = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const fromWeb = name => require(path.join(web, name));
const Storage = fromWeb('modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const OldStorage = fromWeb('modules/GFStorage_v0.5.10/src/gfstorage_core.js');
const CGM = fromWeb('integration/GFCgmEvidencePolicy_v0.1.0.js');
const Provider = fromWeb('integration/GFProviderCgm_v0.1.0.js');
const Backup = fromWeb('integration/GFJournalBackup_v0.1.0.js');
const Journal = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
const Research = fromWeb('integration/GPMvp3ResearchUI_v0.1.0.js');
const Settings = fromWeb('modules/GFSettings_v0.1.8/src/gfsettings.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast_storage_adapter.js');
fromWeb('shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
const Forecast = fromWeb('integration/GFForecastReadout_v0.1.0.js');

const MIN = 60_000, now = Date.parse('2026-11-18T12:00:00Z');
const iso = value => new Date(value).toISOString();
const makeHost = Storage => Storage.createHost({clock: () => iso(now)});
const measurement = ({minutes = 5, output = 108.09354, stale = false, direction = 'FortyFiveDown'} = {}) =>
    ({status: 'MEASUREMENT', measuredAtMs: now - minutes * MIN, receivedAtMs: now, mgdl: output, direction, stale});
const call = (host, role, method, value) => {
    const port = host.connect(role);
    return port[method](value, port.getRevision());
};

test('the local provider records one atomic observation with raw units, receipt and nullable source evidence', () => {
    let persisted = null;
    const driver = {
        load: () => persisted,
        save: state => { persisted = structuredClone(state); },
    };
    const open = () => Storage.createHost({driver, clock: () => iso(now)});
    const host = open();
    const first = {...measurement(), receivedAtMs: now - 1};
    assert.deepEqual(Provider.ingest(host, 'demo', first, now), {status: 'LOCAL_ONLY'});
    assert.equal(host.diagnostics().revision, 0);
    assert.equal(Provider.ingest(host, 'local', {status: 'NO_PROVIDER'}, now).status, 'NO_PROVIDER');
    assert.equal(host.diagnostics().revision, 0);
    assert.equal(Provider.ingest(host, 'local', first, now).revision, 1);
    assert.equal(Provider.ingest(host, 'local', {...first, receivedAtMs: now}, now).idempotent, true);
    const state = open().exportState();
    const [row] = state.cgm;
    assert.equal(row.mgdl, first.mgdl);
    assert.equal(row.mmol, 6);
    assert.equal(row.receivedAt, iso(now - 1));
    assert.equal(state.cgmMetadata.samplingMinutes, null);
    assert.equal(state.cgmMetadata.qualityScore, null);
    assert.equal(state.revision, 1);
    assert.equal(state.history.length, 1);
    const view = CGM.inspect(host, {nowMs: now});
    assert.equal(view.status, 'OBSERVED_ONLY');
    assert.equal(view.currentMmol, null);
    assert.equal(view.reportedMmol, 6);
    assert.equal(CGM.forEvent(view, now, {journal: Journal}).direction, '↘');
    assert.equal(CGM.checkSafety(host, null, {nowMs: now}).forecastInputEligible, false);
});

test('provider freshness at 5, 10, 15 and 30 minutes plus reported stale and unknown', () => {
    for (const [minutes, stale, direction, status, display] of [
        [5, false, 'Flat', 'OBSERVED_ONLY', 6], [10, false, 'Flat', 'OBSERVED_ONLY', 6],
        [15, false, 'Flat', 'OBSERVED_ONLY', 6], [30, false, 'Flat', 'STALE', null],
        [5, true, 'Flat', 'STALE', null], [5, null, null, 'OBSERVED_ONLY', null],
    ]) {
        const host = makeHost(Storage);
        Provider.ingest(host, 'local', measurement({minutes, stale, direction}), now);
        const view = CGM.inspect(host, {nowMs: now});
        assert.equal(view.status, status);
        assert.equal(view.reportedMmol, display);
        assert.equal(view.currentMmol, null);
        if (direction === null) assert.equal(CGM.forEvent(view, now, {journal: Journal}).direction, null);
    }
});

test('reject incompatible provenance, conflicts, future timestamps and invalid numbers without extra revisions', () => {
    const host = makeHost(Storage);
    const first = measurement();
    assert.throws(() => Provider.ingest(host, 'local', measurement({minutes: -1}), now), /PROVIDER_TIMESTAMP/);
    assert.throws(() => Provider.ingest(host, 'local', measurement({output: 0}), now));
    assert.equal(host.diagnostics().revision, 0);
    Provider.ingest(host, 'local', first, now);
    Provider.ingest(host, 'local', measurement({minutes: 10}), now);
    assert.throws(() => Provider.ingest(host, 'local', {...first, mgdl: 109}, now), /CGM_XDRIP_CONFLICT/);
    assert.throws(() => call(host, 'cgmAdapter', 'ingestReadings', []), /CGM_XDRIP_USE_PROVIDER_PORT/);
    assert.equal(host.diagnostics().revision, 2);
    assert.deepEqual(host.exportState().cgm.map(x => x.ts), [now - 10 * MIN, now - 5 * MIN]);
    assert.equal(CGM.inspect(host, {nowMs: now - MIN}).status, 'FUTURE_BLOCKED');
    const existing = makeHost(Storage);
    call(existing, 'cgmAdapter', 'setSourceMetadata', {sourceDeviceId: 'SYNTHETIC-ONLY', sourceType: 'synthetic',
        samplingMinutes: 5, qualityScore: 1});
    assert.throws(() => Provider.ingest(existing, 'local', first, now), /CGM_SOURCE_CONFLICT/);
    assert.equal(existing.diagnostics().revision, 1);
});

test('exact v5 history from previous runtime migrates without changed facts and roundtrips backup', async () => {
    const old = makeHost(OldStorage);
    call(old, 'actionWriter', 'recordInjection', {id: 'synthetic-injection', insulinId: 'rinfast',
        units: 0.5, administeredAt: iso(now - MIN), injectionSite: {region: 'abdomen'}});
    const before = old.exportState();
    const readOnly = {load: () => before, save: () => assert.fail('unexpected write')};
    const host = Storage.createHost({driver: readOnly});
    assert.deepEqual(host.exportState(), before);
    const backup = await Backup.create('demo', host.exportState(), Storage, new Date(now));
    const result = await Backup.verify(backup, 'demo', Storage);
    assert.deepEqual(result.snapshot, before);
    let restored;
    const native = {importIfAbsent: (key, data) => {
        assert.equal(key, 'GFV2SHELL_DATA_v1_demo');
        if (restored) return '{"ok":true,"code":"EXISTS"}';
        restored = JSON.parse(data);
        return JSON.stringify({ok: true, code: 'IMPORTED', revision: restored.revision});
    }};
    Backup.importEmpty(native, 'GFV2SHELL_DATA_v1_demo', result);
    assert.deepEqual(restored, before);
    assert.throws(() => Backup.importEmpty(native, 'GFV2SHELL_DATA_v1_demo', result), /BACKUP_TARGET_EXISTS/);
    assert.throws(() => Backup.importEmpty(native, 'GFV2SHELL_DATA_v1_local', result), /BACKUP_MODE_MISMATCH/);
    await assert.rejects(Backup.verify(backup.replace('0.5', '1.5'), 'demo', Storage), /BACKUP_CHECKSUM_MISMATCH/);
    await assert.rejects(Backup.verify(backup, 'local', Storage), /BACKUP_MODE_MISMATCH/);
    await assert.rejects(Backup.verify(backup.slice(0, -1), 'demo', Storage), /BACKUP_INVALID_JSON/);
});

test('virtual physiology cannot select a synthetic profile while the local journal is active', () => {
    const host = makeHost(Storage);
    const result = Research.physio(host, now, 'local');
    assert.equal(result.status, 'VIRTUAL_PROFILE_REQUIRED');
    assert.equal(result.canDose, false);
    assert.equal(host.diagnostics().revision, 0);
});

test('forecast readout invokes the pinned core on a synthetic eligible contract and rejects unknown evidence', () => {
    const host = makeHost(Storage);
    const key = 'SYNTHETIC-QA-FORECAST';
    call(host, 'cgmAdapter', 'setSourceMetadata', {sourceDeviceId: key, sourceType: 'device_recorded',
        samplingMinutes: 5, qualityScore: 1});
    call(host, 'cgmAdapter', 'ingestReadings', [25, 20, 15, 10, 5].map(n => ({
        ts: now - n * MIN, mmol: 6, sourceDeviceId: key, receivedAt: iso(now - (n - 1) * MIN),
    })));
    call(host, 'actionWriter', 'setCoverage', {startIso: iso(now - 49 * 60 * MIN), endIso: iso(now),
        confirmedComplete: true, declaredBy: 'parent'});
    const settingsPort = host.connect('settings');
    const settings = Settings.createSettingsService({settingsPort, clock: () => iso(now - 30 * MIN)});
    settings.saveProfile({timeZone: 'UTC'}, settingsPort.getRevision());
    for (const [kind, value] of [['carb_g_per_u', 10], ['isf_mmol_per_u', 3]]) {
        settings.addCoefficient({kind, value, source: 'manual', windowLocal: {from: '12:00', to: '18:00'}},
            settingsPort.getRevision());
    }
    const revision = host.diagnostics().revision;
    const input = {host, mode: 'local', nowMs: now, mealCoverageRevision: revision,
        safetyVerdict: {status: 'DATA_OK', forecastInputEligible: true, sourceRevision: revision},
        foodHistoryDeclaration: {source: 'user_declared', confirmedComplete: true,
            startIso: iso(now - 13 * 60 * MIN), endIso: iso(now), declaredAtIso: iso(now)}};
    assert.equal(Forecast.run({...input, mode: 'demo'}).code, 'TEST_JOURNAL');
    assert.equal(Forecast.run({...input, safetyVerdict: null}).code, 'SAFETY_VERDICT_REQUIRED');
    assert.equal(Forecast.run({...input, mealCoverageRevision: revision - 1}).code, 'MEAL_COVERAGE');
    const output = Forecast.run(input);
    assert.equal(output.status, 'EXPERIMENTAL');
    assert.equal(output.clinicalUse, false);
    assert.equal(output.points.length, 25);
    assert(output.points.every(row => row.glucoseMmol === 6));
    assert.equal(host.diagnostics().revision, revision);
});
