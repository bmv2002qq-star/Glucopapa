'use strict';

const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {test}=require('node:test');
const {at,minute,iso,mutate,testJournal,addPlate,Storage}=require('../mvp3-calculators/fixture.cjs');
const {project,ENGINE_SHA256}=require('./gfxdrip-adapter.cjs');

function scenario({count=2,delay=5,quality=true,sourceType='device_recorded',complete=true,covered=true}={}){
    let now=at-25*minute;
    let disk=testJournal({coverage:covered}).exportState();
    const driver={load:()=>disk,save:state=>{disk=state;}};
    const host=Storage.createHost({driver,clock:()=>iso(now)});
    const sensor='SYNTHETIC-GFXDRIP-PARITY';
    for(let i=0;i<count;i++)mutate(host,'actionWriter','recordInjection',{
        id:'rapid-'+i,insulinId:'rinfast',units:0.5,administeredAt:iso(at-(60+i*5)*minute),
    });
    mutate(host,'actionWriter','recordInjection',{id:'long',insulinId:'levemir',units:1,administeredAt:iso(at-78*minute)});
    const {controller,id,plate}=addPlate(host,{grams:75,carbs:14.925,estimated:false,atMs:now});
    controller.ready(id);
    controller.startMeal(id,iso(now),{actuallyStarted:true});
    if(complete){
        controller.actualFood(id,plate,{parentConfirmed:true});
        now+=5*minute;
        controller.finishMeal(id,iso(now),{confirmed:true});
    }
    const plan=addPlate(host,{id:'never-confirmed',grams:100,carbs:190,atMs:now});
    plan.controller.ready(plan.id);
    now=at;
    mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:sensor,sourceType,qualityScore:1,samplingMinutes:5});
    mutate(host,'cgmAdapter','ingestReadings',Array.from({length:6},(_,i)=>{
        const ts=at-(delay+(5-i)*5)*minute;
        return {ts,receivedAt:iso(ts+minute),sourceDeviceId:sensor,mmol:6+i/10,valid:quality,qualityFlag:'ok'};
    }));
    const revision=host.connect('research').getRevision();
    const request={host,nowMs:at,foodHistory:{source:'user_declared',scope:'all_meals',sourceRevision:revision,
        confirmedComplete:true,startIso:iso(at-13*60*minute),endIso:iso(at),declaredAtIso:iso(at)},
        absorption:{scope:'SYNTHETIC_PARITY',revision,rateGPerHour:35,delayMinutes:15,momentum:false}};
    return {request,id};
}

test('GFxDrip input reads 0/1/N confirmed rapid injections and actual food in one revision',()=>{
    for(const n of [0,1,2]){
        const {request,id}=scenario({count:n});
        const initial=request.host.exportState();
        const result=project(request);
        assert.equal(result.status,'READY_FOR_PRIVATE_PARITY',JSON.stringify(result));
        assert.deepEqual(result.injectionIds,Array.from({length:n},(_,i)=>'rapid-'+i));
        assert.deepEqual(result.mealIds,[id]);
        assert.deepEqual(result.config.meals,[{t:-25,grams:14.925}]);
        assert.equal(result.config.cgm.at(-1).t,-5);
        assert.equal(result.config.horizon,120);
        assert.deepEqual(request.host.exportState(),initial);
    }
});

test('GFxDrip input blocks stale, low-quality, synthetic and missing histories and missing absorption rule',()=>{
    for(const [options,reason] of [
        [{delay:11},'CGM_STALE_10MIN'],[{sourceType:'synthetic'},'SYNTHETIC_CGM_EXCLUDED'],
        [{quality:false},'CGM_NOT_ENOUGH'],[{complete:false},'UNFINISHED_MEAL'],[{covered:false},'RAPID_HISTORY_INCOMPLETE'],
    ]){
        const {request}=scenario(options);
        assert.deepEqual(project(request),{status:'BLOCKED',code:reason,clinicalUse:false});
    }
    const {request}=scenario();
    assert.equal(project({...request,absorption:null}).code,'FIXED_ABSORPTION_RULE_UNATTESTED');
    assert.equal(project({...request,foodHistory:null}).code,'NEEDS_FRESH_USER_ATTESTATION');
});

if(process.env.GLUCOPAPA_GFXDRIP_ENGINE){
    test('private run equals the unchanged archive kernel on the same full configuration',()=>{
        const source=resolve(process.env.GLUCOPAPA_GFXDRIP_ENGINE);
        assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),ENGINE_SHA256);
        const engine=require(source);
        for(const n of [0,1,2]){
            const {request}=scenario({count:n});
            const result=project(request);
            assert.equal(result.status,'READY_FOR_PRIVATE_PARITY');
            const independent={
                cgm:[6,6.1,6.2,6.3,6.4,6.5].map((v,i)=>({t:-30+5*i,v})),
                meals:[{t:-25,grams:14.925}],insulins:Array.from({length:n},(_,i)=>({t:-60-5*i,units:0.5})),
                isf:3,carbRatio:12,diaHours:request.host.connect('rinfast').read('models').rinfast.profile.diaMinutes/60,
                horizon:120,mode:'legacySum',momentum:false,absorbRate:35,delayMin:15,
            };
            assert.deepEqual(engine.forecast(result.config),engine.forecast(independent));
        }
    });
}
