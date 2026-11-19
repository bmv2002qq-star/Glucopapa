const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolve} = require('node:path');
const root = process.env.GLUCOPAPA_QA_SOURCE;
const {at,iso,minute,fromWeb} = require(resolve(root,'qa/mvp3-calculators/fixture.cjs'));
const storage = fromWeb('modules/GFStorage_v0.5.11/src/gfstorage_core.js');
const exporter = fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');

test('ST-01 / ST-04 / ST-07: same immutable fact across least-privilege ports and export', () => {
    let saved;
    const open = () => storage.createHost({clock:()=>iso(at),
        driver:{load:()=>saved,save:snapshot=>{saved=structuredClone(snapshot);}}});
    const host = open();
    const writer = host.connect('actionWriter');
    const event = {id:'SYNTHETIC-INJECTION-PORT-CHECK',insulinId:'rinfast',units:0.5,
        administeredAt:iso(at-minute),injectionSite:{region:'abdomen'}};
    writer.recordInjection(event,0);
    const check = instance => {
        const expected = [{type:'insulin_injection',status:'confirmed',...event}];
        for (const role of ['journal','research','calculator','graph','rinfast']) {
            const current = instance.connect(role).getSnapshot();
            assert.equal(current.revision,1);
            assert.deepEqual(current.events,expected);
            assert.equal(instance.connect(role).recordInjection,undefined);
        }
        for (const role of ['sport','settings','food','cgmAdapter','syncWriter','context']) {
            assert.equal(instance.connect(role).getSnapshot().events,undefined);
            assert.equal(instance.connect(role).recordInjection,undefined);
        }
        assert.equal(instance.connect('research').setProfile,undefined);
        assert.equal(instance.connect('journal').startSport,undefined);
        assert.equal(instance.connect('sport').setCoverage,undefined);
        assert.equal(instance.connect('settings').finishSport,undefined);
        const data = JSON.parse(exporter.exportJson(instance));
        assert.equal(data.revision,1);
        assert.deepEqual(data.events,expected);
    };
    check(host);
    for (const instance of [host,host,host,open()]) {
        const view = instance.connect('actionWriter');
        try { view.recordInjection(event,view.getRevision()); }
        catch (error) { assert.match(error.message,/Повтор|дублир/iu); }
        check(instance);
    }
});
