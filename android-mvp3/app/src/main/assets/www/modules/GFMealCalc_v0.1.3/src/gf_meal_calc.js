/* ГлюкоПапа GFMealCalc v0.1.3. READ-ONLY review + strictly labelled fictional demonstration.
 * GFStorage 5 is the single source of truth; never write to calculator port.
 * This module is not a medical device and cannot determine a treatment dose.
 */
(function(root,factory){ 'use strict'; const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFMealCalc=api; })(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.3';
const deepFreeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(deepFreeze);Object.freeze(x);}return x;};
const copy=x=>JSON.parse(JSON.stringify(x));
const finite=(x)=>typeof x==='number'&&Number.isFinite(x);
const timeMs=x=>{if(typeof x!=='string'||!/T\d\d:\d\d/.test(x)||!/(Z|[+-]\d\d:\d\d)$/.test(x)||!Number.isFinite(Date.parse(x)))throw Error('Нужна дата ISO с часовым поясом');return Date.parse(x);};
function periodAt(iso,zone){
 const t=timeMs(iso);let formatter;
 try{formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch(e){return {code:null,label:'Неизвестен часовой пояс'};}
 const x=formatter.formatToParts(t),hh=Number(x.find(p=>p.type==='hour').value), mm=Number(x.find(p=>p.type==='minute').value),minute=hh*60+mm;
 return minute>=6*60&&minute<11*60?{code:'morning',label:'Завтрак'}:minute>=11*60&&minute<17*60?{code:'day',label:'Обед'}:{code:'evening',label:'Ужин / ночь'};
}
function windowHas(time,from,to){const parse=x=>Number(x.slice(0,2))*60+Number(x.slice(3,5));const s=parse(from),e=parse(to);if(s===e)return false;return s<e?(time>=s&&time<e):(time>=s||time<e);}
function activeCoefficient(snapshot,nowIso){
 const now=timeMs(nowIso),tz=snapshot.profile?.timeZone;
 if(!tz)return null;
 const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),parts=fmt.formatToParts(now),tod=Number(parts.find(x=>x.type==='hour').value)*60+Number(parts.find(x=>x.type==='minute').value);
 const records=snapshot.coefficients||[];
 const hits=records.filter(x=>x.kind==='carb_g_per_u'&&x.source==='manual'&&finite(x.value)&&x.value>0&&timeMs(x.effectiveFrom)<=now&&(!x.effectiveUntil||now<timeMs(x.effectiveUntil))&&(!x.windowLocal||windowHas(tod,x.windowLocal.from,x.windowLocal.to))&&
   // Follow the existing GFSettings supersedesId history. Do not resurrect a replaced coefficient.
   !records.some(y=>y.supersedesId===x.id&&timeMs(y.effectiveFrom)<=now));
 if(hits.length!==1)return null; // ambiguity is blocked, not silently resolved
 return {value:hits[0].value,unit:'г/ЕД',origin:'Введено пользователем',verified:false,id:hits[0].id,mode:'manual'};
}
function observedCgm(readings,atMs,staleMins=15){
 if(!Array.isArray(readings))return null;
 const xs=readings.filter(x=>Number.isSafeInteger(x.ts)&&x.ts<=atMs&&finite(x.mmol)&&x.mmol>=1.5&&x.mmol<=30&&x.kind==='observed').sort((a,b)=>b.ts-a.ts);
 const hit=xs[0];return hit&&atMs-hit.ts<=staleMins*60000?{mmol:hit.mmol,atIso:new Date(hit.ts).toISOString(),ageMinutes:Math.round((atMs-hit.ts)/60000),source:'xdrip_follower',kind:'observed'}:null;
}
function iobFor(snapshot,nowIso,engine){
 const unavailable=(reason)=>({status:'UNAVAILABLE',reason,units:null,source:'rinfast_v0.3.1'});
 if(!engine||typeof engine.calculate!=='function'||!engine.DEFAULT_PROFILE)return unavailable('Не подключён утверждённый исследовательский движок РинФаста');
 const dia=engine.DEFAULT_PROFILE.diaMinutes,now=timeMs(nowIso),coverage=snapshot.coverage;
 if(!coverage||coverage.confirmedComplete!==true||timeMs(coverage.startIso)>now-dia*60000||timeMs(coverage.endIso)<now)return unavailable('Нет подтверждения полного журнала РинФаста на период действия');
 const shots=(snapshot.events||[]).filter(x=>x.type==='insulin_injection'&&x.insulinId==='rinfast'&&timeMs(x.administeredAt)<=now&&timeMs(x.administeredAt)>=now-dia*60000);
 let res;try{res=engine.calculate({nowIso,events:shots,profile:engine.DEFAULT_PROFILE});}catch(e){return unavailable('Ошибка/неполные данные модели: '+String(e.message||e));}
 if(res.status!=='MODEL_ESTIMATE')return unavailable('Исследовательская модель отклонила записи: '+res.issues.join('; '));
 return {status:'MODEL_ESTIMATE',units:res.modelRemainingUnits,source:'RinfastEngine v0.3.1 / OpenAPS profile 300/75',validation:false,assumesCompleteJournal:true};
}
function createCalculator(host,{rinfastEngine=null,clock=()=>new Date().toISOString()}={}){
 if(!host||typeof host.connect!=='function'||![2,4,5].includes(host.getSchemaVersion()))throw Error('Нужен GFStorage schema 2, 4 или 5');
 const port=host.connect('calculator');
 function inspect(sessionId,{atIso=clock()}={}){
  const atMs=timeMs(atIso),s=port.getSnapshot();
  const meal=s.mealSessions.find(x=>x.id===sessionId);
  if(!meal)throw Error('Тарелка не найдена в GFStorage');
  const plate=meal.actualPlate||meal.plannedPlate;
  if(!plate||plate.schema!=='GFPlate.v1')throw Error('Нет снимка GFPlate.v1');
  const period=periodAt(atIso,s.profile?.timeZone||'');
  const cgm=observedCgm(s.cgm,atMs),coefficient=activeCoefficient(s,atIso),iob=iobFor(s,atIso,rinfastEngine);
  const knownShots=s.events.filter(x=>meal.injectionIds.includes(x.id));
  const warnings=[];
  if(plate.containsEstimatedValues)warnings.push('Состав еды основан на оценках; действительные БЖУ могут отличаться.');
  if(!cgm)warnings.push('Нет свежего подтверждённого показания CGM за последние 15 минут.');
  if(!coefficient)warnings.push('Нет однозначного пользовательского углеводного коэффициента для этого времени.');
  else warnings.push('УК введён пользователем, но это не подтверждение его пригодности для дозирования.');
  if(iob.status!=='MODEL_ESTIMATE')warnings.push('IOB недоступен: '+iob.reason);
  if(meal.status==='draft')warnings.push('Тарелка пока в черновике.');
  if(meal.actualPlate===null)warnings.push('Фактически съеденное пока не подтверждено.');
  const autoCandidates=(s.proposals||[]).filter(x=>x.kind==='carb_g_per_u'&&x.status==='research_only'&&x.applied===false&&finite(x.candidate)).map(x=>({value:x.candidate,id:x.id,origin:'Исследовательское предложение · не применяется'}));
  const doseIntent=meal.doseIntent?{units:meal.doseIntent.units,source:'parent_manual',notAdministered:true}:null;
  // Fictional fixture ONLY: illustrate carbohydrate arithmetic using live storage plate/ratio.
  // No corrections, IOB, rounding, timing, clinical validation or use as parent intent.
  const isFictional=s.profile?.displayName==='ВЫМЫШЛЕННЫЙ РЕБЁНОК'&&sessionId.startsWith('demo-meal-');
  const researchArithmetic=isFictional&&coefficient&&plate.containsEstimatedValues
   ? {status:'SYNTHETIC_ARITHMETIC_ONLY',carbsG:plate.totals.carbs,ratioGPerUnit:coefficient.value,unroundedEquivalentUnits:plate.totals.carbs/coefficient.value,fromActualFood:meal.actualPlate!==null,roundedToPenStep:false,therapeuticRecommendation:false,note:'Только арифметика вымышленного примера: углеводы / заданное г/ЕД. Не назначение, без поправок и без округления.'}
   : {status:'NOT_AVAILABLE_FOR_REAL_DATA',unroundedEquivalentUnits:null,therapeuticRecommendation:false};
  return deepFreeze(copy({version:VERSION,sessionId,sessionVersion:meal.version,storageRevision:s.revision,asOf:atIso,mealStatus:meal.status,plateSource:meal.actualPlate?'actual':'planned',plate,period,cgm,coefficient,autoCandidates,iob,doseIntent,confirmedInjections:knownShots,mealStartedAt:meal.startedAt,mealCompletedAt:meal.completedAt,researchArithmetic,warnings,clinicalValidation:false,therapyRecommendation:null}));
 }
 // Educational arithmetic ONLY for an immutable, fictional, fixed data set. This never accesses a child's profile.
 function fictionalExample(){
   const fictionalCarbs=24,fictionalRatio=12;
   return deepFreeze({status:'FICTIONAL_EXAMPLE_ONLY',carbsG:fictionalCarbs,ratioGPerUnit:fictionalRatio,arithmeticResultUnits:fictionalCarbs/fictionalRatio,roundedToPenStep:false,fromRealContext:false,clinicallyValidated:false,label:'ВЫМЫШЛЕННЫЕ 24 г ÷ 12 г/ЕД = 2 ЕД. Не назначение, не связано с текущей тарелкой.'});
 }
 return Object.freeze({inspect,fictionalExample,subscribe:(cb)=>port.subscribe(cb)});
}
return Object.freeze({VERSION,createCalculator,periodAt,observedCgm,activeCoefficient});
});
