'use strict';

const assert=require('node:assert/strict');
const {test}=require('node:test');
const {at,minute,iso,fromWeb,mutate,testJournal}=require('../mvp3-calculators/fixture.cjs');
const Storage=fromWeb('modules/GFStorage_v0.5.12/src/gfstorage_core.js');
fromWeb('integration/GFConsensusAutoSelection_v0.1.2.js');
const Four=fromWeb('integration/GFGraphFourLines_v0.1.0.js');
const Consensus=fromWeb('integration/GFConsensusEvidence_v0.1.0.js');
const Main=fromWeb('integration/GFMainScreen_v1.0.0/gfmain_core.js');
const source='SYNTHETIC-SENSOR-CONTRACT';
const model={id:'GFForecast',version:'0.1.2'};

function packet(origin,ids=Four.IDS,sourceId=source,revision=0,version='1.0.0'){
  return ids.map(modelId=>{
    const modelVersion=version, identity=modelId+'@'+modelVersion;
    return {id:[iso(origin),iso(origin),identity].join('|'),kind:'research_forecast',payload:{
      contract:'glucopapa.research-forecast/2',modelId,modelVersion,version:identity,
      mode:'RESEARCH_FORECAST',status:'EXPERIMENTAL',forecastAt:iso(origin),sourceTime:iso(origin),
      sourceReceivedAt:iso(origin),sourceRevision:revision,inputDigest:'a'.repeat(64),mealModel:model,
      snapshot:{sensorSourceId:sourceId,flags:[]},clinicalUse:false,modelValidated:false,
      horizonMinutes:120,stepMinutes:5,uncertainty:null,
      points:Array.from({length:25},(_,i)=>({horizonMin:i*5,at:iso(origin+i*5*minute),
        glucoseMmol:modelId==='GFForecast'?6:7,lower:null,upper:null})),
    }};
  });
}
function observations(ends,sourceId=source){
  return ends.map(ts=>({ts,mmol:6,source:'device_recorded',kind:'observed',sourceDeviceId:sourceId,
    receivedAt:iso(ts),valid:true,qualityFlag:'ok'}));
}

test('both old visibility shapes migrate without writing on open or changing an explicit legacy flag',()=>{
  const old=structuredClone(Storage.createHost().exportState());
  old.graphPreferences={...old.graphPreferences,showForecastMean:false,forecastVisibility:{GFxDrip:false}};
  let disk=old;
  const driver={load:()=>structuredClone(disk),save:value=>{disk=structuredClone(value);}};
  const host=Storage.createHost({driver});
  assert.equal(old.graphPreferences.showForecastMean,false);
  const graph=host.connect('graph');
  assert.deepEqual(graph.read('graphPreferences').forecastVisibility,{GFxDrip:false,GFConsensus:false});
  assert.equal(graph.getRevision(),0);
  mutate(host,'graph','setPreferences',{forecastVisibility:{GFAPSEnhancer:false}});
  assert.equal(disk.graphPreferences.showForecastMean,undefined);
  assert.deepEqual(disk.graphPreferences.forecastVisibility,{GFxDrip:false,GFConsensus:false,GFAPSEnhancer:false});
  const again=Storage.createHost({driver}).connect('graph');
  assert.equal(again.setPreferences({forecastVisibility:{GFxDrip:false}},1).idempotent,true);
  assert.equal(again.getForecastInputRevision(),0);
  assert.throws(()=>again.setPreferences({showForecastMean:true},1));
});

test('all 16 combinations filter visualization alone; 0/1/2/3 models use only retained results',()=>{
  const allIds=[Four.MEAN,...Four.IDS];
  for(let count=0;count<=3;count++){
    const issued=packet(at,Four.IDS.slice(0,count));
    for(let flags=0;flags<16;flags++){
      const visibility=Object.fromEntries(allIds.map((m,i)=>[m,!!(flags&(1<<i))]));
      const args={forecasts:issued,sourceId:source,sourceTime:at,nowMs:at,preferences:{forecastVisibility:visibility}};
      const drawn=Four.select(args);
      assert.equal(drawn.availableModels.length,count);
      assert.equal(drawn.meanOf,count<2?0:count);
      const intended=[...(count>=2?[Four.MEAN]:[]),...Four.IDS.slice(0,count)].filter(modelId=>visibility[modelId]);
      assert.deepEqual(drawn.lines.map(row=>row.modelId),intended);
      assert.deepEqual(Four.select({...args,preferences:{...args.preferences,autoConsensus:false}}),drawn);
    }
  }
});

test('current advice-free consensus requires 24 hours on the same sensor, input packet and model versions',()=>{
  const ids=['GFForecast','GFAPSEnhancer'];
  const train=Array.from({length:330},(_,i)=>at-(330-i)*5*minute);
  const history=train.flatMap(ts=>packet(ts,ids));
  const actual=observations([...train,at]);
  const current=packet(at,ids);
  const run=(patch={})=>Consensus.assess({current,issued:history,actual,asOf:at,...patch});
  assert.equal(run().status,'LEADER');
  assert.equal(run().leader,'GFForecast');
  assert.ok(run().results.every(row=>row.pairedMinutes>=1440&&row.metrics.GFForecast.mae===0));
  assert.equal(run({enabled:false}).reason,'AUTO_SELECTION_OFF');
  assert.equal(run({issued:history.slice(-200)}).status,'NO_LEADER');
  assert.equal(run({current:packet(at,ids,source,0,'1.0.1')}).status,'NO_LEADER');
  assert.equal(run({issued:train.flatMap(ts=>packet(ts,ids,'older-sensor'))}).status,'NO_LEADER');
  assert.equal(run({actual:actual.map(({receivedAt,...row})=>({...row,receivedAt:iso(at+minute)}))}).reason,'ISSUE_ANCHOR_UNVERIFIED');
  const broken=structuredClone(current);
  broken[1].payload.inputDigest='b'.repeat(64);
  assert.equal(run({current:broken}).reason,'MIXED_FORECAST_PACKET');
});

test('changing winners yields a reproducible weighted curve with no second physiological contribution',()=>{
  const ids=['GFForecast','GFAPSEnhancer'];
  const training=Array.from({length:330},(_,i)=>at-(330-i)*5*minute);
  const curves=[...training,at].flatMap(ts=>packet(ts,ids).map(row=>{
    row.payload.points.forEach(p=>{
      if(p.horizonMin>=60)p.glucoseMmol=row.payload.modelId==='GFForecast'?7:6;
    });
    return row;
  }));
  const output=Consensus.assess({current:curves.slice(-2),issued:curves.slice(0,-2),actual:observations([...training,at]),asOf:at});
  assert.equal(output.status,'COMPOSITE');
  assert.deepEqual(output.results.map(row=>row.leader),['GFForecast','GFAPSEnhancer','GFAPSEnhancer']);
  const penalty=1/(1+(1.05/0.05)**2);
  for(const horizon of [30,60,120])assert.ok(Math.abs(output.row.payload.points[horizon/5].glucoseMmol-(6+penalty))<1e-12);
  assert.ok(output.row.payload.points.every(x=>x.glucoseMmol>=6&&x.glucoseMmol<7));
  assert.equal(output.row.payload.clinicalUse,false);
});

test('the selection is archived in the same batch and invalidated by new facts, not toggles or analysis',()=>{
  const host=testJournal();
  mutate(host,'cgmAdapter','setSourceMetadata',{sourceDeviceId:source,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
  const training=Array.from({length:330},(_,i)=>at-(330-i)*5*minute);
  const actual=observations([...training,at]);
  mutate(host,'cgmAdapter','ingestReadings',actual.map(({ts,mmol,sourceDeviceId,receivedAt,qualityFlag,valid})=>
    ({ts,mmol,sourceDeviceId,receivedAt,qualityFlag,valid})));
  const initial=host.exportState();
  const ids=['GFForecast','GFAPSEnhancer'];
  const issued=training.flatMap(ts=>packet(ts,ids,source,initial.revision));
  const current=packet(at,ids,source,initial.revision);
  const result=Consensus.assess({current,issued,actual,asOf:at});
  mutate(host,'forecastWriter','appendResearchEvents',{
    schema:'gfforecast.research-events/1',writerRequired:true,forecasts:[...issued,...current,result.row],assessments:[],
  });
  const go=()=>{
    const revision=host.connect('graph').getRevision();
    return Consensus.readScenario({host,evidence:{status:'OK',sourceStatus:'DEVICE_DECLARED',revision,
      sourceDeviceId:source,latestAt:iso(at)},nowMs:at});
  };
  assert.equal(go().status,'LEADER');
  assert.deepEqual(go().horizons.map(x=>x.deltaMmol),[0,0,0]);
  mutate(host,'graph','setPreferences',{forecastVisibility:{GFConsensus:false}});
  assert.equal(go().status,'LEADER');
  mutate(host,'graph','setPreferences',{autoConsensus:false});
  assert.equal(go().reason,'AUTO_SELECTION_OFF');
  mutate(host,'graph','setPreferences',{autoConsensus:true});
  assert.equal(go().status,'LEADER');
  assert.deepEqual(host.exportState().events,initial.events);
  mutate(host,'settings','setMealAbsorptionModel','GFCOB');
  assert.equal(go().reason,'NO_CURRENT_SELECTION');
});

test('home nutrition excludes plans, counts correction once and discloses partial evidence',()=>{
  const plate={protein:1,fat:2,carbs:9.95,kcal:80};
  const rows=[{id:'p',kind:'meal',status:'planned',meal:{...plate,carbs:19.9}},
    {id:'f',kind:'meal',status:'completed',meal:plate},{id:'f',kind:'meal',status:'completed',meal:plate}];
  assert.equal(Main.nutrition([],null).rows.find(x=>x.key==='carbs').eaten,null);
  assert.equal(Main.nutrition(rows,null).rows.find(x=>x.key==='carbs').eaten,9.95);
  assert.equal(Main.nutrition([...rows,{id:'l',kind:'legacy_meal'}],null).incomplete,true);
});

const {addPlate,Rinfast}=require('../mvp3-calculators/fixture.cjs');
const Fact=fromWeb('integration/GFInjectionFact_v0.1.0.js');
const Audit=fromWeb('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');
fromWeb('modules/GFInjectionAnalytics_v0.2.1/GFInjectionAnalytics_v0.2.1.js');
const Timing=fromWeb('integration/GFInjectionTimingStorage_v0.1.0.js');

test('ordinary confirmation links one real fact and preserves pre-injection IOB through export and reload',()=>{
  let now=at;
  let disk=structuredClone(testJournal().exportState());
  const driver={load:()=>structuredClone(disk),save:state=>{disk=structuredClone(state);}};
  const open=()=>Storage.createHost({driver,clock:()=>iso(now)});
  const host=open();
  mutate(host,'actionWriter','recordInjection',{id:'prior-rapid',insulinId:'rinfast',units:0.5,administeredAt:iso(at-45*minute)});
  mutate(host,'actionWriter','recordInjection',{id:'prior-basal',insulinId:'levemir',units:0.5,administeredAt:iso(at-40*minute)});
  const {controller,id,plate}=addPlate(host,{id:'synthetic-linked-meal',carbs:14.925,grams:75,estimated:false});
  controller.ready(id);
  const item={id:'confirmed-rapid',insulinId:'rinfast',units:0.5,administeredAt:iso(at),injectionSite:{region:'abdomen'}};
  const request={host,item,mealId:id,revision:host.diagnostics().revision};
  assert.throws(()=>Fact.record({...request,confirmed:false}),/CONFIRMATION/);
  assert.equal(host.diagnostics().revision,request.revision);
  const receipt=Fact.record({...request,confirmed:true});
  assert.equal(receipt.revision,request.revision+1);
  assert.deepEqual(Fact.record({...request,confirmed:true}),{revision:receipt.revision,idempotent:true});
  const saved=open().exportState();
  const event=saved.events.find(row=>row.id===item.id);
  assert.equal(event.linkedMealSessionId,id);
  assert.deepEqual(saved.mealSessions.find(row=>row.id===id).injectionIds,[item.id]);
  assert.deepEqual(event.iobEvidence.priorInjectionIds,['prior-rapid']);
  assert.equal(event.iobEvidence.modelUnits,0.5*Rinfast.getCurve(45).remainingFraction);
  assert.equal(event.iobEvidence.clinicalUse,false);
  assert.deepEqual(JSON.parse(Audit.exportJson(open())).events.find(row=>row.id===item.id),event);
  now+=15*minute;
  controller.startMeal(id,iso(now),{actuallyStarted:true});
  controller.actualFood(id,plate,{parentConfirmed:true});
  now+=5*minute;
  controller.finishMeal(id,iso(now),{confirmed:true});
  const analysis=Timing.inspect({host:open(),sessionId:id,nowMs:now});
  assert.equal(analysis.status,'NO_DATA');
  assert.notEqual(analysis.code,'HISTORICAL_IOB_UNKNOWN');
});

test('missing IOB evidence does not prevent an explicit atomic fact; missing or basal links do',()=>{
  const host=testJournal({coverage:false});
  const {controller,id}=addPlate(host,{id:'synthetic-link-without-iob'});
  controller.ready(id);
  const item={id:'confirmed-no-iob',insulinId:'rinfast',units:0.5,administeredAt:iso(at)};
  const request={host,item,mealId:id,confirmed:true,revision:host.diagnostics().revision};
  assert.throws(()=>Fact.record({...request,mealId:'missing'}),/MEAL_LINK_UNAVAILABLE/);
  assert.throws(()=>Fact.record({...request,item:{...item,insulinId:'levemir'}}),/MEAL_LINK_RAPID_ONLY/);
  assert.equal(host.diagnostics().revision,request.revision);
  Fact.record(request);
  assert.equal(host.exportState().events[0].iobEvidence,undefined);
  assert.deepEqual(host.exportState().mealSessions[0].injectionIds,[item.id]);
});
