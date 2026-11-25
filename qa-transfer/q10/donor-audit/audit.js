'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=__dirname;
const refs={
 'GFSafety.js':'73c4d920a6f6a652f24ccaefb2388cc3cb6d8866',
 'GFSafetyBridge.js':'f2b98732d21e04595c9e0da80744437b2c3effad',
 'GFCgmEvidencePolicy.js':'72a5c9de5e74d55d971cd22b468aadb95dbd310e'
};
let n=0;const results=[];
const ck=(label,fn)=>{fn();n++;results.push({id:label,pass:true});console.log('PASS '+label);};
for(const [file,expected] of Object.entries(refs))ck('exact_git_blob_'+file,()=>{const b=fs.readFileSync(path.join(root,file));assert.equal(crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'),expected);});
const safety=require('./GFSafety.js'),bridge=require('./GFSafetyBridge.js'),policy=require('./GFCgmEvidencePolicy.js');
const now=Date.parse('2026-01-01T12:00:00Z'),iso=x=>new Date(x).toISOString(),source='qa-isolated-fixture',rev=10;
// All observations, events and coverage below are fictitious isolated contract fixtures.
const reads=Array.from({length:6},(_,i)=>({measuredAt:iso(now-(26-i*5)*60000),receivedAt:iso(now-(26-i*5)*60000+1000),glucoseMmol:6.4,sourceId:source,valid:true,qualityFlag:'ok'}));
const coverage={confirmedComplete:true,declaredBy:'parent',provenance:'synthetic_demo',startIso:iso(now-48*3600000),endIso:iso(now-60000)};
const basic={sourceSchema:'QA_FIXTURE_ONLY',nowIso:iso(now),readings:reads,injections:[],meals:[],coverage,conditions:{illness:false,activity:false},sourceStatus:{type:'device_recorded'}};
const clone=x=>JSON.parse(JSON.stringify(x));
const noClinical=r=>{assert.equal(r.clinicalUseAllowed,false);assert.equal(r.insulinDoseDecisionAllowed,false);};
const code=(r,c)=>assert(r.issues.some(x=>x.code===c),JSON.stringify(r));
ck('core_fixture_contract',()=>{const r=safety.evaluate(basic);assert.equal(r.status,'DATA_OK');noClinical(r);assert.equal(r.automaticInjectionAllowed,false);});
ck('core_missing_coverage',()=>{const r=safety.evaluate({...basic,coverage:{confirmedComplete:false}});assert.equal(r.status,'BLOCKED');code(r,'INCOMPLETE_HISTORY');noClinical(r);});
ck('core_synthetic_source',()=>{const r=safety.evaluate({...basic,sourceStatus:{type:'synthetic'}});assert.equal(r.status,'BLOCKED');code(r,'CGM_SYNTHETIC_SOURCE');noClinical(r);});
ck('core_missing_receipt',()=>{const b=clone(basic);delete b.readings[0].receivedAt;const r=safety.evaluate(b);assert.equal(r.status,'CAUTION');code(r,'CGM_RECEIPT_UNKNOWN');assert.equal(r.forecastInputEligible,false);noClinical(r);});
ck('core_conflicting_reading',()=>{const b=clone(basic);b.readings.push({...b.readings[5],glucoseMmol:7});const r=safety.evaluate(b);assert.equal(r.status,'BLOCKED');code(r,'CGM_CONFLICT');noClinical(r);});
ck('core_future_reading',()=>{const b=clone(basic);b.readings[5].measuredAt=iso(now+120000);const r=safety.evaluate(b);assert.equal(r.status,'BLOCKED');code(r,'CGM_INVALID_RECORD');});
ck('core_nonfinite',()=>{const b=clone(basic);b.readings[5].glucoseMmol=NaN;const r=safety.evaluate(b);assert.equal(r.status,'BLOCKED');code(r,'INVALID_SNAPSHOT');});
ck('core_independent_context',()=>{const r=safety.evaluate({...basic,conditions:{illness:true,activity:true}});code(r,'ILLNESS_CONTEXT');code(r,'ACTIVITY_CONTEXT');assert.equal(r.forecastInputEligible,false);});
const v2cgm=reads.map(r=>({ts:Date.parse(r.measuredAt),receivedAt:r.receivedAt,mmol:r.glucoseMmol,sourceDeviceId:source,valid:true,qualityFlag:'ok',transport:'xdrip_content_provider',direction:'Flat',staleAtReceipt:false}));
function host({schema=5,type='device_recorded',score=0.9,missing=false,archiveError=false,changed=false}={}){
 const meta={sourceDeviceId:source,sourceType:type,samplingMinutes:5};if(!missing)meta.qualityScore=score;
 const research={schemaVersion:schema,revision:rev,cgm:clone(v2cgm),events:[],mealSessions:[],coverage:{...coverage,provenance:'gfstorage'}};
 const analytics={schemaVersion:schema,revision:rev,cgmMetadata:meta,conditionPeriods:[]};
 const ports={research:{getRevision:()=>rev,getSnapshot:()=>research},injectionAnalytics:{getRevision:()=>rev,getSnapshot:()=>analytics},graph:{getRevision:()=>rev,getSnapshot:()=>research},cgmAdapter:{getRevision:()=>changed?rev+1:rev,read:()=>meta},archive:{summary:()=>{if(archiveError)throw Error('fixture read error');return null;},getRevision:()=>rev}};
 return {getSchemaVersion:()=>schema,connect:k=>{assert(k in ports,k);return ports[k];}};
}
const check=h=>bridge.connect(h,safety).check({nowIso:iso(now)});
ck('bridge_v3_schema_rejected',()=>{const r=check(host({schema:3}));assert.equal(r.code,'UNSUPPORTED_STORAGE_SCHEMA');noClinical(r);});
ck('bridge_xdrip_local_rejected',()=>{const r=check(host({type:'xdrip_local'}));assert.equal(r.code,'CGM_SOURCE_METADATA_MISSING');noClinical(r);});
ck('bridge_fixture_valid_score',()=>{const r=check(host());assert.equal(r.status,'DATA_OK');noClinical(r);});
ck('bridge_low_score_blocked',()=>{const r=check(host({score:0.5}));assert.equal(r.code,'CGM_QUALITY_TOO_LOW');noClinical(r);});
// Reproduction tests for EXISTING donor defects; PASS means the defect is reproduced, not repaired.
ck('DEFECT_bridge_missing_score_bypasses_threshold',()=>{const r=check(host({missing:true}));assert.equal(r.status,'DATA_OK');assert.equal(r.forecastInputEligible,true);noClinical(r);});
ck('DEFECT_bridge_nan_score_bypasses_threshold',()=>{const r=check(host({score:NaN}));assert.equal(r.status,'DATA_OK');assert.equal(r.forecastInputEligible,true);noClinical(r);});
ck('policy_v3_schema_rejected',()=>{const r=policy.inspect(host({schema:3}),{nowMs:now});assert.equal(r.code,'GFSTORAGE_UNAVAILABLE');});
ck('policy_missing_nonprovider_score_blocked',()=>{const r=policy.inspect(host({missing:true}),{nowMs:now});assert.equal(r.code,'CGM_SOURCE_QUALITY_LOW');});
ck('policy_provider_observed_only',()=>{const r=policy.inspect(host({type:'xdrip_local',missing:true}),{nowMs:now});assert.equal(r.status,'OBSERVED_ONLY');assert.equal(r.currentMmol,null);assert.equal(r.reportedMmol,6.4);});
ck('policy_provider_never_upgrades_to_model_permission',()=>{const r=policy.checkSafety(host({type:'xdrip_local',missing:true}),{check:()=>({status:'DATA_OK',forecastInputEligible:true})},{nowMs:now});assert.equal(r.status,'BLOCKED');assert.equal(r.forecastInputEligible,false);noClinical(r);});
ck('policy_mixed_revision_rejected',()=>{const r=policy.inspect(host({changed:true}),{nowMs:now});assert.equal(r.code,'REVISION_CHANGED');});
ck('DEFECT_policy_archive_exception_escapes',()=>assert.throws(()=>policy.inspect(host({archiveError:true}),{nowMs:now}),/fixture read error/));
ck('DEFECT_policy_invalid_clock_check_throws',()=>assert.throws(()=>policy.checkSafety(host(),{check:()=>({})},{nowMs:NaN}),RangeError));
const out={scope:'V2 exact donor compatibility audit only; synthetic data; no production changes',total:n,passed:n,defectReproductions:results.filter(x=>x.id.startsWith('DEFECT_')).map(x=>x.id),results};
fs.writeFileSync(path.join(root,'donor_audit_result.json'),JSON.stringify(out,null,2)+'\n');console.log(`TOTAL ${n}/${n} PASS (includes explicit reproductions of open defects)`);
