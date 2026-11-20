'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const web = '../../android-mvp3/app/src/main/assets/www/';
const Storage = require(web + 'modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const Provider = require(web + 'integration/GFProviderCgm_v0.1.0.js');
const Evidence = require(web + 'integration/GFCgmEvidencePolicy_v0.1.0.js');

const now = Date.parse('2026-11-20T00:00:00Z');
const sample = {status:'MEASUREMENT', measuredAtMs:now-300000, receivedAtMs:now,
    mgdl:150, direction:'Flat', stale:false, transport:'xdrip_loopback_live', device:'Follower', deltaMgdl:-1.002};
const direct = (mgdl) => ({
    status:'MEASUREMENT', measuredAtMs:sample.measuredAtMs, receivedAtMs:sample.receivedAtMs, mgdl,
    direction:'Flat', stale:false,
});
const make = () => {
    let disk = null;
    const driver = {load:()=>disk, save:next=>{disk=structuredClone(next);}};
    const open = () => Storage.createHost({clock:()=>new Date(now).toISOString(),driver});
    return {open,host:open()};
};

test('current Web Service is observed once, persists, and remains ineligible for quantitative advice', () => {
    const {host,open} = make();
    assert.equal(Provider.ingest(host,'local',sample,now).status,'OBSERVED');
    assert.equal(Provider.ingest(host,'local',sample,now).idempotent,true);
    const view = Evidence.inspect(open(), {nowMs:now});
    assert.equal(view.reportedMmol,150/18.01559);
    assert.equal(view.currentMmol,null);
    assert.equal(view.status,'OBSERVED_ONLY');
    const snapshot=open().exportState();
    assert.equal(snapshot.revision,1);
    assert.equal(snapshot.cgm[0].transport,'xdrip_loopback_live');
    assert.equal(snapshot.cgm[0].deltaMgdl,-1.002);
});

test('duplicate ContentProvider and Web Service points coalesce and keep ContentProvider precision', () => {
    for (const order of [[sample,direct(150.7)],[direct(150.7),sample]]) {
        const {host,open}=make();
        for (const input of order) Provider.ingest(host,'local',input,now);
        const saved=open().exportState();
        assert.equal(saved.cgm.length,1);
        assert.equal(saved.cgm[0].mgdl,150.7);
        assert.equal(saved.cgm[0].transport,undefined);
        assert.throws(()=>Provider.ingest(host,'local',direct(151),now), /CGM_XDRIP_CONFLICT/);
        assert.deepEqual(saved,open().exportState());
    }
});

test('stale Web Service observations do not become current; conflicting timestamps or freshness fail closed', () => {
    const {host}=make();
    const expired={...sample,measuredAtMs:now-16*60000,stale:true};
    assert.equal(Provider.ingest(host,'local',expired,now).status,'STALE');
    assert.equal(Evidence.inspect(host,{nowMs:now}).reportedMmol,null);
    assert.throws(()=>Provider.ingest(host,'local',{...expired,stale:false},now),/WEB_FORMAT/);
    assert.throws(()=>Provider.ingest(host,'local',{...sample,measuredAtMs:now+1},now),/TIMESTAMP/);
    assert.equal(host.diagnostics().revision,1);
});
