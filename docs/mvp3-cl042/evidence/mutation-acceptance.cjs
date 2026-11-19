'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createRequire} = require('node:module');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');
const {at, minute, iso, web, Rinfast}=require('../../../qa/mvp3-calculators/fixture.cjs');

const forecastPath='modules/GFForecast_v0.1.3/src/gfforecast.js';
const storagePath='modules/GFStorage_v0.5.11/src/gfstorage_core.js';
function load(file, edit) {
    const path=join(web,file);
    const context={module:{exports:{}},require:createRequire(path)};
    let bytes=readFileSync(path,'utf8');
    if (edit) {
        const [old,next]=edit;
        assert.equal(bytes.split(old).length,2);
        bytes=bytes.replace(old,next);
    }
    runInNewContext(bytes,context,{filename:path,timeout:1000});
    return runInNewContext('({...module.exports, jsonFromQA:text=>JSON.parse(text)})',context);
}
const samples=[25,20,15,10,5,0].map(n=>({sourceId:'SYNTHETIC-MUTATION',measuredAt:iso(at-n*minute),
    receivedAt:iso(at-n*minute),glucoseMmol:7}));
const input={nowIso:iso(at),readings:samples,sourceIsComplete:true,rinfastEngine:Rinfast,
    settings:{carbRatioGPerUnit:12,isfMmolPerUnit:3,mealTauMin:55},
    injections:[{id:'shot',insulinId:'rinfast',units:0.5,status:'confirmed',administeredAt:iso(at-55*minute)}],
    meals:[{id:'food',status:'confirmed',carbsG:14.925,eatenAt:iso(at-34*minute)}]};
const result=load(forecastPath).predict(input);
assert.equal(result.status,'EXPERIMENTAL');
const baseline=JSON.stringify(result.points);
const cases=[
    ['WRONG_SIGN','drift+insulin.delta(h)+meals.delta(h)','drift-insulin.delta(h)+meals.delta(h)'],
    ['TIMELINE_SHIFT','new Date(now+h*MS).toISOString()','new Date(now+(h+5)*MS).toISOString()'],
    ['DOUBLE_COB','drift+insulin.delta(h)+meals.delta(h)','drift+insulin.delta(h)+2*meals.delta(h)'],
    ['DOUBLE_IOB','drift+insulin.delta(h)+meals.delta(h)','drift+2*insulin.delta(h)+meals.delta(h)'],
    ['DROPPED_EVENT','request.injections||[]','[]'],
];
for(const [name,old,next] of cases){
    const shifted=load(forecastPath,[old,next]).predict(input);
    assert.throws(()=>assert.equal(JSON.stringify(shifted.points),baseline),assert.AssertionError,name);
}
function xdripReading(storage) {
    const host=storage.createHost({clock:()=>iso(at)}), adapter=host.connect('cgmAdapter');
    const observation=storage.jsonFromQA(JSON.stringify({ts:at,receivedAt:iso(at),mgdl:108.09354,direction:'Flat',staleAtReceipt:false}));
    adapter.ingestXDripObservation(observation,adapter.getRevision());
    return host.connect('research').read('cgm')[0].mmol;
}
assert.equal(xdripReading(load(storagePath)),6);
assert.throws(()=>assert.equal(xdripReading(load(storagePath,['XDRIP_MGDL_PER_MMOL=18.01559','XDRIP_MGDL_PER_MMOL=20'])),6),
    assert.AssertionError);
console.log(JSON.stringify({id:'E2E-09',status:'PASS',scope:'isolated-source-mutations',detected:[...cases.map(x=>x[0]),'MGDL_UNIT']},null,2));
