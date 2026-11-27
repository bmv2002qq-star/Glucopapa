/* ГлюкоПапа V2 · GFInjectionAnalytics v0.2.1-history-only
 * Read-only, deterministic retrospective analysis of confirmed RinFast/meals.
 * No drug kinetics, no forward glucose model, no dose or injection-time recommendation.
 * Single source of truth: GFStorage; no autonomous persistence or cross-module calls.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GFInjectionAnalyticsV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '0.2.1-history-only';
  const DAY = 86400000, MIN = 60000;
  const HISTORY_MONTHS = 6, MIN_HISTORY_DAYS = 3, MIN_MATCHES = 4, MIN_UNIQUE_DAYS = 3;
  const MAX_EVENTS = 50000, MAX_CGM = 500000;
  const MSG = 'Недостаточно данных для определения времени между уколом и началом еды.';
  const SLOTS = Object.freeze([
    Object.freeze({id:'night',start:0,end:360,title:'Ночь'}),
    Object.freeze({id:'morning',start:360,end:720,title:'Утро'}),
    Object.freeze({id:'day',start:720,end:1080,title:'День'}),
    Object.freeze({id:'evening',start:1080,end:1440,title:'Вечер'})
  ]);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const validTime = x => {
    if (typeof x === 'number') return Number.isSafeInteger(x) && Math.abs(x) <= 8.64e15 ? x : NaN;
    if (typeof x !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(x)) return NaN;
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : NaN;
  };
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const median = a => quantile(a,.5);
  function quantile(a,p) { if (!a.length) return null; const v=a.slice().sort((x,y)=>x-y); const h=(v.length-1)*p, i=Math.floor(h),j=Math.ceil(h); return v[i]+(v[j]-v[i])*(h-i); }
  const rounded = x => x===null||!finite(x)?null:Math.round(x*10)/10;
  function weightedMedian(pairs) {
    if(!pairs.length)return null;
    const sorted=pairs.slice().sort((a,b)=>a.value-b.value),total=sorted.reduce((sum,x)=>sum+x.weight,0);
    if(!(total>0))return null;
    let accrued=0;
    for(const x of sorted){accrued+=x.weight;if(accrued>=total/2)return x.value;}
    return sorted.at(-1).value;
  }
  function deepFreeze(x) { if (x && typeof x==='object' && !Object.isFrozen(x)) {Object.values(x).forEach(deepFreeze);Object.freeze(x);}return x; }
  function shiftedMonths(utcMs, months) {
    const d=new Date(utcMs), day=d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+months);
    const y=d.getUTCFullYear(),m=d.getUTCMonth(),days=new Date(Date.UTC(y,m+1,0)).getUTCDate();d.setUTCDate(Math.min(day,days));return d.valueOf();
  }
  function slotFor(timeMs, zone) {
    if (!Number.isFinite(timeMs)||typeof zone!=='string'||!zone.trim()) return null;
    try {
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(timeMs);
      const h=Number(parts.find(p=>p.type==='hour').value),m=Number(parts.find(p=>p.type==='minute').value),v=h*60+m;
      return SLOTS.find(x=>v>=x.start&&v<x.end)?.id||null;
    } catch { return null; }
  }
  function dayFor(timeMs,zone) {
    try {return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timeMs));}
    catch {return null;}
  }
  function normalizePlate(p) {
    if (!p || p.schema!=='GFPlate.v1' || !Array.isArray(p.items) || !p.totals || !p.items.length) return null;
    const sum={carbs:0,fat:0,protein:0,kcal:0};let grams=0, allGrams=true,giSum=0,giCarbs=0,unknownGI=false;
    for(const it of p.items) {
      if (!it||!['carbs','fat','protein','kcal'].every(k=>finite(it[k])&&it[k]>=0)) return null;
      for (const k of Object.keys(sum))sum[k]+=it[k];
      if (it.unit==='г' && finite(it.amount) && it.amount>0) grams+=it.amount;
      else allGrams=false;
      if (it.carbs>0.05) {
        if (finite(it.glycemicIndex) && it.glycemicIndex>=0 && it.glycemicIndex<=100 && it.glycemicIndexStatus!=='unknown') {
          giSum+=it.carbs*it.glycemicIndex;giCarbs+=it.carbs;
        } else unknownGI=true;
      }
    }
    if (!['carbs','fat','protein','kcal'].every(k=>finite(p.totals[k])&&Math.abs(p.totals[k]-sum[k])<=0.1+0.01*p.items.length)) return null;
    const gi=!unknownGI&&giCarbs>0?giSum/giCarbs:null;
    const density=allGrams&&grams>0?Object.fromEntries(['carbs','fat','protein'].map(k=>[k,100*sum[k]/grams])):null;
    return {totals:sum,grams:allGrams?grams:null,density,gi,giClass:gi===null?'unknown':gi<=55?'slow':gi<70?'standard':'fast',
      estimated:p.containsEstimatedValues===true, itemsCount:p.items.length};
  }
  function normalizeCGM(rows,meta,asOf) {
    if(!Array.isArray(rows)||rows.length>MAX_CGM) throw Error('CGM_ROWS_INVALID');
    const source=meta&&typeof meta.sourceDeviceId==='string'?meta.sourceDeviceId:null;
    const byTs=new Map(),invalid=new Set();
    for(const x of rows) {
      if(!x)continue;
      const ts=validTime(x.ts);if(!finite(ts)||ts>asOf)continue;
      if(source && x.sourceDeviceId!==source) {invalid.add(ts);continue;}
      if(x.kind!==undefined && x.kind!=='observed') {invalid.add(ts);continue;}
      if(x.valid===false||x.qualityFlag==='invalid'||x.staleAtReceipt===true||!finite(x.mmol)||x.mmol<1.5||x.mmol>30) {invalid.add(ts);continue;}
      if(byTs.has(ts) && byTs.get(ts)!==x.mmol) {invalid.add(ts);continue;}
      byTs.set(ts,x.mmol);
    }
    for(const ts of invalid)byTs.delete(ts);
    return [...byTs].sort((a,b)=>a[0]-b[0]).map(([ts,mmol])=>({ts,mmol}));
  }
  function lowerBound(rows,t){let lo=0,hi=rows.length;while(lo<hi){const m=(lo+hi)>>1;if(rows[m].ts<t)lo=m+1;else hi=m;}return lo;}
  function near(rows,t,maxAgeMin=12){const i=lowerBound(rows,t+1)-1;return i>=0&&t-rows[i].ts<=maxAgeMin*MIN?rows[i]:null;}
  function segment(rows,from,to){return rows.slice(lowerBound(rows,from),lowerBound(rows,to+1));}
  function slope(points){if(points.length<3)return null;const base=points[0].ts;let sx=0,sy=0,sxx=0,sxy=0,n=points.length;for(const p of points){const x=(p.ts-base)/MIN;sx+=x;sy+=p.mmol;sxx+=x*x;sxy+=x*p.mmol;}const den=n*sxx-sx*sx;return den?((n*sxy-sx*sy)/den):null;}
  function observedContext(rows,t) {
    const p=near(rows,t,12),before=segment(rows,t-20*MIN,t);
    if(!p||before.length<3) return null;
    const rate=slope(before);
    if(rate===null)return null;
    return {glucose:p.mmol,slope:rate,trend:rate>=0.015?'rising':rate<=-0.015?'falling':'flat'};
  }
  function cgmOutcome(rows,injectionMs,mealMs,asOf) {
    const end=mealMs+180*MIN;
    if(end>asOf) return {ok:false,reason:'observation_not_finished'};
    const baseline=observedContext(rows,injectionMs),atMeal=near(rows,mealMs,12);
    if(!baseline||!atMeal)return {ok:false,reason:'baseline_or_meal_cgm_missing'};
    const points=segment(rows,mealMs,end);
    if(points.length<2||points.at(-1).ts<end-12*MIN||points[0].ts>mealMs+12*MIN)
      return {ok:false,reason:'cgm_coverage_missing'};
    const gaps=[];for(let i=1;i<points.length;i++)gaps.push((points[i].ts-points[i-1].ts)/MIN);
    const observedCadence=median(gaps);
    if(!finite(observedCadence)||observedCadence<1||observedCadence>10 ||
       points.length<Math.floor(175/observedCadence*.8))return {ok:false,reason:'cgm_cadence_or_coverage_missing'};
    if(Math.max(...gaps)>15) return {ok:false,reason:'cgm_gap'};
    const values=points.map(x=>x.mmol);const min=Math.min(...values),max=Math.max(...values);
    if(baseline.glucose<3.9||atMeal.mmol<3.9)return {ok:false,reason:'low_glucose_context'};
    const end120=near(rows,mealMs+120*MIN,12);
    return {ok:true,baseline,atMeal:atMeal.mmol,min,max,low:min<3.9,
      excursionUp:rounded(max-atMeal.mmol),excursionDown:rounded(atMeal.mmol-min),
      at120:end120?end120.mmol:null};
  }
  function correctionDecline(rows,shotMs,asOf){
    if(shotMs+150*MIN>asOf)return null;
    const base=observedContext(rows,shotMs);if(!base||base.slope<-.012)return null;
    const points=segment(rows,shotMs,shotMs+150*MIN);
    if(points.length<15)return null;
    for(let i=1;i<points.length;i++)if(points[i].ts-points[i-1].ts>15*MIN)return null;
    for(let i=0;i<points.length;i++){
      const dt=(points[i].ts-shotMs)/MIN;
      if(dt<15)continue;
      const win=segment(points,points[i].ts-20*MIN,points[i].ts);
      const s=slope(win);
      if(win.length>=3 && win.at(-1).ts-win[0].ts>=14*MIN && s!==null && s<-.015 && points[i].mmol<=base.glucose-.35)
        return {observedDeclineAtMin:Math.round(dt/5)*5,cgmResolutionMin:median(points.slice(1).map((p,j)=>(p.ts-points[j].ts)/MIN))};
    }
    return null;
  }
  function completedSportAt(periods,ts){
    return Array.isArray(periods) && periods.some(p=>p?.kind==='sport' && finite(validTime(p.start)) &&
      finite(validTime(p.end)) && validTime(p.start)<=ts && ts<validTime(p.end));
  }
  function canonicalContext(raw) {
    const ctx=raw&&typeof raw==='object'?raw:{};
    return {
      activity:['low','usual','high','sport'].includes(ctx.activity)?ctx.activity:null,
      iobU:finite(ctx.iobU)&&ctx.iobU>=0?ctx.iobU:null,
      cobG:finite(ctx.cobG)&&ctx.cobG>=0?ctx.cobG:null,
      settingRevision:typeof ctx.settingRevision==='string'||Number.isSafeInteger(ctx.settingRevision)?String(ctx.settingRevision):null,
      site:typeof ctx.site==='string'?ctx.site:null,
      plannedDoseU:finite(ctx.plannedDoseU)&&ctx.plannedDoseU>=0?ctx.plannedDoseU:null
    };
  }
  function buildIndex(snapshot, opts={}) {
    return buildVerifiedIndex(snapshot, opts);
  }

  function buildVerifiedIndex(snapshot, opts, verifiedQ09Rows) {
    const asOf=validTime(opts.asOf??Date.now());if(!finite(asOf))throw Error('AS_OF_INVALID');
    if(!snapshot||!Array.isArray(snapshot.events)||!Array.isArray(snapshot.mealSessions)||!Array.isArray(snapshot.cgm))throw Error('GFSTORAGE_SNAPSHOT_INCOMPLETE');
    if(snapshot.events.length>MAX_EVENTS)throw Error('EVENT_LIMIT');
    const zone=snapshot.profile&&snapshot.profile.timeZone;
    if(!slotFor(asOf,zone)) return deepFreeze({version:VERSION,status:'TIMEZONE_UNKNOWN',revision:snapshot.revision,meals:[],corrections:[],rejected:{timezone_unknown:1}});
    const boundary=shiftedMonths(asOf,-HISTORY_MONTHS);
    if(!snapshot.cgmMetadata||typeof snapshot.cgmMetadata.sourceDeviceId!=='string'||
       !['xdrip_local','synthetic','device_recorded'].includes(snapshot.cgmMetadata.sourceType))
      return deepFreeze({version:VERSION,status:'CGM_PROVENANCE_UNKNOWN',revision:snapshot.revision,meals:[],corrections:[],rejected:{cgm_provenance_missing:1}});
    const meta=snapshot.cgmMetadata;
    if(meta.sourceType==='synthetic')
      return deepFreeze({version:VERSION,status:'CGM_SOURCE_SYNTHETIC',revision:snapshot.revision,meals:[],corrections:[],rejected:{synthetic_source:1}});
    if((meta.sourceType==='xdrip_local'&&meta.sourceDeviceId!=='xdrip-local-provider' &&
        !(meta.sourceDeviceId==='xdrip-local-follower' && snapshot.cgm===verifiedQ09Rows)) ||
       (meta.sourceType==='device_recorded'&&(![5,10].includes(meta.samplingMinutes)||!finite(meta.qualityScore)||meta.qualityScore<.8)))
      return deepFreeze({version:VERSION,status:'CGM_PROVENANCE_UNVERIFIED',revision:snapshot.revision,meals:[],corrections:[],rejected:{cgm_provenance_unverified:1}});
    const cgm=normalizeCGM(snapshot.cgm,snapshot.cgmMetadata,asOf);
    const events=snapshot.events.filter(e=>e&&e.type==='insulin_injection'&&e.insulinId==='rinfast'&&e.status==='confirmed'&&finite(validTime(e.administeredAt)))
      .sort((a,b)=>validTime(a.administeredAt)-validTime(b.administeredAt));
    const byId=new Map(),duplicates=new Set();for(const e of events){if(byId.has(e.id))duplicates.add(e.id);byId.set(e.id,e);}
    const shots=events.filter(e=>!duplicates.has(e.id));
    const sessions=new Map(snapshot.mealSessions.map(s=>[s.id,s]));
    const linked=new Set(),meals=[],corrections=[],rejected={};
    const reject=why=>{rejected[why]=(rejected[why]||0)+1;};
    for(const session of sessions.values()) {
      if(!session||!Array.isArray(session.injectionIds)||!session.injectionIds.length)continue;
      for(const x of session.injectionIds)linked.add(x);
      const shotCandidates=session.injectionIds.map(id=>byId.get(id)).filter(s=>s&&s.insulinId==='rinfast'&&!duplicates.has(s.id));
      if(shotCandidates.length!==1) {reject('ambiguous_meal_injections');continue;}
      const shot=shotCandidates[0],t=validTime(shot.administeredAt),mealTime=validTime(session.startedAt),plate=normalizePlate(session.actualPlate);
      if(t<boundary||t>asOf) {reject('outside_history');continue;}
      if(!finite(mealTime)||!plate) {reject('actual_meal_unconfirmed');continue;}
      if(mealTime>asOf||mealTime-t<-60*MIN||mealTime-t>180*MIN) {reject('meal_time_mismatch');continue;}
      const slot=slotFor(mealTime,zone);if(!slot) {reject('slot_unknown');continue;}
      if(!finite(shot.units)||shot.units<=0) {reject('invalid_units');continue;}
      if(shot.injectionContext?.mealGroup!=='with_meal') {reject('not_a_meal_bolus');continue;}
      const futureShot=shots.some(e=>e.id!==shot.id&&validTime(e.administeredAt)>t&&validTime(e.administeredAt)<=mealTime+180*MIN);
      if(futureShot) {reject('overlapping_future_injection');continue;}
      const quality=cgmOutcome(cgm,t,mealTime,asOf);
      if(!quality.ok){reject(quality.reason);continue;}
      const context=canonicalContext(shot.injectionContext);
      if(completedSportAt(snapshot.conditionPeriods,t))context.activity='sport';
      if(!context.activity||context.iobU===null) {reject('injection_context_missing');continue;}
      // Preserve verified activity only; unrelated condition fields are never read or indexed.
      meals.push({id:String(session.id),shotId:String(shot.id),at:mealTime,slot,lagMin:(mealTime-t)/MIN,
        plate,context,site:shot.injectionSite?.region||null,units:shot.units,quality});
    }
    for(const shot of shots){
      const t=validTime(shot.administeredAt);if(t<boundary||t>asOf||linked.has(shot.id))continue;
      if(shot.injectionContext?.mealGroup!=='without_meal'||shot.injectionContext?.carbsG>5)continue;
      if(shots.some(e=>e.id!==shot.id&&Math.abs(validTime(e.administeredAt)-t)<=300*MIN))continue;
      const context=canonicalContext(shot.injectionContext),decline=correctionDecline(cgm,t,asOf);
      if(completedSportAt(snapshot.conditionPeriods,t))context.activity='sport';
      if(!decline)continue;
      corrections.push({id:String(shot.id),at:t,slot:slotFor(t,zone),context,site:shot.injectionSite?.region||null,
        units:shot.units, ...decline});
    }
    return deepFreeze({version:VERSION,status:'READY',revision:snapshot.revision,windowMonths:HISTORY_MONTHS,
      windowStart:new Date(boundary).toISOString(),asOf:new Date(asOf).toISOString(),timeZone:zone,
      cgmCount:cgm.length,meals,corrections,rejected});
  }
  function difference(a,b,normalizer){return Math.abs(a-b)/Math.max(normalizer,Math.abs(a),Math.abs(b));}
  function plateSimilarity(q,h){
    const a=q.totals,b=h.totals;
    const totalCarb=difference(a.carbs,b.carbs,12),fat=difference(a.fat,b.fat,8),protein=difference(a.protein,b.protein,10);
    const density=q.density&&h.density?difference(q.density.carbs,h.density.carbs,8):.65;
    const carb=.7*totalCarb+.3*density;
    const fatShape=q.density&&h.density?difference(q.density.fat,h.density.fat,5):.65;
    const gi=q.gi===null||h.gi===null?.65:Math.abs(q.gi-h.gi)/100;
    const proteinShape=q.density&&h.density?difference(q.density.protein,h.density.protein,6):.65;
    return {carb, fat:.65*fat+.35*fatShape, gi,protein:.65*protein+.35*proteinShape,
      penalty:(q.estimated||h.estimated)?.13:0};
  }
  function compare(sample,query){
    if(sample.slot!==query.slot||sample.context.activity!==query.context.activity) return null;
    if(sample.lagMin<0||sample.lagMin>60||sample.quality.low) return null;
    if(sample.context.iobU===null||query.context.iobU===null)return null;
    if(query.context.settingRevision!==null && sample.context.settingRevision!==null &&
       query.context.settingRevision!==sample.context.settingRevision)return null;
    if(query.context.site!==null && sample.site!==null && query.context.site!==sample.site)return null;
    if(query.context.cobG!==null && sample.context.cobG!==null &&
       Math.abs(query.context.cobG-sample.context.cobG)>12)return null;
    if(sample.quality.baseline.trend!==query.cgm.trend) return null;
    const d=plateSimilarity(query.plate,sample.plate),g=Math.abs(sample.quality.baseline.glucose-query.cgm.glucose),
      iob=Math.abs(sample.context.iobU-query.context.iobU);
    const dose=query.context.plannedDoseU;
    const diffDose=finite(dose)?Math.abs(sample.units-dose):null;
    // Do not compare materially different states, even if nutrient contents happen to match.
    if(g>3.0||iob>1.5||(diffDose!==null&&diffDose>1.0))return null;
    if(d.carb>.55||d.fat>.95||d.gi>.65||d.protein>.95)return null;
    const tier=d.carb<=.28&&d.fat<=.5&&d.gi<=.25&&g<=1.5&&iob<=.6&&
      (diffDose===null||diffDose<=.5)?'near':'extended';
    const penalty=.48*d.carb+.13*d.fat+.13*d.gi+.07*d.protein+.1*(g/3)+.06*(iob/1.5)+
      .03*(diffDose===null?.4:diffDose)+d.penalty;
    return {tier,score:Math.max(0,1-penalty),factors:d,glucoseDifference:g,iobDifference:iob};
  }
  function noData(reason,extra={}){return deepFreeze({version:VERSION,status:'NO_DATA',code:reason,message:MSG,
    descriptiveLagMinutes:null,rangeMinutes:null,clinicalUse:false,automaticInjectionTiming:false,...extra});}
  function analyze(index,request){
    if(!index||index.version!==VERSION||index.status!=='READY')return noData('INDEX_UNAVAILABLE');
    const at=validTime(request?.atIso||index.asOf);if(!finite(at))return noData('TIME_INVALID');
    const slot=slotFor(at,index.timeZone);if(!slot)return noData('TIMEZONE_UNKNOWN');
    const context=canonicalContext(request?.context),plate=normalizePlate(request?.plate);
    const cgm=request?.cgm;
    if(!plate)return noData('PLATE_UNAVAILABLE',{slot});
    if(!['low','usual','high','sport'].includes(context.activity)||context.iobU===null)
      return noData('CONTEXT_INCOMPLETE',{slot});
    if(!cgm||!finite(cgm.glucose)||!['rising','falling','flat'].includes(cgm.trend))return noData('CGM_UNAVAILABLE',{slot});
    if(cgm.glucose<3.9)return noData('CURRENT_GLUCOSE_LOW',{slot});
    if(index.cgmCount===0)return noData('CGM_HISTORY_UNAVAILABLE',{slot});
    const lower=shiftedMonths(at,-HISTORY_MONTHS),window=index.meals.filter(e=>e.slot===slot&&e.at>=lower&&e.at<=at),
      candidates=window.map(e=>({e,match:compare(e,{slot,plate,context,cgm})})).filter(x=>x.match);
    // Phase is a hard partition, always. Require at least three days of learning before analysis.
    const historyStart=window.length?Math.min(...window.map(e=>e.at)):NaN;
    if(!finite(historyStart)||at-historyStart<MIN_HISTORY_DAYS*DAY)
      return noData('HISTORY_LESS_THAN_3_DAYS',{slot,eligibleCases:window.length,candidateCases:candidates.length});
    // Nutrient/context proximity dominates; age of observation is the secondary ranking input.
    // 1% similarity advantage is roughly equivalent to ten days of recency.
    candidates.sort((a,b)=> (a.match.tier==='near'?0:1)-(b.match.tier==='near'?0:1) ||
      (b.match.score-(at-b.e.at)/DAY*.001)-(a.match.score-(at-a.e.at)/DAY*.001) ||
      b.e.at-a.e.at || a.e.id.localeCompare(b.e.id));
    const nearCandidates=candidates.filter(x=>x.match.tier==='near');
    const selected=(nearCandidates.length>=MIN_MATCHES?nearCandidates:candidates).slice(0,20);
    const distinctDays=new Set(selected.map(x=>dayFor(x.e.at,index.timeZone))).size;
    if(selected.length<MIN_MATCHES||distinctDays<MIN_UNIQUE_DAYS)
      return noData('SIMILAR_CASES_INSUFFICIENT',{slot,eligibleCases:window.length,candidateCases:candidates.length,
        matchedCases:selected.length,distinctDays});
    const lags=selected.map(x=>x.e.lagMin),low=quantile(lags,.1),high=quantile(lags,.9);
    const observed=weightedMedian(selected.map(x=>{
      const days=(at-x.e.at)/DAY;
      const recencyWeight=Math.pow(.5,days/75);
      const similarityWeight=Math.pow(Math.max(.1,x.match.score),4);
      // Give precedence to histories with lower observed excursions, not merely popular wait times.
      // This remains observational correlation, never a causal optimum.
      const excursion=x.e.quality.excursionUp+x.e.quality.excursionDown;
      const observedOutcomeWeight=1/(1+Math.max(0,excursion)/4);
      return {value:x.e.lagMin,weight:Math.max(.000001,recencyWeight*similarityWeight*observedOutcomeWeight)};
    }));
    const corrections=index.corrections.filter(x=>x.slot===slot&&x.at>=lower&&x.at<=at);
    return deepFreeze({version:VERSION,status:'HISTORICAL_ESTIMATE',slot,
      label:'Наблюдавшийся интервал по похожим случаям',descriptiveLagMinutes:Math.round(observed),
      estimator:'weighted_historical_median_v1',
      rangeMinutes:[Math.floor(low),Math.ceil(high)],matchedCases:selected.length,distinctDays,
      periodDays:rounded((at-historyStart)/DAY),tier:selected.every(x=>x.match.tier==='near')?'near':'extended',
      cases:selected.map(x=>({sessionId:x.e.id,at:new Date(x.e.at).toISOString(),lagMinutes:rounded(x.e.lagMin),
        similarity:rounded(x.match.score),qualifier:x.match.tier,glucoseMin:x.e.quality.min,glucoseMax:x.e.quality.max})),
      correctionEvidence:{matchedPeriodCount:corrections.length,medianObservedDeclineMin:median(corrections.map(x=>x.observedDeclineAtMin))},
      warnings:['Это статистика прежних интервалов, не измерение начала всасывания и не инструкция для укола.',
        'Частота CGM и задержка тканевой глюкозы не обеспечивают точность до секунды.'],
      clinicalUse:false,automaticInjectionTiming:false,usedForwardModels:false,usedDrugKinetics:false});
  }
  function analyzeSnapshot(snapshot,request){
    return analyzeVerifiedSnapshot(snapshot, request);
  }

  function analyzeVerifiedSnapshot(snapshot, request, verifiedQ09Rows) {
    const index=buildVerifiedIndex(snapshot,{asOf:request?.atIso},verifiedQ09Rows);
    if(index.status==='CGM_PROVENANCE_UNVERIFIED' && snapshot.cgmMetadata?.sourceDeviceId==='xdrip-local-follower') return noData(index.status);
    const at=validTime(request?.atIso||index.asOf);
    const rows=normalizeCGM(snapshot.cgm,snapshot.cgmMetadata,at);
    const actual=observedContext(rows,at);
    const session=snapshot.mealSessions.find(s=>s.id===request?.sessionId);
    if(!session) return noData('MEAL_SESSION_NOT_FOUND');
    const plate=session.actualPlate||session.plannedPlate;
    return analyze(index,{atIso:request?.atIso,plate,cgm:actual,context:request?.context});
  }
  function createAnalyzer(host,{clock=()=>new Date().toISOString()}={}){
    if(!host||typeof host.connect!=='function')throw Error('GFStorage host required');
    const analyticsPort=host.connect('injectionAnalytics'), researchPort=host.connect('research');
    const inspect=request=>{
      const first=analyticsPort.getSnapshot(), second=researchPort.getSnapshot();
      if(first.revision!==second.revision||analyticsPort.getRevision()!==first.revision||researchPort.getRevision()!==first.revision)
        return noData('REVISION_CHANGED');
      // Dynamic IOB is not persisted in the current GFStorage analytics projection.
      // The integration must supply a same-revision calculation context from GFStorage,
      // never a fabricated value or an unversioned UI placeholder.
      if(request?.context?.sourceRevision!==first.revision)return noData('CONTEXT_REVISION_UNVERIFIED');
      const snapshot={...second,events:first.events,cgm:first.cgm,cgmMetadata:first.cgmMetadata};
      let verifiedQ09Rows;
      if(first.cgmMetadata?.sourceType==='xdrip_local' && first.cgmMetadata.sourceDeviceId==='xdrip-local-follower') {
        // The storage port must validate each receipt against its persisted
        // observation, profile and snapshot revision. JSON claims carry no authority.
        const profileId=first.profileId;
        if(typeof profileId!=='string' || !profileId || second.profileId!==profileId ||
           !Array.isArray(first.cgm) || first.cgm.length===0 || first.cgm.length>MAX_CGM ||
           typeof analyticsPort.verifyQ09CgmSnapshot!=='function')
          return noData('CGM_PROVENANCE_UNVERIFIED');
        try {
          const rows=first.cgm.map(row=>Object.freeze({...row}));
          if(rows.some(row=>row.profileId!==profileId || row.sourceDeviceId!=='xdrip-local-follower') ||
             analyticsPort.verifyQ09CgmSnapshot({profileId, revision:first.revision, rows:Object.freeze(rows)})!==true)
            return noData('CGM_PROVENANCE_UNVERIFIED');
          snapshot.cgm=verifiedQ09Rows=rows;
        } catch {
          return noData('CGM_PROVENANCE_UNVERIFIED');
        }
      }
      const result=analyzeVerifiedSnapshot(snapshot,{...request,atIso:request?.atIso||clock()},verifiedQ09Rows);
      return analyticsPort.getRevision()===first.revision&&researchPort.getRevision()===first.revision?result:noData('REVISION_CHANGED');
    };
    return Object.freeze({inspect});
  }
  return Object.freeze({VERSION,SLOTS,HISTORY_MONTHS,MIN_HISTORY_DAYS,MIN_MATCHES,MIN_UNIQUE_DAYS,
    slotFor,shiftedMonths,normalizePlate,buildIndex,analyze,analyzeSnapshot,createAnalyzer});
});
