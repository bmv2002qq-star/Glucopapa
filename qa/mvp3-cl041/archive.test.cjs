'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');
const {resolve} = require('node:path');
const {test} = require('node:test');
const {at,minute,iso,web,fromWeb,mutate,testJournal} = require('../mvp3-calculators/fixture.cjs');
const Storage = fromWeb('modules/GFStorage_v0.5.11/src/gfstorage_core.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast_storage_adapter.js');
fromWeb('integration/GFForecastReadout_v0.1.0.js');
const Run = fromWeb('integration/GFResearchForecastRun_v0.1.0.js');
const Backup = fromWeb('integration/GFJournalBackup_v0.1.0.js');
const engineContext = {};
for (const file of readFileSync(resolve(web,'runtime/LOAD_ORDER.txt'),'utf8').split(/\r?\n/)
    .filter(line => /modules\/GFAAPSResearch|modules\/GFAPSEnhancer/.test(line))) {
    runInNewContext(readFileSync(resolve(web,file),'utf8'),engineContext,{filename:file});
}
globalThis.GFAPSResearch = engineContext.GFAPSResearch;
globalThis.GFAPSEnhancer = engineContext.GFAPSEnhancer;

function prepare({delayed=false, mergeReceipt=false}={}) {
    const template = testJournal();
    let saved=template.exportState(), fail=false;
    const open = () => Storage.createHost({clock:()=>iso(at),driver:{load:()=>saved,
        save:state=>{if(fail)throw Error('synthetic write fault');saved=structuredClone(state);}}});
    const host=open(), source='SYNTHETIC-CL041';
    mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:source,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
    const rows=Array.from({length:14}, (_, index)=>{
        const ts=at-(13-index)*5*minute-(delayed?minute:0);
        return {ts,sourceDeviceId:source,mmol:6,receivedAt:iso(ts+(mergeReceipt?minute:0)),valid:true,qualityFlag:'ok'};
    });
    mutate(host,'cgmAdapter','ingestReadings',rows);
    const sourceRevision=host.diagnostics().revision;
    const options={host,mode:'local',nowMs:at,mealCoverageRevision:sourceRevision,
        safetyVerdict:{status:'DATA_OK',forecastInputEligible:true,sourceRevision},
        foodHistoryDeclaration:{source:'user_declared',confirmedComplete:true,startIso:iso(at-13*60*minute),
            endIso:iso(at),declaredAtIso:iso(at)}};
    return {open,options,host,sourceRevision,source,failWrite:()=>{fail=true;}};
}

test('PRED-05: two pinned engines share one immutable edition and later data leave archived bytes intact', async () => {
    const {open,options,host,sourceRevision,source}=prepare();
    const start=host.exportState();
    const result=await Run.run(options);
    assert.equal(result.status,'ARCHIVED');
    assert.equal(result.archiveRevision,sourceRevision+1);
    assert.equal(result.sourceRevision,sourceRevision);
    const forecasts=host.connect('research').getSnapshot().forecasts;
    assert.deepEqual(forecasts.map(row=>row.payload.modelId),['GFForecast','GFAPSEnhancer']);
    assert.equal(result.engines.find(row=>row.modelId==='GFxDrip').code,'LICENSE_BLOCKED');
    for (const row of forecasts) {
        assert.equal(row.payload.clinicalUse,false);
        assert.equal(row.payload.inputDigest,result.inputDigest);
        assert.equal(row.payload.sourceRevision,sourceRevision);
        assert.equal(row.payload.sourceTime,iso(at));
        assert.ok(row.payload.points.every((p,i)=>p.glucoseMmol===6&&p.at===iso(at+i*5*minute)));
    }
    const bytes=JSON.stringify(forecasts);
    mutate(host,'cgmAdapter','ingestReadings',[{ts:at+5*minute,sourceDeviceId:source,
        mmol:7,receivedAt:iso(at+5*minute),valid:true,qualityFlag:'ok'}]);
    assert.equal(JSON.stringify(open().connect('research').getSnapshot().forecasts),bytes);
    const state=open().exportState();
    assert.deepEqual(state.events,start.events);
    assert.deepEqual(state.mealSessions,start.mealSessions);
    const backup=await Backup.create('demo',state,Storage,new Date(at));
    assert.equal(JSON.stringify((await Backup.verify(backup,'demo',Storage)).snapshot.forecasts),bytes);
    const writer=host.connect('forecastWriter');
    const batch={schema:'gfforecast.research-events/1',writerRequired:true,forecasts,assessments:[]};
    assert.equal(writer.appendResearchEvents(batch,writer.getRevision()).idempotent,true);
    const edit=structuredClone(batch);
    edit.forecasts[1].payload.points[0].glucoseMmol=7;
    assert.throws(()=>writer.appendResearchEvents(edit,writer.getRevision()),/Конфликт прогноза/);
    assert.equal(JSON.stringify(open().connect('research').getSnapshot().forecasts),bytes);
});

test('engine isolation: preserve true sample time, other series survives', async () => {
    const {host,options}=prepare({delayed:true});
    const result=await Run.run(options);
    assert.equal(result.status,'ARCHIVED');
    assert.equal(result.engines.find(row=>row.modelId==='GFAPSEnhancer').code,'HORIZON_ANCHOR_MISMATCH');
    const [row]=host.connect('research').getSnapshot().forecasts;
    assert.equal(row.payload.modelId,'GFForecast');
    assert.equal(row.payload.sourceTime,iso(at-minute));
    assert.equal(row.payload.points[0].at,iso(at));
    assert.equal(host.exportState().forecasts.length,1);
});

test('front door refuses future receipt, concurrent revision and failed durable commit', async () => {
    const future=prepare({mergeReceipt:true});
    const originalFuture=future.host.exportState();
    assert.equal((await Run.run(future.options)).code,'SOURCE_TIME_UNAVAILABLE');
    assert.deepEqual(future.host.exportState(),originalFuture);
    const race=prepare();
    const pending=Run.run(race.options);
    const settings=race.host.connect('settings');
    settings.updateProfile({timeZone:'Europe/Minsk'},settings.getRevision());
    assert.equal((await pending).code,'REVISION_CHANGED');
    assert.equal(race.open().exportState().forecasts.length,0);
    const failed=prepare();
    failed.failWrite();
    const old=failed.open().exportState();
    assert.equal((await Run.run(failed.options)).code,'FORECAST_ARCHIVE_FAILED');
    assert.deepEqual(failed.open().exportState(),old);
    const switched=prepare();
    assert.equal((await Run.run({...switched.options,isCurrent:()=>false})).code,'REVISION_CHANGED');
    assert.equal(switched.host.exportState().forecasts.length,0);
});

test('stable digest and immutable model inventory on replay of the same input', async () => {
    const first=prepare(), second=prepare();
    const one=await Run.run(first.options), two=await Run.run(second.options);
    assert.equal(one.inputDigest,two.inputDigest);
    assert.match(one.inputDigest,/^[a-f0-9]{64}$/);
    assert.deepEqual(first.open().exportState().forecasts,second.open().exportState().forecasts);
    assert.deepEqual(first.host.exportState().forecasts.map(x=>x.payload.modelVersion),['0.1.2','0.1.1']);
});

test('Stored assessment separates three intervals, excludes future receipts, and never rewrites the source', async () => {
    const review=fromWeb('integration/GFConsensusReview_v0.1.0.js');
    const {open,options,host,source}=prepare();
    await Run.run(options);
    const old=JSON.stringify(host.exportState().forecasts);
    const facts=Array.from({length:24},(_,i)=>{
        const ts=at+(i+1)*5*minute, index=i+1;
        return {ts,sourceDeviceId:source,mmol:index<=6?5:index<=12?7:6,
            receivedAt:iso(index===24?ts+10*minute:ts),valid:true,qualityFlag:'ok'};
    });
    mutate(host,'cgmAdapter','ingestReadings',facts);
    const cutoff=at+125*minute;
    const result=review.archiveAssessment(host,cutoff);
    assert.equal(result.status,'NO_LEADER');
    assert.equal(result.archived,2);
    assert.equal(JSON.stringify(open().exportState().forecasts),old);
    const stored=open().exportState().forecastAssessments;
    assert.equal(stored.length,2);
    for (const row of stored) {
        const intervals=row.payload.intervals;
        assert.deepEqual(intervals.map(r=>[r.fromMin,r.toMin,r.n,r.mae,r.rmse,r.bias]),
            [[0,30,6,1,1,1],[30,60,6,1,1,-1],[60,120,11,0,0,0]]);
        assert.equal(row.payload.checks.at(-1).status,'MISSING_CGM');
    }
    const oldRevision=host.diagnostics().revision;
    assert.equal(review.archiveAssessment(host,cutoff).archived,0);
    assert.equal(host.diagnostics().revision,oldRevision);
    assert.equal(review.archiveAssessment(host,at+131*minute).archived,2);
    assert.equal(host.exportState().forecastAssessments.length,4);
    assert.equal(JSON.stringify(host.exportState().forecasts),old);
});
