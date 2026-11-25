'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const gate=require('./GFHighLowInputGateV3.js');
const fixtures=JSON.parse(fs.readFileSync(__dirname+'/parity_fixtures.json','utf8'));
const f=fixtures[0];const cases=[];
function test(id,raw,stamp,clock,code){const r=gate.inspect(raw,stamp,clock);assert.equal(r.status,'BLOCKED',id);if(code)assert.equal(r.code,code,id);for(const k of ['allowDose','allowRecommendation','forecastInputEligible','clinicalUseAllowed','insulinDoseDecisionAllowed','automaticInjectionAllowed'])assert.equal(r[k],false,id);for(const k of ['glucose','iob','cob']){assert.equal(r[k].status,'UNKNOWN',id);assert.equal(r[k].value,null,id);assert(Object.isFrozen(r[k]),id)}for(const k of ['foodCoverage','insulinCoverage','cgmCoverage'])assert.equal(r[k],'NOT_PROVEN',id);assert.equal(r.qualityScore,null,id);assert.equal(r.activityEffect,'NOT_APPLIED',id);assert(Object.isFrozen(r)&&Object.isFrozen(r.issues),id);cases.push({id,raw,stamp,clock,expected:r});}
for(const x of fixtures)test(x.id,x.raw,x.stamp,x.now);
test('valid',f.raw,f.stamp,f.now,'THERAPEUTIC_INPUT_NOT_READY');
test('revision-change',f.raw,{...f.stamp,revision:f.stamp.revision+1},f.now,'REVISION_OR_PROFILE_CHANGED');
test('invalid-clock',f.raw,f.stamp,-1,'INVALID_CLOCK');
test('schema5',f.raw,{...f.stamp,schemaVersion:5},f.now,'REVISION_OR_PROFILE_CHANGED');
const v=[null,false,true,-1,0,1.5,'bad',[],{}];
for(const key of Object.keys(f.stamp))for(const val of v)test('stamp-'+key+'-'+JSON.stringify(val),f.raw,{...f.stamp,[key]:val},f.now);
for(const val of v)test('clock-'+JSON.stringify(val),f.raw,f.stamp,val);
for(const raw of ['', '{','[]','null','{"__proto__":{"allowDose":true}}'])test('raw-'+raw,raw,f.stamp,f.now);
fs.writeFileSync(__dirname+'/gate_fixtures.json',JSON.stringify(cases));console.log(JSON.stringify({total:cases.length,pass:cases.length,fail:0,scope:'diagnostic availability only, no clinical authorization'}));
