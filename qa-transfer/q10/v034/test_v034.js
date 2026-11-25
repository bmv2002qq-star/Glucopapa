'use strict';
const assert=require('node:assert/strict');
const core=require('../donor-audit/GFSafety.js');
const adapter=require('./Q10V3DonorProjection.js');
const now='2026-01-01T12:00:00Z',ts=Date.parse(now);
const row=i=>({profileId:'qa-profile',sourceDeviceId:'qa-channel',source:'xdrip_local',provenance:'observed',quality:'VALID',measuredAtUtc:new Date(ts-(26-i*5)*60000).toISOString(),receivedAtUtc:new Date(ts-(26-i*5)*60000+1000).toISOString(),glucoseMmolL:6.4});
const snapshot=()=>({schemaVersion:3,revision:10,inputRevision:9,profileConfigured:true,profileId:'qa-profile',status:'READY_STORAGE',data:{cgm:Array.from({length:6},(_,i)=>row(i)),events:[],mealSessions:[],conditionPeriods:[]}});
let n=0;
function ck(label,f){f();n++;console.log('PASS '+label);}
function run(s,clock=now,c=core){const x=adapter.evaluate(s,clock,c);for(const k of ['forecastInputEligible','clinicalUseAllowed','insulinDoseDecisionAllowed','automaticInjectionAllowed'])assert.equal(x[k],false);assert.equal(x.status,'BLOCKED');return x;}
ck('exact_core_observational_projection',()=>{const r=run(snapshot());assert.equal(r.donorVersion,'0.1.0');assert.equal(r.counts.cgm,6);assert(r.donorIssues.includes('INCOMPLETE_HISTORY'));assert(r.reasons.includes('SOURCE_QUALITY_NOT_CERTIFIED'));});
ck('no_quality_score_invented',()=>assert(run(snapshot()).reasons.includes('SOURCE_QUALITY_NOT_CERTIFIED')));
ck('wrong_schema_not_coerced',()=>{let s=snapshot();s.schemaVersion=5;assert.equal(run(s).code,'V3_SNAPSHOT_UNAVAILABLE');});
ck('clock_failure_closed',()=>assert.equal(run(snapshot(),'not-a-clock').code,'V3_DONOR_READ_FAILED'));
ck('invalid_number_closed',()=>{let s=snapshot();s.data.cgm[0].glucoseMmolL=NaN;assert.equal(run(s).code,'CGM_PROVENANCE_UNVERIFIED');});
ck('missing_quality_closed',()=>{let s=snapshot();delete s.data.cgm[0].quality;assert.equal(run(s).code,'CGM_QUALITY_UNKNOWN');});
ck('foreign_profile_closed',()=>{let s=snapshot();s.data.cgm[0].profileId='foreign';assert.equal(run(s).code,'CGM_PROVENANCE_UNVERIFIED');});
ck('archive_not_live',()=>{let s=snapshot();s.data.cgm.push({provenance:'archived'});assert.equal(run(s).counts.cgm,6);});
ck('missing_receipt_not_invented',()=>{let s=snapshot();delete s.data.cgm[5].receivedAtUtc;assert(run(s).donorIssues.includes('CGM_RECEIPT_UNKNOWN'));});
ck('source_read_exception_closed',()=>{let s=snapshot();Object.defineProperty(s,'data',{get(){throw Error('fixture');}});assert.equal(run(s).code,'V3_DONOR_READ_FAILED');});
ck('over_capacity_closed',()=>{let s=snapshot();s.data.cgm=Array(2001).fill(row(0));assert.equal(run(s).code,'V3_SNAPSHOT_CONTRACT');});
ck('at_capacity_never_complete',()=>{let s=snapshot();s.data.cgm=Array(2000).fill({provenance:'archived'});assert(run(s).reasons.includes('POSSIBLY_TRUNCATED_CGM'));});
ck('bad_core_report_closed',()=>assert.equal(run(snapshot(),now,{VERSION:'0.1.0',parseIso:core.parseIso,evaluate:()=>({clinicalUseAllowed:true})}).code,'DONOR_REPORT_CONTRACT'));
ck('no_mutation',()=>{let s=snapshot(),before=JSON.stringify(s);run(s);assert.equal(JSON.stringify(s),before);});
console.log('Q10 V034 '+n+'/'+n+' PASS');