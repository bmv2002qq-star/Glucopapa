/* GlucoPapa 0.24 — automatic retrospective data pipeline. Research only.
 * Reads existing diary data, checks provenance, links unambiguous meal injections,
 * computes population starters and conditional retrospective estimates.
 * It NEVER approves a clinical plan or emits a patient treatment amount.
 */
(function(root){'use strict';
const MS=60000,DAY=86400000;
if(typeof require==='function'&&!root.GFMedical)require('./medical_engine.js');
const med=root.GFMedical;
const personal=(typeof require==='function')?require('./personal_factors_v019.js'):root.GFPersonal19;
const plan=(typeof require==='function')?require('./plan_calculator_v023.js'):root.GFPlan23;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const num=x=>(x===null||x===undefined||x==='')?NaN:Number(x);
const rd=(x,n=3)=>Number(Number(x).toFixed(n));
function mealSlot(ts,timeZone){
  const h=Number(new Intl.DateTimeFormat('en-US',{timeZone,hour:'2-digit',hourCycle:'h23'}).format(new Date(ts)));
  return h<11?'breakfast':h<17?'lunch':'dinner';
}
function normalize(raw,now){
  const events=Array.isArray(raw?.events)?raw.events:[];
  const readings=Array.isArray(raw?.readings)?raw.readings:[];
  const tz=raw?.profile?.timeZone||'UTC';
  const flags=[],linked=[],inferredNames=[];const list=[];
  try{new Intl.DateTimeFormat('en-US',{timeZone:tz}).format(new Date(now));}catch{return {events:[],readings:[],flags:['INVALID_TIMEZONE'],fatal:true,linked,inferredNames}};
  let fatal=false;
  for(const [i,e] of events.entries()){
    if(!e||!['meal','insulin','activity','illness'].includes(e.type))continue;
    const x={...e};x.ts=num(e.ts);
    // Recompute on a rolling window; old events must not poison the new 5-day audit.
    if(finite(x.ts)&&x.ts<now-7.5*DAY&&x.type!=='illness')continue;
    // Planned future meals are proposals, not consumed food or diary errors.
    if(x.type==='meal'&&e.status==='planned')continue;
    if(!finite(x.ts)||x.ts<946684800000||x.ts>now+120000){flags.push(`BAD_EVENT_TIME:${i}`);fatal=true;continue;}
    if(x.type==='insulin'){
      x.units=num(e.units);
      if(!finite(x.units)||x.units<=0||x.units>100){flags.push(`BAD_INSULIN_UNITS:${i}`);fatal=true;continue;}
      // Never guess insulin type from an unfamiliar name.
      if(!['short','long'].includes(x.insulinType)){
        const name=String(x.insulinName||'').toLowerCase().replace(/ё/g,'е').trim();
        if(['novorapid','novo rapid','новорапид','novolog'].includes(name))x.insulinType='short';
        else if(['левемир','levemir','insulin detemir'].includes(name))x.insulinType='long';
        if(['short','long'].includes(x.insulinType)){inferredNames.push(i);flags.push(`INSULIN_TYPE_INFERRED_FROM_NAME:${i}`)}
        else {flags.push(`UNKNOWN_INSULIN_TYPE:${i}`);fatal=true;continue;}
      }
    }
    if(x.type==='meal'){
      if(e.status!=='eaten'){flags.push(`MEAL_NOT_CONFIRMED_EATEN:${i}`);if(e.status==='planned')continue;fatal=true;continue;}
      x.carbs=num(e.carbs);
      if(!finite(x.carbs)||x.carbs<0||x.carbs>500){flags.push(`BAD_MEAL_CARBS:${i}`);fatal=true;continue;}
      const snack= e.mealSlot==='snack'||e.mealKind==='snack'||/^\s*перекус\s*:/i.test(String(e.name||''));
      x.mealSlot=snack?'snack':(['breakfast','lunch','dinner'].includes(e.mealSlot)?e.mealSlot:mealSlot(x.ts,tz));
      x.protein=finite(num(e.protein))?num(e.protein):0;
      x.fat=finite(num(e.fat))?num(e.fat):0;
      if(x.protein<0||x.fat<0){flags.push(`BAD_MACRO:${i}`);fatal=true;continue;}
    }
    list.push(x);
  }
  // Duplicate detection must happen before any linking.
  const injections=list.filter(e=>e.type==='insulin').sort((a,b)=>a.ts-b.ts);
  for(let j=1;j<injections.length;j++){
    const a=injections[j-1],b=injections[j];
    if(Math.abs(b.ts-a.ts)<=MS&&a.insulinType===b.insulinType&&a.units===b.units&&String(a.insulinName||'')===String(b.insulinName||'')){
      flags.push('POSSIBLE_DUPLICATE_INSULIN');fatal=true;
    }
  }
  // A meal is unambiguously linkable only when it has exactly one rapid shot in
  // the -45..+45 minute window and that shot is not linked to another meal.
  const meals=list.filter(e=>e.type==='meal');
  for(const shot of injections){
    if(shot.insulinType!=='short')continue;
    if(shot.doseReason==='correction'||shot.doseReason==='mixed')continue;
    const candidateMeals=meals.filter(m=>Math.abs(m.ts-shot.ts)<=45*MS);
    const candidateShots=candidateMeals.length===1?injections.filter(s=>s.insulinType==='short'&&Math.abs(s.ts-candidateMeals[0].ts)<=45*MS):[];
    if(candidateMeals.length===1&&candidateShots.length===1){
      const explicitlyMeal=shot.doseReason==='meal';
      shot.doseReason='meal';shot.purpose='meal';shot.mealSlot=candidateMeals[0].mealSlot;
      linked.push({insulinTime:shot.ts,mealTime:candidateMeals[0].ts,slot:shot.mealSlot,method:explicitlyMeal?'recorded-purpose-and-time-match':'inferred-time-association;unverified'});
    }else{flags.push(`UNCLASSIFIED_RAPID_BOLUS:${shot.ts}`);
      if(shot.doseReason==='meal')shot.doseReason='unknown';
    }
  }
  // These links are hypotheses, not proof of injection intent.
  const rows=readings.filter(r=>finite(num(r?.ts))&&finite(num(r?.mmol))&&num(r.ts)<=now&&num(r.ts)>=now-7.5*DAY).map(r=>({ts:num(r.ts),mmol:num(r.mmol)}));
  if(rows.some(r=>r.mmol<1.5||r.mmol>35)){flags.push('INVALID_CGM_VALUES');fatal=true;}
  rows.sort((a,b)=>a.ts-b.ts);
  for(let i=1;i<rows.length;i++){
    if(rows[i].ts===rows[i-1].ts){flags.push('DUPLICATE_CGM_TIMESTAMP');fatal=true;break;}
  }
  for(let i=1;i<rows.length;i++){
    if(rows[i].ts-rows[i-1].ts<=10*MS&&Math.abs(rows[i].mmol-rows[i-1].mmol)>5){flags.push('POSSIBLE_CGM_SPIKE');fatal=true;break;}
  }
  return {events:list,readings:rows,flags:[...new Set(flags)],fatal,linked,inferredNames,timeZone:tz};
}
function analyze(raw,now=Date.now()){
  if(!finite(now))return {version:'0.24-research',status:'blocked',flags:['INVALID_NOW'],patientTreatmentAmount:null};
  const n=normalize(raw,now);
  const observed={version:'0.24-research',flags:n.flags,linkedMealInjections:n.linked,sourceEvents:n.events.length,
    sourceReadings:n.readings.length,patientTreatmentAmount:null,autoApprovedTreatmentPlan:false};
  if(n.fatal)return {...observed,status:'needs-review',reason:'INPUT_NOT_TRUSTWORTHY',audit:null,personal:null,proposals:null};
  const snacks=n.events.filter(e=>e.type==='meal'&&e.mealSlot==='snack');
  const inp={profile:raw?.profile||{},events:n.events,readings:n.readings};
  // Three main meals required for the historical 5-day audit; snacks remain in
  // the personal estimator as interfering food and are never silently discarded.
  const audit=med.replayFiveDays({...inp,events:n.events.filter(e=>e.type!=='meal'||e.mealSlot!=='snack')},now);
  const tddValid=audit.tddMean!==null&&audit.tddMean!==undefined&&audit.validDays===5&&audit.status!=='needs-review';
  const personalResult=tddValid?personal.estimate(inp,now,{replayFiveDays:()=>audit}):null;
  const status=tddValid?'provisional-profile':'needs-review';
  const observations=personalResult?.corrections;
  const factor=(slot)=>personalResult?.meals?.[slot];
  const f=audit.reference;
  const proposals=tddValid?{
    provenance:'UNVALIDATED_DIARY_ESTIMATE',
    tddUnitsPerDay:audit.tddMean,
    isfRapid:{population:f.isfNovorapidMmolPerUnit,observed:observations?.status==='provisional'?observations.median:null,
      observedStatus:observations?.status||'insufficient',unit:'mmol/L per unit'},
    isfRegular:{population:f.isfRegularMmolPerUnit,unit:'mmol/L per unit'},
    icrGramsPerUnit:Object.fromEntries(['breakfast','lunch','dinner'].map(slot=>[slot,{
      population:f.carbGramsPerUnit,observed:factor(slot)?.status==='provisional'?factor(slot).median:null,
      observedStatus:factor(slot)?.status||'insufficient',ratioFromLoggedDoses:audit.byMeal?.[slot]?.observedGramsPerUnit??null}])),
    warnings:['Не использовать для назначения доз без независимой проверки.','Наблюдаемые отношения описывают зарегистрированные инъекции, а не доказанные индивидуальные потребности.']
  }:null;
  const latest=n.readings.at(-1)||null;
  const cgm=latest&&now-latest.ts<=10*MS?{status:'fresh',mmol:latest.mmol,ageMinutes:rd((now-latest.ts)/MS,1)}:
    {status:'stale-or-absent',mmol:null};
  const iob=latest?plan.iobBreakdown(now,n.events.filter(e=>e.type==='insulin'&&e.ts<=now)):{totalUnits:null,items:[]};
  const notes=[];
  if(n.inferredNames.length)notes.push('Тип отдельных инсулинов определён по названию; требуется ручное подтверждение.');
  if(n.linked.length)notes.push('Связи инъекций с едой определены по времени; назначение укола не подтверждено.');
  if(observations?.status!=='provisional')notes.push('Для индивидуальной ФЧИ нет достаточного числа чистых коррекций.');
  if(!tddValid)notes.push('Нет пяти завершённых достоверных суток для расчёта СДИ.');
  if(snacks.length)notes.push(`Дополнительных перекусов: ${snacks.length}; не используются как основные приёмы пищи, но исключают загрязнённые эпизоды калибровки.`);
  return {...observed,status,audit,personal:personalResult,proposals,cgm,modelIob:iob,notes,snackCount:snacks.length,
    careCalculatorEligibility:'NOT_ELIGIBLE_AUTOMATICALLY',
    clinicalReason:'На основании самих данных дневника нельзя автоматически утверждать лечебный план.'};
}
function evaluatePatient(raw,now,individualPlan,clinicalContext={}){
  const profile=analyze(raw,now);
  const n=normalize(raw,now);
  const r=n.readings.filter(x=>x.ts<=now).at(-1)||null;
  const history=n.events.filter(e=>e.type==='insulin'&&e.ts<=now).map(e=>({type:'insulin',ts:e.ts,units:e.units,
    insulinType:e.insulinType,insulinName:e.insulinName,purpose:e.doseReason||'unknown'}));
  const input={...clinicalContext,nowTs:now,mode:'patient',cgm:r,history,historyComplete:false};
  // Never claim that a diary alone verifies the complete injection history.
  const clinical=plan.evaluate(input,individualPlan||null);
  return {profile,clinical,patientDoseUnits:null,patientRescueCarbsGrams:null};
}
root.GFAuto24={version:'0.24-research',normalize,analyze,evaluatePatient};
if(typeof module!=='undefined'&&module.exports)module.exports=root.GFAuto24;
})(typeof window==='undefined'?globalThis:window);
