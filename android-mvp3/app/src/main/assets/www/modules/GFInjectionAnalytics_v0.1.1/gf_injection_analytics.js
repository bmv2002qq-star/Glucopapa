
/* ГлюкоПапа · GFInjectionAnalytics v0.1.1 — исследовательский анализатор.
 * ВАЖНО: описательная статистика CGM НЕ равна началу действия инсулина,
 * не вычисляет дозы и интервалы до еды. История никогда не удаляется.
 * Все данные поступают через снимок GFStorage; внешние модули не вызываются.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFInjectionAnalytics=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.1',SCHEMA='GFInjectionAnalyticsInput.v1',DAY=86400000,MINUTE=60000;
const WINDOW_DAYS=90,CGM_WINDOW_MIN=180,MIN_SAMPLES=8,MIN_DAYS=5,MIN_MATCHED_PAIRS=6;
const REGIONS=Object.freeze(['abdomen','arm','thigh','buttock']);
const SITE_LABEL=Object.freeze({abdomen:'Живот',arm:'Плечо',thigh:'Бедро',buttock:'Ягодица'});
const validTime=x=>(typeof x==='number'&&Number.isSafeInteger(x)&&Math.abs(x)<8.64e15?x:(typeof x==='string'&&Number.isFinite(Date.parse(x))?Date.parse(x):NaN));
const number=x=>typeof x==='number'&&Number.isFinite(x);
const rnd1=n=>Math.round(n*10)/10;
const med=v=>{if(!v.length)return null;const a=v.slice().sort((x,y)=>x-y),m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;};
const quantile=(v,q)=>{if(!v.length)return null;const a=v.slice().sort((x,y)=>x-y),p=(a.length-1)*q,l=Math.floor(p),h=Math.ceil(p);return a[l]+(a[h]-a[l])*(p-l);};
function weightedMedian(values,weights){if(!values.length)return null;const a=values.map((x,i)=>[x,weights[i]]).sort((x,y)=>x[0]-y[0]),sum=weights.reduce((x,y)=>x+y,0);let z=0;for(const [v,w] of a){z+=w;if(z>=sum/2)return v;}return a.at(-1)[0];}
const groupTime=h=>h<11?'morning':h<17?'day':'evening';
const dayKey=ts=>new Date(ts).toISOString().slice(0,10);
const count=(obj,key)=>{obj[key]=(obj[key]||0)+1;};
function normalizedInterval(v){if(!v||typeof v!=='object')return null;const start=validTime(v.start),end=validTime(v.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>30*DAY||typeof v.id!=='string'||!v.id.trim())return null;return {id:v.id.trim(),start,end};}
function normalizeShot(raw){
 if(!raw||typeof raw.id!=='string'||!raw.id.trim()||!['rinfast','levemir'].includes(raw.insulinId))return null;
 const ts=validTime(raw.administeredAt),c=raw.context||{};
 if(!Number.isFinite(ts)||!number(raw.units)||raw.units<=0||raw.units>200)return null;
 const region=REGIONS.includes(raw.site?.region)?raw.site.region:null;
 const offset=Number.isInteger(c.utcOffsetMinutes)&&c.utcOffsetMinutes>=-720&&c.utcOffsetMinutes<=840&&c.utcOffsetMinutes%15===0?c.utcOffsetMinutes:null;
 const localHour=Number.isInteger(c.localHour)&&c.localHour>=0&&c.localHour<=23?c.localHour:null;
 const actualHour=offset!==null?new Date(ts+offset*MINUTE).getUTCHours():null;
 const rawRevision=(typeof c.settingRevision==='string'||Number.isSafeInteger(c.settingRevision))?String(c.settingRevision).trim():'';
 const illness=['no','yes'].includes(c.illness)?c.illness:null;
 const activity=['low','usual','high'].includes(c.activity)?c.activity:null;
 const mealGroup=['with_meal','without_meal'].includes(c.mealGroup)?c.mealGroup:null;
 return {id:raw.id.trim(),insulinId:raw.insulinId,ts,units:raw.units,region,side:['left','right'].includes(raw.site?.side)?raw.site.side:null,
   illness,activity,carbsG:number(c.carbsG)&&c.carbsG>=0&&c.carbsG<=400?c.carbsG:null,
   iobU:number(c.iobU)&&c.iobU>=0&&c.iobU<=100?c.iobU:null,
   mealLagMinutes:number(c.mealLagMinutes)&&c.mealLagMinutes>=-60&&c.mealLagMinutes<=180?c.mealLagMinutes:null,
   mealGroup,settingRevision:rawRevision||null,localHour,
   utcOffsetMinutes:offset,timeConsistent:localHour!==null&&offset!==null&&localHour===actualHour,
   illnessPeriod:normalizedInterval(c.illnessPeriod),activityPeriod:normalizedInterval(c.activityPeriod)};
}
function sameShot(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function normalizeCgm(cgm,expectedSourceId){
 const readings=new Map(),conflicts=new Set(),invalidTimes=new Set();
 for(const x of cgm){if(!x||typeof x!=='object')continue;const ts=validTime(x.ts);if(!Number.isFinite(ts))continue;
   if(x.valid===false||x.qualityFlag==='invalid'||(typeof x.sourceDeviceId==='string'&&expectedSourceId&&x.sourceDeviceId!==expectedSourceId)){invalidTimes.add(ts);continue;}
   if(!number(x.mmol)||x.mmol<1.5||x.mmol>30){invalidTimes.add(ts);continue;}
   if(readings.has(ts)&&readings.get(ts)!==x.mmol){conflicts.add(ts);continue;}
   readings.set(ts,x.mmol);
 }
 for(const ts of [...conflicts,...invalidTimes])readings.delete(ts);
 return {readings:[...readings].sort((a,b)=>a[0]-b[0]).map(([ts,mmol])=>({ts,mmol})),conflicts,invalidTimes};
}
function normalizeInput(input){
 if(!input||typeof input!=='object'||input.schema!==SCHEMA)throw Error('Ожидался '+SCHEMA);
 if(!Array.isArray(input.injections)||!Array.isArray(input.cgm))throw Error('Нужны массивы injections и cgm');
 if(input.injections.length>50000||input.cgm.length>500000)throw Error('Слишком большой снимок');
 const byId=new Map(),quality={invalidInjections:0,conflictingIds:0,repeatedIds:0,ambiguousSameMoment:0,cgmConflicts:0,invalidCgmPoints:0};
 for(const raw of input.injections){const s=normalizeShot(raw);if(!s){quality.invalidInjections++;if(raw&&typeof raw.id==='string'&&raw.id.trim()){const id=raw.id.trim();if(!byId.has(id))byId.set(id,[]);byId.get(id).push(null);}continue;}
   if(!byId.has(s.id))byId.set(s.id,[]);byId.get(s.id).push(s);
 }
 const shots=[];
 for(const entries of byId.values()){if(entries.some(x=>x===null)||entries.some(x=>!sameShot(x,entries[0]))){quality.conflictingIds++;continue;}if(entries.length>1)quality.repeatedIds+=entries.length-1;shots.push(entries[0]);}
 // Два разных ID, совпадающих по моменту/типу/дозе/месту, не считаем независимыми.
 // Остальные одновременные уколы обнаруживаются как перекрывающиеся эпизоды ниже.
 const keys=new Map();for(const s of shots){const k=[s.ts,s.insulinId,s.units,s.region,s.side].join('|');if(!keys.has(k))keys.set(k,[]);keys.get(k).push(s);}
 const quarantine=new Set();for(const v of keys.values())if(v.length>1){quality.ambiguousSameMoment+=v.length;for(const s of v)quarantine.add(s.id);}
 shots.sort((a,b)=>a.ts-b.ts||a.id.localeCompare(b.id));
 const m=input.cgmMetadata||{};const sourceId=typeof m.sourceDeviceId==='string'&&m.sourceDeviceId.trim()?m.sourceDeviceId.trim():null;
 const normCgm=normalizeCgm(input.cgm,sourceId);quality.cgmConflicts=normCgm.conflicts.size;quality.invalidCgmPoints=normCgm.invalidTimes.size;
 const badTimestamps=[...new Set([...normCgm.conflicts,...normCgm.invalidTimes])].sort((a,b)=>a-b);
 const sourceType=['synthetic','device_recorded'].includes(m.sourceType)?m.sourceType:'unknown';
 const samplingMinutes=[5,10].includes(m.samplingMinutes)?m.samplingMinutes:null;
 const qualityScore=number(m.qualityScore)&&m.qualityScore>=0&&m.qualityScore<=1?m.qualityScore:null;
 const provenanceComplete=!!sourceId&&sourceType!=='unknown'&&samplingMinutes!==null&&qualityScore!==null&&qualityScore>=0.8;
 return {shots,cgm:normCgm.readings,badTimestamps,quarantine,quality,meta:{sourceDeviceId:sourceId,sourceType,samplingMinutes,qualityScore,provenanceComplete},revision:Number.isInteger(input.revision)?input.revision:null};
}
function lowerBound(a,t){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].ts<t)lo=m+1;else hi=m;}return lo;}
function lowerBoundNumbers(a,t){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<t)lo=m+1;else hi=m;}return lo;}
function linearSlope(points){if(points.length<3)return null;const t0=points[0].ts;let sx=0,sy=0,sxy=0,sxx=0,n=points.length;for(const p of points){const x=(p.ts-t0)/MINUTE;sx+=x;sy+=p.mmol;sxx+=x*x;sxy+=x*p.mmol;}const den=n*sxx-sx*sx;return !den?null:(n*sxy-sx*sy)/den;}
function extractObservation(shot,data){
 const t=shot.ts,a=lowerBound(data.cgm,t-23*MINUTE),b=lowerBound(data.cgm,t+(CGM_WINDOW_MIN+1)*MINUTE),series=data.cgm.slice(a,b);
 const badIndex=lowerBoundNumbers(data.badTimestamps,t-22*MINUTE);
 if(badIndex<data.badTimestamps.length&&data.badTimestamps[badIndex]<=t+CGM_WINDOW_MIN*MINUTE)return {ok:false,reason:'cgm_quality_conflict'};
 const pre=series.filter(p=>p.ts>=t-22*MINUTE&&p.ts<=t),at=pre.filter(p=>p.ts>=t-11*MINUTE);
 if(pre.length<3||!at.length||t-pre.at(-1).ts>10*MINUTE)return {ok:false,reason:'no_baseline'};
 const priorSlope=linearSlope(pre),glucose=med(at.map(p=>p.mmol));
 if(priorSlope===null)return {ok:false,reason:'no_baseline'};
 if(priorSlope<-0.012)return {ok:false,reason:'already_falling'};
 if(Math.abs(priorSlope)>0.1)return {ok:false,reason:'unstable_baseline'};
 const post=series.filter(p=>p.ts>=t&&p.ts<=t+CGM_WINDOW_MIN*MINUTE);
 if(!post.length)return {ok:false,reason:'cgm_gap'};
 const firstAfter=post.find(p=>p.ts>t)||post[0];
 if(firstAfter.ts-pre.at(-1).ts>15*MINUTE||post[0].ts-t>10*MINUTE)return {ok:false,reason:'cgm_gap_around_injection'};
 const gaps=[];for(let i=1;i<post.length;i++)gaps.push((post[i].ts-post[i-1].ts)/MINUTE);
 const observedCadence=med(gaps);
 if(!number(observedCadence)||Math.abs(observedCadence-data.meta.samplingMinutes)>1)return {ok:false,reason:'cgm_cadence_mismatch'};
 if(Math.max(...gaps)>15)return {ok:false,reason:'cgm_gap'};
 if(post.length<Math.floor(160/data.meta.samplingMinutes)||post.at(-1).ts-post[0].ts<160*MINUTE)return {ok:false,reason:'cgm_gap'};
 if(series.some(p=>p.mmol<3.9))return {ok:false,reason:'low_glucose_context'};
 let onset=null;
 for(let i=0;i<post.length;i++){
   const p=post[i],minute=(p.ts-t)/MINUTE;if(minute<25||minute>175)continue;
   const left=lowerBound(post,p.ts-20*MINUTE),pts=post.slice(left,i+1);
   if(pts.length<(data.meta.samplingMinutes===10?3:4)||pts.at(-1).ts-pts[0].ts<14*MINUTE)continue;
   const slope=linearSlope(pts);
   if(slope!==null&&slope<=-0.015&&pts[0].mmol-pts.at(-1).mmol>=0.30&&p.mmol<=glucose-0.45){onset=Math.round(minute);break;}
 }
 if(onset===null)return {ok:false,reason:'no_decline_observed'};
 return {ok:true,firstDeclineMinutes:onset,glucoseAtShot:glucose,baselineSlope:priorSlope};
}
function quality(s){
 if(!s.region||!s.illness||!s.activity||s.carbsG===null||s.iobU===null||s.mealLagMinutes===null||!s.mealGroup||!s.settingRevision||!s.timeConsistent)return false;
 if(s.mealGroup==='without_meal'&&s.carbsG>5)return false;
 if(s.illness==='yes'&&(!s.illnessPeriod||s.ts<s.illnessPeriod.start||s.ts>s.illnessPeriod.end))return false;
 if(s.illness==='no'&&s.illnessPeriod&&s.ts>=s.illnessPeriod.start&&s.ts<=s.illnessPeriod.end)return false;
 if(s.activity!=='usual'&&(!s.activityPeriod||s.ts<s.activityPeriod.start||s.ts>s.activityPeriod.end))return false;
 return true;
}
function compatible(a,b){return a.insulinId===b.insulinId&&a.illness===b.illness&&a.activity===b.activity&&a.mealGroup===b.mealGroup&&a.settingRevision===b.settingRevision&&a.phase===b.phase&&
 Math.abs(a.units-b.units)<=0.5&&Math.abs(a.carbsG-b.carbsG)<=12&&Math.abs(a.iobU-b.iobU)<=0.5&&
 Math.abs(a.mealLagMinutes-b.mealLagMinutes)<=15&&Math.abs(a.glucoseAtShot-b.glucoseAtShot)<=1.5&&Math.abs(a.baselineSlope-b.baselineSlope)<=0.03;}
function pairDistance(a,b){return Math.abs(a.units-b.units)*3+Math.abs(a.carbsG-b.carbsG)/10+Math.abs(a.iobU-b.iobU)*2+Math.abs(a.glucoseAtShot-b.glucoseAtShot)+Math.abs(a.mealLagMinutes-b.mealLagMinutes)/15;}
function bucketKey(s){return [s.insulinId,s.illness,s.activity,s.mealGroup,s.settingRevision,s.phase].join('|');}
// O(n*128), а не полное O(n*m). Недостающие пары безопасно уменьшают статистическую достаточность.
function greedyPair(a,b){
 const buckets=new Map();for(const s of b){const key=bucketKey(s);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(s);}
 for(const arr of buckets.values())arr.sort((x,y)=>x.glucoseAtShot-y.glucoseAtShot||x.ts-y.ts||x.id.localeCompare(y.id));
 const used=new Set(),out=[];
 const sorted=a.slice().sort((x,y)=>x.ts-y.ts||x.id.localeCompare(y.id));
 for(const s of sorted){const arr=buckets.get(bucketKey(s));if(!arr||!arr.length)continue;
   let lo=0,hi=arr.length;while(lo<hi){let mid=(lo+hi)>>1;if(arr[mid].glucoseAtShot<s.glucoseAtShot)lo=mid+1;else hi=mid;}
   let best=null;const begin=Math.max(0,lo-64),end=Math.min(arr.length,lo+64);
   for(let i=begin;i<end;i++){const q=arr[i];if(used.has(q.id)||Math.abs(s.ts-q.ts)<=DAY/2||!compatible(s,q))continue;
     const d=pairDistance(s,q);if(!best||d<best.d||(d===best.d&&(q.ts<best.q.ts||(q.ts===best.q.ts&&q.id<best.q.id))))best={q,d};
   }
   if(best){used.add(best.q.id);out.push([s,best.q]);}
 }
 return out;
}
function intervalBootstrap(values,seed=53217){if(values.length<2)return null;let x=seed>>>0;const next=()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296;};const e=[];for(let i=0;i<500;i++){const v=[];for(let j=0;j<values.length;j++)v.push(values[Math.floor(next()*values.length)]);e.push(med(v));}return [rnd1(quantile(e,0.05)),rnd1(quantile(e,0.95))];}
function analyze(input,opts={}){
 const asOf=validTime(opts.asOf??Date.now());if(!Number.isFinite(asOf))throw Error('Неверное время анализа');
 const referenceRegion=REGIONS.includes(opts.referenceRegion)?opts.referenceRegion:'abdomen';
 const illness=['no','yes'].includes(opts.illness)?opts.illness:'no';
 const activity=['low','usual','high'].includes(opts.activity)?opts.activity:'usual';
 const data=normalizeInput(input),boundary=asOf-WINDOW_DAYS*DAY;
 const visibleCgm=data.cgm.filter(p=>p.ts<=asOf);
 const available={...data,cgm:visibleCgm};
 const status={total:data.shots.length,archived:0,future:0,basalExcluded:0,metadataMissing:0,outsideContext:0,cgmMissingOrUnclear:0,eligible:0,reasonCounts:{},duplicateAndIntegrity:data.quality,overlappingEpisodes:0};
 const recent=data.shots.filter(x=>x.ts>=boundary&&x.ts<=asOf),rapid=recent.filter(x=>x.insulinId==='rinfast');
 const overload=rapid.length>1500;
 if(overload)count(status.reasonCounts,'history_over_limit');
 const samples=[];
 for(const s of data.shots){
   if(s.ts<boundary){status.archived++;continue;}if(s.ts>asOf){status.future++;continue;}
   if(s.insulinId!=='rinfast'){status.basalExcluded++;continue;}
   if(data.quarantine.has(s.id)){status.metadataMissing++;count(status.reasonCounts,'ambiguous_duplicate_event');continue;}
   if(!quality(s)){status.metadataMissing++;count(status.reasonCounts,'metadata_inconsistent');continue;}
   if(s.illness!==illness||s.activity!==activity){status.outsideContext++;continue;}
   if(overload){status.metadataMissing++;continue;}
   if(!data.meta.provenanceComplete){status.cgmMissingOrUnclear++;count(status.reasonCounts,'cgm_provenance_missing');continue;}
   // Не приписываем эффект одному уколу при другом быстром инсулине:
   // предыдущие 5 ч (возможный остаточный эффект) или следующие 3 ч наблюдения.
   const pos=lowerBound(rapid,s.ts-300*MINUTE);
   let overlap=false;for(let i=pos;i<rapid.length&&rapid[i].ts<=s.ts+180*MINUTE;i++){if(rapid[i].id!==s.id){overlap=true;break;}}
   if(overlap){status.overlappingEpisodes++;count(status.reasonCounts,'overlapping_rapid_injection');continue;}
   const x=extractObservation(s,available);
   if(!x.ok){status.cgmMissingOrUnclear++;count(status.reasonCounts,x.reason);continue;}
   samples.push({...s,...x,phase:groupTime(s.localHour),ageDays:Math.max(0,(asOf-s.ts)/DAY)});
 }
 status.eligible=samples.length;
 const bySite=Object.fromEntries(REGIONS.map(k=>[k,samples.filter(x=>x.region===k)]));
 const siteStats=REGIONS.map(region=>{const group=bySite[region],uniqueDays=new Set(group.map(x=>dayKey(x.ts))).size,weights=group.map(x=>Math.pow(.5,x.ageDays/45));
  const sufficient=group.length>=MIN_SAMPLES&&uniqueDays>=MIN_DAYS;
  return {region,label:SITE_LABEL[region],count:group.length,days:uniqueDays,medianObservedMinutes:group.length?med(group.map(x=>x.firstDeclineMinutes)):null,
    recencyWeightedMinutes:group.length?weightedMedian(group.map(x=>x.firstDeclineMinutes),weights):null,sufficient};});
 const comparisons=REGIONS.filter(x=>x!==referenceRegion).map(region=>{
   const p=greedyPair(bySite[referenceRegion],bySite[region]);
   const dr=new Set(p.map(x=>dayKey(x[0].ts))).size,db=new Set(p.map(x=>dayKey(x[1].ts))).size;
   const other=siteStats.find(x=>x.region===region),ref=siteStats.find(x=>x.region===referenceRegion);
   const sufficient=ref.sufficient&&other.sufficient&&p.length>=MIN_MATCHED_PAIRS&&dr>=MIN_DAYS&&db>=MIN_DAYS;
   const values=p.map(([a,b])=>b.firstDeclineMinutes-a.firstDeclineMinutes),weights=p.map(([a,b])=>Math.pow(.5,Math.max(a.ageDays,b.ageDays)/45));
   return {referenceRegion,region,label:SITE_LABEL[region],matchedPairs:p.length,sufficient,observedDifferenceMinutes:sufficient?rnd1(weightedMedian(values,weights)):null,
     exploratoryInterval90:sufficient?intervalBootstrap(values):null,note:sufficient?'Только описание CGM, не начало действия инсулина':'Недостаточно надёжных сопоставимых наблюдений'};
 });
 return {schema:'GFInjectionAnalyticsResult.v1',version:VERSION,analysisAt:new Date(asOf).toISOString(),referenceRegion,daysWindow:WINDOW_DAYS,
   windowStart:new Date(boundary).toISOString(),condition:{illness,activity,illnessPeriod:'проверяется по каждой инъекции'},sourceRevision:data.revision,
   sourceDeviceId:data.meta.sourceDeviceId,cgmSensorQuality:{status:data.meta.provenanceComplete?'metadata_complete':'unverified',type:data.meta.sourceType,
     qualityScore:data.meta.qualityScore,samplingMinutes:data.meta.samplingMinutes,qualityMeasuresAreNotClinicalValidation:true},
   totals:status,siteStats,comparisons,
   limitations:['Снижение CGM не устанавливает начало действия инсулина','Косвенная статистика не доказывает причину изменения CGM',
   'Периоды болезни, активность и близкие уколы требуют достоверных меток','Даже достаточные числовые наблюдения не предназначены для изменения дозы или времени','История старше 90 дней исключается, но не удаляется'],
   automatedDoseOrTimingChange:false,safeForDoseOrTiming:false};
}
function fromGFStoragePort(port){
 if(!port||typeof port.getSnapshot!=='function')throw Error('Нужен разрешённый порт GFStorage');
 const snap=port.getSnapshot();if(!snap||!Array.isArray(snap.events)||!Array.isArray(snap.cgm))throw Error('GFStorage не предоставил events/cgm');
 const shots=snap.events.filter(x=>x&&x.type==='insulin_injection'&&x.status==='confirmed').map(x=>({id:x.id,insulinId:x.insulinId,administeredAt:x.administeredAt,units:x.units,site:x.injectionSite||null,context:x.injectionContext||null}));
 // Никаких предположений о provenance: GFStorage v0.2.0 не передаёт cgmMetadata.
 const m=snap.cgmMetadata||null;
 return {schema:SCHEMA,revision:snap.revision,injections:shots,cgm:snap.cgm.map(x=>({ts:x.ts,mmol:x.mmol,valid:x.valid,qualityFlag:x.qualityFlag,sourceDeviceId:x.sourceDeviceId})),...(m?{cgmMetadata:m}:{})};
}
return Object.freeze({VERSION,SCHEMA,WINDOW_DAYS,REGIONS,SITE_LABEL,analyze,fromGFStoragePort});
});

