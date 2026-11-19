const fs = require('node:fs');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');
const {resolve} = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.GLUCOPAPA_QA_SOURCE;
const fixture = resolve(root,'qa/mvp3-calculators/fixture.cjs');
const {at,iso,minute,web,testJournal,mutate} = require(fixture);
const {study} = require(resolve(root,'qa/mvp3-calculators/research-forecast.cjs'));
const ctx = {};
const runtime = fs.readFileSync(resolve(web,'runtime/LOAD_ORDER.txt'),'utf8');
for (const file of runtime.split(/\r?\n/).filter(line => /modules\/GFAAPSResearch|modules\/GFAPSEnhancer/.test(line))) {
    runInNewContext(fs.readFileSync(resolve(web,file),'utf8'),ctx,{filename:file});
}

test('Pinned GFForecast and AAPS-inspired engine independently preserve a stable synthetic CGM history', t => {
    const host = testJournal();
    const sourceId = 'SYNTHETIC-FORECAST-STABLE';
    mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:sourceId,sourceType:'synthetic',samplingMinutes:5,qualityScore:1});
    const readings = Array.from({length:13}, (_,n) => ({ts:at-(12-n)*5*minute,
        receivedAt:iso(at-(12-n)*5*minute),sourceDeviceId:sourceId,valid:true,qualityFlag:'ok',mmol:6}));
    mutate(host,'cgmAdapter','ingestReadings',readings);
    const port = host.connect('research'), snapshot = port.getSnapshot();
    const before = JSON.stringify(snapshot);
    const gf = study(host);
    assert.equal(gf.status, 'RESEARCH_ONLY');
    const aaps = ctx.GFAPSEnhancer.compute({researchSnapshot:snapshot,nowTs:at,
        parameters:{isfMmolPerU:3,crGPerU:12,diaMinutes:300,peakMinutes:75}});
    assert.equal(aaps.sourceRevision,gf.revision);
    assert.equal(aaps.details.aaps.ok,true);
    assert.equal(gf.forecast.points.length,25);
    assert.equal(aaps.details.aaps.points.length,25);
    assert.ok(gf.forecast.points.every(p=>p.glucoseMmol===6));
    assert.ok(aaps.details.aaps.points.every(p=>p.IOB===6&&p.COB===6&&p.UAM===6));
    const invalid = ctx.GFAPSEnhancer.compute({researchSnapshot:{...snapshot,cgm:snapshot.cgm.slice(1)},nowTs:at,
        parameters:{isfMmolPerU:3,crGPerU:12,diaMinutes:300,peakMinutes:75}});
    assert.equal(invalid.details.aaps.ok,false);
    assert.equal(invalid.details.aaps.points.length,0);
    assert.equal(JSON.stringify(port.getSnapshot()),before);
    t.diagnostic(JSON.stringify({fixture:'SYNTHETIC_STABLE_CGM',revision:snapshot.revision,pointsByModel:[25,25],
        expectedMmol:6,thirdEngine:'LICENSE_BLOCKED'}));
});
