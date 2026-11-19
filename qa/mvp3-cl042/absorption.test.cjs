'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {at,minute,iso,fromWeb,mutate,testJournal,addPlate,Storage,Settings,Evidence} = require('../mvp3-calculators/fixture.cjs');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast.js');
fromWeb('modules/GFForecast_v0.1.3/src/gfforecast_storage_adapter.js');
const Readout = fromWeb('integration/GFForecastReadout_v0.1.0.js');
const Absorption = fromWeb('integration/GFMealAbsorption_v0.1.0.js');
const Auto = fromWeb('integration/GFAutoCOBProfile_v0.1.0.js');

const clock = () => iso(at);
const declaration = {source:'user_declared',confirmedComplete:true,declaredAtIso:iso(at),
    startIso:iso(at-13*60*minute),endIso:iso(at+5*minute)};
const confirm = host => ({historyDeclaration:declaration,mealCoverageRevision:host.connect('research').getRevision(),
    kineticsByMealId:Auto.inspect({host,nowMs:at}).kineticsByMealId??{}});
const inspect = (host,options) => Absorption.inspect({host,nowMs:at,options});
function food(host,{id='confirmed',grams=75,carbs=14.925,gi=49,start=45,estimated=false}={}) {
    const {controller,plate} = addPlate(host,{id,grams,carbs,gi,estimated});
    controller.ready(id);
    controller.startMeal(id,iso(at-start*minute),{actuallyStarted:true});
    mutate(host,'actionWriter','recordActualPlate',{sessionId:id,expectedVersion:controller.lookup(id).version,plate,opId:'fact-'+id});
    controller.finishMeal(id,iso(at-(start-10)*minute),{confirmed:true});
    return controller;
}

test('FOOD-06: persisted one model, audit and same-revision consumers with no input substitution',()=>{
    let stored = testJournal({glucose:7,sourceType:'device_recorded'}).exportState();
    const open = () => Storage.createHost({clock,driver:{load:()=>stored,save:state=>{stored=state;}}});
    const host = open();
    food(host);
    const old = confirm(host);
    const smooth = inspect(host,old);
    assert.equal(smooth.model.id,'GFForecast');
    assert.equal(smooth.code,'SMOOTH_PROFILE_MISSING');
    assert.equal(smooth.lowerG,null);
    assert.deepEqual(smooth.mealIds,['confirmed']);
    const prepare = (host,options) => Readout.prepare({host,mode:'local',nowMs:at,
        ...options,foodHistoryDeclaration:options.historyDeclaration,
        safetyVerdict:{status:'DATA_OK',forecastInputEligible:true,sourceRevision:options.mealCoverageRevision}});
    assert.equal(prepare(host,old).code,'SMOOTH_PROFILE_MISSING');

    const port = host.connect('settings');
    const settings = Settings.createSettingsService({settingsPort:port,clock});
    const picks = ['constructor','unknown'];
    for (const bad of picks) assert.throws(()=>settings.setMealAbsorptionModel(bad,port.getRevision()),/Неизвестная модель/);
    assert.throws(()=>settings.setMealAbsorptionModel('GFCOB',port.getRevision()-1),/Конфликт ревизии/);
    settings.setMealAbsorptionModel('GFCOB',port.getRevision());
    assert.equal(settings.setMealAbsorptionModel('GFCOB',port.getRevision()).idempotent,true);
    assert.equal(host.connect('research').setMealAbsorptionModel,undefined);
    assert.deepEqual(stored.history.at(-1).changes.mealAbsorptionModel,
        {before:null,after:{id:'GFCOB',version:'0.1.1'}});
    assert.equal(inspect(host,old).lowerG,null);

    const reopened = open(), current = confirm(reopened);
    const linear = inspect(reopened,current);
    assert.equal(linear.status,'RESEARCH_INTERVAL');
    assert.deepEqual(linear.model,{id:'GFCOB',version:'0.1.1'});
    assert.equal(linear.value,null);
    // The original medium preset spans 120–240 min, with zero lag.
    assert.ok(Math.abs(linear.lowerG-14.925*(1-45/240))<1e-9);
    assert.ok(Math.abs(linear.upperG-14.925*(1-45/360))<1e-9);
    assert.equal(linear.forecastReady,false);
    assert.equal(prepare(reopened,current).code,'LINEAR_INTERVAL_NO_POINT_MODEL');
    const reasons = ['low','high','meal'].map(route=>Evidence.inspect({host:reopened,route,nowMs:at,cobOptions:current}).trace.cob);
    for(const reason of reasons){
        assert.deepEqual(reason.model,linear.model);
        assert.equal(reason.upperG,linear.upperG);
        assert.equal(reason.contributions.length,1);
    }
    assert.throws(()=>Storage.createHost({driver:{load:()=>({...stored,profile:{...stored.profile,
        mealAbsorptionModel:{id:'GFCOB',version:'0.9.0'}}}),save(){}}}),/версия модели/);
});

test('FOOD-05: unknown GI, estimated actuals and incomplete stages are explicit',()=>{
    const unknown = testJournal();
    mutate(unknown,'settings','setMealAbsorptionModel','GFCOB');
    food(unknown,{gi:null});
    assert.equal(inspect(unknown,confirm(unknown)).code,'RESEARCH_PARAMETERS_REQUIRED');
    assert.equal(inspect(unknown,confirm(unknown)).upperG,null);

    const estimated = testJournal();
    food(estimated,{estimated:true});
    assert.equal(inspect(estimated,confirm(estimated)).code,'FOOD_DATA_UNKNOWN');

    const unfinished = testJournal();
    const draft = addPlate(unfinished,{estimated:false});
    draft.controller.ready(draft.id);
    draft.controller.startMeal(draft.id,iso(at-minute),{actuallyStarted:true});
    assert.equal(inspect(unfinished,confirm(unfinished)).code,'UNFINISHED_MEAL');
});

test('FOOD-07: plan, declared empty window and expired declarations cannot double-count food',()=>{
    const host = testJournal();
    addPlate(host,{id:'plan-only',estimated:false});
    assert.equal(inspect(host).status,'UNKNOWN');
    assert.equal(inspect(host).lowerG,null);
    const smooth = inspect(host,confirm(host));
    assert.equal(smooth.status,'MODEL_ZERO');
    assert.equal(smooth.forecastReady,true);
    assert.equal(smooth.upperG,0);
    const stale = {...confirm(host),historyDeclaration:{...declaration,declaredAtIso:iso(at-11*minute)}};
    assert.equal(inspect(host,stale).status,'UNKNOWN');
    mutate(host,'settings','setMealAbsorptionModel','GFCOB');
    assert.equal(inspect(host,confirm(host)).upperG,0);
    food(host,{id:'one',carbs:12,start:30,gi:62});
    food(host,{id:'two',carbs:10,start:90,gi:62});
    const two = inspect(host,confirm(host));
    assert.deepEqual(two.contributions.map(p=>p.mealId),['one','two']);
    assert.ok(Math.abs(two.lowerG-(12*(1-30/120)+10*(1-90/120)))<1e-9);
    assert.ok(Math.abs(two.upperG-(12*(1-30/240)+10*(1-90/240)))<1e-9);
});
