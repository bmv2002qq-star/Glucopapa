
/* ГлюкоПапа — GFCoefficients v0.1.1, retrospective research only.
 * No treatment recommendations; no dose calculation; no parameter updates.
 * Works with read-only GFStorage role=research snapshot.
 * CommonJS + browser global GFCoefficients.
 */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GFCoefficients=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const NORMALIZER=typeof require==='function'?require('../../../shared/GFNormalizedFacts_v0.1.0.js'):globalThis.GFNormalizedFacts;
  const VERSION='0.1.2', DAY=86400000, MIN=60000, HOUR=3600000;
  const PERIODS=Object.freeze([
    Object.freeze({id:'morning',label:'Утро (06:00–11:00)',from:6,to:11}),
    Object.freeze({id:'day',label:'День (11:00–17:00)',from:11,to:17}),
    Object.freeze({id:'evening',label:'Вечер/ночь (17:00–06:00)',from:17,to:6})
  ]);
  const LIMITS=Object.freeze({days:14,cgmNeighborMinutes:12,maxGapMinutes:20,
    mealBeforeMinutes:35,mealAfterMinutes:35,mealIsolationHours:2.5,
    correctionWindowHours:4,correctionObservationHours:3});
  function fail(s){throw new Error(s);}
  const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  function text(s,max=150){if(typeof s!=='string'||!s.trim()||s.length>max)fail('Некорректный текст');return s;}
  function positive(v,max){if(!finite(v)||v<=0||v>max)fail('Недопустимое число');return v;}
  function iso(s){if(typeof s!=='string'||!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail('Требуется ISO время с часовым поясом');return s;}
  function date(s){if(typeof s!=='string'||!/^\d{4}-\d\d-\d\d$/.test(s)||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('Неверная локальная дата');return s;}
  function freezeCopy(data){const clone=JSON.parse(JSON.stringify(data));const fr=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(fr);Object.freeze(o);}return o;};return fr(clone);}
  function timeZone(value){text(value,100);try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(new Date(0));}catch(e){fail('Неверный часовой пояс');}return value;}
  const fmtCache=new Map();
  function formatter(tz){if(!fmtCache.has(tz))fmtCache.set(tz,new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}));return fmtCache.get(tz);}
  function localParts(ts,tz){const p=Object.fromEntries(formatter(tz).formatToParts(ts).filter(x=>['year','month','day','hour'].includes(x.type)).map(x=>[x.type,Number(x.value)]));return {key:[p.year,p.month,p.day].map((x,i)=>i?String(x).padStart(2,'0'):String(x)).join('-'),hour:p.hour};}
  function addDays(d,n){date(d);const ms=Date.parse(d+'T00:00:00Z')+n*DAY;return new Date(ms).toISOString().slice(0,10);}
  // Find first UTC millisecond belonging to the requested local calendar date.
  // This approach is timezone and daylight-saving aware (23/24/25 hour days).
  function localStartUtc(localDay,tz){date(localDay);timeZone(tz);const anchor=Date.parse(localDay+'T00:00:00Z');let lo=anchor-36*HOUR,hi=anchor+36*HOUR;
    while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(localParts(mid,tz).key<localDay)lo=mid+1;else hi=mid;}
    if(localParts(lo,tz).key!==localDay)fail('Не удалось определить локальные сутки');return lo;
  }
  function median(arr){if(!arr.length)return null;const a=arr.slice().sort((x,y)=>x-y),m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;}
  function rounding(n,d=2){return n===null?null:Number(n.toFixed(d));}
  function normalizeSnapshot(s){
    if(!obj(s)||![1,2,3,4,5].includes(s.schemaVersion)||!Number.isSafeInteger(s.revision)||!obj(s.profile)||!Array.isArray(s.events)||!Array.isArray(s.cgm)||!('coverage' in s))fail('Нужен снимок GFStorage research schemaVersion 1–5');
    if(!s.profile.timeZone&&(s.events.length||s.cgm.length))fail('Не указан часовой пояс: временная аналитика заблокирована');
    const tz=timeZone(s.profile.timeZone||'UTC'); // UTC is only for the completely empty demo state.
    const injections=s.events.filter(x=>x.type==='insulin_injection'&&x.status==='confirmed'&&['rinfast','levemir'].includes(x.insulinId)&&finite(x.units)&&x.units>0&&Number.isFinite(Date.parse(x.administeredAt))).map(x=>({...x,ms:Date.parse(x.administeredAt)})).sort((a,b)=>a.ms-b.ms);
    if(!NORMALIZER)fail('Не подключён единый GFNormalizedFacts');
    const reconciliation=NORMALIZER.reconcile({...s,mealSessions:Array.isArray(s.mealSessions)?s.mealSessions:[]});
    const meals=reconciliation.normalizedMeals.map(x=>({...x,ms:Date.parse(x.startedAt)})).sort((a,b)=>a.ms-b.ms);
    const readings=s.cgm.filter(x=>Number.isSafeInteger(x.ts)&&finite(x.mmol)&&x.mmol>=1.5&&x.mmol<=30&&x.kind==='observed').map(x=>({ts:x.ts,mmol:x.mmol})).sort((a,b)=>a.ts-b.ts);
    return {tz,injections,meals,readings,coverage:s.coverage,mealWarnings:reconciliation.warnings};
  }
  function parseMealAnnotations(rows){if(!Array.isArray(rows))fail('Углеводы должны быть массивом');const a=new Map();for(const row of rows){if(!obj(row))fail('Некорректная запись углеводов');
      const mealId=text(row.mealId,100);positive(row.carbsGrams,1000);
      if(!['manual_estimate','food_catalog'].includes(row.source))fail('Нужен источник количества углеводов');
      if(a.has(mealId))fail('Повтор аннотации еды');a.set(mealId,{carbsGrams:row.carbsGrams,source:row.source});
    }return a;
  }
  function parseCorrectionTags(rows){if(!Array.isArray(rows))fail('Метки событий должны быть массивом');const a=new Map();for(const row of rows){if(!obj(row))fail('Некорректная метка');const injectionId=text(row.injectionId,100);
      if(row.intent!=='correction_only'||row.userVerified!==true)fail('Допускается только явно подтверждённая метка correction_only');
      if(a.has(injectionId))fail('Повтор метки инъекции');a.set(injectionId,true);
    }return a;
  }
  function nearest(readings,t,within=LIMITS.cgmNeighborMinutes*MIN){let lo=0,hi=readings.length;while(lo<hi){const mid=(lo+hi)>>1;if(readings[mid].ts<t)lo=mid+1;else hi=mid;}
    let best=null;for(const idx of [lo-1,lo]){const x=readings[idx];if(x&&Math.abs(x.ts-t)<=within&&(!best||Math.abs(x.ts-t)<Math.abs(best.ts-t)))best=x;}return best;
  }
  function noLargeGaps(readings,start,end){let prev=null,count=0;for(const r of readings){if(r.ts<start)continue;if(r.ts>end)break;if(prev!==null&&r.ts-prev>LIMITS.maxGapMinutes*MIN)return false;prev=r.ts;count++;}return count>=2;}
  function covered(coverage,start,end){if(!coverage||coverage.confirmedComplete!==true||coverage.declaredBy!=='parent'||!Number.isFinite(Date.parse(coverage.startIso))||!Number.isFinite(Date.parse(coverage.endIso)))return false;return Date.parse(coverage.startIso)<=start&&Date.parse(coverage.endIso)>=end;}
  function period(hour){if(!Number.isInteger(hour)||hour<0||hour>23)fail('Некорректный час');return PERIODS.find(p=>p.from<p.to?(hour>=p.from&&hour<p.to):(hour>=p.from||hour<p.to));}
  function buildDays({asOf,windowDays,tz,injections,coverage}){
    const today=localParts(Date.parse(asOf),tz).key;
    const days=[];
    for(let i=windowDays;i>=1;i--){const day=addDays(today,-i),start=localStartUtc(day,tz),end=localStartUtc(addDays(day,1),tz);
      const relevant=injections.filter(x=>x.ms>=start&&x.ms<end),rapid=relevant.filter(x=>x.insulinId==='rinfast').reduce((a,b)=>a+b.units,0),basal=relevant.filter(x=>x.insulinId==='levemir').reduce((a,b)=>a+b.units,0);
      const c=covered(coverage,start,end);days.push({localDate:day,dayHours:rounding((end-start)/HOUR),recordedRapidU:rounding(rapid),recordedBasalU:rounding(basal),recordedTotalU:rounding(rapid+basal),fullyDeclared:c,usableForSummary:c,recordCount:relevant.length});
    }return days;
  }
  function categorizeExclusions(map,reason){map[reason]=(map[reason]||0)+1;}
  function buildMealObservations(meals,injections,carbs,tags,tz,asOfMs){
    const exclusions={},out=[],boluses=injections.filter(x=>x.insulinId==='rinfast'),limit=LIMITS.mealIsolationHours*HOUR;
    for(const m of meals){if(m.ms>asOfMs)continue;const a=carbs.get(m.id);
      if(!a){categorizeExclusions(exclusions,'Углеводы пока неизвестны');continue;}
      const nearMeals=meals.filter(x=>x.id!==m.id&&Math.abs(x.ms-m.ms)<limit);
      if(nearMeals.length){categorizeExclusions(exclusions,'Рядом другой приём пищи');continue;}
      const eligible=boluses.filter(x=>x.ms>=m.ms-LIMITS.mealBeforeMinutes*MIN&&x.ms<=m.ms+LIMITS.mealAfterMinutes*MIN&&!tags.has(x.id));
      if(eligible.length!==1){categorizeExclusions(exclusions,eligible.length?'Несколько близких инъекций':'Нет однозначной инъекции');continue;}
      const bolus=eligible[0];
      if(boluses.some(x=>x.id!==bolus.id&&Math.abs(x.ms-m.ms)<limit)){
        categorizeExclusions(exclusions,'Дополнительный короткий инсулин рядом');continue;
      }
      // This is ONLY a recorded meal/bolus arithmetic ratio, not a usable ICR.
      out.push({mealId:m.id,injectionId:bolus.id,localDate:localParts(m.ms,tz).key,
        period:period(localParts(m.ms,tz).hour).id,carbsGrams:rounding(a.carbsGrams),recordedUnits:rounding(bolus.units),
        observedGramsPerUnit:rounding(a.carbsGrams/bolus.units),carbsSource:a.source,clinicalValidation:false});
    }
    return {observations:out,exclusions};
  }
  function buildCorrectionObservations(meals,injections,readings,tags,tz,asOfMs){
    const exclusions={},out=[],limit=LIMITS.correctionWindowHours*HOUR;
    for(const [id] of tags){const shot=injections.find(x=>x.id===id&&x.insulinId==='rinfast');
      if(!shot){categorizeExclusions(exclusions,'Метка без подтверждённой короткой инъекции');continue;}
      if(shot.ms+LIMITS.correctionObservationHours*HOUR>asOfMs){categorizeExclusions(exclusions,'Ещё не завершилось окно наблюдения');continue;}
      if(meals.some(m=>Math.abs(m.ms-shot.ms)<limit)){categorizeExclusions(exclusions,'Еда близко к инъекции');continue;}
      if(injections.some(x=>x.id!==shot.id&&Math.abs(x.ms-shot.ms)<limit)){categorizeExclusions(exclusions,'Другая инъекция близко к событию');continue;}
      const end=shot.ms+LIMITS.correctionObservationHours*HOUR;
      const before=nearest(readings,shot.ms),after=nearest(readings,end);
      if(!before||!after||!noLargeGaps(readings,before.ts,after.ts)){categorizeExclusions(exclusions,'Пробелы CGM');continue;}
      const difference=before.mmol-after.mmol;
      out.push({injectionId:id,localDate:localParts(shot.ms,tz).key,period:period(localParts(shot.ms,tz).hour).id,
        startMmol:rounding(before.mmol),endMmol:rounding(after.mmol),observedChangeMmol:rounding(difference),
        observedChangePerUnit:rounding(difference/shot.units),recordedUnits:rounding(shot.units),clinicalValidation:false});
    }
    return {observations:out,exclusions};
  }
  function aggregateMeals(obs){return PERIODS.map(p=>{const rows=obs.filter(x=>x.period===p.id);return {period:p.id,label:p.label,events:rows.length,
    medianObservedGramsPerUnit:rounding(median(rows.map(x=>x.observedGramsPerUnit))),
    minObservedGramsPerUnit:rows.length?Math.min(...rows.map(x=>x.observedGramsPerUnit)):null,
    maxObservedGramsPerUnit:rows.length?Math.max(...rows.map(x=>x.observedGramsPerUnit)):null,
    note:'Это только соотношение записанных углеводов и ЕД, не углеводный коэффициент.'};});}
  function analyze({snapshot,mealAnnotations=[],correctionTags=[],asOfIso,windowDays=7}={}){
    if(!Number.isSafeInteger(windowDays)||windowDays<1||windowDays>LIMITS.days)fail('Период 1–14 полных суток');
    iso(asOfIso);const n=normalizeSnapshot(snapshot),asOfMs=Date.parse(asOfIso),carbs=parseMealAnnotations(mealAnnotations),tags=parseCorrectionTags(correctionTags);
    // Use actual-plate carbohydrates for confirmed GFStorage sessions unless an explicit
    // source annotation exists. Plans and unfinished sessions are never consumed meals.
    for(const m of n.meals){if(m.source==='mealSessions'&&!carbs.has(m.id)&&Number.isFinite(m.carbsGrams)&&m.carbsGrams>0)
      carbs.set(m.id,{carbsGrams:m.carbsGrams,source:m.carbsSource});}
    const first=addDays(localParts(asOfMs,n.tz).key,-windowDays),start=localStartUtc(first,n.tz);
    const selectedMeals=n.meals.filter(x=>x.ms>=start&&x.ms<=asOfMs);
    const selectedInjections=n.injections.filter(x=>x.ms>=start&&x.ms<=asOfMs);
    const selectedReadings=n.readings.filter(x=>x.ts>=start&&x.ts<=asOfMs);
    const days=buildDays({asOf:asOfIso,windowDays,tz:n.tz,injections:selectedInjections,coverage:n.coverage});
    const meals=buildMealObservations(selectedMeals,n.injections,carbs,tags,n.tz,asOfMs);
    const corrections=buildCorrectionObservations(n.meals,n.injections,n.readings,tags,n.tz,asOfMs);
    const corrected=corrections.observations.filter(x=>x.localDate>=first&&x.localDate<localParts(asOfMs,n.tz).key);
    const eligibleTdd=days.filter(x=>x.usableForSummary);
    const stats={totalDays:days.length,fullyDeclaredDays:eligibleTdd.length,
      medianRecordedTddU:eligibleTdd.length>=3?rounding(median(eligibleTdd.map(x=>x.recordedTotalU))):null,
      meanRecordedTddU:eligibleTdd.length>=3?rounding(eligibleTdd.reduce((sum,x)=>sum+x.recordedTotalU,0)/eligibleTdd.length):null,
      completeEnoughForSummary:eligibleTdd.length>=3,
      meals:selectedMeals.length,carbAnnotatedMeals:selectedMeals.filter(m=>carbs.has(m.id)).length,mealPairs:meals.observations.length,
      correctionTags:tags.size,correctionObservations:corrected.length,confirmedInjections:selectedInjections.length,
      cgmReadings:selectedReadings.length};
    const flags=n.mealWarnings.map(w=>'Неразрешённая возможная повторная запись еды: '+w.legacyId+'. Не включена повторно в итоги.');
    if(!n.coverage||n.coverage.confirmedComplete!==true)flags.push('Полнота журнала инъекций не заявлена: СДИ по неполному журналу ненадёжна.');
    else if(eligibleTdd.length<3)flags.push('Для сводки СДИ нужно хотя бы 3 полностью заявленных календарных дня.');
    if(stats.carbAnnotatedMeals<stats.meals)flags.push('Нет данных об углеводах для части блюд: модуль питания пока не подключён.');
    if([...carbs.keys()].some(id=>!n.meals.some(m=>m.id===id)))flags.push('Есть данные об углеводах с неизвестными ID приёмов пищи: сопоставление требует проверки.');
    if(stats.mealPairs<5)flags.push('Недостаточно однозначных пар еда–инъекция для устойчивого описания истории.');
    if(stats.correctionObservations<3)flags.push('Мало изолированных наблюдений после корректирующих инъекций; ФЧИ не определяется.');
    if(!stats.cgmReadings)flags.push('Нет фактических показаний CGM.');
    flags.push('Нельзя отделить действие инсулина от еды, активности, болезни и ошибок записей только по этим данным.');
    return freezeCopy({version:VERSION,sourceRevision:snapshot.revision,schemaVersion:snapshot.schemaVersion,asOfIso,windowDays,timeZone:n.tz,
      title:'Ретроспективная арифметика, не подбор терапии',statuses:{medicalUse:false,coefficientProposalCreated:false,automaticallyApplied:false},
      statistics:stats,days,mealPeriods:aggregateMeals(meals.observations),mealObservations:meals.observations,mealExclusions:meals.exclusions,
      correctionObservations:corrected,correctionExclusions:corrections.exclusions,flags,
      interpretation:{tdd:'Сумма подтверждённых записей по локальным календарным суткам при заявленной полноте журнала.',
        carbohydrate:'г/ЕД в совпавших записях еды и инъекций; НЕ индивидуальный углеводный коэффициент.',
        sensitivity:'Разность CGM до и после события / ЕД — только наблюдение; НЕ ФЧИ.',
        uncertainty:'Количественная медицинская неопределённость не оценена; никакого прогнозирования глюкозы.'}});
  }
  function createService({researchPort,clock=()=>new Date().toISOString()}={}){
    if(!researchPort||typeof researchPort.getSnapshot!=='function'||typeof researchPort.getRevision!=='function')fail('Требуется GFStorage role=research');
    const sample=researchPort.getSnapshot();normalizeSnapshot(sample);
    return Object.freeze({VERSION,run:({mealAnnotations=[],correctionTags=[],asOfIso=clock(),windowDays=7}={})=>analyze({snapshot:researchPort.getSnapshot(),mealAnnotations,correctionTags,asOfIso,windowDays}),
      sourceRevision:()=>researchPort.getRevision()});
  }
  return Object.freeze({VERSION,PERIODS,LIMITS,period,analyze,createService,localStartUtc,localParts,median});
});

