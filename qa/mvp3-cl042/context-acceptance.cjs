'use strict';

const assert = require('node:assert/strict');
const {at,minute,iso,fromWeb,testJournal,mutate,Storage,Settings} = require('../mvp3-calculators/fixture.cjs');
const Sport = fromWeb('modules/GFPhysioActivity_v0.1.3/gfphysio_exercise_context.js');
const Auto = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');
const Linear = fromWeb('integration/GFCOBResearch_v0.1.1.js');
const reports=[];

const late=Date.parse('2026-11-19T23:00:00Z');
let now=late-30*minute;
const host=Storage.createHost({clock:()=>iso(now)});
mutate(host,'sport','startSport',{id:'SYNTHETIC-SPORT',start:iso(now)});
now=late;
mutate(host,'sport','finishSport',{id:'SYNTHETIC-SPORT',end:iso(now)});
for (const offset of [0,30,120,360]) {
    const view=Sport.connect(host,iso(late+offset*minute));
    assert.equal(view.latestCompleted.minuteDuration,30);
    assert.equal(view.latestCompleted.end,iso(late));
    assert.equal(view.minutesSinceLastSport,offset);
    assert.equal(view.multiplier,null);
    assert.equal(view.insulinAdjustment,null);
    assert.equal(view.carbohydrateAdjustment,null);
}
reports.push({id:'ACT-06',status:'PASS',offsets:[0,30,120,360],midnight:true});

const settingsPort=host.connect('settings');
const settings=Settings.createSettingsService({settingsPort,clock:()=>iso(now)});
mutate(host,'context','openPeriod',{id:'SYNTHETIC-ILLNESS',kind:'illness',start:iso(now)});
assert.equal(settings.getView(iso(now)).illness.effectiveFactor,null);
assert.throws(()=>settings.setIllnessFactor(NaN,settings.getRevision()));
assert.throws(()=>settings.setIllnessFactor(-1,settings.getRevision()));
assert.throws(()=>mutate(host,'context','openPeriod',{id:'SYNTHETIC-OVERLAP',kind:'illness',start:iso(now)}),/пересекается/);
now+=minute;
settings.setIllnessFactor(1.2,settings.getRevision());
assert.equal(settings.getView(iso(now-minute)).illness.effectiveFactor,null);
assert.equal(settings.getView(iso(now)).illness.effectiveFactor,1.2);
assert.equal(settingsPort.read('profile').illnessFactor.source,'user_input');
assert.equal(settingsPort.read('conditionPeriods').find(p=>p.kind==='illness').start,iso(late));
mutate(host,'context','closePeriod',{id:'SYNTHETIC-ILLNESS',end:iso(now)});
assert.equal(settings.getView(iso(now)).illness.effectiveFactor,1);
assert.equal(settingsPort.read('profile').illnessFactor.value,1.2);
reports.push({id:'ILL-01/ILL-04',status:'PASS',effectiveAtBoundary:1,missingAndOverlapDetected:true});

const plate={schema:'GFPlate.v1',source:'GFFoodOnly',containsEstimatedValues:false,
    items:[{amount:75,unit:'г',carbs:14.925,protein:2,fat:3,glycemicIndex:49,
        glycemicIndexStatus:'verified',nutritionStatus:'label_verified'}],
    totals:{carbs:14.925,protein:2,fat:3}};
assert.equal(Auto.profilePlate({...plate,items:[{...plate.items[0],amount:null}]}).code,'ITEM_QUANTITY_UNKNOWN');
assert.equal(Auto.profilePlate({...plate,totals:{...plate.totals,protein:8}}).code,'MACROS_SUM_CONFLICT');
assert.equal(Auto.profilePlate({...plate,items:[{...plate.items[0],glycemicIndex:null}]}).code,'GI_NOT_TRANSFERRED_OR_UNKNOWN');
assert.equal(Auto.profilePlate(plate).profile,'slow');
reports.push({id:'FOOD-05',status:'PASS',unknownQuantity:true,badMacros:true,unknownGI:true});

function linearPair(age) {
    const rev=1;
    const meal=(id,minutes,carbs)=>({id,status:'completed',startedAt:iso(at-minutes*minute),completedAt:iso(at-(minutes-5)*minute),
        actualPlate:{...plate,totals:{...plate.totals,carbs},items:[{...plate.items[0],carbs}]}});
    const storage={getSchemaVersion:()=>5,connect:()=>({getRevision:()=>rev,
        getSnapshot:()=>({revision:rev,profile:{},conditionPeriods:[],mealSessions:[meal('one',age,14.925),meal('two',90,12)]})})};
    const historyDeclaration={source:'user_declared',confirmedComplete:true,
        startIso:iso(at-13*60*minute),endIso:iso(at),declaredAtIso:iso(at)};
    const kinetics={origin:'plate_auto_research_preset_v1',lagMinutes:0,fastDurationMinutes:240,slowDurationMinutes:360};
    return Linear.inspect({host:storage,nowMs:at,historyDeclaration,kineticsByMealId:{one:kinetics,two:kinetics}});
}
const p=linearPair(30), q=linearPair(60);
assert.equal(p.status,'RESEARCH_INTERVAL');
assert.equal(q.status,'RESEARCH_INTERVAL');
assert.deepEqual(p.contributions[1],q.contributions[1]);
assert.ok(Math.abs((p.lowerG-q.lowerG)-14.925*30/240)<1e-9);
assert.ok(Math.abs((p.upperG-q.upperG)-14.925*30/360)<1e-9);
reports.push({id:'FOOD-07',status:'PASS',changedOnly:'one',shiftMinutes:30,unchanged:'two'});

const basal=testJournal();
mutate(basal,'settings','addMeasurement',{id:'SYNTHETIC-20KG',measuredAt:iso(at-48*60*minute),weightKg:20});
for (const [idx,hours] of [44,32,20,8].entries()) {
    mutate(basal,'actionWriter','recordInjection',{id:'basal-'+idx,insulinId:'levemir',units:4,administeredAt:iso(at-hours*60*minute)});
}
const rapid=globalThis.GPModuleHub.rinfastModel(basal,iso(at));
assert.equal(rapid.status,'MODEL_ESTIMATE');
assert.equal(rapid.totalModelUnits,0);
assert.equal(rapid.parts.length,0);
const profile=globalThis.GPModuleHub.levemirModel(basal,iso(at));
assert.equal(profile.status,'MODEL_ESTIMATE');
assert.ok(profile.remainingModelActionUnits>0);
assert.equal(basal.connect('journal').read('events').length,4);
reports.push({id:'BASAL-02',status:'PASS',recorded:4,fastIOB:0,basalRemaining:profile.remainingModelActionUnits});
console.log(JSON.stringify({status:'PASS',synthetic:true,reports},null,2));
