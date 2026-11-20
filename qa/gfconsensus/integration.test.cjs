'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {fromWeb,Storage}=require('../mvp3-calculators/fixture.cjs');
const Auto=fromWeb('integration/GFConsensusAutoSelection_v0.1.2.js');
const Graph=fromWeb('integration/GFGraphFourLines_v0.1.0.js');
const STEP=300000, END=Date.parse('2026-11-20T00:00:00Z');
const iso=t=>new Date(t).toISOString();

function history(count=315,ids=['GFForecast','GFAPSEnhancer']){
  const issued=[],actual=[],start=END-(count+26)*STEP;
  for(let i=0;i<count+30;i++){
    const ts=start+i*STEP;
    actual.push({ts,mmol:7,sourceDeviceId:'synthetic-consensus',valid:true,qualityFlag:'ok',receivedAt:iso(ts+1000)});
  }
  for(let i=0;i<count;i++){
    const t=start+i*STEP;
    for(const id of ids)issued.push({contract:'glucopapa.research-forecast/2',
      modelId:id,modelVersion:'0.1.0',sourceId:'synthetic-consensus',sourceRevision:1,
      inputDigest:'e'.repeat(64),forecastAt:iso(t),sourceTime:iso(t),
      sourceReceivedAt:iso(t),snapshot:{sensorSourceId:'synthetic-consensus'},
      points:Array.from({length:25},(_,j)=>({horizonMin:j*5,at:iso(t+j*STEP),
        glucoseMmol:id==='GFForecast'?7:id==='GFAPSEnhancer'?9:8.5}))});
  }
  return {issued,actual,asOf:END};
}
test('two research models select leader only after enough shared history',()=>{
  const r=Auto.evaluate(history());assert.equal(r.status,'LEADER');assert.equal(r.leader,'GFForecast');
  assert.equal(r.modelIds.length,2);assert.ok(r.results.every(x=>x.n>=288));
  assert.equal(Auto.evaluate(history(25)).status,'NO_LEADER');
});
test('a third model is optional; not a fake GFxDrip forecast',()=>{
  assert.equal(Auto.evaluate(history(315,['GFForecast','GFxDrip','GFAPSEnhancer'])).status,'LEADER');
  const h=history(1),source=h.issued[0],graph=Graph.select({
    forecasts:h.issued.map(payload=>({payload})),sourceId:'synthetic-consensus',
    sourceTime:Date.parse(source.sourceTime),nowMs:Date.parse(source.forecastAt)+1000});
  assert.deepEqual(graph.missingModels,['GFxDrip']);
  assert.equal(graph.lines[0].modelId,'GFConsensus');
  assert.equal(graph.lines[0].points[12].glucoseMmol,8);
});
test('later-arrived CGM is never treated as previous prediction evidence',()=>{
  const f=history();
  f.actual.forEach(x=>x.receivedAt=iso(END+STEP));
  assert.equal(Auto.evaluate(f).status,'NO_LEADER');
});
test('four independent visibility flags persist through the GFStorage graph contract',()=>{
  const host=Storage.createHost(),port=host.connect('graph');
  const flags={GFConsensus:false,GFForecast:true,GFxDrip:false,GFAPSEnhancer:true};
  port.setPreferences({forecastVisibility:flags},port.getRevision());
  assert.deepEqual(port.getSnapshot().graphPreferences.forecastVisibility,flags);
  const rows=history(1).issued.map(payload=>({payload}));
  const ctx={forecasts:rows,sourceId:'synthetic-consensus',sourceTime:Date.parse(rows[0].payload.sourceTime),
    nowMs:Date.parse(rows[0].payload.forecastAt)+1000};
  assert.deepEqual(Graph.select({...ctx,preferences:{forecastVisibility:flags}}).lines.map(x=>x.modelId),['GFForecast','GFAPSEnhancer']);
});
test('read-only GFStorage adapter does not increment revision',()=>{
  const host=Storage.createHost(),prior=host.connect('research').getRevision();
  const result=Auto.fromHost(host,END);
  assert.equal(result.status,'NO_LEADER');
  assert.equal(host.connect('research').getRevision(),prior);
});
test('runtime and HTML load both candidates before app exactly once',()=>{
  const web=join(__dirname,'../../android-mvp3/app/src/main/assets/www');
  const html=readFileSync(join(web,'index.html'),'utf8'),order=readFileSync(join(web,'runtime/LOAD_ORDER.txt'),'utf8');
  for(const path of ['integration/GFConsensusAutoSelection_v0.1.2.js','integration/GFGraphFourLines_v0.1.0.js']){
    assert.equal(order.split(path).length-1,1);
    assert.equal(html.split('src="'+path+'"').length-1,1);
    assert.ok(html.indexOf(path)<html.indexOf('src="app.js"'));
    assert.ok(order.indexOf(path)<order.indexOf('\napp.js'));
  }
  assert.equal((html.match(/data-model-visibility="GFConsensus"/g)||[]).length,2);
});
