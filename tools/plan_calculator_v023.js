/* GlucoPapa v0.23 — plan-constrained numerical calculator, research/verification build.
 * All numeric outputs are for SYNTHETIC fixtures only. NEVER a patient instruction.
 * Individual clinical use requires independent clinical validation and a release process.
 * No AI model may change approved treatment-plan parameters.
 */
(function(root){'use strict';
 const temporal=(typeof require==='function')?require('./temporal_engine_v018.js'):root.GFTemporal18;
 const OK_NUM=x=>typeof x==='number'&&Number.isFinite(x);
 const MS=60000;
 const round=(x,n=3)=>Number(x.toFixed(n));
 const result=(status,codes,extra={})=>({version:'0.23-research',status,codes,...extra,patientDoseUnits:null,patientRescueCarbsGrams:null,validatedForTreatment:false});
 const hardFail=(code)=>result('blocked',[code]);
 const validNumber=(x,min,max)=>OK_NUM(x)&&x>=min&&x<=max;
 function validatePlan(plan,now){
  if(!plan||typeof plan!=='object')return ['NO_INDIVIDUAL_PLAN'];
  const issues=[];
  if(plan.reviewedByClinician!==true)issues.push('PLAN_NOT_CLINICIAN_REVIEWED');
  if(typeof plan.planId!=='string'||!plan.planId.trim())issues.push('NO_PLAN_ID');
  if(!validNumber(plan.validUntilTs,now+1,now+1000*86400000))issues.push('EXPIRED_OR_INVALID_PLAN');
  const f=plan.factors||{};
  if(!validNumber(f.isfMmolPerUnit,0.1,40))issues.push('BAD_ISF');
  if(!f.icrGramsPerUnit||['breakfast','lunch','dinner'].some(x=>!validNumber(f.icrGramsPerUnit[x],1,150)))issues.push('BAD_ICR');
  if(!validNumber(plan.targetMmol,3.9,12))issues.push('BAD_TARGET');
  if(!validNumber(plan.bolusStepUnits,0.1,1)||![0.1,0.5,1].includes(plan.bolusStepUnits))issues.push('BAD_PEN_STEP');
  if(!validNumber(plan.maxBolusUnits,0.5,50))issues.push('BAD_MAX_BOLUS');
  if(!validNumber(plan.maxCorrectionUnits,0.5,30))issues.push('BAD_MAX_CORRECTION');
  if(!validNumber(plan.minCorrectionSpacingMinutes,0,600))issues.push('BAD_INTERVAL');
  if(!validNumber(plan.minRoutineGlucoseMmol,3.9,15))issues.push('BAD_MIN_GLUCOSE');
  if(!validNumber(plan.maxKetonesForRoutineMmol,0,3))issues.push('BAD_KETONE_CUTOFF');
  if(!validNumber(plan.hypo?.fastCarbsGrams,1,60))issues.push('BAD_HYPO_PLAN');
  if(!validNumber(plan.hypo?.recheckMin,5,30))issues.push('BAD_RECHECK');
  if(!validNumber(plan.hypo?.triggerBelowMmol,2.5,5))issues.push('BAD_HYPO_THRESHOLD');
  return issues;
 }
 function slot(ts,timezone='UTC'){
  let hour=0;try{hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date(ts)))}catch{return null}
  return hour<11?'breakfast':hour<17?'lunch':'dinner';
 }
 function validateInput(input,plan){
  const now=input?.nowTs;if(!validNumber(now,946684800000,4102444800000))return {codes:['INVALID_TIME']};
  if(!['synthetic','patient'].includes(input.mode))return {codes:['INVALID_MODE']};
  const g=input.meter||input.cgm;
  if(!g||!validNumber(g.mmol,1.5,35)||!OK_NUM(g.ts)||g.ts>now||now-g.ts>10*MS)return {codes:['NO_FRESH_GLUCOSE']};
  if(input.cgm&&input.meter){
   if(!validNumber(input.cgm.mmol,1.5,35)||!OK_NUM(input.cgm.ts)||Math.abs(input.cgm.mmol-input.meter.mmol)>1.7)
    return {codes:['SENSOR_METER_MISMATCH']};
  }
  const hist=input.history;
  if(!Array.isArray(hist))return {codes:['MISSING_INSULIN_HISTORY']};
  if(input.historyComplete!==true)return {codes:['HISTORY_NOT_CONFIRMED_COMPLETE']};
  const seen=new Set();
  for(const e of hist){
   if(!e||e.type!=='insulin'||!OK_NUM(e.ts)||e.ts>now||!validNumber(e.units,0.01,100)||!['short','long'].includes(e.insulinType))
    return {codes:['BAD_INSULIN_RECORD']};
   const key=`${e.ts}:${e.insulinType}:${e.units}:${e.insulinName||''}`;
   if(seen.has(key))return {codes:['POSSIBLE_DUPLICATE_INJECTION']};
   seen.add(key);
   if(e.insulinType==='short'&&!['correction','meal','mixed'].includes(e.purpose))return {codes:['UNKNOWN_BOLUS_PURPOSE']};
  }
  if(input.mealCarbs!=null&&!validNumber(input.mealCarbs,0,250))return {codes:['BAD_MEAL_CARBS']};
  if(input.rescueProduct!=null){const p=input.rescueProduct;
   if(!validNumber(p.carbsPer100,0.1,100)||!['g','ml'].includes(p.unit))return {codes:['BAD_RESCUE_FOOD_LABEL']};}
  return {codes:[],g:input.meter||input.cgm,now};
 }
 function iobBreakdown(now,history){
  let total=0;const items=[];
  for(const x of history){if(x.insulinType!=='short')continue;
   const age=(now-x.ts)/MS;
   if(age<0||age>=300)continue;
   const remaining=x.units*(1-temporal.f('rapid',age));
   total+=remaining;items.push({ageMinutes:round(age,1),purpose:x.purpose,remainingUnits:round(remaining,4)});
  }
  return {totalUnits:round(total,4),items,method:'v0.18 experimental nonlinear rapid kernel; 300min; excludes Levemir'};
 }
 function evaluate(input,plan,release={}){
  // Patient mode NEVER exposes a numerical treatment amount: no clinical release exists.
  // A product team may only change this after independent clinical validation.
  if(!input)return hardFail('INVALID_TIME');
  // Emergency triage must not depend on a valid plan, CGM, or diary.
  if(input.unconscious||input.canSwallow===false||input.seizure){
   return result('emergency',['SEVERE_HYPO_OR_CANNOT_SWALLOW'],{action:'EMERGENCY_HELP_AND_PRESCRIBED_GLUCOGON_NO_ORAL_FOOD'});
  }
  if(input.vomiting||input.confusion||input.rapidBreathing){
   return result('urgent-evaluation',['URGENT_SYMPTOMS_NO_ROUTINE_BOLUS']);
  }
  if(!validNumber(input.nowTs,946684800000,4102444800000))return hardFail('INVALID_TIME');
  const earlyGlucose=input.meter||input.cgm;
  const lowNow=earlyGlucose&&OK_NUM(earlyGlucose.mmol)&&earlyGlucose.mmol<3.9&&
   OK_NUM(earlyGlucose.ts)&&earlyGlucose.ts<=input.nowTs&&input.nowTs-earlyGlucose.ts<=10*MS;
  if(input.sick===true&&!lowNow)return result('sick-day-plan',['ILLNESS_USE_APPROVED_SICK_DAY_PLAN']);
  const errors=validatePlan(plan,input.nowTs);
  if(errors.length)return lowNow
    ?result('immediate-hypo-plan',['LOW_GLUCOSE_DO_NOT_DELAY_FOR_PLAN',...errors])
    :result('blocked',errors);
  const checked=validateInput(input,plan);
  if(checked.codes.length)return lowNow
    ?result('immediate-hypo-plan',['LOW_GLUCOSE_DO_NOT_DELAY_FOR_DIARY',...checked.codes])
    :result('blocked',checked.codes);
  const g=checked.g.mmol,now=checked.now;
  const main=input.mode==='synthetic'?'synthetic-only':'blocked-not-clinically-validated';
  const facts={glucoseMmol:g,source:input.meter?'meter':'cgm',planId:plan.planId,planReviewed:true,
    tddReference:OK_NUM(input.observedTddUnits)?input.observedTddUnits:null,
    isfUsed:plan.factors.isfMmolPerUnit,icrUsed:plan.factors.icrGramsPerUnit,
    activeRapidIob:iobBreakdown(now,input.history),researchOnly:true,
    note:'The patient plan is an unverified test object. No clinical release/authorization is implemented.'};
  if(g<plan.hypo.triggerBelowMmol){
   if(input.mode!=='synthetic')return result('blocked-not-clinically-validated',['HYPOTHETICAL_CALCULATION_NOT_PATIENT_INSTRUCTION'],{...facts,triage:'LOW_GLUCOSE_FOLLOW_EXISTING_PLAN_IMMEDIATELY'});
   const grams=plan.hypo.fastCarbsGrams;
   const food=input.rescueProduct||null;
   const servings=food?round(grams*100/food.carbsPer100,1):null;
   return result(main,['LOW_GLUCOSE','FOLLOW_PREENTERED_PLAN'],{...facts,demoOnly:{quickCarbsGrams:grams,productQuantity:servings,productUnit:food?.unit||null,recheckMin:plan.hypo.recheckMin},
    predictedPostTreatmentMmol:null,warning:'Demo only. No reliable individual post-treatment glucose is asserted.'});
  }
  if(input.sick||input.ketonesMmol!=null&&(!OK_NUM(input.ketonesMmol)||input.ketonesMmol>=plan.maxKetonesForRoutineMmol)){
   return result('sick-day-plan',['ILLNESS_OR_KETONES_USE_SPECIAL_PLAN'],{...facts});
  }
  if(input.activityRecent==='intense'||input.activityPlanned==='intense'){
   return result('blocked',['EXERCISE_REQUIRES_SPECIAL_PLAN'],{...facts});
  }
  if(input.mode!=='synthetic')return result('blocked-not-clinically-validated',['NO_CLINICAL_RELEASE_FOR_NUMERIC_BOLUS'],{...facts});
  if(g<plan.minRoutineGlucoseMmol)return result('blocked',['GLUCOSE_BELOW_ROUTINE_BOLUS_MIN'],{...facts});
  const rapidHistory=input.history.filter(x=>x.insulinType==='short');
  const lastRapid=Math.max(...rapidHistory.map(x=>x.ts),-Infinity);
  const elapsed=(now-lastRapid)/MS;
  if(g>plan.targetMmol&&Number.isFinite(elapsed)&&elapsed<plan.minCorrectionSpacingMinutes)
   return result('blocked',['RECENT_RAPID_BOLUS_NO_ROUTINE_CORRECTION'],{...facts,minutesSinceRapid:round(elapsed)});
  const mealCarbs=Number(input.mealCarbs||0),timeSlot=input.mealSlot||slot(now,input.timeZone||'UTC');
  if(!['breakfast','lunch','dinner'].includes(timeSlot))return result('blocked',['BAD_MEAL_SLOT'],{...facts});
  const mealComponent=mealCarbs/plan.factors.icrGramsPerUnit[timeSlot];
  const correctionBeforeIob=Math.max(0,(g-plan.targetMmol)/plan.factors.isfMmolPerUnit);
  // Whole-bolus IOB can have overlap with meal coverage. If any significant
  // meal/mixed IOB, refuse routine correction rather than double accounting.
  const iob=facts.activeRapidIob;
  if(correctionBeforeIob>0&&iob.items.some(x=>['meal','mixed'].includes(x.purpose)&&x.remainingUnits>0.05))
   return result('blocked',['MEAL_OR_MIXED_IOB_NOT_SAFE_TO_SUBTRACT'],{...facts});
  const correctionIob=iob.items.filter(x=>x.purpose==='correction').reduce((s,x)=>s+x.remainingUnits,0);
  const correction=Math.max(0,correctionBeforeIob-correctionIob);
  if(correction>plan.maxCorrectionUnits)return result('blocked',['CORRECTION_EXCEEDS_APPROVED_MAX'],{...facts});
  const raw=correction+mealComponent;
  if(raw>plan.maxBolusUnits)return result('blocked',['TOTAL_EXCEEDS_APPROVED_MAX'],{...facts});
  const step=plan.bolusStepUnits;
  const rounded=Math.floor((raw+1e-9)/step)*step;
  return result(main,['PLAN_REPRODUCTION_ONLY'],{...facts,demoOnly:{rawTotalUnits:round(raw,4),mealUnits:round(mealComponent,4),correctionBeforeIobUnits:round(correctionBeforeIob,4),correctionIobUnits:round(correctionIob,4),correctionAfterIobUnits:round(correction,4),roundedTotalUnits:round(rounded,2),stepUnits:step,slot:timeSlot},
   predictedPostTreatmentMmol:null,warning:'Synthetic demonstration only. Neither dose nor final glucose has been clinically validated.'});
 }
 root.GFPlan23={version:'0.23-research',validatePlan,validateInput,iobBreakdown,evaluate,slot};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.GFPlan23;
})(typeof window==='undefined'?globalThis:window);
