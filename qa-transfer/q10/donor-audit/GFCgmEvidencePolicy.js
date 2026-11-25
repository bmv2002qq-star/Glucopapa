/* ГлюкоПапа W05b — техническая политика достоверности CGM v0.1.0.
 * Единственный источник данных: read-only ports GFStorage schema 5.
 * No doses, no new database, no CGM ingestion, no treatment authorization.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFCgmEvidencePolicy=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MINUTE=60000;
const FROZEN_UNKNOWN=Object.freeze({value:null,direction:null,trendLabel:'Нет достоверных данных',source:null,ageMin:null});
const usable=p=>Number.isFinite(p.mmol)&&p.mmol>=1.5&&p.mmol<=30&&p.valid!==false&&p.qualityFlag!=='invalid';
function fail(code,status='BLOCKED',extra={}){return Object.freeze({status,code,currentMmol:null,latestAt:null,sourceStatus:'UNKNOWN',sourceDeviceId:null,revision:null,readings:[],timelineReadings:[],rawReadings:[],freshnessMinutes:null,...extra});}
function inspect(host,{nowMs=Date.now()}={}){
 if(!Number.isSafeInteger(nowMs))return fail('INVALID_CLOCK');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return fail('GFSTORAGE_UNAVAILABLE');
 let a,meta,rev;
 try{
   const graph=host.connect('graph'),adapter=host.connect('cgmAdapter');
   for(let attempt=0;attempt<3;attempt++){
     const before=graph.getRevision();a=graph.getSnapshot();meta=adapter.read('cgmMetadata');const after=adapter.getRevision();
     if(before===a.revision&&a.revision===after){rev=after;break;}
   }
 }catch(e){return fail('CGM_READ_FAILED');}
 if(rev===undefined)return fail('REVISION_CHANGED');
 const archived=host.connect('archive');
 const archive=archived.summary(),past=archive?archived.glucose().filter(row=>row.ts<=nowMs&&usable(row)):[];
 if(archived.getRevision()!==rev)return fail('REVISION_CHANGED');
 const history=archive?{archive,timelineReadings:past}:{};
 if(!meta||typeof meta.sourceDeviceId!=='string'||!meta.sourceDeviceId){
   if(past.length)return fail('CGM_ARCHIVE_ONLY','ARCHIVED_ONLY',{revision:rev,sourceStatus:'REAL_CGM_IMPORT',...history});
   return fail('CGM_SOURCE_UNKNOWN','BLOCKED',{revision:rev});
 }
 if(!['synthetic','device_recorded','xdrip_local'].includes(meta.sourceType))return fail('SOURCE_INVALID','BLOCKED',{revision:rev});
 const provider=meta.sourceType==='xdrip_local';
 const sourceStatus=provider?'XDRIP_LOCAL':meta.sourceType==='synthetic'?'SYNTHETIC':'DEVICE_DECLARED';
 const common={revision:rev,sourceStatus,sourceDeviceId:meta.sourceDeviceId,sourceType:meta.sourceType,...history};
 if(!provider&&(!Number.isFinite(meta.qualityScore)||meta.qualityScore<0.8))return fail('CGM_SOURCE_QUALITY_LOW','BLOCKED',common);
 const all=(a.cgm||[]).filter(p=>p&&p.sourceDeviceId===meta.sourceDeviceId&&Number.isSafeInteger(p.ts)).sort((x,y)=>x.ts-y.ts);
 const raw=provider?all.filter(row=>row.transport!=='xdrip_loopback_history'):all;
 if(!raw.length)return fail('CGM_NOT_ENOUGH','BLOCKED',{...common,rawReadings:raw});
 const receivedInFuture=p=>p.receivedAt!=null&&Date.parse(p.receivedAt)>nowMs;
 const futureCode=raw.at(-1).ts>nowMs?'CGM_FUTURE_TIMESTAMP':raw.some(receivedInFuture)?'CGM_FUTURE_RECEIPT':null;
 const received=raw.filter(p=>p.ts<=nowMs&&!receivedInFuture(p));
 const latestRecorded=received.at(-1)||null;
 const qualityBlocked=!!(latestRecorded&&(latestRecorded.valid===false||latestRecorded.qualityFlag==='invalid'));
 const clean=received.filter(usable);
 if(!clean.length)return fail(futureCode||'CGM_NOT_ENOUGH',futureCode?'FUTURE_BLOCKED':'BLOCKED',{...common,rawReadings:raw});
 const latest=clean.at(-1),ageMinutes=(nowMs-latest.ts)/MINUTE;
 // For the provider, 15 minutes is a display boundary, not a declared sampling interval.
 const freshnessMinutes=provider?15:Math.max(15,3*(Number.isFinite(meta.samplingMinutes)?meta.samplingMinutes:5));
 const stale=ageMinutes>freshnessMinutes||(provider&&latest.staleAtReceipt===true);
 const status=futureCode?'FUTURE_BLOCKED':qualityBlocked?'QUALITY_BLOCKED':stale?'STALE':provider?'OBSERVED_ONLY':'OK';
 const code=futureCode||(status==='QUALITY_BLOCKED'?'CGM_QUALITY_REJECTED':status==='STALE'?'CGM_STALE':
   provider?(latest.staleAtReceipt===false?'XDRIP_MODEL_QUALITY_UNKNOWN':'XDRIP_FRESHNESS_UNKNOWN'):'FRESH_HISTORY');
 return Object.freeze({status,code,archive,currentMmol:status==='OK'?latest.mmol:null,
   reportedMmol:status==='OBSERVED_ONLY'&&latest.staleAtReceipt===false?latest.mmol:null,
   latestAt:new Date(latest.ts).toISOString(),sourceStatus,sourceDeviceId:meta.sourceDeviceId,sourceType:meta.sourceType,revision:rev,readings:clean,rawReadings:raw,freshnessMinutes,ageMinutes,
   timelineReadings:[...past,...(provider?all.filter(p=>p.ts<=nowMs&&!receivedInFuture(p)&&usable(p)):clean)]});
}
function archivedAt(readings,ts){
 let left=0,right=readings.length;
 while(left<right){const mid=(left+right)>>1;if(readings[mid].ts<=ts)left=mid+1;else right=mid;}
 const row=readings[left-1];
 if(!row||ts-row.ts>10*MINUTE)return FROZEN_UNKNOWN;
 return {value:row.mmol,direction:null,trendLabel:'Архив CGM',source:'real_cgm_import',ageMin:(ts-row.ts)/MINUTE};
}
function forEvent(view,ts,{journal=null}={}){
 if(!view||!Number.isSafeInteger(ts)||view.status==='BLOCKED'||!view.sourceDeviceId)return FROZEN_UNKNOWN;
 const recorded=view.rawReadings.filter(x=>x.ts<=ts).at(-1)||null;
 if(!recorded||recorded.valid===false||recorded.qualityFlag==='invalid')return FROZEN_UNKNOWN;
 const good=view.readings.filter(x=>x.ts<=ts).at(-1)||null;
 if(!good||good.ts!==recorded.ts||ts-good.ts>Math.min(10,view.freshnessMinutes)*MINUTE)return FROZEN_UNKNOWN;
 if(journal&&typeof journal.glucoseAt==='function'){
   const val=journal.glucoseAt(view.readings,ts);
   if(view.sourceStatus==='XDRIP_LOCAL'&&good.direction===null){
     return Object.freeze({...val,direction:null,trendLabel:'Тренд не передан',source:'xdrip_local'});
   }
   return Object.freeze({...val,source:view.sourceStatus==='SYNTHETIC'?'synthetic':view.sourceStatus==='XDRIP_LOCAL'?'xdrip_local':view.sourceStatus==='DEVICE_DECLARED'?'device_declared':'observed'});
 }
 return Object.freeze({value:good.mmol,direction:null,trendLabel:'Наблюдение',ageMin:(ts-good.ts)/MINUTE,source:view.sourceStatus});
}
function journalView(host,journal,adapter,{nowMs=Date.now()}={}){
 if(!journal||typeof journal.buildAll!=='function'||!adapter||typeof adapter.connect!=='function')throw Error('Отсутствует GFJournal adapter');
 const view=inspect(host,{nowMs}),input=adapter.connect(host).read();
 if(view.revision!==null&&view.revision!==input.journal.revision)throw Error('REVISION_CHANGED');
 const sanitized={...input,graph:{...input.graph,cgm:view.readings.map(x=>({...x,direction:view.sourceStatus==='XDRIP_LOCAL'?x.direction:null}))}};
 const all=journal.buildAll(sanitized);
 const archived=view.archive?view.timelineReadings.filter(row=>row.source==='real_cgm_import'):[];
 const rows=all.rows.map(r=>({...r,glucose:r.ts>nowMs?FROZEN_UNKNOWN:
   view.archive&&r.ts<=view.archive.lastAt+59999?archivedAt(archived,r.ts):forEvent(view,r.ts,{journal})}));
 return Object.freeze({...all,rows,cgm:view.readings,sourceStatus:view.sourceStatus,sourceDeviceId:view.sourceDeviceId,cgmEvidenceStatus:view.status,cgmEvidenceCode:view.code,
   ...(view.archive?{researchHistory:{...view.archive,notes:host.connect('archive').reportedNotes(),meter:host.connect('archive').meter()}}:{})});
}
function checkSafety(host,safetyBridge,{nowMs=Date.now()}={}){
 const view=inspect(host,{nowMs});
 const original=safetyBridge?.check({nowIso:new Date(nowMs).toISOString()});
 if(!original||!['OK'].includes(view.status))return Object.freeze({status:'BLOCKED',code:view.code,sourceRevision:view.revision,cgmEvidenceStatus:view.status,forecastInputEligible:false,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false,approvedSafetyResult:original||null});
 return Object.freeze({...original,cgmEvidenceStatus:view.status,sourceRevision:view.revision,forecastInputEligible:original.forecastInputEligible===true,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false});
}
return Object.freeze({VERSION:'0.1.0-candidate',inspect,forEvent,journalView,checkSafety});
});
