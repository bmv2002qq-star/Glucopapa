/* GFForecast Journal v0.1.2: immutable append-only research records; no GFStorage writes. */
(function(root,factory){
 'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.GFForecastJournal=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VERSION='0.1.2',MINUTE=60000,STEP=5,MAX_READINGS=20000,MAX_RECORDS=30000;
 const isNumber=n=>typeof n==='number'&&Number.isFinite(n);
 const clean=s=>typeof s==='string'&&s.length>0&&s.trim()===s;
 const clone=v=>JSON.parse(JSON.stringify(v));
 function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);Object.values(v).forEach(deepFreeze);}return v;}
 function parseIso(s){
  if(!clean(s))throw new Error('Недопустимый ISO timestamp.');
  const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?(Z|([+-])(\d\d):(\d\d))$/.exec(s);
  if(!m)throw new Error('ISO timestamp должен содержать часовой пояс.');
  const year=+m[1],month=+m[2],day=+m[3],hour=+m[4],minute=+m[5],second=+(m[6]||0),th=+(m[10]||0),tm=+(m[11]||0);
  if(hour>23||minute>59||second>59||th>14||tm>59||(th===14&&tm!==0))throw new Error('Недопустимое время или смещение.');
  const civil=new Date(0);civil.setUTCHours(0,0,0,0);civil.setUTCFullYear(year,month-1,day);
  if(civil.getUTCFullYear()!==year||civil.getUTCMonth()!==month-1||civil.getUTCDate()!==day)throw new Error('Недопустимая дата.');
  const t=Date.parse(s);if(!Number.isFinite(t))throw new Error('Некорректное время.');return t;
 }
 function verifyForecast(f){
  if(!f||f.status!=='EXPERIMENTAL'||!clean(f.version)||!clean(f.forecastAt)||!Array.isArray(f.points)||f.points.length!==25||
     f.horizonMinutes!==120||f.stepMinutes!==5||f.clinicalUse!==false||f.modelValidated!==false)
    throw new Error('Журнал принимает только полный исследовательский прогноз.');
  const now=parseIso(f.forecastAt),src=parseIso(f.sourceTime);
  if(src>now||now-src>12*MINUTE)throw new Error('Повреждено время источника прогноза.');
  if(!f.snapshot||!clean(f.snapshot.sensorSourceId)||!clean(f.snapshot.lastCgmMeasuredAt)||
     !clean(f.snapshot.lastCgmReceivedAt)||!isNumber(f.snapshot.lastCgmMmol)||!Array.isArray(f.snapshot.flags))
    throw new Error('Повреждён источник или снимок прогноза.');
  if(f.snapshot.lastCgmMmol<2||f.snapshot.lastCgmMmol>33)throw new Error('Неверная глюкоза в снимке.');
  const observed=parseIso(f.snapshot.lastCgmMeasuredAt),received=parseIso(f.snapshot.lastCgmReceivedAt);
  if(observed!==src||received<observed-MINUTE||received>now+MINUTE)throw new Error('Нарушена хронология снимка прогноза.');
  for(let i=0;i<25;i++){
   const p=f.points[i],h=i*STEP;
   if(!p||p.horizonMin!==h||parseIso(p.at)!==now+h*MINUTE||
     !isNumber(p.glucoseMmol)||p.glucoseMmol<2||p.glucoseMmol>33||
     !isNumber(p.lower)||!isNumber(p.upper)||p.lower<0||p.upper< p.lower||
     p.glucoseMmol<p.lower-0.011||p.glucoseMmol>p.upper+0.011)
     throw new Error('Повреждена точка прогнозной кривой №'+i+'.');
  }
  if(!Array.isArray(f.peaks)||f.peaks.length>10000)throw new Error('Повреждён список пиков РинФаста.');
  const ids=new Set();
  for(const peak of f.peaks){
   if(!peak||!clean(peak.id)||ids.has(peak.id)||!isNumber(peak.inMinutes)||peak.inMinutes<0||peak.inMinutes>120||
      Math.abs(parseIso(peak.at)-(now+peak.inMinutes*MINUTE))>1000)
      throw new Error('Повреждена запись пика РинФаста.');
   ids.add(peak.id);
  }
  if(!f.modelVersions||f.modelVersions.gfforecast!==f.version||
      !(clean(f.modelVersions.rinfastEngine)||(f.modelVersions.rinfastEngine===null&&
        Array.isArray(f.snapshot.rinfastInjections)&&f.snapshot.rinfastInjections.length===0)))
   throw new Error('Версия модели не подтверждена.');
 }
 function normalizeFacts(readings,asOf){
  if(!Array.isArray(readings)||readings.length>MAX_READINGS)throw new Error('Неверный массив CGM для сверки.');
  return readings.map(r=>{
   if(!r||!isNumber(r.glucoseMmol)||r.glucoseMmol<2||r.glucoseMmol>33)
    throw new Error('Повреждённая точка факта.');
   const time=parseIso(r.measuredAt),received=parseIso(r.receivedAt);
   if(received<time-MINUTE)throw new Error('Получение CGM не может значительно предшествовать измерению.');
   for(const key of ['sourceId','sensorId','patientId'])if(r[key]!==undefined&&r[key]!==null&&!clean(r[key]))
     throw new Error('Неверная идентификация CGM.');
   return {time,received,glucoseMmol:r.glucoseMmol,sourceId:r.sourceId||null,
      sensorId:r.sensorId||null,patientId:r.patientId||null};
  }).filter(r=>r.received<=asOf&&r.time<=asOf);
 }
 function pickFact(valid,target,f){
  const near=valid.filter(r=>Math.abs(r.time-target)<=2.5*MINUTE)
    .sort((a,b)=>Math.abs(a.time-target)-Math.abs(b.time-target)||a.time-b.time);
  if(!near.length)return {status:'MISSING_CGM'};
  const grouped=new Map();
  for(const r of near){
   const same=grouped.get(r.time);
   if(same&&(same.glucoseMmol!==r.glucoseMmol||same.sourceId!==r.sourceId||
      same.sensorId!==r.sensorId||same.patientId!==r.patientId))return {status:'CONFLICTING_CGM'};
   grouped.set(r.time,r);
  }
  const expected=f.snapshot;
  // In the comparison window a mixed source is a conflict, not a valid alternative.
  const verified=near.filter(r=>r.sourceId===expected.sensorSourceId&&
    (!expected.sensorId||r.sensorId===expected.sensorId)&&
    (!expected.patientId||r.patientId===expected.patientId));
  const unknown=near.some(r=>!r.sourceId||
    (expected.sensorId&&!r.sensorId)||(expected.patientId&&!r.patientId));
  const foreign=near.some(r=>r.sourceId&&r.sourceId!==expected.sensorSourceId||
    (expected.sensorId&&r.sensorId&&r.sensorId!==expected.sensorId)||
    (expected.patientId&&r.patientId&&r.patientId!==expected.patientId));
  if(verified.length && (unknown||foreign))return {status:'CONFLICTING_CGM'};
  if(!verified.length)return {status:foreign?'SOURCE_MISMATCH':'UNVERIFIED_SOURCE'};
  return {status:'MATCHED',reading:verified[0]};
 }
 function createJournal(){
  const records=new Map();
  function append(forecast){
   verifyForecast(forecast);
   const id=forecast.forecastAt+'|'+forecast.sourceTime+'|'+forecast.version;
   const payload=JSON.stringify(forecast);
   if(records.has(id)){
    if(JSON.stringify(records.get(id).forecast)!==payload)throw new Error('Конфликт: прогноз с тем же ID изменился.');
    return {id,added:false};
   }
   if(records.size>=MAX_RECORDS)throw new Error('Лимит учебного журнала; нужен порт постоянного хранения.');
   records.set(id,deepFreeze({id,recordedAt:forecast.forecastAt,forecast:clone(forecast)}));
   return {id,added:true};
  }
  function read(){return Object.freeze([...records.values()]);}
  function assess(readings,asOfIso){
   const asOf=parseIso(asOfIso),valid=normalizeFacts(readings,asOf);
   return [...records.values()].map(item=>{
    const checks=[],f=item.forecast;
    function check(target,predicted,meta){
     if(asOf<target+2.5*MINUTE)return {...meta,status:'PENDING'};
     const found=pickFact(valid,target,f);
     if(found.status!=='MATCHED')return {...meta,status:found.status};
     const actual=found.reading,error=+(actual.glucoseMmol-predicted).toFixed(2);
     return {...meta,status:'MATCHED',predictedMmol:+predicted.toFixed(2),actualMmol:actual.glucoseMmol,
      errorMmol:error,absoluteErrorMmol:+Math.abs(error).toFixed(2),
      actualMeasuredAt:new Date(actual.time).toISOString(),actualReceivedAt:new Date(actual.received).toISOString(),
      sourceId:actual.sourceId};
    }
    for(const h of [30,60,90,120]){
     const point=f.points[h/STEP];
     checks.push(check(parseIso(point.at),point.glucoseMmol,{horizonMin:h}));
    }
    const peaks=f.peaks.map(peak=>{
     const h=peak.inMinutes,left=f.points[Math.floor(h/STEP)],right=f.points[Math.min(24,Math.ceil(h/STEP))];
     const predicted=left===right?left.glucoseMmol:left.glucoseMmol+
       (right.glucoseMmol-left.glucoseMmol)*(h-left.horizonMin)/(right.horizonMin-left.horizonMin);
     return check(parseIso(peak.at),predicted,{injectionId:peak.id,at:peak.at});
    });
    return deepFreeze({forecastId:item.id,forecastAt:f.forecastAt,assessedAt:asOfIso,checks,peaks});
   });
  }
  function exportTxt(readings,asOfIso){
   const assessed=assess(readings,asOfIso),all=read();
   const lines=['ГлюкоПапа | GFForecast | Прогноз / Факт | '+VERSION,
    'Исследовательские оценки. Только анализ, не расчёт доз.',
    'CGM берётся только из GFStorage после согласованной интеграции.',''];
   for(let i=0;i<assessed.length;i++){
    const a=assessed[i],f=all[i].forecast;
    lines.push('ПРОГНОЗ '+f.forecastAt+' | модель '+f.version+' | РинФаст '+f.modelVersions.rinfastEngine,
      'Старт CGM: '+f.snapshot.lastCgmMmol+' ммоль/л, измерено '+f.snapshot.lastCgmMeasuredAt+
      ', получено '+f.snapshot.lastCgmReceivedAt+' | источник '+f.snapshot.sensorSourceId,
      'Контекст: '+JSON.stringify({flags:f.snapshot.flags,modelIsf:f.snapshot.userIsf,
       modelCarbRatio:f.snapshot.userCarbRatio,injections:f.snapshot.rinfastInjections,meals:f.snapshot.mealEvents}),
      'Время | прогноз, ммоль/л | факт, ммоль/л | разница (факт минус прогноз), ммоль/л | статус');
    a.checks.forEach(c=>lines.push('+'+c.horizonMin+' мин | '+(c.predictedMmol??'—')+' | '+
      (c.actualMmol??'—')+' | '+(c.errorMmol??'—')+' | '+c.status));
    a.peaks.forEach(p=>lines.push('Пик РинФаста '+p.injectionId+' | '+(p.predictedMmol??'—')+' | '+
      (p.actualMmol??'—')+' | '+(p.errorMmol??'—')+' | '+p.status));
    lines.push('');
   }return lines.join('\n');
  }
  function prepareEvents(readings,asOfIso){
   return {schema:'gfforecast.research-events/1',writerRequired:true,
    forecasts:read().map(r=>clone({id:r.id,kind:'research_forecast',payload:r.forecast})),
    assessments:assess(readings,asOfIso).map(r=>clone({id:r.forecastId+'|'+asOfIso,
      kind:'research_forecast_assessment',payload:r}))};
  }
  return Object.freeze({VERSION,append,read,assess,exportTxt,prepareEvents});
 }
 return Object.freeze({VERSION,createJournal});
});
