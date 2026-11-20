'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const older = path.resolve(process.argv[2] || '');
const current = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const load = (root, asset) => require(path.join(root, asset));
const storageAsset = 'modules/GFStorage_v0.5.12/src/gfstorage_core.js';
const backupAsset = 'integration/GFJournalBackup_v0.1.0.js';
const sourceAsset = 'integration/GFProviderCgm_v0.1.0.js';
const version = root => fs.readFileSync(path.join(root, 'app.js'), 'utf8').match(/\bVER='([^']+)'/)?.[1];
assert.ok(version(older) && version(current));
const oldStorage = load(older, storageAsset);
const newStorage = load(current, storageAsset);
const oldBackup = load(older, backupAsset);
const newBackup = load(current, backupAsset);
const provider = load(older, sourceAsset);

async function run() {
    const at = Date.parse('2026-11-20T12:00:00.000Z');
    const iso = ms => new Date(ms).toISOString();
    const host = oldStorage.createHost({clock:()=>iso(at)});
    const settings = host.connect('settings');
    settings.updateProfile({displayName:'SYNTHETIC_PROFILE',birthDate:'2019-03-01',
        sex:'male',timeZone:'Europe/Minsk'},0);
    settings.addMeasurement({id:'synthetic-weight-height',measuredAt:iso(at),weightKg:20,heightCm:120},1);
    const writer = host.connect('actionWriter');
    writer.recordInjection({id:'synthetic-backup-shot',insulinId:'rinfast',units:0.5,administeredAt:iso(at-600000)},2);
    provider.ingest(host,'local',{status:'MEASUREMENT',measuredAtMs:at-300000,
        receivedAtMs:at-1000,mgdl:108.09354,direction:'Flat',stale:false},at);
    provider.ingestHistory(host,'local',{status:'HISTORY_READY',anchorTs:at-300000,
        anchorSgv:108,receivedAtMs:at,items:[{measuredAtMs:at-600000,mgdl:101,direction:'Flat'}]},at);

    const snapshot = host.exportState();
    const original = await oldBackup.create('local', snapshot, oldStorage, new Date(at));
    const verified = await newBackup.verify(original, 'local', newStorage);
    assert.deepEqual(verified.snapshot, snapshot);
    assert.equal(verified.snapshot.events.length, 1);
    assert.equal(verified.snapshot.cgm.length, 2);
    assert(await newBackup.verify(original, 'demo', newStorage).then(()=>false, error=>error.message==='BACKUP_MODE_MISMATCH'));
    await assert.rejects(newBackup.verify(original.replace('SYNTHETIC_PROFILE', 'TAMPERED_PROFILE'), 'local', newStorage),
        /BACKUP_CHECKSUM_MISMATCH/);
    process.stdout.write(JSON.stringify({
        status:'PASS',fixture:'SYNTHETIC_ONLY',from:version(older),to:version(current),
        identicalJournal:true,revision:snapshot.revision,measurements:snapshot.measurements.length,
        confirmedFacts:snapshot.events.length,cgm:snapshot.cgm.length,damagedBackupRejected:true,
        actualAndroidUpdate:false
    },null,2)+'\n');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
