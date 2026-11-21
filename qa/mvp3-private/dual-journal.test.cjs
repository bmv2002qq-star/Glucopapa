'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const web = '../../android-mvp3/app/src/main/assets/www/';
const Storage = require(web+'modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const Policy = require(web+'integration/GFCgmEvidencePolicy_v0.1.0.js');
const Graph = require(web+'integration/GFGraphEvidenceBridge_v0.1.0.js');
const Chart = require(web+'modules/CGMChart_v0.2/xdrip_chart.js');
const RinFast = require(web+'shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
const Backup = require(web+'integration/GFJournalBackup_v0.1.0.js');
const Timing = require(web+'integration/GFMealTimingService_v0.1.0.js');
const MealController = require(web+'modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js');
const {build} = require('./build_seeds.cjs');
const {replay} = require('./replay.cjs');
const min=60000, iso=value=>new Date(value).toISOString();
const first=Date.parse('2040-03-01T00:00:00Z'), last=first+1435*min, live=last+175*min;
const profile={displayName:'SYNTHETIC',birthDate:'2033-06-18',
    timeZone:'UTC',heightCm:119,weightKg:21,reportedAt:iso(last)};
const archive={version:1,sourceDigest:'8'.repeat(64),timeZone:'UTC',
    points:[[first,110],[first+5*min,120],[last-5*min,130],[last,140]],
    meter:[[last,113],[last,121]],
    notes:[{id:'reported-a',day:'2040-03-01',time:null,text:'Фикстура технических испытаний',provenance:'user_reported'}]};
const normal=build(profile), research=build(profile,archive);
const open=(state,clock=live)=>Storage.createHost({
    clock:()=>iso(clock),driver:{load:()=>state,save(){}}});

test('main seed contains profile only, hybrid rows appear only in journal and graph projections',async()=>{
    assert.deepEqual(normal.profile.birthDate,research.profile.birthDate);
    assert.deepEqual(normal.measurements,research.measurements);
    for(const field of ['events','mealSessions','cgm','conditionPeriods','coefficients'])assert.deepEqual(normal[field],[]);
    assert.equal(normal.privateHistory,undefined);
    const host=open(research);
    assert.ok(host.connect('journal').read('events').length>0);
    assert.ok(host.connect('journal').read('mealSessions').every(row=>row.id.startsWith('qa-seed-')));
    for(const role of ['research','rinfast','levemir','injectionAnalytics','calculator','lowReview']){
        const view=host.connect(role).getSnapshot();
        for(const field of ['events','mealSessions','conditionPeriods'])if(view[field])assert.deepEqual(view[field],[]);
    }
    const controller=MealController.createController(host);
    controller.createFromFood(research.mealSessions[0].actualPlate,'new-draft');
    assert.equal(Timing.refresh(host,{sessionId:'new-draft',units:2,site:'abdomen',
        atIso:iso(live),mode:'local'}).code,'NON_LOCAL_HISTORY');
    await assert.rejects(Backup.create('local',research,Storage),/BACKUP_RESEARCH_JOURNAL_ISOLATED/);
    assert.equal(host.connect('archive').meter().length,2);
    assert.equal(new Set(host.connect('archive').meter().map(x=>x.id)).size,2);
    assert.equal(host.connect('archive').reportedNotes()[0].time,null);
    assert.deepEqual(host.connect('archive').replay(),replay());
});

test('xDrip observations append after the archive minute, with single conversion, gap and preserved history',()=>{
    const host=open(research);
    const port=host.connect('cgmAdapter');
    const initial=port.getRevision();
    const shot=ts=>({ts,mgdl:150,receivedAt:iso(live),direction:'Flat',staleAtReceipt:false});
    assert.equal(Policy.inspect(host,{nowMs:live}).status,'ARCHIVED_ONLY');
    assert.equal(Policy.inspect(host,{nowMs:live}).currentMmol,null);
    assert.equal(port.ingestXDripObservation(shot(last+59000),initial).revision,initial);
    assert.equal(port.ingestXDripObservation(shot(live),initial).revision,initial+1);
    assert.equal(port.ingestXDripObservation(shot(live),initial+1).revision,initial+1);
    const state=host.exportState();
    assert.deepEqual(state.privateHistory,research.privateHistory);
    const reopened=open(state);
    const view=Policy.inspect(reopened,{nowMs:live});
    assert.equal(view.status,'OBSERVED_ONLY');
    assert.equal(view.currentMmol,null);
    assert.ok(Math.abs(view.reportedMmol-150/18.01559)<1e-10);
    assert.equal(view.timelineReadings.at(-2).source,'real_cgm_import');
    const detail=Graph.render({host:reopened,renderer:Chart,engine:RinFast,nowMs:live,historyH:12});
    const trace=detail.svg.match(/class="gp-cgm-trace">([\s\S]*?)<\/g>/)[1];
    assert.equal((trace.match(/<path /g)||[]).length,2);
});

test('reopened private seed retains an edit and validated archive is idempotent',()=>{
    let disk=structuredClone(research);
    const reopen=()=>Storage.createHost({clock:()=>iso(live),driver:{load:()=>disk,save(next){disk=next;}}});
    let host=reopen(), port=host.connect('settings');
    port.addMeasurement({id:'later-weight',measuredAt:iso(live),weightKg:22,heightCm:120},port.getRevision());
    host=reopen();
    assert.equal(host.connect('settings').read('measurements').at(-1).weightKg,22);
    const seed=host.connect('researchSeed'), revision=seed.getRevision();
    assert.equal(seed.install(disk.privateHistory,revision).revision,revision);
    assert.equal(seed.recordReplay(replay(),revision).revision,revision);
    const corrupt=structuredClone(disk);
    corrupt.privateHistory.points.push(corrupt.privateHistory.points.at(-1));
    assert.throws(()=>open(corrupt),/PRIVATE_HISTORY_READING/);
    const misleading=structuredClone(disk);
    misleading.privateHistory.replay.appliedToProfile=true;
    assert.throws(()=>open(misleading),/PRIVATE_REPLAY_FORMAT/);
});

test('the explicit reset removes only scenario records and preserves profile, coefficients and real history',()=>{
    let disk=research;
    const host=Storage.createHost({clock:()=>iso(live),driver:{load:()=>disk,save(next){disk=next;}}});
    const writer=host.connect('actionWriter');
    writer.recordInjection({id:'confirmed-after-install',insulinId:'rinfast',units:0.5,administeredAt:iso(live)},
        writer.getRevision());
    const before=host.exportState(),seed=host.connect('researchSeed');
    assert.equal(seed.clearScenario(before.revision).revision,before.revision+1);
    const after=open(host.exportState()).exportState();
    for(const key of ['profile','measurements','coefficients','privateHistory'])assert.deepEqual(after[key],before[key]);
    assert.deepEqual(after.events.map(row=>row.id),['confirmed-after-install']);
    assert.deepEqual(after.mealSessions,[]);
    assert.deepEqual(after.conditionPeriods,[]);
    assert.equal(seed.clearScenario(after.revision).idempotent,true);
    const main=open(normal).connect('researchSeed');
    assert.throws(()=>main.clearScenario(main.getRevision()),/PRIVATE_HISTORY_REQUIRED/);
});
