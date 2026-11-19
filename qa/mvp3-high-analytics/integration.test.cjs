'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {Storage,Settings,Rinfast,at,iso,minute,fromWeb,mutate,testJournal,addPlate}=require('../mvp3-calculators/fixture.cjs');
fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
fromWeb('modules/GFInjectionAnalytics_v0.1.1/gf_injection_analytics.js');
const analytics=fromWeb('modules/GFInjectionAnalytics_v0.2.1/GFInjectionAnalytics_v0.2.1.js');
const timing=fromWeb('integration/GFInjectionTimingStorage_v0.1.0.js');
const absorption=fromWeb('integration/GFMealAbsorption_v0.1.0.js');
const profile=fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');
const core=fromWeb('modules/GFHighTarget_v0.1.4/gfhigh_target_core.js');
const high=fromWeb('integration/GFHighTargetStorage_v0.1.1.js');
const hour=60*minute;

function highSettings(host, patch) {
    const port=host.connect('settings');
    return Settings.createSettingsService({settingsPort:port,clock:()=>iso(at)}).setHighSettings(patch,port.getRevision());
}
function options(host,nowMs=at) {
    return {mealCoverageRevision:host.connect('research').getRevision(),
        historyDeclaration:{source:'user_declared',confirmedComplete:true,startIso:iso(nowMs-12*hour-15*minute),
            endIso:iso(nowMs+10*minute),declaredAtIso:iso(nowMs)},
        kineticsByMealId:profile.inspect({host,nowMs}).kineticsByMealId??{}};
}
function inspect(host,args={}) {
    const nowMs=args.nowMs??at;
    return high.inspect({host,nowMs,foodOptions:options(host,nowMs),...args});
}
function highFixture({glucose=12, sourceType='device_recorded', clock=at, delay=0}={}) {
    const host=testJournal({glucose,sourceType,clock,delay});
    highSettings(host,{targetMmol:6});
    return host;
}

test('HIGH-QA-004/005/009 persists explicit target and HIGH-only activity, preserving legacy activity, metadata and revision',()=>{
    let disk=testJournal().exportState();
    const open=()=>Storage.createHost({clock:()=>iso(at),driver:{load:()=>disk,save:state=>{disk=state;}}});
    let host=open(), s=host.connect('settings');
    assert.equal(high.preferences(s.read('profile')).target,null);
    assert.deepEqual(high.preferences(s.read('profile')).activity.coefficients,{normal:1,high:1.05,sport:1.1});
    mutate(host,'activityUi','setBaseLevel','high');
    const selected={enabled:false,selectedLevel:'sport',coefficients:{normal:1,high:1.06,sport:1.2}};
    highSettings(host,{targetMmol:5,activity:selected});
    const saved=JSON.stringify(host.exportState());
    assert.equal(highSettings(host,{targetMmol:5,activity:selected}).idempotent,true);
    assert.equal(JSON.stringify(host.exportState()),saved);
    assert.throws(()=>s.setHighSettings({activity:{...selected,selectedLevel:'low'}},s.getRevision()),/активности HIGH/);
    assert.throws(()=>s.setHighSettings({targetMmol:6},s.getRevision()-1),/Конфликт ревизии/);
    assert.throws(()=>s.setHighSettings({targetMmol:3},s.getRevision()));
    host=open();s=host.connect('settings');
    assert.equal(s.read('profile').activityBaseLevel,'high');
    const prefs=high.preferences(s.read('profile'));
    assert.deepEqual(prefs.target,{version:1,valueMmol:5,source:'user_input',editedAt:iso(at)});
    assert.deepEqual(prefs.activity,{...selected,version:1,source:'user_configured',editedAt:iso(at)});
    assert.deepEqual(s.read('history').at(-1).changes.highTarget,{before:null,after:prefs.target});
    assert.equal(host.connect('calculator').setHighSettings,undefined);
    highSettings(host,{activity:{...selected,enabled:true}});
    assert.equal(s.read('profile').highActivity.selectedLevel,'sport');
    assert.equal(s.read('profile').highActivity.coefficients.sport,1.2);
});

test('HIGH only uses the separately dated target, never a TIR midpoint',()=>{
    const host=testJournal({glucose:12,sourceType:'device_recorded'});
    mutate(host,'settings','addCoefficient',{id:'range',kind:'target_range_mmol',value:{low:4,high:10},
        effectiveFrom:iso(at-hour),source:'manual'});
    assert.equal(inspect(host).code,'SETTINGS_INCOMPLETE');
    highSettings(host,{targetMmol:5});
    const view=inspect(host);
    assert.equal(view.status,'READ_ONLY');
    assert.equal(view.code,'CLINICAL_FORMULA_NOT_VALIDATED');
    assert.equal(view.observations.targetMmol,5);
    assert.equal(view.candidate,null);
    assert.equal(view.canSuggestDose,false);
    assert.equal(inspect(host,{previewDose:2,mode:'demo'}).code,'CGM_SOURCE_NOT_ELIGIBLE');
});

test('HIGH: absent or untrusted CGM, delays and missing history are never numeric suggestions',()=>{
    assert.equal(inspect(testJournal()).code,'CGM_SOURCE_UNKNOWN');
    for(const [delay,expected] of [[5,'CLINICAL_FORMULA_NOT_VALIDATED'],[10,'CLINICAL_FORMULA_NOT_VALIDATED'],
        [15,'CGM_STALE'],[30,'CGM_STALE']]){
        const host=highFixture({delay});
        const result=inspect(host);
        assert.equal(result.code,expected,JSON.stringify({delay,code:result.code}));
        assert.equal(result.candidate,null);
    }
    const host=highFixture();
    assert.equal(high.inspect({host,nowMs:at}).code,'NO_CONFIRMED_MEALS_IN_WINDOW');
    const bad=Storage.createHost({clock:()=>iso(at)});
    mutate(bad,'cgmAdapter','setSourceMetadata',{sourceDeviceId:'BAD-SOURCE',sourceType:'device_recorded',samplingMinutes:5,qualityScore:0});
    assert.equal(inspect(bad).code,'CGM_SOURCE_QUALITY_LOW');
    assert.throws(()=>mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:'OTHER-SENSOR',
        sourceType:'device_recorded',samplingMinutes:5,qualityScore:1}),/Источник CGM уже установлен/);

    const legacy=highFixture();
    function connect(role) {
        const p=legacy.connect(role);
        return role!=='graph'?p:{...p,getSnapshot:()=>{
            const state=p.getSnapshot();
            return {...state,cgm:state.cgm.map(({sourceDeviceId,...row})=>row)};
        }};
    }
    assert.equal(inspect({...legacy,connect}).code,'CGM_NOT_ENOUGH');
});

test('HIGH one current meal model, two declared cases, no GFForecast tau invented and no second COB',()=>{
    const host=highFixture();
    addPlate(host,{id:'draft-only',estimated:false});
    assert.equal(inspect(host).observations.cobModelG,0);
    const {controller,plate,id}=addPlate(host,{id:'real-meal',grams:75,carbs:14.925,estimated:false,gi:49});
    controller.ready(id);
    controller.startMeal(id,iso(at-30*minute),{actuallyStarted:true});
    controller.actualFood(id,plate,{parentConfirmed:true});
    controller.finishMeal(id,iso(at-20*minute),{confirmed:true});
    assert.equal(inspect(host).code,'SMOOTH_PROFILE_MISSING');
    const recent=host.connect('research').getRevision();
    mutate(host,'settings','setMealAbsorptionModel','GFCOB');
    const linear=inspect(host);
    assert.equal(linear.code,'LINEAR_INTERVAL_NO_POINT_MODEL');
    assert.equal(linear.view.foodModel.id,absorption.selected(host.connect('settings').read('profile')).id);
    assert.ok(Math.abs(linear.view.food.upperG-14.925*(1-30/360))<1e-12);
    assert.equal(linear.baseline.length,0);
    assert.equal(inspect(host,{foodOptions:{...options(host),mealCoverageRevision:recent}}).status,'BLOCKED');
});

test('HIGH Levemir does not affect baseline and one confirmed rapid event contributes once',()=>{
    const host=highFixture();
    const current=inspect(host);
    const basal=mutate(host,'actionWriter','recordInjection',{id:'basal',insulinId:'levemir',units:3,administeredAt:iso(at-hour)});
    assert.ok(basal.revision>0);
    assert.deepEqual(inspect(host).baseline,current.baseline);
    const shot={id:'one-rapid',insulinId:'rinfast',units:.5,administeredAt:iso(at-70*minute)};
    mutate(host,'actionWriter','recordInjection',shot);
    assert.equal(mutate(host,'actionWriter','recordInjection',shot).idempotent,true);
    const rapid=inspect(host);
    assert.equal(rapid.observations.activeInjections,1);
    assert.equal(rapid.observations.iobModelU,Number((Rinfast.getCurve(70).remainingFraction*.5).toFixed(3)));
    assert.notDeepEqual(rapid.baseline,current.baseline);
});

test('HIGH real activity and illness fail closed, a confirmed sport session overrides only while active',()=>{
    const host=highFixture();
    const activity={enabled:true,selectedLevel:'normal',coefficients:{normal:1,high:1.05,sport:1.1}};
    highSettings(host,{activity});
    mutate(host,'sport','startSport',{id:'SYNTHETIC-HIGH-SPORT',start:iso(at)});
    const active=inspect(host);
    assert.equal(active.code,'UNVERIFIED_ACTIVITY_MODEL');
    assert.equal(active.view.activity.effectiveLevel,'sport');
    assert.equal(active.view.activity.selectedLevel,'normal');
    highSettings(host,{activity:{...activity,enabled:false}});
    const off=inspect(host);
    assert.equal(off.status,'READ_ONLY');
    assert.equal(off.view.activity.effectiveCoefficient,1);
    assert.equal(off.view.illness.effectiveFactor,1);
    mutate(host,'context','openPeriod',{id:'SYNTHETIC-HIGH-PERIOD',kind:'illness',start:iso(at)});
    assert.equal(inspect(host).code,'UNVERIFIED_ILLNESS_MODEL');
});

test('HIGH synthetic preview and 0/no-solution are distinct, with the exact original activity effect applied once',()=>{
    const host=highFixture({sourceType:'synthetic'});
    const result=inspect(host,{mode:'demo',previewDose:1});
    assert.equal(result.status,'SIMULATION_SOLUTION');
    assert.equal(result.manualPreview.dose,1);
    const activity={enabled:true,selectedLevel:'high',coefficients:{normal:1,high:1.05,sport:1.1}};
    highSettings(host,{activity});
    const highTrace=inspect(host,{mode:'demo',previewDose:1});
    assert.equal(highTrace.trace.modifiers.filter(x=>x==='activity').length,1);
    assert.ok(Math.abs(highTrace.baseline[24].g-(result.baseline[24].g-0.06))<1e-9);
    highSettings(host,{activity:{...activity,enabled:false}});
    assert.deepEqual(inspect(host,{mode:'demo',previewDose:1}).baseline,result.baseline);
    assert.equal(inspect(host).code,'CGM_SOURCE_NOT_ELIGIBLE');
    assert.equal(inspect(highFixture({glucose:6,sourceType:'synthetic'}),{mode:'demo'}).candidate.dose,0);
    const noSolution=inspect(highFixture({glucose:20,sourceType:'synthetic'}),{mode:'demo'});
    assert.notEqual(noSolution.candidate?.dose,0);
    assert.equal(host.connect('journal').getSnapshot().events.length,0);
});

test('HIGH-QA-007 accepts facts only with nonnegative BJU and preserves original research mathematics otherwise',()=>{
    const opts={nowIso:iso(at),origin:'synthetic_fixture',fixtureTag:'SYNTHETIC_TEST_ONLY',rinfastEngine:Rinfast,
        readings:[20,15,10,5,0].map(t=>({ts:at-t*minute,mmol:12,sourceDeviceId:'SYNTHETIC',
            receivedAt:iso(at-t*minute),valid:true})),injections:[],
        coverage:{injectionsConfirmed:true,mealsConfirmed:true},context:{activity:'low'},
        settings:{target:6,uk:12,isf:3,foodModel:'GFCOB',step:.5,maxDose:6}};
    const meal={id:'SYNTHETIC-MEAL',status:'completed',startedAt:iso(at-30*minute),
        actualPlate:{containsEstimatedValues:false,totals:{carbs:15,fat:3,protein:5}},
        kinetics:{origin:'explicit_research_scenario',lagMinutes:0,slowDurationMinutes:180}};
    const good=core.analyse({...opts,meals:[meal]});
    assert.ok(good.status.startsWith('SIMULATION_'));
    for(const field of ['fat','protein']){
        const bad={...meal,actualPlate:{...meal.actualPlate,totals:{...meal.actualPlate.totals,[field]:-0.01}}};
        assert.equal(core.analyse({...opts,meals:[bad]}).code,'MEAL_COMPOSITION_UNKNOWN');
    }
});

test('HIGH-QA-003 all injection sites durably recorded once only after confirmation and stable retry ID',()=>{
    let saved=null;
    const open=()=>Storage.createHost({clock:()=>iso(at),driver:{load:()=>saved,save:s=>{saved=s;}}});
    const host=open(), writer=host.connect('actionWriter');
    const request={host,record:{id:'FACT-0',units:.5,administeredAt:iso(at),injectionSite:{region:'abdomen'}}};
    assert.equal(high.recordActualInjection({...request,expectedRevision:writer.getRevision()}).code,'NO_FACT_CONFIRMATION');
    assert.equal(high.recordActualInjection({...request,record:{...request.record,units:.7},confirmation:true,expectedRevision:0}).code,'FACT_INVALID');
    assert.equal(high.recordActualInjection({...request,record:{...request.record,injectionSite:'abdomen'},confirmation:true,expectedRevision:0}).code,'FACT_INVALID');
    assert.equal(saved,null);
    const regions=Object.values(high.SITE);
    regions.forEach((region,index)=>{
        const record={id:'FACT-'+index,units:.5,administeredAt:iso(at-10*index*minute),injectionSite:{region}};
        const req={host,record,confirmation:true};
        assert.equal(high.recordActualInjection({...req,expectedRevision:writer.getRevision()}).status,'RECORDED');
        assert.equal(high.recordActualInjection({...req,expectedRevision:writer.getRevision()}).idempotent,true);
    });
    assert.equal(high.recordActualInjection({...request,confirmation:true,expectedRevision:0}).code,'REVISION_CHANGED');
    assert.deepEqual(open().connect('journal').read('events').map(x=>[x.id,x.injectionSite.region,x.status]),
        regions.map((region,index)=>['FACT-'+index,region,'confirmed']));
});

function history() {
    let now=at, sequence=0;
    const host=Storage.createHost({clock:()=>iso(now)});
    mutate(host,'settings','updateProfile',{timeZone:'UTC'});
    const cgm='SYNTHETIC-CL047-VERIFIED-FIXTURE';
    mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:cgm,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
    const rows=[];
    for(const days of [10,8,6,4,0]){
        const day=at-days*24*hour-4*hour, meal=day+15*minute;
        now=day;
        const id='SYNTHETIC-MEAL-'+days;
        const {controller,plate}=addPlate(host,{id,grams:75,carbs:14.925,gi:49,estimated:false,atMs:now});
        controller.ready(id);
        const shot={sessionId:id,expectedVersion:controller.lookup(id).version,opId:'op-inj-'+sequence++,
            injectionId:'shot-'+days,insulinId:'rinfast',units:.5,administeredAt:iso(day),injectionSite:{region:'abdomen'},
            injectionContext:{activity:'usual',illness:'no',carbsG:14.925,iobU:.1,mealGroup:'with_meal',
                mealLagMinutes:15,settingRevision:5,localHour:8,utcOffsetMinutes:0}};
        mutate(host,'actionWriter','recordSessionInjection',shot);
        now=meal;
        controller.startMeal(id,iso(now),{actuallyStarted:true});
        controller.actualFood(id,plate,{parentConfirmed:true});
        now+=5*minute;
        controller.finishMeal(id,iso(now),{confirmed:true});
        for(let offset=-30;offset<=15+180;offset+=5){
            const ts=day+offset*minute;
            const mmol=offset<=15?7:7+0.7*Math.sin(Math.PI*(offset-15)/180);
            rows.push({ts,mmol,receivedAt:iso(ts),sourceDeviceId:cgm,valid:true,qualityFlag:'ok'});
        }
    }
    now=at;
    mutate(host,'cgmAdapter','ingestReadings',rows);
    return host;
}

test('CL047 uses original analytics in a read-only GFStorage projection, preserves site analyzer and ignores any illness flags bit-for-bit',()=>{
    const host=history(), before=JSON.stringify(host.exportState()), sessionId='SYNTHETIC-MEAL-0';
    assert.equal(globalThis.GFInjectionAnalytics.VERSION.startsWith('0.1.1'),true);
    assert.equal(analytics.VERSION,'0.2.1-history-only');
    const r=timing.inspect({host,sessionId,nowMs:at});
    assert.equal(r.status,'HISTORICAL_ESTIMATE',JSON.stringify(r));
    assert.equal(r.descriptiveLagMinutes,15);
    assert.equal(r.cases.length,4);
    assert(r.cases.every(x=>x.sessionId!==sessionId));
    assert.equal(r.clinicalUse,false);
    assert.equal(r.automaticInjectionTiming,false);
    assert.equal(JSON.stringify(host.exportState()),before);
    for(const flag of ['yes','no',undefined]){
        const connect=role=>{
            const port=host.connect(role);
            if(role!=='injectionAnalytics')return port;
            return {...port,getSnapshot:()=>{
                const s=port.getSnapshot();
                const events=s.events.map(e=>{
                    const {illness,...context}=e.injectionContext;
                    if(flag!==undefined)context.illness=flag;
                    return {...e,injectionContext:context};
                });
                return {...s,events};
            }};
        };
        assert.equal(JSON.stringify(timing.inspect({host:{...host,connect},sessionId,nowMs:at})),JSON.stringify(r));
    }
    assert.equal(timing.inspect({host,sessionId,nowMs:at,mode:'demo'}).code,'SYNTHETIC_HISTORY_EXCLUDED');
    assert.equal(timing.inspect({host,sessionId:'plan-only',nowMs:at}).descriptiveLagMinutes,null);
});

test('Both adapters fail closed on revision races, and timing returns null without stored IOB',()=>{
    const host=highFixture(), read=host.connect('research');
    const shifting={...host,connect:role=>role==='research'?{...read,getRevision:()=>read.getRevision()+1}:host.connect(role)};
    assert.equal(inspect(shifting).code,'REVISION_CHANGED');

    const h=history(), port=h.connect('injectionAnalytics'), sessionId='SYNTHETIC-MEAL-0';
    const conflicted={...h,connect:role=>role==='injectionAnalytics'?{...port,getRevision:()=>port.getRevision()+1}:h.connect(role)};
    assert.equal(timing.inspect({host:conflicted,sessionId,nowMs:at}).code,'REVISION_CHANGED');
    const noContext={...h,connect:role=>role==='injectionAnalytics'?{...port,getSnapshot:()=>{
        const s=port.getSnapshot();
        return {...s,events:s.events.map(e=>e.id==='shot-0'?{...e,injectionContext:undefined}:e)};
    }}:h.connect(role)};
    const absent=timing.inspect({host:noContext,sessionId,nowMs:at});
    assert.equal(absent.code,'HISTORICAL_IOB_UNKNOWN');
    assert.equal(absent.descriptiveLagMinutes,null);
});
