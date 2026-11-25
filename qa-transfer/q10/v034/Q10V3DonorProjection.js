/* Q10 V3 read-only adapter. Original GFSafety v0.1.0 is unchanged.
 * No coverage certificate, no clinical/model permission, no writes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.Q10V3DonorProjection=api;})(globalThis,function(){
'use strict';
const VERSION='0.3.4',limits={cgm:2000,events:2000,mealSessions:1000,conditionPeriods:1000};
const deny={forecastInputEligible:false,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false,automaticInjectionAllowed:false};
const blocked=(code,extra={})=>({version:VERSION,status:'BLOCKED',code,...extra,...deny});
const str=x=>typeof x==='string'&&x.trim()===x&&x.length>0&&x.length<=180;
const num=x=>typeof x==='number'&&Number.isFinite(x);
function evaluate(s,nowIso,core){
 try{
  if(!core||core.VERSION!=='0.1.0'||typeof core.evaluate!=='function'||typeof core.parseIso!=='function')return blocked('DONOR_UNAVAILABLE');
  const now=core.parseIso(nowIso);
  if(!s||s.schemaVersion!==3||!Number.isSafeInteger(s.revision)||!Number.isSafeInteger(s.inputRevision)||s.profileConfigured!==true||!str(s.profileId)||s.status!=='READY_STORAGE')return blocked('V3_SNAPSHOT_UNAVAILABLE');
  const d=s.data;
  if(!d||Object.keys(limits).some(k=>!Array.isArray(d[k])||d[k].length>limits[k]))return blocked('V3_SNAPSHOT_CONTRACT');
  const reasons=['HISTORY_COVERAGE_NOT_PROVEN','SOURCE_QUALITY_NOT_CERTIFIED'];
  for(const k of Object.keys(limits))if(d[k].length===limits[k])reasons.push('POSSIBLY_TRUNCATED_'+k.toUpperCase());
  const readings=[];
  for(const r of d.cgm){
   if(!r||typeof r!=='object')return blocked('INVALID_CGM_ROW');
   if(r.provenance==='archived')continue;
   if(r.provenance!=='observed'||r.source!=='xdrip_local'||r.profileId!==s.profileId||!str(r.sourceDeviceId)||!num(r.glucoseMmolL)||!str(r.measuredAtUtc))return blocked('CGM_PROVENANCE_UNVERIFIED');
   core.parseIso(r.measuredAtUtc);
   const p={measuredAt:r.measuredAtUtc,glucoseMmol:r.glucoseMmolL,sourceId:r.sourceDeviceId};
   if(r.receivedAtUtc!=null){core.parseIso(r.receivedAtUtc);p.receivedAt=r.receivedAtUtc;}
   if(r.quality==='VALID'){p.valid=true;p.qualityFlag='ok';}
   else if(r.quality==='INVALID'){p.valid=false;p.qualityFlag='invalid';}
   else return blocked('CGM_QUALITY_UNKNOWN');
   readings.push(p);
  }
  const injections=[],meals=[];
  for(const e of d.events){
   if(!e||typeof e!=='object'||!str(e.eventType))return blocked('INVALID_EVENT_ROW');
   if(e.eventType!=='insulin_injection')continue;
   if(!str(e.eventId)||!str(e.occurredAtUtc)||!str(e.insulinId)||!num(e.units))return blocked('INJECTION_FACT_UNVERIFIED');
   core.parseIso(e.occurredAtUtc);
   injections.push({id:e.eventId,administeredAt:e.occurredAtUtc,insulinId:e.insulinId,units:e.units,status:e.status==='confirmed'&&e.provenance==='CONFIRMED_ACTUAL'?'confirmed':'unconfirmed'});
  }
  for(const m of d.mealSessions){
   if(!m||typeof m!=='object'||!str(m.status))return blocked('INVALID_MEAL_ROW');
   if(m.status!=='completed'){if(m.startedAtUtc!=null)reasons.push('UNCONFIRMED_STARTED_MEAL');continue;}
   if(!str(m.sessionId)||!str(m.startedAtUtc)||!num(m.actualPlate?.totals?.carbs))return blocked('MEAL_FACT_UNVERIFIED');
   core.parseIso(m.startedAtUtc);
   meals.push({id:m.sessionId,eatenAt:m.startedAtUtc,carbsG:m.actualPlate.totals.carbs,status:m.userConfirmed===true?'confirmed':'unconfirmed'});
  }
  let illness=false,activity=false;
  for(const p of d.conditionPeriods){
   if(!p||!str(p.kind)||!str(p.startUtc))return blocked('CONDITION_FACT_UNVERIFIED');
   const start=core.parseIso(p.startUtc),end=p.endUtc==null?null:core.parseIso(p.endUtc);
   if(end!==null&&end<start)return blocked('CONDITION_TIME_INVALID');
   if(start<=now&&(end===null||end>=now)){if(p.kind==='illness')illness=true;else if(p.kind==='sport')activity=true;else reasons.push('CONDITION_KIND_UNVERIFIED');}
  }
  const normalized={sourceSchema:'GFStorage/3',nowIso,readings,injections,meals,coverage:{confirmedComplete:false,declaredBy:null,provenance:'external_adapter'},conditions:{illness,activity},sourceStatus:{type:'xdrip_local'}};
  const report=core.evaluate(normalized);
  if(!report||report.clinicalUseAllowed!==false||report.insulinDoseDecisionAllowed!==false||report.automaticInjectionAllowed!==false||!Array.isArray(report.issues))return blocked('DONOR_REPORT_CONTRACT');
  // Do not expose clinical/model permission or CGM values; use only diagnostic issue codes.
  return blocked('V3_OBSERVATIONAL_ONLY',{revision:s.revision,inputRevision:s.inputRevision,donorVersion:core.VERSION,donorStatus:report.status,donorIssues:report.issues.map(x=>x.code),counts:{cgm:readings.length,injections:injections.length,meals:meals.length},reasons:[...new Set(reasons)]});
 }catch(_){return blocked('V3_DONOR_READ_FAILED');}
}
return Object.freeze({VERSION,evaluate});
});