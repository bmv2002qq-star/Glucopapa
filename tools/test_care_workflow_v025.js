'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const M=require('./care_workflow_v025.js');
const {makeFixture,NOW}=require('./generate_fixture_v024.js');
const base=makeFixture(),tag='GF_SYNTHETIC_FIXTURE_V025';
const fixture=()=>({source:tag,now:NOW,raw:{...structuredClone(base.input),syntheticTag:tag}});
const plan=()=>({planId:'SYNTHETIC-ONLY-DO-NOT-TREAT',reviewedByClinician:true,validUntilTs:NOW+365*86400000,
 factors:{isfMmolPerUnit:5,icrGramsPerUnit:{breakfast:15,lunch:20,dinner:18}},targetMmol:6,
 bolusStepUnits:.5,maxBolusUnits:8,maxCorrectionUnits:4,minCorrectionSpacingMinutes:180,
 minRoutineGlucoseMmol:4.5,maxKetonesForRoutineMmol:.6,
 hypo:{fastCarbsGrams:12,recheckMin:15,triggerBelowMmol:3.9}});
let count=0;const tests=[];const eq=(a,b,t=0.001)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
function check(name,fn){try{fn();count++;tests.push({name,ok:true})}catch(e){tests.push({name,ok:false,error:e.stack});console.error('FAILED '+name+' '+e.stack);process.exitCode=1}}
function sim(change={}){return M.simulateSynthetic(fixture(),{glucoseMmol:12.5,...change},plan())}
const p=()=>M.assess(base.input,NOW,plan());
check('complete 5-day real application event model loads',()=>assert.equal(p().status,'provisional-profile'));
check('average 5-day TDD',()=>eq(p().tddUnitsPerDay,20.3));
check('reference ISF 100/TDD',()=>eq(p().comparison.fields[0].starter,100/20.3));
check('reference ICR 500/TDD',()=>eq(p().comparison.fields[1].starter,500/20.3));
check('independent recorded CGM FCHI',()=>eq(p().comparison.fields[0].observed,5.652));
check('ICR breakfast observed',()=>eq(p().comparison.fields[1].observed,23.274));
check('ICR lunch observed',()=>eq(p().comparison.fields[2].observed,21.102));
check('ICR dinner observed',()=>eq(p().comparison.fields[3].observed,17.798));
check('IOB measured separately from basal',()=>assert.equal(typeof p().iobUnits,'number'));
check('all values have explicitly identified provenance',()=>assert.ok(p().provenance.patientPrescription));
check('plan and diary comparison covers four factors',()=>assert.equal(p().comparison.fields.length,4));
check('isf difference can be measured',()=>eq(p().comparison.fields[0].vsPlanPct,(5.652/5-1)*100,0.01));
check('deviating breakfast factor warned',()=>assert.ok(p().comparison.alertCount>=1));
check('unconfirmed inferred meal links warned',()=>assert.ok(p().warnings.includes('MEAL_BOLUS_LINK_INFERRED_NOT_CONFIRMED')));
check('no fake automatic plan approval',()=>assert.equal(p().autoApproveFactors,false));
check('no automatically authorized patient prescription',()=>assert.equal(p().autoPrescriptionUnits,null));
check('synthetic high glucose produces transparent numerical example',()=>{const x=sim();assert.equal(x.status,'synthetic-numerical-result');assert.equal(x.researchNumbers.roundedTotalUnits,1);assert.equal(x.calculation.patientDoseUnits,null)});
check('synthetic breakfast changes numerical meal units',()=>{const x=sim({glucoseMmol:6,mealCarbs:30,mealSlot:'breakfast'});assert.equal(x.researchNumbers.roundedTotalUnits,2)});
check('synthetic lunch with high glucose combines meal and correction',()=>{const x=sim({glucoseMmol:12.5,mealCarbs:40,mealSlot:'lunch'});assert.equal(x.researchNumbers.roundedTotalUnits,3);eq(x.researchNumbers.mealUnits,2)});
check('hypoglycemia example replays pre-entered plan',()=>{const x=sim({glucoseMmol:3.5});assert.equal(x.researchNumbers.quickCarbsGrams,12);assert.equal(x.researchNumbers.productQuantity,120)});
check('hypoglycemia has NO asserted final mmol',()=>assert.equal(sim({glucoseMmol:3.5}).finalGlucosePredictionMmol,null));
check('no meal plus target produces zero synthetic units',()=>assert.equal(sim({glucoseMmol:6}).researchNumbers.roundedTotalUnits,0));
check('research only with exact artificial input tag',()=>{const f=fixture();delete f.raw.syntheticTag;assert.equal(M.simulateSynthetic(f,{glucoseMmol:12.5},plan()).status,'not-a-synthetic-fixture')});
check('cannot switch patient history into synthetic through source flag',()=>{const f=fixture();f.source='patient';assert.equal(M.simulateSynthetic(f,{glucoseMmol:12.5},plan()).status,'not-a-synthetic-fixture')});
check('cannot use patient plan as synthetic',()=>{const d=plan();d.planId='CHILD';assert.equal(M.simulateSynthetic(fixture(),{glucoseMmol:12.5},d).status,'not-a-synthetic-fixture')});
check('unexpected recent bolus refuses synthetic routine correction',()=>{const x=sim({additionalHistory:[{type:'insulin',insulinType:'short',purpose:'correction',units:1,ts:NOW-30*60000}]});assert.equal(x.status,'blocked');assert.ok(x.calculation.codes.includes('RECENT_RAPID_BOLUS_NO_ROUTINE_CORRECTION'))});
check('illness triggers sick-day route',()=>{const x=sim({sick:true});assert.equal(x.status,'sick-day-plan')});
check('ketones trigger separate path',()=>assert.equal(sim({ketonesMmol:.7}).status,'sick-day-plan'));
check('exercise triggers separate route',()=>assert.equal(sim({activityRecent:'intense'}).status,'blocked'));
check('unconscious overrides numeric rescue',()=>{const x=sim({glucoseMmol:3,unconscious:true});assert.equal(x.status,'emergency');assert.equal(x.researchNumbers,null)});
check('cannot swallow overrides numeric rescue',()=>{const x=sim({glucoseMmol:3,canSwallow:false});assert.equal(x.status,'emergency')});
check('emergency without plan/day history still works',()=>{const x=M.emergency({},NOW,{unconscious:true});assert.equal(x.status,'emergency')});
check('vomiting triggers urgent state',()=>assert.equal(sim({vomiting:true}).status,'urgent-evaluation'));
check('illness must not produce dose',()=>assert.equal(sim({sick:true}).calculation.patientDoseUnits,null));
check('duplicate record stops numerical synthetic replay',()=>{const f=fixture(),dupe=f.raw.events.find(x=>x.type==='insulin');f.raw.events.push({...dupe});const x=M.simulateSynthetic(f,{glucoseMmol:12.5},plan());assert.equal(x.status,'invalid-synthetic-diary')});
check('missing CGM day stops replay',()=>{const f=fixture();f.raw.readings=f.raw.readings.filter(x=>x.ts<Date.parse('2026-11-09')||x.ts>=Date.parse('2026-11-10'));assert.equal(M.simulateSynthetic(f,{glucoseMmol:12.5},plan()).status,'invalid-synthetic-diary')});
check('negative meal carbs stops replay',()=>{const f=fixture();f.raw.events.find(x=>x.type==='meal').carbs=-3;assert.equal(M.simulateSynthetic(f,{glucoseMmol:12.5},plan()).status,'invalid-synthetic-diary')});
check('patient mode assessment does not fabricate any dose',()=>{const x=M.assess(base.input,NOW,plan());assert.equal(x.autoPrescriptionUnits,null);assert.equal(x.autoRescueCarbsGrams,null)});
check('no plan reference still exposes observed research factors',()=>{const x=M.assess(base.input,NOW);assert.equal(x.comparison.status,'preliminary-without-verified-plan');assert.equal(x.comparison.fields[0].plan,null)});
check('unreviewed plan never labeled verified',()=>{const v=plan();v.reviewedByClinician=false;const x=M.assess(base.input,NOW,v);assert.ok(x.warnings.includes('PLAN_UNVERIFIED'));assert.equal(x.comparison.fields[0].plan,null)});
check('stale CGM noted without turning diary into patient dose',()=>{const r=structuredClone(base.input);r.readings.pop();const x=M.assess(r,NOW);assert.ok(x.warnings.includes('NO_FRESH_CGM'));assert.equal(x.autoPrescriptionUnits,null)});
check('proportional difference sign',()=>{eq(M.pct(20,10),100);eq(M.pct(5,10),-50)});
check('zero coefficient never generates infinity',()=>assert.equal(M.pct(7,0),null));
// Global simulation: 400 perturbed scenarios, validate invariants and clinical gating.
let stressCount=0;const nums=[];
for(let i=0;i<400;i++){
 const g=2.6+(i%100)*0.25,carbs=(i%13)*5;
 const x=sim({glucoseMmol:g,mealCarbs:carbs,mealSlot:['breakfast','lunch','dinner'][i%3]});
 assert.equal(x.patientPrescriptionUnits,null);
 assert.equal(x.patientRescueCarbsGrams,null);
 assert.equal(x.finalGlucosePredictionMmol,null);
 if(x.status==='synthetic-numerical-result'){
  assert(x.researchNumbers&&(x.researchNumbers.roundedTotalUnits!=null||x.researchNumbers.quickCarbsGrams!=null));
  if(x.researchNumbers.roundedTotalUnits!=null){const u=x.researchNumbers.roundedTotalUnits;assert(u>=0&&u<=plan().maxBolusUnits);assert(Math.abs(u*2-Math.round(u*2))<1e-8);nums.push(u);}
 }
 stressCount++;
}
check('400 synthetic scenarios preserve non-prescription bounds',()=>assert.equal(stressCount,400));
check('synthetic grid has varied numeric calculation outcomes',()=>assert(new Set(nums).size>5));
const results={version:'0.25-research',passed:count,stressScenarios:stressCount,failed:tests.filter(x=>!x.ok).length,
 synthetic:{tdd:p().tddUnitsPerDay,referenceIsf:p().comparison.fields[0].starter,observedIsf:p().comparison.fields[0].observed,
   observedIcr:Object.fromEntries(p().comparison.fields.filter(x=>x.key!=='isf').map(x=>[x.key,x.observed]))},tests};
fs.writeFileSync(path.join(__dirname,'results_v025.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({passed:count,failed:results.failed,stress:stressCount,tdd:results.synthetic.tdd},null,2));
if(results.failed)process.exitCode=1;
