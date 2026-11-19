'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');
const {at,minute,iso,web,fromWeb,mutate,testJournal} = require('../mvp3-calculators/fixture.cjs');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast_storage_adapter.js');
fromWeb('integration/GFForecastReadout_v0.1.0.js');
const Run = fromWeb('integration/GFResearchForecastRun_v0.1.0.js');
const Review = fromWeb('integration/GFConsensusReview_v0.1.0.js');
const Graph = fromWeb('integration/GFResearchForecastGraph_v0.1.0.js');
const APS = fromWeb('modules/GFAAPSResearch_v0.1.0/core/GFAPSResearch.js');
const browser = {GFAPSResearch:APS};
for (const file of ['GFConsensus_v0.1.1.js','GFAPSEnhancer_v0.1.1.js']) {
    runInNewContext(readFileSync(join(web,'modules/GFAPSEnhancer_v0.1.1',file),'utf8'),browser,{filename:file});
}
globalThis.GFAPSEnhancer=browser.GFAPSEnhancer;

const STEPMIN=5;
const source='SYNTHETIC-ALIGNMENT';
const issue=at;
const slope=0.025;
function snapshot(delay=0) {
    const host = testJournal();
    const measured = issue-delay*minute;
    mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:source,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
    mutate(host,'cgmAdapter','ingestReadings',Array.from({length:14},(_,i)=>{
        const offset=(13-i)*STEPMIN;
        return {ts:measured-offset*minute,mmol:7-slope*offset,sourceDeviceId:source,receivedAt:iso(issue-offset*minute),
            valid:true,qualityFlag:'ok'};
    }));
    const revision=host.connect('research').getRevision();
    const request={host,nowMs:issue,mode:'local',mealCoverageRevision:revision,
        foodHistoryDeclaration:{source:'user_declared',confirmedComplete:true,startIso:iso(issue-13*60*minute),
            endIso:iso(issue+10*minute),declaredAtIso:iso(issue)},
        safetyVerdict:{status:'DATA_OK',forecastInputEligible:true,sourceRevision:revision}};
    return {host,request,measured,revision};
}

test('AAPS alignment has independent sloped goldens on exact and fractional grid ages',async()=>{
    const ratio=Math.exp(-5/35);
    // Closed form of the sum of damped per-step increments, including the original output precision.
    const modelPoint=k=>Number((7+5*slope*ratio*(1-ratio**k)/(1-ratio)).toFixed(3));
    for(const delay of [0,1,5,7,10]){
        const {host,request,measured}=snapshot(delay);
        const run=await Run.run(request);
        const forecast=run.engines.find(e=>e.modelId==='GFAPSEnhancer');
        assert.equal(forecast.status,'EXPERIMENTAL',JSON.stringify(forecast));
        const row=forecast.row.payload;
        assert.equal(row.sourceTime,iso(measured));
        assert.equal(row.sourceReceivedAt,iso(issue));
        assert.deepEqual(row.mealModel,{id:'GFForecast',version:'0.1.2'});
        for(const point of row.points){
            const k=(delay+point.horizonMin)/5, lo=Math.floor(k), x=k-lo;
            const expected=(1-x)*modelPoint(lo)+x*modelPoint(lo+1);
            assert.ok(Math.abs(point.glucoseMmol-expected)<1e-12,JSON.stringify({delay,point,expected}));
            assert.equal(point.at,iso(issue+point.horizonMin*minute));
        }
        assert.equal(host.exportState().events.length,0);
    }
});

test('both forecasts reuse the pinned Rinfast curve and ignore basal for corrective action',async()=>{
    const {host,request} = snapshot();
    mutate(host,'actionWriter','recordInjection',{id:'RINFAST-ONE',insulinId:'rinfast',units:0.5,administeredAt:iso(at-55*minute)});
    mutate(host,'actionWriter','recordInjection',{id:'LEVEMIR-ONE',insulinId:'levemir',units:2,administeredAt:iso(at-95*minute)});
    const engine=globalThis.RinfastEngine, calls=[];
    globalThis.RinfastEngine={...engine,getCurve(age,profile){calls.push({age,profile});return engine.getCurve(age,profile);}};
    try {
        const revision=host.connect('research').getRevision();
        const result=await Run.run({...request,mealCoverageRevision:revision,
            safetyVerdict:{...request.safetyVerdict,sourceRevision:revision}});
        assert.equal(result.status,'ARCHIVED');
        const gff=result.engines.find(x=>x.modelId==='GFForecast');
        const aaps=result.engines.find(x=>x.modelId==='GFAPSEnhancer');
        assert.deepEqual(gff.summary.rinfastInjections,['RINFAST-ONE']);
        assert.equal(aaps.status,'EXPERIMENTAL');
        // The AAPS original recurrence rounds the aggregate activity to eight decimals per step.
        let expected=7;
        for(let index=1;index<=24;index++){
            const end=5*index;
            const activity=Number((0.5*engine.getCurve(55+end).activityFractionPerMinute).toFixed(8));
            expected+=5*slope*Math.exp(-end/35)-activity*3*5;
            assert.equal(aaps.row.payload.points[index].glucoseMmol,Number(expected.toFixed(3)));
        }
        assert.ok(calls.length>25);
        assert(calls.every(c=>c.profile.modelVersion===engine.ENGINE_VERSION));
    } finally {
        globalThis.RinfastEngine=engine;
    }
    assert.equal(typeof APS.forecast.predict,'function');
});

test('forecasts remain archived but stop contributing to the live plot on a new input revision',async()=>{
    const {host,request,measured,revision}=snapshot();
    await Run.run(request);
    const graph=host.connect('graph');
    const archived=JSON.stringify(graph.read('forecasts'));
    const lines = ()=>Graph.select({forecasts:graph.read('forecasts'),cgm:graph.read('cgm'),sourceId:source,
        sourceTime:measured,nowMs:issue,preferences:graph.read('graphPreferences'),
        minimumSourceRevision:graph.getForecastInputRevision()}).lines.map(line=>line.modelId);
    assert.equal(graph.getForecastInputRevision(),revision);
    assert.deepEqual(lines(),['GFForecast','GFAPSEnhancer']);
    mutate(host,'graph','setPreferences',{forecastVisibility:{GFForecast:false,GFxDrip:true,GFAPSEnhancer:true}});
    assert.deepEqual(lines(),['GFAPSEnhancer']);
    mutate(host,'settings','setMealAbsorptionModel','GFCOB');
    assert.deepEqual(lines(),[]);
    assert.equal(JSON.stringify(graph.read('forecasts')),archived);
});

test('an assessment cohort cannot mix food model versions or fill a missing third curve',()=>{
    const current={id:'GFCOB',version:'0.1.1'}, other={id:'GFForecast',version:'0.1.2'};
    const rows=(origin,mealModels)=>Review.MODELS.map((modelId,index)=>({
        modelId,modelVersion:'1.0.0',mealModel:mealModels[index],forecastAt:iso(origin),sourceTime:iso(origin),
        sourceRevision:1,sourceId:source,inputDigest:'4'.repeat(64),
        points:Array.from({length:25},(_,i)=>({horizonMin:i*5,at:iso(origin+i*5*minute),glucoseMmol:7}))
    }));
    const issued=[...rows(at-12*60*minute,[other,other,other]),...rows(at-4*60*minute,[current,current,other])];
    assert.equal(Review.evaluate({issued,actual:[],asOf:at,mealModel:current}).matchedIssueGroups,0);
    assert.equal(Review.evaluate({issued,actual:[],asOf:at,mealModel:other}).matchedIssueGroups,1);
    assert.equal(Review.evaluate({issued,actual:[],asOf:at,mealModel:current}).status,'NO_LEADER');
});

test('E2E-02: no hybrid forecast after simultaneous facts, CGM, sport, illness and coefficient changes',async()=>{
    const {host,request,revision}=snapshot(1);
    const pending=Run.run(request);
    mutate(host,'cgmAdapter','ingestReadings',[{ts:at,sourceDeviceId:source,mmol:7,receivedAt:iso(at),valid:true,qualityFlag:'ok'}]);
    mutate(host,'actionWriter','recordInjection',{id:'RACE-SHOT',insulinId:'rinfast',units:0.5,administeredAt:iso(at-12*minute)});
    mutate(host,'sport','startSport',{id:'RACE-SPORT',start:iso(at)});
    mutate(host,'context','openPeriod',{id:'RACE-ILLNESS',kind:'illness',start:iso(at-10*minute)});
    const settings=host.connect('settings');
    settings.updateProfile({coefficientModes:{carb_g_per_u:'manual',isf_mmol_per_u:'auto'}},settings.getRevision());
    const plan={schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:iso(at),containsEstimatedValues:false,
        items:[{kind:'manual',foodId:null,name:'SYNTHETIC-RACE',amount:75,unit:'г',carbs:14.925,fat:0,protein:0,
            kcal:59.7,glycemicIndex:49,glycemicIndexStatus:'verified',nutritionStatus:'label_verified'}],
        totals:{amount:75,count:1,carbs:14.925,fat:0,protein:0,kcal:59.7}};
    const controller=globalThis.GFMealController.createController(host);
    controller.createFromFood(plan,'race-food');
    controller.ready('race-food');
    controller.startMeal('race-food',iso(at-10*minute),{actuallyStarted:true});
    mutate(host,'actionWriter','recordActualPlate',{sessionId:'race-food',expectedVersion:controller.lookup('race-food').version,
        plate:plan,opId:'race-food-fact'});
    controller.finishMeal('race-food',iso(at-minute),{confirmed:true});
    assert.equal((await pending).code,'REVISION_CHANGED');
    assert.equal(host.exportState().forecasts.length,0);
    const later=host.connect('research').getRevision();
    assert.ok(later>revision);
    assert.equal((await Run.run({...request,mealCoverageRevision:later,
        safetyVerdict:{...request.safetyVerdict,sourceRevision:later}})).code,'SMOOTH_PROFILE_MISSING');
    assert.equal(host.exportState().forecasts.length,0);
});
