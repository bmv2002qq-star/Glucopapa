/* GFHighTarget v0.1.0 | trajectory research engine | GlucoPapa V2
 * No basal insulin. No writes. A synthetic-only optimizer; live estimates
 * cannot yield a correction dose until external independent clinical review.
 * Original RinfastEngine is injected, not copied. No hidden defaults for dose.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFHighTarget=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.1-candidate',MS=60000,STEP=5;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const iso=t=>typeof t==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(t)&&Number.isFinite(Date.parse(t))?Date.parse(t):NaN;
const round=(v,n=3)=>+v.toFixed(n);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function block(code,reasons,extra={}){return {version:VERSION,status:'BLOCKED',code,reasons:Array.isArray(reasons)?reasons:[reasons],clinicalUse:false,canRecordInjection:false,canSuggestDose:false,...extra};}
function median(a){const x=a.slice().sort((p,q)=>p-q),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function validateCGM(rows,now){
 if(!Array.isArray(rows)||rows.length<4)return {error:'CGM_HISTORY_INCOMPLETE'};
 const dedup=new Map();
 for(const r of rows){
  if(!finite(r?.mmol)||r.mmol<2||r.mmol>33||!Number.isSafeInteger(r.ts)||r.ts>now||r.ts<now-24*3600000||r.valid===false||r.qualityFlag==='invalid'||!r.sourceDeviceId)return {error:'CGM_INVALID_OR_UNTRUSTED'};
  if(r.receivedAt!==undefined){const received=iso(r.receivedAt);if(!finite(received)||received<r.ts-60000||received>now+60000||received-r.ts>10*MS)return {error:'CGM_RECEIPT_INVALID'};}
  if(dedup.has(r.ts)&&(dedup.get(r.ts).mmol!==r.mmol||dedup.get(r.ts).sourceDeviceId!==r.sourceDeviceId))return {error:'CGM_CONFLICTING_DUPLICATE'};
  dedup.set(r.ts,r);
 }
 const all=[...dedup.values()].sort((a,b)=>a.ts-b.ts),last=all.at(-1);if(now-last.ts>10*MS)return {error:'CGM_STALE'};
 const a=all.filter(x=>last.ts-x.ts<=25*MS);if(a.length<4||a.at(-1).ts-a[0].ts<15*MS)return {error:'CGM_TREND_INCOMPLETE'};
 if(a.some(r=>r.sourceDeviceId!==last.sourceDeviceId))return {error:'CGM_SOURCE_CHANGED'};
 for(let i=1;i<a.length;i++)if(a[i].ts-a[i-1].ts>10*MS)return {error:'CGM_GAP'};
 const slopes=[];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[j].ts-a[i].ts>=4*MS)slopes.push((a[j].mmol-a[i].mmol)/((a[j].ts-a[i].ts)/MS));
 if(slopes.length<3)return {error:'CGM_TREND_INCOMPLETE'};
 const slope=median(slopes),scatter=median(a.map(r=>Math.abs(r.mmol-(last.mmol+slope*(r.ts-last.ts)/MS))));
 if(Math.abs(slope)>0.22||scatter>0.9)return {error:'CGM_TREND_UNSTABLE'};
 const before=a.slice(0,-1);const baseSlopes=[];for(let i=0;i<before.length;i++)for(let j=i+1;j<before.length;j++)if(before[j].ts-before[i].ts>=4*MS)baseSlopes.push((before[j].mmol-before[i].mmol)/((before[j].ts-before[i].ts)/MS));
 if(baseSlopes.length>=3){const expected=before.at(-1).mmol+median(baseSlopes)*(last.ts-before.at(-1).ts)/MS;if(Math.abs(last.mmol-expected)>1.3)return {error:'CGM_LAST_POINT_SPIKE'};}
 return {last,latestMmol:last.mmol,slope,scatter,sourceId:last.sourceDeviceId,readingsUsed:a.length};
}
function validateShots(rows,now,engine){
 if(!Array.isArray(rows)||rows.length>10000)return {error:'INJECTION_EVENTS_INVALID'};
 if(!engine||typeof engine.getCurve!=='function'||engine.DEFAULT_PROFILE?.drugId!=='rinfast')return {error:'RINFAST_ENGINE_MISSING'};
 const ids=new Set(),active=[];
 for(const r of rows){
  if(r?.type!=='insulin_injection')continue;
  // Explicitly ignore basal insulin. This module never looks at its dose or schedule.
  if(r.insulinId==='levemir')continue;
  if(r.insulinId!=='rinfast')return {error:'OTHER_RAPID_INSULIN_UNMODELED'};
  if(typeof r.id!=='string'||!r.id||ids.has(r.id)||r.status!=='confirmed'||!finite(r.units)||r.units<=0||r.units>200)return {error:'INJECTION_UNCONFIRMED_OR_CORRUPT'};
  ids.add(r.id);const t=iso(r.administeredAt);if(!finite(t)||t>now)return {error:'INJECTION_TIME_INVALID'};
  const age=(now-t)/MS;if(age<engine.DEFAULT_PROFILE.diaMinutes)active.push({id:r.id,units:r.units,age});
 }
 return {active};
}
function smoothCDF(t,tau){if(t<=0)return 0;return clamp(1-(1+t/tau)*Math.exp(-t/tau),0,1);}
function smoothDerivative(t,tau){return t<=0?0:(t/(tau*tau))*Math.exp(-t/tau);}
function linearCDF(t,lag,duration){return clamp((t-lag)/duration,0,1);}
function foodCDF(meal,age,mode){return mode==='GFCOB'?linearCDF(age,meal.lag,meal.slowDuration):smoothCDF(Math.max(0,age-meal.lag),meal.slowDuration/5);}
function foodRate(meal,age,mode){
 if(mode==='GFCOB')return age>=meal.lag&&age<=meal.lag+meal.slowDuration?1/meal.slowDuration:0;
 return smoothDerivative(Math.max(0,age-meal.lag),meal.slowDuration/5);
}
function validateMeals(rows,now,mode){
 if(!Array.isArray(rows)||rows.length>10000)return {error:'MEALS_INVALID'};
 const ids=new Set(),active=[];
 for(const r of rows){
  if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id))return {error:'MEAL_ID_INVALID'};
  ids.add(r.id);
  if(r.status==='draft'||r.status==='planned'||r.status==='ready')continue;
  if(r.status!=='completed')return {error:'MEAL_NOT_CONFIRMED'};
  const t=iso(r.startedAt);if(!finite(t)||t>now)return {error:'MEAL_TIME_INVALID'};
  const plate=r.actualPlate;
  if(!plate||plate.containsEstimatedValues===true||!plate.totals||!finite(plate.totals.carbs)||plate.totals.carbs<0||!finite(plate.totals.fat)||plate.totals.fat<0||!finite(plate.totals.protein)||plate.totals.protein<0)return {error:'MEAL_COMPOSITION_UNKNOWN'};
  const k=r.kinetics;
  if(!k||!['plate_auto_research_preset_v1','explicit_research_scenario'].includes(k.origin)||!finite(k.lagMinutes)||k.lagMinutes<0||k.lagMinutes>120||!finite(k.slowDurationMinutes)||k.slowDurationMinutes<20||k.slowDurationMinutes>720)return {error:'MEAL_KINETICS_UNKNOWN'};
  const age=(now-t)/MS,lag=k.lagMinutes,slowDuration=k.slowDurationMinutes;
  // Keep contributions until their hypothesized model tail becomes negligible.
  if(age>lag+Math.max(720,slowDuration*7))continue;
  if(plate.totals.carbs>0)active.push({id:r.id,carbs:plate.totals.carbs,age,lag,slowDuration,model:mode,origin:k.origin,fat:plate.totals.fat,protein:plate.totals.protein});
 }
 return {active};
}
function modifierAt(mod,h){
 const ps=mod.points;if(h<=ps[0].t)return ps[0].delta;
 for(let i=1;i<ps.length;i++){if(h<=ps[i].t){const a=ps[i-1],b=ps[i];return a.delta+(b.delta-a.delta)*(h-a.t)/(b.t-a.t);}}
 return ps.at(-1).delta;
}
function checkModifiers(modifiers,context){
 const active=[];
 for(const k of ['activity','illness','physio']){
  const relevant=k==='activity'?context.activity!=='low':k==='illness'?context.illness===true:context.physioApplied===true;
  if(!relevant)continue;
  const m=modifiers?.[k];
  if(!m||typeof m.version!=='string'||!m.version||m.includesCurrentTrend!==false||!Array.isArray(m.points)||m.points.length<2||m.points.length>500||m.points[0].t!==0||m.points[0].delta!==0||!m.points.every((p,i)=>finite(p.t)&&finite(p.delta)&&p.t>=0&&p.t<=1440&&(i===0||p.t>m.points[i-1].t)))return {error:'UNVERIFIED_'+k.toUpperCase()+'_MODEL'};
  // A valid technical modifier is NOT proof of calibration or disjoint effects.
  active.push({key:k,curve:m});
 }
 return {active};
}
function findSettled(points,target,band,minimumMinutes){
 for(let i=0;i<points.length;i++){
  if(points.at(-1).t-points[i].t<minimumMinutes)break;
  if(points.slice(i).every(p=>Math.abs(p.g-target)<=band))return points[i].t;
 }
 return null;
}
function analyse(req){
 try{
  if(!req||typeof req!=='object')return block('INPUT_MISSING','Нет входного снимка');
  const now=iso(req.nowIso);if(!finite(now))return block('CLOCK_INVALID','Время должно включать часовой пояс');
  const s=req.settings||{},cov=req.coverage||{},context=req.context||{};
  if(!finite(s.target)||s.target<4||s.target>13||!finite(s.isf)||s.isf<=0||s.isf>50||!finite(s.uk)||s.uk<=0||s.uk>200)return block('COEFFICIENTS_MISSING','Нет датированных пользовательских цели/ФЧИ/УК');
  if(!['GFForecast','GFCOB'].includes(s.foodModel))return block('FOOD_MODEL_NOT_SELECTED','Не выбран единый тип модели усвоения');
  if(cov.injectionsConfirmed!==true||cov.mealsConfirmed!==true)return block('HISTORY_COVERAGE_UNKNOWN','Не подтверждена полнота истории еды и инсулина');
  const cgm=validateCGM(req.readings,now);if(cgm.error)return block(cgm.error,'CGM требует достоверной последовательности и времени измерений');
  if(cgm.latestMmol<=3.9)return block('LOW_CGM_USE_LOW_MODULE','При низкой глюкозе HIGH не используется');
  const ins=validateShots(req.injections,now,req.rinfastEngine);if(ins.error)return block(ins.error,'Неопределённая история короткого инсулина или модель РинФаста');
  const food=validateMeals(req.meals,now,s.foodModel);if(food.error)return block(food.error,'Нет проверенной фактической еды и модельной кинетики');
  const modifiers=checkModifiers(req.modifiers,context);if(modifiers.error)return block(modifiers.error,'Для выбранного состояния отсутствует непересекающаяся исследовательская модель');
  const profile=req.rinfastEngine.DEFAULT_PROFILE;
  const remaining=a=>req.rinfastEngine.getCurve(Math.max(0,a)).remainingFraction;
  const rate=a=>req.rinfastEngine.getCurve(Math.max(0,a)).activityFractionPerMinute;
  const iob=ins.active.reduce((z,e)=>z+e.units*remaining(e.age),0);
  const cob=food.active.reduce((z,m)=>z+m.carbs*(1-foodCDF(m,m.age,s.foodModel)),0);
  const insulinNowRate=-s.isf*ins.active.reduce((z,e)=>z+e.units*rate(e.age),0);
  const foodNowRate=s.isf/s.uk*food.active.reduce((z,m)=>z+m.carbs*foodRate(m,m.age,s.foodModel),0);
  const residual=cgm.slope-insulinNowRate-foodNowRate;
  if(Math.abs(residual)>0.28)return block('UNSTABLE_RESIDUAL','Прогноз слишком сильно расходится с фактической скоростью CGM',{diagnostics:{residual:round(residual)}});
  const drift=h=>clamp(residual,-0.18,0.18)*35*(1-Math.exp(-h/35));
  const lastMealTail=Math.max(0,...food.active.map(m=>m.lag+Math.max(m.slowDuration,s.foodModel==='GFForecast'?m.slowDuration*1.4:m.slowDuration)-m.age));
  const horizon=Math.min(900,Math.ceil(Math.max(profile.diaMinutes+60,lastMealTail+120)/STEP)*STEP);
  const horizonIncomplete=lastMealTail+120>900;
  if(horizonIncomplete)return block('HORIZON_CAPPED','Модель еды не завершает влияние в допустимом исследовательском окне');
  const baseline=[];
  for(let h=0;h<=horizon;h+=STEP){
   const pastInsulin=-s.isf*ins.active.reduce((z,e)=>z+e.units*(remaining(e.age)-remaining(e.age+h)),0);
   const foodEffect=s.isf/s.uk*food.active.reduce((z,m)=>z+m.carbs*(foodCDF(m,m.age+h,s.foodModel)-foodCDF(m,m.age,s.foodModel)),0);
   const modifierEffect=modifiers.active.reduce((z,m)=>z+modifierAt(m.curve,h),0);
   baseline.push({t:h,g:cgm.latestMmol+drift(h)+pastInsulin+foodEffect+modifierEffect,insulinPast:pastInsulin,meal:foodEffect,drift:drift(h),modifiers:modifierEffect});
  }
  const resultBase={version:VERSION,clinicalUse:false,canRecordInjection:false,canSuggestDose:false,sourceRevision:req.revision??null,meta:{foodModel:s.foodModel,engine:'RinfastEngine '+(req.rinfastEngine.ENGINE_VERSION||'0.3.0'),horizonMin:horizon,sampleMin:STEP,sourceId:cgm.sourceId,modelUncertainty:'UNQUANTIFIED'},observations:{currentMmol:round(cgm.latestMmol),targetMmol:s.target,trendMmolPerMin:round(cgm.slope,5),iobModelU:round(iob,3),cobModelG:round(cob,2),isf:s.isf,uk:s.uk,activeInjections:ins.active.length,activeMeals:food.active.length,context:{activity:context.activity||'low',illness:!!context.illness,physioApplied:!!context.physioApplied}},baseline:baseline.map(p=>({t:p.t,g:round(p.g,3)}))};
  // Actual sensor measurements MUST NEVER be used in an unvalidated numeric dose search.
  if(req.origin!=='synthetic_fixture'||req.fixtureTag!=='SYNTHETIC_TEST_ONLY')return {...resultBase,status:'READ_ONLY',code:'CLINICAL_FORMULA_NOT_VALIDATED',reasons:['Дозовая оптимизация закрыта для реальных данных до независимой проверки детской формулы.'],candidate:null,points:resultBase.baseline};
  if(!finite(s.maxDose)||s.maxDose<0||s.maxDose>20||!finite(s.step)||s.step!==0.5||Math.abs(s.maxDose/0.5-Math.round(s.maxDose/0.5))>1e-9)return block('TEST_DOSE_RANGE_INVALID','Для синтетического стенда нужен ограниченный диапазон и шаг 0,5 ЕД');
  const candidates=[],band=0.5,stability=45;
  for(let i=0;i<=Math.round(s.maxDose/s.step);i++){
   const dose=i*s.step;
   const pts=baseline.map(p=>({t:p.t,g:round(p.g-dose*s.isf*(1-remaining(p.t)),3)}));
   const min=Math.min(...pts.map(p=>p.g)),max=Math.max(...pts.map(p=>p.g));
   const entered=pts.find(p=>Math.abs(p.g-s.target)<=band)?.t??null;
   const settled=findSettled(pts,s.target,band,stability);
   const withinFloor=min>=3.9;
   const terminalError=Math.abs(pts.at(-1).g-s.target);
   candidates.push({dose,enteredAtMin:entered,settledAtMin:settled,min:round(min),max:round(max),final:pts.at(-1).g,terminalError:round(terminalError),acceptable:withinFloor&&settled!==null,points:pts});
  }
  const valid=candidates.filter(x=>x.acceptable).sort((a,b)=>a.terminalError-b.terminalError||a.settledAtMin-b.settledAtMin||a.dose-b.dose);
  const chosen=valid[0]||null;
  const previewDose=s.previewDose;
  const preview=finite(previewDose)&&previewDose>=0&&Math.abs(previewDose/s.step-Math.round(previewDose/s.step))<1e-8?candidates.find(x=>x.dose===previewDose):null;
  return {...resultBase,status:chosen?'SIMULATION_SOLUTION':'SIMULATION_NO_SOLUTION',code:chosen?'SYNTHETIC_TARGET_SETTLING':'NO_STABLE_TRAJECTORY',candidate:chosen?{dose:chosen.dose,enteredAtMin:chosen.enteredAtMin,settledAtMin:chosen.settledAtMin,finalMmol:chosen.final,minMmol:chosen.min,maxMmol:chosen.max}:null,points:preview?preview.points:(chosen?chosen.points:resultBase.baseline),manualPreview:preview?{dose:preview.dose,enteredAtMin:preview.enteredAtMin,settledAtMin:preview.settledAtMin,finalMmol:preview.final,minMmol:preview.min,acceptable:preview.acceptable}:null,candidates:candidates.map(({points,...rest})=>rest),reasons:chosen?[]:['В синтетической модели нет траектории, удовлетворяющей целевой полосе и ограничению снижения'],trace:{equation:'G(t,D)=Gnow+drift(t)+oldRinfastDelta(t)+mealDelta(t)+validatedIncrementalModifiers(t)-D*ISF*usedRinfastFraction(t)',notes:['IOB не вычитается второй раз: интеграл старых уколов уже включён в oldRinfastDelta','COB не добавляется повторно: усвоение еды считается только выбранной моделью','Базальный инсулин исключён'],modifiers:modifiers.active.map(x=>x.key),modelCalibrated:false}};
 }catch(e){return block('CALC_EXCEPTION','Сбой в изолированном расчёте: '+String(e.message||e).slice(0,150));}
}
return Object.freeze({VERSION,analyse,validateCGM,smoothCDF,linearCDF});
});
