const {test}=require('node:test');
const assert=require('node:assert/strict');
const web='../../android-mvp3/app/src/main/assets/www/';
const Storage=require(web+'modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const Cgm=require(web+'integration/GFProviderCgm_v0.1.0.js');
const Policy=require(web+'integration/GFCgmEvidencePolicy_v0.1.0.js');
const Export=require(web+'modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');

const minute=60000;
const now=Date.parse('2026-11-20T16:00:00Z');
const anchor=now-5*minute;
const nowIso=new Date(now).toISOString();
const point=(offset,mgdl=100)=>({measuredAtMs:anchor-offset*minute,mgdl,direction:'Flat'});
const latest={status:'MEASUREMENT',measuredAtMs:anchor,receivedAtMs:now-1000,mgdl:108.09354,
  direction:'FortyFiveDown',stale:false};
const batch=(items=[point(10),point(5,104)])=>({
  status:'HISTORY_READY',anchorTs:anchor,anchorSgv:108,receivedAtMs:now,items
});
const setup=()=>{
  let data=null;
  const driver={load:()=>data,save:snapshot=>{data=snapshot;}};
  const open=()=>Storage.createHost({driver,clock:()=>nowIso});
  const host=open();
  Cgm.ingest(host,'local',latest,now);
  return {host,open};
};

test('history is one atomic commit, idempotent, persistent and identified in JSON export',()=>{
  const {host,open}=setup();
  const result=Cgm.ingestHistory(host,'local',batch([point(5,104),point(10),point(10)]),now);
  assert.deepEqual(result,{status:'HISTORY_IMPORTED',revision:2,added:2});
  assert.equal(Cgm.ingestHistory(host,'local',batch(),now).added,0);
  const saved=open().exportState();
  assert.equal(saved.revision,2);
  assert.equal(saved.history[1].action,'import_xdrip_history');
  assert.deepEqual(saved.cgm.map(row=>row.ts),[anchor-10*minute,anchor-5*minute,anchor]);
  assert.equal(saved.cgm[0].transport,'xdrip_loopback_history');
  assert.equal(saved.cgm[0].staleAtReceipt,null);
  assert.equal(saved.cgm[2].receivedAt,new Date(now-1000).toISOString());
  assert.equal(saved.cgm[2].mgdl,latest.mgdl);
  assert.throws(()=>Cgm.ingestHistory(host,'local',batch([{...point(5,104),direction:'SingleUp'}]),now),/HISTORY_CONFLICT/);
  assert.deepEqual(host.exportState(),saved);
  assert.deepEqual(JSON.parse(Export.exportJson(open())).cgm,saved.cgm);
});

test('duplicate and conflicting overlapping direct points never lose provider precision',()=>{
  const {host}=setup();
  Cgm.ingest(host,'local',{...latest,measuredAtMs:anchor-5*minute,mgdl:104.8},now);
  const result=Cgm.ingestHistory(host,'local',batch(),now);
  assert.equal(result.added,1);
  const snapshot=host.exportState();
  assert.equal(snapshot.cgm[1].mgdl,104.8);
  assert.throws(()=>Cgm.ingestHistory(host,'local',batch([point(20),point(5,105)]),now),/HISTORY_CONFLICT/);
  assert.deepEqual(host.exportState(),snapshot);
});

test('backfilled points never enter calculation inputs or establish live freshness',()=>{
  const {host,open}=setup();
  Cgm.ingestHistory(host,'local',batch(),now);
  const sample=open(), view=Policy.inspect(sample,{nowMs:now});
  assert.equal(view.reportedMmol,6);
  assert.equal(view.currentMmol,null);
  assert.equal(view.status,'OBSERVED_ONLY');
  assert.equal(view.timelineReadings.length,3);
  assert.equal(view.readings.length,1);
  assert.equal(view.rawReadings.length,1);
  for(const role of ['calculator','lowReview','mealFlow','research','injectionAnalytics','cgm','syncWriter']){
    assert.equal(sample.connect(role).read('cgm').length,1,role);
    assert.equal(sample.connect(role).getSnapshot().cgm.length,1,role);
  }
  assert.equal(Policy.forEvent(view,anchor-5*minute).value,null);
});

test('direct delivery replaces a historical slot without a duplicate and preserves other history',()=>{
  const {host,open}=setup();
  Cgm.ingestHistory(host,'local',batch(),now);
  const promoted={...latest,measuredAtMs:anchor-5*minute,mgdl:107.7};
  Cgm.ingest(host,'local',promoted,now);
  assert.equal(Cgm.ingest(host,'local',promoted,now).idempotent,true);
  const saved=open().exportState();
  assert.equal(saved.cgm.length,3);
  assert.equal(saved.cgm[1].mgdl,107.7);
  assert.equal(saved.cgm[1].transport,undefined);
  assert.equal(saved.cgm[0].transport,'xdrip_loopback_history');
});

test('wrong anchor, future or old time, out-of-range, fractional and conflicting history leave journal unchanged',()=>{
  const {host}=setup();
  const baseline=host.exportState();
  for(const invalid of [
    {...batch(),anchorTs:anchor-5*minute},{...batch(),anchorSgv:109},{...batch(),receivedAtMs:now+1},
    batch([point(5),point(0)]),batch([point(10),point(5,900)]),batch([point(1450)]),
    batch([point(5,100.25)]),batch([point(10),point(10,101)]),
    batch([point(5),{...point(10),direction:'UNKNOWN'}]),
    batch(Array(288).fill(point(5))),
  ]){
    assert.throws(()=>Cgm.ingestHistory(host,'local',invalid,now));
    assert.deepEqual(host.exportState(),baseline);
  }
  assert.equal(Cgm.ingestHistory(host,'demo',batch(),now).status,'LOCAL_ONLY');
  assert.equal(Cgm.ingestHistory(host,'local',{status:'HISTORY_ANCHOR_MISMATCH'},now).status,'HISTORY_ANCHOR_MISMATCH');
  assert.throws(()=>Cgm.ingestHistory(Storage.createHost({clock:()=>nowIso}),'local',batch(),now),/ANCHOR/);
  const orphan={...baseline,cgm:[]};
  assert.throws(()=>Cgm.ingestHistory(Storage.createHost({driver:{load:()=>orphan,save:()=>{}},clock:()=>nowIso}),
    'local',batch(),now),/ANCHOR/);
});

test('stale writer and persistence failure cannot partially install history',()=>{
  const {host,open}=setup();
  const older=open();
  Cgm.ingestHistory(host,'local',batch(),now);
  assert.throws(()=>Cgm.ingestHistory(older,'local',batch([point(22)]),now),/CONCURRENT_STORAGE_CHANGE/);
  assert.equal(older.exportState().cgm.length,1);
  assert.equal(open().exportState().cgm.length,3);
  const base=older.exportState();
  const failing=Storage.createHost({clock:()=>nowIso,driver:{load:()=>base,save(){throw Error('DISK_FULL');}}});
  assert.throws(()=>Cgm.ingestHistory(failing,'local',batch(),now),/DISK_FULL/);
  assert.deepEqual(failing.exportState(),base);
});
