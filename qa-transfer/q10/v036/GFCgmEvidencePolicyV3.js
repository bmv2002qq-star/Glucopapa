/* Q10 V3 CGM-only evidence compatibility candidate. Not the legacy V2 policy.
 * The immutable V2 donor remains separate; do not spoof schema 5.
 * V3 does not certify quality, model eligibility, coverage, or a physical sensor.
 * Uses the validated CGM projection; no writes, treatment decisions or journal reconstruction. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./GFSafetyV3DiagnosticAdapter.js'));else root.GFCgmEvidencePolicyV3=factory(root.GFSafetyV3DiagnosticAdapter);})(globalThis,function(adapter){
'use strict';
const VERSION='0.3.6-qa';
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const deny={qualityScore:null,cgmCoverage:'NOT_PROVEN',currentMmol:null,forecastInputEligible:false,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false,automaticInjectionAllowed:false};
const out=(status,code,extra={})=>freeze({version:VERSION,scope:'CGM_EVIDENCE_ONLY',status,code,...extra,...deny});
const fail=code=>out('BLOCKED',code,{stamp:null,latestAt:null,ageMinutes:null,sourceStatus:'UNKNOWN',reportedMmol:null});
function inspect(raw,stamp,nowMs){
 try{
  if(!adapter||adapter.VERSION!=='0.3.5-qa'||typeof adapter.prepare!=='function')return fail('ADAPTER_UNAVAILABLE');
  if(typeof raw!=='string'||raw.length===0||raw.length>8000000)return fail('INVALID_SNAPSHOT_SIZE');
  const s=JSON.parse(raw);if(!s||typeof s!=='object'||!s.data||!Array.isArray(s.data.cgm))return fail('INVALID_SNAPSHOT');
  // Validate only the CGM portion. The deliberately absent non-CGM arrays are not evidence of empty history.
  const cgmOnly={schemaVersion:s.schemaVersion,profileId:s.profileId,profileConfigured:s.profileConfigured,status:s.status,revision:s.revision,inputRevision:s.inputRevision,data:{cgm:s.data.cgm,events:[],mealSessions:[],conditionPeriods:[],...('cgmArchivePresent' in s.data?{cgmArchivePresent:s.data.cgmArchivePresent}:{})}};
  const p=adapter.prepare(JSON.stringify(cgmOnly),stamp,nowMs);
  const observed=s.data.cgm.filter(x=>x.provenance==='observed');
  const archive=s.data.cgmArchivePresent===true||s.data.cgm.some(x=>x.provenance==='archived');
  const base={stamp:p.stamp,archivePresent:archive,windowLimitReached:s.data.cgm.length===2000,latestAt:null,ageMinutes:null,sourceStatus:'UNKNOWN',reportedMmol:null,notes:['QUALITY_SCORE_UNKNOWN','CGM_COVERAGE_UNKNOWN','PHYSICAL_SENSOR_ID_UNKNOWN']};
  if(!observed.length)return out(archive?'ARCHIVED_ONLY':'BLOCKED',archive?'CGM_ARCHIVE_ONLY':'NO_CGM',base);
  const latest=observed.reduce((a,b)=>Date.parse(b.measuredAtUtc)>Date.parse(a.measuredAtUtc)?b:a);
  const age=(nowMs-Date.parse(latest.measuredAtUtc))/60000;
  const common={...base,latestAt:latest.measuredAtUtc,ageMinutes:age,sourceStatus:'XDRIP_LOCAL',transport:latest.transport,freshnessAtReceipt:latest.freshnessAtReceipt};
  // No fallback to older good rows when the latest observation is unverified, stale, or unknown.
  if(latest.quality==='UNVERIFIED_SOURCE')return out('BLOCKED','SOURCE_UNVERIFIED',common);
  if(latest.freshnessAtReceipt==='STALE'||age>15)return out('STALE','CGM_STALE',common);
  if(latest.freshnessAtReceipt!=='FRESH')return out('BLOCKED','CGM_FRESHNESS_UNKNOWN',common);
  return out('OBSERVED_ONLY','XDRIP_MODEL_QUALITY_UNKNOWN',{...common,reportedMmol:latest.glucoseMmolL});
 }catch(e){return fail(typeof e?.message==='string'&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'CGM_READ_FAILED');}
}
return Object.freeze({VERSION,inspect});
});
