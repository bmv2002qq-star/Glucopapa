'use strict';
const assert=require('node:assert/strict');
const fs=require('fs');
const engine=require('./plan_calculator_v023.js');
const NOW=Date.UTC(2026,10,11,12);
const clone=x=>structuredClone(x);
const plan={planId:'SYNTHETIC-SAMPLE-NOT-FOR-TREATMENT',reviewedByClinician:true,validUntilTs:Date.UTC(2027,0,1),
 factors:{isfMmolPerUnit:5,icrGramsPerUnit:{breakfast:15,lunch:20,dinner:18}},targetMmol:6,
 bolusStepUnits:0.5,maxBolusUnits:8,maxCorrectionUnits:4,minCorrectionSpacingMinutes:180,
 minRoutineGlucoseMmol:4.5,maxKetonesForRoutineMmol:0.6,
 hypo:{fastCarbsGrams:12,recheckMin:15,triggerBelowMmol:3.9}};
const input={nowTs:NOW,mode:'synthetic',meter:{ts:NOW,mmol:12.5},
 cgm:{ts:NOW,mmol:12.3},historyComplete:true,history:[],mealCarbs:0,timeZone:'UTC',
 canSwallow:true,rescueProduct:{carbsPer100:10,unit:'ml'}};
let good=0;const cases=[];
function check(name,fn){try{fn();good++;cases.push({name,ok:true})}catch(e){cases.push({name,ok:false,reason:e.stack}); console.error('FAIL',name,e.stack)}}
function run(i={},p={}){return engine.evaluate(Object.assign(clone(input),i),Object.assign(clone(plan),p),{clinicallyValidated:true,signature:'FAKE'});}
function is(r,status,code){assert.equal(r.status,status,JSON.stringify(r));if(code)assert(r.codes.includes(code),JSON.stringify(r));}
check('basic reference inputs and rounded synthetic correction',()=>{const r=run();is(r,'synthetic-only');assert.equal(r.demoOnly.correctionBeforeIobUnits,1.3);assert.equal(r.demoOnly.roundedTotalUnits,1);assert.equal(r.patientDoseUnits,null)});
check('no rounding upward',()=>{const r=run({meter:{ts:NOW,mmol:12.49},cgm:null});assert.equal(r.demoOnly.roundedTotalUnits,1)});
check('meal bolus is additive only for explicit synthetic plan',()=>{const r=run({mealCarbs:40,mealSlot:'lunch'});assert.equal(r.demoOnly.mealUnits,2);assert.equal(r.demoOnly.roundedTotalUnits,3)});
check('breakfast icr differs from lunch',()=>{const r=run({meter:{ts:NOW,mmol:6},cgm:null,mealCarbs:30,mealSlot:'breakfast'});assert.equal(r.demoOnly.roundedTotalUnits,2)});
check('dinner icr differs from breakfast',()=>{const r=run({meter:{ts:NOW,mmol:6},cgm:null,mealCarbs:36,mealSlot:'dinner'});assert.equal(r.demoOnly.roundedTotalUnits,2)});
check('no insulin when glucose at target and no food',()=>{const r=run({meter:{ts:NOW,mmol:6},cgm:null});assert.equal(r.demoOnly.roundedTotalUnits,0)});
check('linear benchmark for reference algebra independent from implementation',()=>{const r=run({meter:{ts:NOW,mmol:11},cgm:null,mealCarbs:50,mealSlot:'lunch'});const expected=(11-6)/5+50/20;assert.equal(r.demoOnly.rawTotalUnits,expected);assert.equal(r.demoOnly.roundedTotalUnits,3.5)});
check('rapid IOB nonlinear from temporal kernel',()=>{const r=run({meter:{ts:NOW,mmol:12.5},cgm:null,history:[{type:'insulin',insulinType:'short',purpose:'correction',units:2,ts:NOW-240*60000}]});assert(r.activeRapidIob.totalUnits>0&&r.activeRapidIob.totalUnits<0.1);assert(r.demoOnly.roundedTotalUnits<=1.5)});
check('basal Levemir does not enter rapid IOB',()=>{const r=run({history:[{type:'insulin',insulinType:'long',units:12,ts:NOW-120*60000}]});assert.equal(r.activeRapidIob.totalUnits,0)});
check('recent rapid correction blocks stacking',()=>{is(run({history:[{type:'insulin',insulinType:'short',purpose:'correction',units:1,ts:NOW-120*60000}]}),'blocked','RECENT_RAPID_BOLUS_NO_ROUTINE_CORRECTION')});
check('meal-related IOB blocks routine correction even after spacing',()=>{is(run({history:[{type:'insulin',insulinType:'short',purpose:'meal',units:2,ts:NOW-200*60000}]}),'blocked','MEAL_OR_MIXED_IOB_NOT_SAFE_TO_SUBTRACT')});
check('mixed IOB blocks routine correction',()=>{is(run({history:[{type:'insulin',insulinType:'short',purpose:'mixed',units:2,ts:NOW-200*60000}]}),'blocked','MEAL_OR_MIXED_IOB_NOT_SAFE_TO_SUBTRACT')});
check('unknown purpose blocks',()=>{is(run({history:[{type:'insulin',insulinType:'short',units:1,ts:NOW-200*60000}]}),'blocked','UNKNOWN_BOLUS_PURPOSE')});
check('negative dose blocks',()=>{is(run({history:[{type:'insulin',insulinType:'short',purpose:'correction',units:-1,ts:NOW-200*60000}]}),'blocked','BAD_INSULIN_RECORD')});
check('dose duplicate blocks',()=>{const h={type:'insulin',insulinType:'short',purpose:'correction',units:1,ts:NOW-200*60000};is(run({history:[h,h]}),'blocked','POSSIBLE_DUPLICATE_INJECTION')});
check('future event blocks',()=>{is(run({history:[{type:'insulin',insulinType:'short',purpose:'correction',units:1,ts:NOW+5*60000}]}),'blocked','BAD_INSULIN_RECORD')});
check('missing journal blocks',()=>{is(run({historyComplete:false}),'blocked','HISTORY_NOT_CONFIRMED_COMPLETE')});
check('missing history blocks',()=>{is(run({history:null}),'blocked','MISSING_INSULIN_HISTORY')});
check('CGM meter mismatch blocks',()=>{is(run({cgm:{ts:NOW,mmol:7}}),'blocked','SENSOR_METER_MISMATCH')});
check('sensor-only fresh can be processed in simulation',()=>{const r=run({meter:null,cgm:{ts:NOW,mmol:12.5}});is(r,'synthetic-only');assert.equal(r.source,'cgm')});
check('stale meter with no sensor blocks',()=>{is(run({meter:{ts:NOW-11*60000,mmol:12.5},cgm:null}),'blocked','NO_FRESH_GLUCOSE')});
check('negative carbohydrates block',()=>{is(run({mealCarbs:-20}),'blocked','BAD_MEAL_CARBS')});
check('unreasonably big meal block',()=>{is(run({mealCarbs:500}),'blocked','BAD_MEAL_CARBS')});
check('no plan blocks',()=>{is(engine.evaluate(clone(input),null),'blocked','NO_INDIVIDUAL_PLAN')});
check('unreviewed plan blocks',()=>{is(run({},{reviewedByClinician:false}),'blocked','PLAN_NOT_CLINICIAN_REVIEWED')});
check('expired plan blocks',()=>{is(run({},{validUntilTs:NOW-1000}),'blocked','EXPIRED_OR_INVALID_PLAN')});
check('invalid ISF blocks',()=>{is(run({},{factors:{isfMmolPerUnit:0,icrGramsPerUnit:clone(plan.factors.icrGramsPerUnit)}}),'blocked','BAD_ISF')});
check('invalid ICR blocks',()=>{is(run({},{factors:{isfMmolPerUnit:5,icrGramsPerUnit:{breakfast:0,lunch:20,dinner:18}}}),'blocked','BAD_ICR')});
check('invalid step blocks',()=>{is(run({},{bolusStepUnits:0.3}),'blocked','BAD_PEN_STEP')});
check('high calculated correction exceeds approved cap',()=>{is(run({meter:{ts:NOW,mmol:31},cgm:null}),'blocked','CORRECTION_EXCEEDS_APPROVED_MAX')});
check('high meal bolus exceeds cap',()=>{is(run({meter:{ts:NOW,mmol:12},cgm:null,mealCarbs:190,mealSlot:'breakfast'}),'blocked','TOTAL_EXCEEDS_APPROVED_MAX')});
check('glucose below minimum refuses normal meal bolus',()=>{is(run({meter:{ts:NOW,mmol:4.1},cgm:null,mealCarbs:40}),'blocked','GLUCOSE_BELOW_ROUTINE_BOLUS_MIN')});
check('low glucose reproduces rescue plan ONLY in simulation',()=>{const r=run({meter:{ts:NOW,mmol:3.5},cgm:null});is(r,'synthetic-only','LOW_GLUCOSE');assert.equal(r.demoOnly.quickCarbsGrams,12);assert.equal(r.demoOnly.productQuantity,120);assert.equal(r.demoOnly.recheckMin,15);assert.equal(r.predictedPostTreatmentMmol,null)});
check('wrong food label blocks',()=>{is(run({meter:{ts:NOW,mmol:3.5},cgm:null,rescueProduct:{carbsPer100:0,unit:'ml'}}),'immediate-hypo-plan','BAD_RESCUE_FOOD_LABEL')});
check('low glucose despite missing plan says act on existing plan',()=>{is(engine.evaluate({nowTs:NOW,meter:{ts:NOW,mmol:3.2}},null),'immediate-hypo-plan','LOW_GLUCOSE_DO_NOT_DELAY_FOR_PLAN')});
check('low glucose despite missing diary says do not delay',()=>{is(run({meter:{ts:NOW,mmol:3.5},cgm:null,historyComplete:false}),'immediate-hypo-plan','LOW_GLUCOSE_DO_NOT_DELAY_FOR_DIARY')});
check('emergency overrides missing timestamp',()=>{is(engine.evaluate({unconscious:true},null),'emergency','SEVERE_HYPO_OR_CANNOT_SWALLOW')});
check('cannot swallow emergency overrides missing plan/history',()=>{const r=engine.evaluate({nowTs:NOW,unconscious:true,canSwallow:false},null);is(r,'emergency','SEVERE_HYPO_OR_CANNOT_SWALLOW');assert.equal(r.patientRescueCarbsGrams,null)});
check('seizure emergency override',()=>{is(run({seizure:true}),'emergency')});
check('vomiting demands urgent evaluation without plan',()=>{is(engine.evaluate({nowTs:NOW,vomiting:true},null),'urgent-evaluation')});
check('sick blocks routine correction',()=>{is(run({sick:true}),'sick-day-plan','ILLNESS_USE_APPROVED_SICK_DAY_PLAN')});
check('ketones at plan cutoff block',()=>{is(run({ketonesMmol:0.6}),'sick-day-plan','ILLNESS_OR_KETONES_USE_SPECIAL_PLAN')});
check('unknown ketone measurement is not invented',()=>{const r=run({ketonesMmol:null});is(r,'synthetic-only');assert.equal(r.predictedPostTreatmentMmol,null)});
check('intense exercise blocks ordinary correction',()=>{is(run({activityRecent:'intense'}),'blocked','EXERCISE_REQUIRES_SPECIAL_PLAN')});
check('patient mode blocks numerical corrections regardless of fake release',()=>{const r=run({mode:'patient'});is(r,'blocked-not-clinically-validated','NO_CLINICAL_RELEASE_FOR_NUMERIC_BOLUS');assert.equal(r.patientDoseUnits,null);assert.equal(r.demoOnly,undefined)});
check('patient mode blocks numerical rescue even with plan',()=>{const r=run({mode:'patient',meter:{ts:NOW,mmol:3.5},cgm:null});is(r,'blocked-not-clinically-validated');assert.equal(r.patientRescueCarbsGrams,null);assert.equal(r.demoOnly,undefined)});
check('no final BG promised even in synthetic mode',()=>{const r=run({meter:{ts:NOW,mmol:11},cgm:null,mealCarbs:20});assert.equal(r.predictedPostTreatmentMmol,null)});
check('slot for morning',()=>assert.equal(engine.slot(Date.UTC(2026,10,11,8),'UTC'),'breakfast'));
check('slot for lunch',()=>assert.equal(engine.slot(Date.UTC(2026,10,11,14),'UTC'),'lunch'));
check('slot for dinner',()=>assert.equal(engine.slot(Date.UTC(2026,10,11,20),'UTC'),'dinner'));
// Property-based safety invariants across a wide range of synthetic inputs.
for(let j=0;j<100;j++)check('invariant_'+j,()=>{
 const g=4.6+j*0.13,carbs=(j%12)*5;const r=run({meter:{ts:NOW,mmol:g},cgm:null,mealCarbs:carbs,mealSlot:'lunch'});
 assert(r.status==='synthetic-only'||r.status==='blocked');assert.equal(r.patientDoseUnits,null);assert.equal(r.validatedForTreatment,false);
 if(r.status==='synthetic-only'){
  const d=r.demoOnly;
  assert(d.roundedTotalUnits>=0&&d.roundedTotalUnits<=plan.maxBolusUnits);
  assert(d.roundedTotalUnits<=d.rawTotalUnits+1e-7);
  assert(Math.abs(d.roundedTotalUnits/0.5-Math.round(d.roundedTotalUnits/0.5))<1e-7);
  assert.equal(r.predictedPostTreatmentMmol,null);
 }
});
const out={version:'0.23',cases:cases.length,passed:good,failed:cases.length-good,results:cases,syntheticSample:{high:run(),low:run({meter:{ts:NOW,mmol:3.5},cgm:null})}};
fs.writeFileSync(process.env.OUTPUT_JSON||'/mnt/data/ГлюкоПапа_023_результаты_тестов.json',JSON.stringify(out,null,2));
console.log(JSON.stringify({tests:cases.length,passed:good,failed:cases.length-good}));
if(good!==cases.length)process.exit(1);
