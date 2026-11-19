const assert = require('node:assert/strict');
const {test} = require('node:test');
const {resolve} = require('node:path');
const {createHash} = require('node:crypto');
const root = process.env.GLUCOPAPA_QA_SOURCE;
const {fromWeb,testJournal,addPlate,mutate,at,minute,iso} =
    require(resolve(root,'qa/mvp3-calculators/fixture.cjs'));
const Storage = fromWeb('modules/GFStorage_v0.5.11/src/gfstorage_core.js');
const Journal = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
const Bridge = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal_storage_adapter.js');
const Export = fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');
const Cof = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');
const rows = host => Journal.buildAll(Bridge.connect(host).read()).rows;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const portion = (plate,ratio) => {
    const scale = row => ({...row,...Object.fromEntries(
        ['carbs','kcal','protein','fat','amount'].map(k=>[k,row[k]*ratio]))});
    return {...plate,items:plate.items.map(scale),totals:scale(plate.totals)};
};

test('ST-02 / MEAL-03: planned plate, one confirmed portion, correction and one integral audit path', () => {
    const host=testJournal();
    const {controller,plate,id}=addPlate(host,{grams:100,carbs:20,estimated:false});
    const check=(count,carbs)=>{
        const all=rows(host).filter(row=>row.kind==='meal');
        assert.equal(all.length,1);
        const projected=Cof.inspect({host,nowMs:at});
        assert.equal(projected.rows.length,count);
        assert.equal(all[0].meal?.carbs??null,carbs);
        if(count)assert.equal(projected.rows[0].recordedCarbsG,carbs);
    };
    check(0,null);
    controller.ready(id);check(0,null);
    controller.startMeal(id,iso(at-45*minute),{actuallyStarted:true});check(0,null);
    controller.actualFood(id,portion(plate,.75),{parentConfirmed:true});
    assert.equal(Cof.inspect({host,nowMs:at}).code,'MEAL_NOT_COMPLETED');
    controller.finishMeal(id,iso(at-30*minute),{confirmed:true});
    check(1,15);
    assert.throws(()=>controller.actualFood(id,portion(plate,.5),{parentConfirmed:true}));
    controller.actualFood(id,portion(plate,.5),{parentConfirmed:true,reason:'SYNTHETIC 50 percent'});
    check(1,10);
    const state=host.exportState();
    assert.equal(state.mealSessions.length,1);
    assert.equal(state.mealSessions[0].plannedPlate.totals.carbs,20);
    assert.equal(state.mealSessions[0].actualPlate.totals.carbs,10);
    assert.deepEqual(state.workflowLog.map(x=>x.after.version),[1,2,3,4,5,6]);
    assert.equal(state.events.length,0);
    assert.ok(state.workflowLog.every(op=>state.history.find(h=>h.revision===op.revision).recordId===id));
    assert.deepEqual(Export.collect(host).mealSessions,state.mealSessions);
});

test('ST-08: repeated local DST time, Minsk midnight, and stable historical time after correction', () => {
    const host=testJournal({zone:'Europe/Berlin'});
    for (const [id,administeredAt] of [['spring-clock-a','2026-10-25T02:30:00+02:00'],
        ['spring-clock-b','2026-10-25T02:30:00+01:00'],['midnight','2026-11-18T21:00:00Z']]) {
        mutate(host,'actionWriter','recordInjection',{id,administeredAt,insulinId:'rinfast',units:0.5});
    }
    const berlin=rows(host).filter(r=>r.kind==='injection');
    assert.equal(berlin[0].time,berlin[1].time);
    assert.notEqual(berlin[0].ts,berlin[1].ts);
    const state=host.exportState(), prior=sha(state.events);
    mutate(host,'settings','updateProfile',{timeZone:'Europe/Minsk'});
    const minsk=rows(host).find(r=>r.id==='midnight');
    assert.equal(minsk.day,'2026-11-19'); assert.equal(minsk.time,'00:00');
    assert.equal(sha(host.exportState().events),prior);
    const {controller,plate,id}=addPlate(host);
    controller.ready(id);
    controller.startMeal(id,iso(at-12*60*minute),{actuallyStarted:true});
    controller.actualFood(id,portion(plate,.75),{parentConfirmed:true});
    controller.finishMeal(id,iso(at-11*60*minute),{confirmed:true});
    assert.equal(rows(host).find(r=>r.id===id).time,'03:00');
    controller.actualFood(id,portion(plate,.5),{parentConfirmed:true,reason:'SYNTHETIC ACTUAL'});
    assert.equal(rows(host).find(r=>r.id===id).time,'03:00');
    assert.equal(sha(host.exportState().events),prior);
});

test('ST-06: legacy schema 1–4 projections retain factual and optional data when representable', () => {
    const original=testJournal();
    mutate(original,'actionWriter','recordInjection',{id:'SYNTHETIC-LEGACY-RECORD',insulinId:'rinfast',units:0.5,administeredAt:iso(at-minute)});
    mutate(original,'graph','setPreferences',{showRinfast:false});
    mutate(original,'context','openPeriod',{id:'SYNTHETIC-SCHEMA-PERIOD',kind:'illness',start:iso(at-minute)});
    const complete=original.exportState();
    const checksum=sha(complete.events);
    for (const version of [1,2,3,4]) {
        const state=structuredClone(complete);
        state.schemaVersion=version;
        delete state.profile.dailyNutritionReference;
        if(version===1){delete state.profile.sex; delete state.mealSessions;delete state.workflowLog;}
        if(version<=2){delete state.cgmMetadata;delete state.conditionPeriods;}
        if(version<=3){delete state.forecasts;delete state.forecastAssessments;delete state.syncInbox;}
        const fake={load:()=>state,save:()=>assert.fail('reading legacy data must not write')};
        const after=Storage.createHost({driver:fake}).exportState();
        assert.equal(after.schemaVersion,5);
        assert.equal(sha(after.events),checksum);
        assert.equal(after.revision,complete.revision);
        assert.equal(after.profile.timeZone,complete.profile.timeZone);
        assert.equal(after.profile.dailyNutritionReference,null);
        assert.equal(after.graphPreferences.showRinfast,false);
        assert.equal(after.conditionPeriods.length,version<=2?0:1);
    }
});

test('ACT-08: reversed end and overlapping sessions are rejected without changing the snapshot', () => {
    let now=at, saved;
    const host=Storage.createHost({clock:()=>iso(now),driver:{load:()=>saved,save:s=>{saved=structuredClone(s);}}});
    mutate(host,'sport','startSport',{id:'SYNTHETIC-OLD-SPORT',start:iso(at)});
    const open=sha(host.exportState());
    assert.throws(()=>mutate(host,'sport','finishSport',{id:'SYNTHETIC-OLD-SPORT',end:iso(at-minute)}));
    assert.throws(()=>mutate(host,'activityUi','setBaseLevel','high'));
    assert.equal(sha(host.exportState()),open);
    now=at+30*minute;
    mutate(host,'sport','finishSport',{id:'SYNTHETIC-OLD-SPORT',end:iso(now)});
    const completed=sha(host.exportState());
    now=at+15*minute; // Simulate an Android wall-clock correction.
    assert.throws(()=>mutate(host,'sport','startSport',{id:'NEW-SYNTHETIC-SPORT',start:iso(now)}), /Перекрытие/);
    assert.equal(sha(host.exportState()),completed);
    assert.equal(rows(host).filter(x=>x.kind==='sport').length,1);
});

test('GRAPH-01: two established injections preserve separate observed link, dashed line and peak', () => {
    const chart=fromWeb('modules/CGMChart_v0.2/xdrip_chart.js');
    const bridge=fromWeb('integration/GFGraphEvidenceBridge_v0.1.0.js');
    const engine=fromWeb('shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
    const host=testJournal({glucose:6.1});
    const injections=[{id:'SYNTHETIC-RIN-A',units:0.5,insulinId:'rinfast',administeredAt:iso(at-80*minute)},
        {id:'SYNTHETIC-RIN-B',units:1,insulinId:'rinfast',administeredAt:iso(at-45*minute)}];
    for(const item of injections)mutate(host,'actionWriter','recordInjection',item);
    const result=bridge.render({host,renderer:chart,engine,nowMs:at});
    const original=chart.renderSvg({readings:host.connect('graph').getSnapshot().cgm,
        shots:injections.map(x=>({...x,ts:Date.parse(x.administeredAt),status:'confirmed'})),
        engine,now:at,historyH:12,showInsulin:true,showTotal:false,layout:'guided'});
    assert.equal(result.svg,original.svg);
    assert.equal(result.shotCount,2);
    const traces=result.svg.slice(result.svg.indexOf('gp-rinfast-model'));
    assert.equal((traces.match(/data-insulin-mark="1"/g)||[]).length,2);
    assert.ok(traces.includes('stroke-dasharray='));
    assert.equal(rows(host).filter(x=>x.kind==='injection').length,2);
});
