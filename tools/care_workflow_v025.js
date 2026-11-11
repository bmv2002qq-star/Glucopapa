/* GlucoPapa 0.25 — auditable automatic journal workflow.
 * Research-only numerical replay; does not prescribe medication to a child.
 * Patient mode shows evidence, comparison with an EXPLICIT plan, safety triage,
 * but never converts observational coefficients into patient treatment amounts.
 */
(function(root){'use strict';
const Auto = typeof require==='function'?require('./auto_profile_v024.js'):root.GFAuto24;
const Plan = typeof require==='function'?require('./plan_calculator_v023.js'):root.GFPlan23;
const N=x=>typeof x==='number'&&Number.isFinite(x);
const R=(x,n=3)=>N(x)?Number(x.toFixed(n)):null;
const SLOTS=['breakfast','lunch','dinner'];
function pct(estimate,reference){return N(estimate)&&N(reference)&&reference>0?R((estimate/reference-1)*100,2):null;}
function compare(profile,individualPlan){
 const rec=profile?.proposals;
 const okay=individualPlan?.reviewedByClinician===true;
 if(!rec)return {status:'no-trusted-five-day-record',fields:[],approvedAutomatically:false};
 const supplied=okay&&individualPlan.factors||null;
 const fields=[{key:'isf',label:'ФЧИ НовоРапида',unit:'ммоль/л на ЕД',starter:rec.isfRapid.population,
    observed:rec.isfRapid.observed,quality:rec.isfRapid.observedStatus,plan: N(supplied?.isfMmolPerUnit)?supplied.isfMmolPerUnit:null}];
 for(const slot of SLOTS){const o=rec.icrGramsPerUnit[slot];
   fields.push({key:slot,label:({breakfast:'Завтрак',lunch:'Обед',dinner:'Ужин'})[slot],unit:'г/ЕД',starter:o.population,
    observed:o.observed,quality:o.observedStatus,
    plan:N(supplied?.icrGramsPerUnit?.[slot])?supplied.icrGramsPerUnit[slot]:null});
 }
 for(const v of fields){v.vsStartPct=pct(v.observed,v.starter);v.vsPlanPct=pct(v.observed,v.plan);v.changeMayAffectDosing=v.vsPlanPct!=null&&Math.abs(v.vsPlanPct)>=20;
  v.verdict=v.observed===null?'insufficient-evidence':v.vsPlanPct===null?'unreviewed-observational-estimate':v.changeMayAffectDosing?'material-disagreement-needs-clinician-review':'observational-agreement-not-validation';
 }
 return {status:okay?'compare-with-declared-plan':'preliminary-without-verified-plan',fields,
   tddUnitsPerDay:rec.tddUnitsPerDay,approvedAutomatically:false,
   provenance:'Observations are associations, not confirmed treatment coefficients',
   alertCount:fields.filter(x=>x.changeMayAffectDosing).length};
}
function assess(raw,now,declaredPlan){
 const profile=Auto.analyze(raw,now),comparison=compare(profile,declaredPlan);
 const problems=[...(profile.flags||[]),...(profile.audit?.flags||[])];
 if(profile.status!=='provisional-profile')problems.push('FIVE_COMPLETE_DAYS_NOT_VERIFIED');
 if(profile.cgm?.status!=='fresh')problems.push('NO_FRESH_CGM');
 if(comparison.alertCount>0)problems.push('OBSERVATIONAL_FACTOR_DISAGREEMENT');
 if(profile.linkedMealInjections?.some(x=>x.method.includes('unverified')))problems.push('MEAL_BOLUS_LINK_INFERRED_NOT_CONFIRMED');
 const unreviewedPlan=declaredPlan&&declaredPlan.reviewedByClinician!==true;
 if(unreviewedPlan)problems.push('PLAN_UNVERIFIED');
 const warnings=[...new Set(problems)];
 return {version:'0.25-research',status:profile.status,profile,comparison,warnings,
  provenance:{analysis:'retrospective synthetic/diary',forecast:'not clinically validated',patientPrescription:'not available'},
  tddUnitsPerDay:profile.proposals?.tddUnitsPerDay??null,
  iobUnits:profile.modelIob?.totalUnits??null,
  numericDemoAvailable:profile.status==='provisional-profile',
  autoApproveFactors:false,autoPrescriptionUnits:null,autoRescueCarbsGrams:null};
}
function historyFromNormalized(raw,now){const n=Auto.normalize(raw,now);
 if(n.fatal)return {valid:false,codes:n.flags,history:[]};
 const history=n.events.filter(e=>e.type==='insulin'&&e.ts<=now).map(e=>({type:'insulin',insulinName:e.insulinName,
  insulinType:e.insulinType,ts:e.ts,units:e.units,purpose:e.doseReason||e.purpose||'unknown'}));
 return {valid:true,codes:n.flags,history};
}
// Explicit synthetic test cases. NEVER activated from patient data by a mode switch.
// An artificial source marker AND a synthetic-only plan identity are required.
function simulateSynthetic(fixture,scenario,syntheticPlan){
 if(fixture?.source!=='GF_SYNTHETIC_FIXTURE_V025'||fixture?.raw?.syntheticTag!=='GF_SYNTHETIC_FIXTURE_V025'||
    !String(syntheticPlan?.planId||'').startsWith('SYNTHETIC-'))
  return {status:'not-a-synthetic-fixture',patientPrescriptionUnits:null,patientRescueCarbsGrams:null};
 const now=fixture.now,assessment=assess(fixture.raw,now,syntheticPlan);
 if(assessment.status!=='provisional-profile')return {status:'invalid-synthetic-diary',assessment,patientPrescriptionUnits:null};
 const h=historyFromNormalized(fixture.raw,now);
 if(!h.valid)return {status:'invalid-synthetic-record',assessment,patientPrescriptionUnits:null};
 const input={mode:'synthetic',nowTs:now,timeZone:fixture.raw.profile?.timeZone||'UTC',
  meter:{ts:now,mmol:scenario.glucoseMmol},cgm:{ts:now,mmol:scenario.glucoseMmol},
  history:h.history,historyComplete:true,
  mealCarbs:scenario.mealCarbs||0,mealSlot:scenario.mealSlot||'lunch',
  rescueProduct:scenario.rescueProduct||{carbsPer100:10,unit:'ml'},
  ketonesMmol:scenario.ketonesMmol??null,sick:scenario.sick||false,
  activityRecent:scenario.activityRecent||null,
  unconscious:scenario.unconscious||false,canSwallow:scenario.canSwallow!==false,
  vomiting:scenario.vomiting||false,confusion:scenario.confusion||false};
 if(scenario.additionalHistory)input.history=[...input.history,...scenario.additionalHistory];
 const calculation=Plan.evaluate(input,syntheticPlan);
 return {status:calculation.status==='synthetic-only'?'synthetic-numerical-result':calculation.status,
  assessment,calculation,researchNumbers:calculation.demoOnly||null,
  patientPrescriptionUnits:null,patientRescueCarbsGrams:null,
  finalGlucosePredictionMmol:null,
  notTreatment:'Numbers are a synthetic protocol-replay demonstration, not a patient instruction.'};
}
function emergency(raw,now,caseInput){
 const input={mode:'patient',nowTs:now,unconscious:!!caseInput?.unconscious,
  canSwallow:caseInput?.canSwallow!==false,seizure:!!caseInput?.seizure,
  vomiting:!!caseInput?.vomiting,confusion:!!caseInput?.confusion};
 const v=Plan.evaluate(input,null);
 return {status:v.status,codes:v.codes,action:v.action||null};
}
root.GFCare25={version:'0.25-research',assess,compare,simulateSynthetic,historyFromNormalized,emergency,pct};
if(typeof module!=='undefined'&&module.exports)module.exports=root.GFCare25;
})(typeof window==='undefined'?globalThis:window);
