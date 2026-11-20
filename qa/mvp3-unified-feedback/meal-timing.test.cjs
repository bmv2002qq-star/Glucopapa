'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const web = '../../android-mvp3/app/src/main/assets/www/';
const Storage = require(web+'modules/GFStorage_v0.5.12/src/gfstorage_core.js');
require(web+'modules/GFSettings_v0.1.8/src/gfsettings.js');
require(web+'modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js');
require(web+'shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
require(web+'integration/GFInsulinEvidenceGate_v0.1.0.js');
const writer = require(web+'integration/GFInjectionFact_v0.1.0.js');
const engine = require(web+'modules/GFInjectionAnalytics_v0.2.1/GFInjectionAnalytics_v0.2.1.js');
const service = require(web+'integration/GFMealTimingService_v0.1.0.js');
const fixture = require('../../android-mvp3/app/src/androidTest/assets/meal-timing-case.js');

function setup() {
    let clock = Date.parse('2026-11-20T08:30:00Z'), disk, fail = false;
    const open = () => Storage.createHost({
        clock: () => new Date(clock).toISOString(),
        driver: {load:()=>disk, save(next){if(fail)throw Error('SYNTHETIC_WRITE_FAILED');disk=structuredClone(next);}},
    });
    const host = open();
    const meal = fixture.prepare(host,clock);
    const request = {sessionId:meal.mealId,units:meal.units,site:meal.site,atIso:meal.atIso,mode:'local'};
    const item = {id:'qa-actual-shot',insulinId:'rinfast',units:meal.units,administeredAt:meal.atIso,injectionSite:{region:meal.site}};
    const refresh = () => service.refresh(host,request);
    const record = (overrides={}) => writer.record({
        host,item,mealId:meal.mealId,confirmed:true,revision:host.diagnostics().revision,mealWorkflow:true,...overrides,
    });
    return {host,open,meal,request,item,refresh,record,now:()=>clock,advance:ms=>{clock+=ms;},
        fail:flag=>{fail=flag;},replace:s=>{disk=s;}};
}

test('the unchanged GFIA result is saved in one factual injection and restored', () => {
    const s=setup();
    const before=s.host.exportState(), result=s.refresh();
    assert.deepEqual(s.host.exportState(),before);
    assert.equal(result.estimate?.version,engine.VERSION,JSON.stringify(result));
    assert.equal(result.estimate.matchedCases,6);
    assert.ok(result.estimate.minutes>=10&&result.estimate.minutes<=15);
    assert.equal(s.host.connect('mealTiming').readPreview(s.meal.mealId),result);
    assert.equal(s.host.connect('mealTiming').readPreview('another-meal'),null);
    assert.equal(s.record().revision,before.revision+1);
    assert.equal(s.record().idempotent,true);
    s.advance(60000);
    const restored=s.open(), snapshot=restored.exportState();
    const shot=snapshot.events.at(-1);
    assert.equal(snapshot.events.length,before.events.length+1);
    assert.equal(restored.connect('mealTiming').readPreview(s.meal.mealId),null);
    assert.deepEqual(shot.mealTiming.estimate,result.estimate);
    assert.equal(shot.mealTiming.sourceRevision,before.revision);
    assert.equal(service.countdown(shot,s.now()),(result.estimate.minutes-1)*60);
    assert.equal(service.countdown(shot,s.now()+3600000),0);
    assert.equal(service.countdown({...shot,linkedMealSessionId:'different'},s.now()),null);
});

test('failure to write, mismatched site and stale revision do not leave partial evidence', () => {
    const s=setup();
    s.refresh();
    const prior=s.host.exportState();
    assert.throws(()=>s.record({item:{...s.item,injectionSite:{region:'arm'}}}),/MEAL_TIMING_STALE/);
    s.fail(true);
    assert.throws(s.record,/SYNTHETIC_WRITE_FAILED/);
    assert.deepEqual(s.open().exportState(),prior);
    s.fail(false);
    const settings=s.host.connect('settings');
    GFSettings.createSettingsService({settingsPort:settings}).saveProfile({displayName:'SYNTHETIC'},settings.getRevision());
    assert.equal(s.host.connect('mealTiming').readPreview(s.meal.mealId),null);
    assert.throws(s.record,/MEAL_TIMING_STALE/);
    s.refresh();
    s.record();
    assert.equal(s.open().exportState().events.length,prior.events.length+1);
});

test('an unavailable interval allows the confirmed factual administration without a timer', () => {
    const s=setup();
    const result=service.refresh(s.host,{...s.request,mode:'demo'});
    assert.equal(result.estimate,null);
    assert.equal(result.code,'NON_LOCAL_HISTORY');
    s.record();
    const shot=s.open().exportState().events.at(-1);
    assert.equal(shot.id,s.item.id);
    assert.equal(shot.mealTiming,undefined);
    assert.equal(service.countdown(shot,s.now()),null);
});

test('earlier actual meal time and subsequent edits leave the accepted interval intact', () => {
    const s=setup();
    s.refresh();
    s.record();
    const original=s.host.exportState().events.at(-1);
    s.advance(120000);
    const control=GFMealController.createController(s.host);
    control.startMeal(s.meal.mealId,new Date(s.now()-3*60000).toISOString(),{actuallyStarted:true});
    control.actualFood(s.meal.mealId,s.meal.plate,{parentConfirmed:true});
    control.finishMeal(s.meal.mealId,new Date(s.now()).toISOString(),{confirmed:true});
    control.actualFood(s.meal.mealId,s.meal.plate,{parentConfirmed:true,reason:'SYNTHETIC correction'});
    const settings=s.host.connect('settings');
    GFSettings.createSettingsService({settingsPort:settings}).setCoefficientMode('carb_g_per_u','auto',settings.getRevision());
    assert.deepEqual(s.open().exportState().events.at(-1),original);
    assert.ok(Date.parse(control.lookup(s.meal.mealId).startedAt)<Date.parse(original.administeredAt));
    const corrupt=structuredClone(s.open().exportState());
    corrupt.events.at(-1).mealTiming.sessionId='other-session';
    s.replace(corrupt);
    assert.throws(s.open,/Некорректная связь интервала/);
});
