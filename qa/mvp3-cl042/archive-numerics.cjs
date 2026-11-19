'use strict';

/* Reproduce synthetic goldens against the supplied owner archive without installing it in the app. */
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {globSync,readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {at,minute,iso,fromWeb,testJournal,addPlate,archivedEngine,Rinfast} = require('../mvp3-calculators/fixture.cjs');

if (!process.argv[2]) throw Error('Usage: node qa/mvp3-cl042/archive-numerics.cjs <extracted-intake-root>');
const dir=resolve(process.argv[2]);
const report=[];
function original(pattern, expectedSha) {
    const hits=globSync(pattern,{cwd:dir});
    assert.equal(hits.length,1,pattern);
    const path=resolve(dir,hits[0]);
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),expectedSha);
    return require(path);
}

const lowPath='nested/02_МОДУЛИ/01_*/**/*v0.3.5*/src/';
const low=original(lowPath+'GFHypoScenario_v0.3.2.js','faab699b9c053365c18658ce7ec844ed44eb7b5f2c3cf2e94156009c7a44f2c7');
const lowBase=original(lowPath+'GFForecastHypo_v0.3.0.js','ffe808ff1fb9eae828a792fa4b2c1048bf1ea18f2b91a915acb43ceb8efdf8c3');
const smooth=fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
const settings={carbRatioGPerUnit:10,isfMmolPerUnit:3,mealTauMin:40};
const readings=[25,20,15,10,5,0].map(age=>({sourceId:'SYNTHETIC-LOW',measuredAt:iso(at-age*minute),
    receivedAt:iso(at-age*minute),glucoseMmol:6}));
const base={nowIso:iso(at),readings,injections:[],meals:[],conditions:{},settings,sourceIsComplete:true,rinfastEngine:Rinfast};
const integrate=(until,tau)=>{
    const steps=12000, step=until/steps;
    let total=0;
    for(let i=0;i<steps;i++) {const t=(i+0.5)*step;total+=t*Math.exp(-t/tau)/(tau*tau);}
    return total*step;
};
const check=(actual,expected,tolerance)=>assert.ok(Math.abs(actual-expected)<=tolerance,JSON.stringify({actual,expected}));

const scenario={...base,synthetic:true,product:{name:'SYNTHETIC-JUICE',unit:'мл',carbsPer100:10,absorptionTauMin:40},
    horizonMin:60,targetMmol:6};
const amounts=[];
for (const amount of [30,40,50,60]) {
    const row=low.run({...scenario,amount},lowBase,Rinfast);
    assert.equal(row.status,'MODEL_SCENARIO');
    assert.equal(row.clinicalUse,false);
    const expected=6+amount/100*10*0.3*integrate(60,40);
    check(row.withAtHorizon,expected,0.005);
    assert.equal(row.modelAmount,0);
    amounts.push({amount,inMmol:row.withAtHorizon,expected});
}
assert(amounts.every((row,i)=>i===0||row.inMmol>amounts[i-1].inMmol));
assert.equal(low.run({...scenario,product:{...scenario.product,absorptionTauMin:null}},lowBase,Rinfast).code,'FOOD_PROFILE_MISSING');
report.push({id:'LOW-F1',status:'PASS',amounts});

const request={...base,meals:[{id:'SYNTHETIC-PLATE',eatenAt:iso(at-20*minute),status:'confirmed',carbsG:5}]};
const canonical=smooth.predict(request), distinct=lowBase.predict(request);
assert.equal(canonical.status,'EXPERIMENTAL');
assert.equal(distinct.status,'EXPERIMENTAL');
const age=20, tau=40, step=60;
const derivative=1.5*age/(tau*tau)*Math.exp(-age/tau);
const expected=6-derivative*35*(1-Math.exp(-step/35))+1.5*(integrate(age+step,tau)-integrate(age,tau));
check(canonical.points[12].glucoseMmol,expected,0.005);
assert.deepEqual(canonical.points.map(p=>p.glucoseMmol),distinct.points.map(p=>p.glucoseMmol));
assert.equal(smooth.predict({...request,meals:[request.meals[0],request.meals[0]]}).status,'UNAVAILABLE');
report.push({id:'LOW-F2/FOOD-F1',status:'PASS',explicitSharedTau:tau,expected,
    gffAt60:canonical.points[12].glucoseMmol,lowAt60:distinct.points[12].glucoseMmol});

const strict=original('nested/02_МОДУЛИ/02_*/**/GFActionMath_v0.1.0.js',
    '777cbc67e502c020aa65165d3ad1335d3c8377417075b6b3edeadcf3f809bfe0');
const meter={source:'manual',measuredNow:true,measuredAt:iso(at),planConfirmed:true};
const high={...meter,glucose:15,target:6,isf:4,iob:1,iobAt:iso(at),maxDose:5,insulinName:'SYNTHETIC-INSULIN',
    historyComplete:true,mealStatus:'known-none',ketones:'negative',trend:'flat',activity:'none'};
assert.equal(strict.high(high,at).units,Math.floor(((15-6)/4-1)*2)/2);
assert.equal(strict.high({...high,glucose:5},at).units,0);
assert.equal(strict.high({...high,iob:null},at).ok,false);
assert.equal(strict.high({...high,mealStatus:'present'},at).ok,false);
const lowAmount=strict.low({...meter,glucose:3.5,planCarbs:12,carbsPer100:10,productName:'SYNTHETIC-JUICE',unit:'мл'},at);
assert.equal(lowAmount.amount,12*100/10);
assert.equal(lowAmount.unit,'мл');
assert(archivedEngine());
report.push({id:'LOW-F3/HIGH-F1',status:'PASS',rounded:strict.high(high,at).units,zero:0,unknownRejected:true,
    conversionMl:lowAmount.amount});

const host=testJournal();
const {id}=addPlate(host,{id:'demo-meal-qa',carbs:14.925,estimated:true});
const v12=fromWeb('modules/GFMealCalc_v0.1.2/src/gf_meal_calc.js');
const meal=v12.createCalculator(host,{rinfastEngine:Rinfast,clock:()=>iso(at)}).inspect(id);
check(meal.researchArithmetic.unroundedEquivalentUnits,14.925/12,1e-12);
assert.equal(meal.researchArithmetic.roundedToPenStep,false);
assert.equal(meal.therapyRecommendation,null);
assert.equal(host.exportState().events.length,0);
report.push({id:'MEAL-F1',status:'PASS',recorded:false,researchEquivalent:meal.researchArithmetic.unroundedEquivalentUnits});
console.log(JSON.stringify({status:'PASS',data:'SYNTHETIC_ONLY',report},null,2));
