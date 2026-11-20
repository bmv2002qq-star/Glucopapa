
/* ГлюкоПапа GFForecast v0.1.2 — исследовательский автономный модуль.
 * Copyright (c) 2026. No external dependencies. MIT.
 * Requires the approved RinfastEngine injected by the caller; never modifies it.
 * Experimental physiological prediction ONLY. No calibrated treatment choice.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GFForecastHypo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '0.3.0-hypo', STEP_MIN = 5, HORIZON_MIN = 120;
  const MS = 60000;
  const clean = s => typeof s === 'string' && s.trim().length > 0;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const fail = (code, reason, context={}) => Object.freeze({
    version:VERSION, status:'UNAVAILABLE', code, reason, points:[], peaks:[], context,
    modelValidated:false, clinicalUse:false
  });
  // Reject impossible civil dates and UTC offsets; Date.parse alone normalizes e.g. Nov 31.
  function parseIso(s) {
    if (!clean(s)) throw new Error('Нужна дата ISO 8601 с часовым поясом.');
    const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?(Z|([+-])(\d\d):(\d\d))$/.exec(s);
    if(!m)throw new Error('Некорректный формат ISO 8601.');
    const y=+m[1],mo=+m[2],day=+m[3],hour=+m[4],minute=+m[5],sec=+(m[6]||0);
    const tzHour=+(m[10]||0),tzMinute=+(m[11]||0);
    if(hour>23||minute>59||sec>59||tzHour>14||tzMinute>59||(tzHour===14&&tzMinute!==0))
      throw new Error('Недопустимое время или смещение UTC.');
    const civil=new Date(0);
    civil.setUTCHours(0,0,0,0);civil.setUTCFullYear(y,mo-1,day);
    if(civil.getUTCFullYear()!==y||civil.getUTCMonth()!==mo-1||civil.getUTCDate()!==day)
      throw new Error('Недопустимая календарная дата.');
    const t=Date.parse(s);
    if (!Number.isFinite(t)) throw new Error('Некорректная дата ISO.');
    return t;
  }
  const median = arr => {
    if (!arr.length) throw new Error('Нет значений для медианы');
    const a=[...arr].sort((x,y)=>x-y);const m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  };
  const round = (v,d=3) => +v.toFixed(d);
  function normalizedReadings(rows,now) {
    if (!Array.isArray(rows)||rows.length>20000) throw new Error('Неверный массив CGM.');
    const byTime=new Map();
    for (const r of rows) {
      if (!r||!finite(r.glucoseMmol)||r.glucoseMmol<2||r.glucoseMmol>33)
        throw new Error('Недостоверное числовое значение CGM.');
      for(const key of ['sourceId','sensorId','patientId']){
        if(r[key]!==undefined&&r[key]!==null&&(!clean(r[key])||r[key].trim()!==r[key]))
          throw new Error('Неверные метаданные источника CGM.');
      }
      const t=parseIso(r.measuredAt), received=parseIso(r.receivedAt);
      if (received<t-60000||received>now+60000||t>now)
        throw new Error('Неверная хронология измерения/получения CGM.');
      if (byTime.has(t)) {
        const prior=byTime.get(t);
        if (prior.glucoseMmol!==r.glucoseMmol||prior.sourceId!==(r.sourceId||null)||prior.sensorId!==(r.sensorId||null)||prior.patientId!==(r.patientId||null))
          throw new Error('Противоречащие значения или источники CGM в одно время.');
        // Keep earliest valid receipt; duplicate retries are idempotent.
        prior.received=Math.min(prior.received,received);
        continue;
      }
      byTime.set(t,{t,received,glucoseMmol:r.glucoseMmol,sourceId:r.sourceId||null,sensorId:r.sensorId||null,patientId:r.patientId||null});
    }
    return [...byTime.values()].filter(x=>x.t<=now).sort((a,b)=>a.t-b.t);
  }
  function currentTrend(rows) {
    const last=rows.at(-1), recent=rows.filter(r=>last.t-r.t<=25*MS);
    if (recent.length<4) throw new Error('Для тренда нужно минимум четыре CGM-точки за последние 25 минут.');
    const slopes=[];
    for(let i=0;i<recent.length;i++)for(let j=i+1;j<recent.length;j++){
      const dt=(recent[j].t-recent[i].t)/MS;
      if(dt>=4)slopes.push((recent[j].glucoseMmol-recent[i].glucoseMmol)/dt);
    }
    if(slopes.length<3)throw new Error('Недостаточно временного интервала для тренда.');
    for(let j=1;j<recent.length;j++)if(recent[j].t-recent[j-1].t>10*MS)
      throw new Error('Большой пропуск в последних CGM-измерениях.');
    // The short trusted window spans all readings used to establish the baseline/trend.
    // Older history may belong to a legitimately replaced sensor and is not pooled.
    const trusted=rows.filter(r=>last.t-r.t<=40*MS);
    const recentSourceIds=trusted.map(r=>r.sourceId);
    if(recentSourceIds.some(id=>!clean(id))||new Set(recentSourceIds).size!==1)
      throw new Error('Нужен один подтверждённый источник CGM в рабочем временном окне.');
    for(const key of ['sensorId','patientId']){
      const known=trusted.map(r=>r[key]).filter(x=>x!==null);
      if(known.length&& (known.length!==trusted.length||new Set(known).size!==1))
        throw new Error('Несовместимые идентификаторы датчика/профиля CGM.');
    }
    // Independent last-point consistency test: a robust global trend must NOT
    // legitimize a single isolated spike when the baseline is otherwise smooth.
    const before=recent.slice(0,-1);
    if(before.length>=3){
      const prev=before.at(-1),dtLast=(last.t-prev.t)/MS;
      const prevSlopes=[];
      for(let i=0;i<before.length;i++)for(let j=i+1;j<before.length;j++){
        const dt=(before[j].t-before[i].t)/MS;
        if(dt>=4)prevSlopes.push((before[j].glucoseMmol-before[i].glucoseMmol)/dt);
      }
      if(prevSlopes.length>=3){
        const baselineSlope=median(prevSlopes),expected=prev.glucoseMmol+baselineSlope*dtLast;
        const residuals=before.map(p=>p.glucoseMmol-(prev.glucoseMmol+baselineSlope*(p.t-prev.t)/MS));
        const baselineScatter=median(residuals.map(x=>Math.abs(x-median(residuals))));
        // Conservative fail-closed threshold, not a physiologic absolute bound.
        const tolerance=Math.max(1.25,0.22*dtLast+4*baselineScatter);
        if(Math.abs(last.glucoseMmol-expected)>tolerance)
          throw new Error('Последняя точка CGM резко расходится с предыдущим трендом: нужен следующий замер.');
      }
    }
    const slope=median(slopes);
    if(Math.abs(slope)>0.22)throw new Error('Слишком быстрые изменения CGM для данной модели.');
    const offsets=recent.map(r=>r.glucoseMmol-slope*(r.t-last.t)/MS);
    const scatter=median(offsets.map(v=>Math.abs(v-median(offsets))));
    if(scatter>0.9)throw new Error('Слишком шумные измерения CGM.');
    return {slope,scatter,pointCount:recent.length};
  }
  function profileInsulin(injections,now,engine,isf) {
    if(!Array.isArray(injections)||injections.length>10000)throw new Error('Неверный журнал инъекций.');
    const ids=new Set(), accepted=[], peaks=[];
    for(const e of injections){
      if(!e||!clean(e.id)||ids.has(e.id))throw new Error('Повторяющаяся или неполная инъекция.');
      ids.add(e.id);
      if(!['rinfast','levemir'].includes(e.insulinId))throw new Error('Неизвестный тип инсулина.');
      if(e.status!=='confirmed')throw new Error('Запланированная или неподтверждённая инъекция.');
      const time=parseIso(e.administeredAt);
      if(time>now)throw new Error('Инъекция находится в будущем.');
      if(!finite(e.units)||e.units<=0||e.units>100)throw new Error('Неверное количество единиц в журнале.');
      if(e.insulinId==='levemir')continue; // Background; not double-counted as another correction.
      if(!engine||typeof engine.getCurve!=='function'||!engine.DEFAULT_PROFILE)
        throw new Error('Отсутствует утверждённый движок РинФаста.');
      const profile=engine.DEFAULT_PROFILE;
      const age=(now-time)/MS;
      if(age>=profile.diaMinutes)continue;
      const peakTime=time+profile.peakMinutes*MS;
      if(peakTime>now && peakTime<=now+HORIZON_MIN*MS)
        peaks.push({id:e.id,at:new Date(peakTime).toISOString(),inMinutes:round((peakTime-now)/MS,2)});
      accepted.push({id:e.id,units:e.units,age,time});
    }
    if(accepted.length && (!finite(isf)||isf<=0||isf>30))throw new Error('Нет действительного заданного пользователем ФЧИ.');
    // 0 * undefined is NaN in JavaScript. Without active short insulin, effect is exactly zero.
    function derivative(){if(!accepted.length)return 0;return -accepted.reduce((s,e)=>s+e.units*engine.getCurve(e.age).activityFractionPerMinute,0)*isf;}
    function delta(h){if(!accepted.length)return 0;return -accepted.reduce((s,e)=>s+e.units*
      (engine.getCurve(e.age).remainingFraction-engine.getCurve(e.age+h).remainingFraction),0)*isf;}
    return {delta,derivative,peaks,used:accepted.map(x=>x.id)};
  }
  // Deliberately simplified experimental meal response, not physiological COB.
  function profileMeals(meals,now,ratio,isf,mealTauMin) {
    if(!Array.isArray(meals)||meals.length>10000)throw new Error('Неверный журнал еды.');
    const ids=new Set(), accepted=[];
    for(const e of meals){
      if(!e||!clean(e.id)||ids.has(e.id))throw new Error('Повторяющаяся или неполная еда.');
      ids.add(e.id);
      if(e.status!=='confirmed')throw new Error('Еда не подтверждена.');
      const t=parseIso(e.eatenAt);
      if(t>now)throw new Error('Еда находится в будущем.');
      if(!finite(e.carbsG)||e.carbsG<0||e.carbsG>500)throw new Error('Недостоверное количество углеводов.');
      if((now-t)/MS>360||e.carbsG===0)continue;
      accepted.push({id:e.id,carbsG:e.carbsG,age:(now-t)/MS,tau:e.absorptionTauMin??mealTauMin});
    }
    if(accepted.length&&(!finite(ratio)||ratio<=0||ratio>200||!finite(isf)||isf<=0||isf>30))
      throw new Error('Для модели еды нужны заданные пользователем УК и ФЧИ.');
    for(const e of accepted)if(!finite(e.tau)||e.tau<20||e.tau>240)
      throw new Error('Для каждой еды необходимо подтверждённое время усвоения от 20 до 240 мин (модельный параметр).');
    const F=(age,tau)=>age<=0?0:1-(1+age/tau)*Math.exp(-age/tau);
    const Fd=(age,tau)=>age<=0?0:age/(tau*tau)*Math.exp(-age/tau);
    const potential=e=>e.carbsG/ratio*isf;
    return {
      delta:h=>accepted.reduce((s,e)=>s+potential(e)*(F(e.age+h,e.tau)-F(e.age,e.tau)),0),
      derivative:()=>accepted.reduce((s,e)=>s+potential(e)*Fd(e.age,e.tau),0),
      used:accepted.map(e=>e.id),tau:mealTauMin??null
    };
  }
  function predict(request) {
    try {
      if(!request||typeof request!=='object')return fail('BAD_REQUEST','Нет входного снимка.');
      const now=parseIso(request.nowIso);
      if(request.sourceIsComplete!==true)
        return fail('INCOMPLETE_HISTORY','Не подтверждена полнота истории инсулина и еды.',{flags:['history_completeness_unverified']});
      const readings=normalizedReadings(request.readings,now);
      if(!readings.length)return fail('NO_CGM','Нет достоверных данных CGM.');
      const last=readings.at(-1), age=(now-last.t)/MS;
      if(age>12)return fail('STALE_CGM','Последнее измерение старше 12 минут.',{lastMeasuredAt:new Date(last.t).toISOString()});
      // Hypo research: retain all input-integrity gates; do not block low CGM by value alone.
      const current=currentTrend(readings);
      const settings=request.settings||{};
      const engine=request.rinfastEngine;
      const insulin=profileInsulin(request.injections||[],now,engine,settings.isfMmolPerUnit);
      const meals=profileMeals(request.meals||[],now,settings.carbRatioGPerUnit,settings.isfMmolPerUnit,settings.mealTauMin);
      const obsSlope=current.slope;
      // Current CGM trend already includes earlier insulin/food effects.
      // Subtract their instantaneous model derivatives BEFORE forecasting future contributions.
      const residualRaw=obsSlope-insulin.derivative()-meals.derivative();
      if(Math.abs(residualRaw)>0.28)
        return fail('UNSTABLE_RESIDUAL','Расхождение модели с наблюдаемым трендом слишком велико.');
      const residual=Math.max(-0.18,Math.min(0.18,residualRaw));
      const decay=35;
      const predictedNow=last.glucoseMmol+Math.max(0,age)*obsSlope;
      const transmittedDelay=Math.max(0,(last.received-last.t)/MS);
      const flags=[];
      if(last.glucoseMmol<=3.9)flags.push('low_glucose_research');
      if(request.conditions?.illness)flags.push('illness_unmodeled');
      if(request.conditions?.activity)flags.push('activity_unmodeled');
      if(Math.abs(obsSlope)>0.12)flags.push('rapid_cgm_trend');
      if(transmittedDelay>5)flags.push('transport_delay');
      const points=[];
      for(let h=0;h<=HORIZON_MIN;h+=STEP_MIN){
        const drift=residual*decay*(1-Math.exp(-h/decay));
        const value=predictedNow+drift+insulin.delta(h)+meals.delta(h);
        if(!finite(value)||value<2||value>33)return fail('MODEL_OUT_OF_RANGE','Расчёт выходит за допустимые границы иллюстрационной модели.');
        // Heuristic illustration, NOT a confidence interval or clinically calibrated band.
        const spread=0.5+0.014*h+0.24*Math.abs(obsSlope)*h+
          0.015*Math.min(transmittedDelay,20)+0.02*Math.min(age,12)+
          current.scatter+10*Math.abs(obsSlope)+(flags.includes('illness_unmodeled')||flags.includes('activity_unmodeled')?0.7:0);
        points.push(Object.freeze({horizonMin:h,at:new Date(now+h*MS).toISOString(),
          glucoseMmol:round(value,2),lower:round(Math.max(0,value-spread),2),upper:round(value+spread,2)}));
      }
      const snapshot={lastCgmMmol:last.glucoseMmol,lastCgmMeasuredAt:new Date(last.t).toISOString(),
        lastCgmReceivedAt:new Date(last.received).toISOString(),measuredAgeMin:round(age),
        transportDelayMin:round(transmittedDelay),observedSlopeMmolPerMin:round(obsSlope,5),
        residualSlopeMmolPerMin:round(residual,5),lastReadingsUsed:current.pointCount,sensorSourceId:last.sourceId,sensorId:last.sensorId,patientId:last.patientId,
        physiologicalLagShiftAppliedMinutes:0,lagBandRule:'uncalibrated_slope_times_10_min',
        baselineMmol:round(predictedNow,2),rinfastInjections:insulin.used,mealEvents:meals.used,
        userIsf:finite(settings.isfMmolPerUnit)?settings.isfMmolPerUnit:null,
        userCarbRatio:finite(settings.carbRatioGPerUnit)?settings.carbRatioGPerUnit:null,
        mealTauMin:meals.tau,flags};
      return Object.freeze({version:VERSION,mode:'HYPO_RESEARCH_FORECAST',status:'EXPERIMENTAL',
        forecastAt:request.nowIso,sourceTime:new Date(last.t).toISOString(),
        horizonMinutes:HORIZON_MIN,stepMinutes:STEP_MIN,points,peaks:insulin.peaks,
        snapshot:Object.freeze(snapshot),modelVersions:{gfforecast:VERSION,rinfastEngine:engine?.ENGINE_VERSION||null},
        uncertainty:'UNCALIBRATED_HEURISTIC_RANGE',modelValidated:false,clinicalUse:false,
        instructions:'Не использовать для расчёта или изменения инсулина и еды.'});
    } catch(e) {return fail('INVALID_OR_INCOMPLETE_INPUT',String(e.message||e));}
  }
  return Object.freeze({VERSION,HORIZON_MIN,STEP_MIN,predict});
});

