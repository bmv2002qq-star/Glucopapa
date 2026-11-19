'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {at,minute,iso,fromWeb,mutate,Evidence} = require('../mvp3-calculators/fixture.cjs');
const Storage = fromWeb('modules/GFStorage_v0.5.11/src/gfstorage_core.js');
const Settings = fromWeb('modules/GFSettings_v0.1.8/src/gfsettings.js');
const Journal = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal.js');
const JournalAdapter = fromWeb('modules/GFJournal_v0.1.3/src/gfjournal_storage_adapter.js');

test('ILL-03 / ILL-06: reconstruct factor as of each revision interval and preserve OFF=1', () => {
    let persisted, now=at;
    const open=()=>Storage.createHost({clock:()=>iso(now),driver:{load:()=>persisted,save:state=>{persisted=structuredClone(state);}}});
    let host=open();
    const make=()=>Settings.createSettingsService({settingsPort:host.connect('settings'),clock:()=>iso(now)});
    const change=v=>make().setIllnessFactor(v,make().getRevision());
    const check=(mins,active,factor)=>{
        const ms=at+mins*minute;
        const expected=make().getView(iso(ms)).illness;
        assert.equal(expected.active,active);
        assert.equal(expected.effectiveFactor,factor);
        for (const route of ['low','high','meal']) {
            const view=Evidence.inspect({route,host,nowMs:ms});
            assert.equal(view.revision,host.diagnostics().revision);
            assert.equal(view.result,null);
            assert.equal(view.trace.illness.effectiveFactor,factor);
        }
    };
    mutate(host,'context','openPeriod',{id:'SYNTHETIC-ILLNESS',kind:'illness',start:iso(at)});
    check(-1,false,1);
    check(0,true,null);
    now=at+minute; change(1.2);
    now=at+4*minute; change(1.4);
    now=at+6*minute; mutate(host,'settings','updateProfile',{illnessFactor:null});
    now=at+8*minute; mutate(host,'context','closePeriod',{id:'SYNTHETIC-ILLNESS',end:iso(now)});
    now=at+10*minute; change(1.6);
    host=open();
    for (const row of [[-1,false,1],[0,true,null],[1,true,1.2],[3,true,1.2],
        [4,true,1.4],[6,true,null],[8,false,1],[10,false,1]]) check(...row);
    assert.equal(host.exportState().profile.illnessFactor.value,1.6);
});

test('ACT-02 / ACT-03: one restored sport session, duplicate start/end rejected, factual diary duration', () => {
    let saved, now=at;
    const open=()=>Storage.createHost({clock:()=>iso(now),driver:{load:()=>saved,save:d=>{saved=structuredClone(d);}}});
    let host=open(), first={id:'SYNTHETIC-SPORT',start:iso(now)};
    mutate(host,'activityUi','setBaseLevel','high');
    mutate(host,'sport','startSport',first);
    const rev=host.diagnostics().revision;
    assert.throws(()=>mutate(host,'sport','startSport',{id:'SYNTHETIC-SPORT-2',start:first.start}));
    host=open();
    assert.equal(host.diagnostics().revision,rev);
    assert.equal(host.exportState().conditionPeriods[0].end,null);
    assert.throws(()=>mutate(host,'activityUi','setBaseLevel','low'));
    now=at+30*minute;
    const end={id:first.id,end:iso(now)};
    mutate(host,'sport','finishSport',end);
    assert.throws(()=>mutate(host,'sport','finishSport',end));
    const recovered=open();
    assert.equal(recovered.exportState().profile.activityBaseLevel,'high');
    const rows=Journal.buildAll(JournalAdapter.connect(recovered).read()).rows.filter(r=>r.kind==='sport');
    assert.equal(rows.length,1);
    assert.equal(rows[0].durationMinutes,30);
    assert.equal(recovered.diagnostics().revision,rev+1);
});
