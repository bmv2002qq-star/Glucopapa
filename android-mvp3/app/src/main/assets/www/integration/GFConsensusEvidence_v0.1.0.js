/* GFStorage research forecast contract adapter. The imported scoring kernel is unchanged. */
(function (root) {
  'use strict';
  const CONTRACT='glucopapa.consensus-selection/1';
  const version='0.1.2';
  const models=['GFForecast','GFxDrip','GFAPSEnhancer'];
  const minute=60_000;
  const unpack=row=>row.payload??row;
  const mealKey=meal=>meal?JSON.stringify([meal.id,meal.version]):null;
  const measuredAt=forecast=>Date.parse(forecast.sourceTime);
  const issuedAt=forecast=>Date.parse(forecast.forecastAt);
  const sensor=forecast=>forecast.snapshot?.sensorSourceId;
  const cleanSeries=forecast=>forecast.contract==='glucopapa.research-forecast/2'&&
    models.includes(forecast.modelId)&&forecast.clinicalUse===false&&forecast.modelValidated===false&&
    measuredAt(forecast)<=Date.parse(forecast.sourceReceivedAt)&&Date.parse(forecast.sourceReceivedAt)<=issuedAt(forecast);
  const blocked=(reason,fields={})=>({contract:CONTRACT,version,status:'BLOCKED',reason,clinicalUse:false,...fields});
  const attestedReading=row=>row.source==='device_recorded'&&row.kind==='observed'&&
    row.valid===true&&row.qualityFlag==='ok'&&Number.isFinite(Date.parse(row.receivedAt));

  function assess({issued,actual,current,asOf,enabled=true,reviewOnly=false}) {
    if(!enabled)return blocked('AUTO_SELECTION_OFF');
    const series=current.map(unpack).filter(cleanSeries);
    const first=series[0];
    const modelIds=[...new Set(series.map(row=>row.modelId))];
    if(modelIds.length<2)return {contract:CONTRACT,version,status:'NO_LEADER',reason:'INSUFFICIENT_MODELS',modelIds,clinicalUse:false};
    if(series.length!==modelIds.length||issuedAt(first)>asOf||(!reviewOnly&&issuedAt(first)!==asOf)||series.some(row=>
      row.forecastAt!==first.forecastAt||row.sourceTime!==first.sourceTime||row.sourceReceivedAt!==first.sourceReceivedAt||
      sensor(row)!==sensor(first)||row.sourceRevision!==first.sourceRevision||row.inputDigest!==first.inputDigest||
      mealKey(row.mealModel)!==mealKey(first.mealModel)))return blocked('MIXED_FORECAST_PACKET');
    const sourceId=sensor(first);
    if(!sourceId||!first.mealModel)return blocked('UNKNOWN_MODEL_COHORT');
    const versions=new Map(series.map(row=>[row.modelId,row.modelVersion]));
    const facts=actual.filter(row=>row.sourceDeviceId===sourceId&&row.source==='device_recorded'&&row.kind==='observed');
    const anchors=new Set(facts.filter(attestedReading).map(row=>row.ts+'|'+Date.parse(row.receivedAt)));
    const isAnchored=row=>anchors.has(measuredAt(row)+'|'+Date.parse(row.sourceReceivedAt));
    if(!isAnchored(first))return blocked('ISSUE_ANCHOR_UNVERIFIED');
    const cohort=issued.map(unpack).filter(row=>cleanSeries(row)&&sensor(row)===sourceId&&
      versions.get(row.modelId)===row.modelVersion&&mealKey(row.mealModel)===mealKey(first.mealModel)&&
      isAnchored(row)).map(row=>({...row,sourceId}));
    const normalized=series.map(row=>({...row,sourceId}));
    const outcome=root.GFConsensusAutoSelection.evaluate({
      issued:cohort.concat(normalized),
      actual:facts.map(row=>({...row,valid:attestedReading(row)})),asOf,mealModel:first.mealModel,candidates:modelIds,
    });
    const selection={contract:CONTRACT,version,status:outcome.status,reason:outcome.reason??null,
      leader:outcome.leader,modelIds:outcome.modelIds,trainedVersions:outcome.trainedVersions??null,
      sourceId,evaluatedAt:new Date(asOf).toISOString(),results:outcome.results,clinicalUse:false};
    if(reviewOnly)return selection;
    const chosen=outcome.status==='LEADER'?normalized.find(row=>row.modelId===outcome.leader):
      outcome.status==='COMPOSITE'?root.GFConsensusAutoSelection.compose(outcome,normalized):null;
    if(!chosen)return outcome.status==='COMPOSITE'?blocked('COMPOSITION_FAILED'):selection;
    const points=chosen.points.map(({horizonMin,at,glucoseMmol})=>({
      horizonMin,at:new Date(at).toISOString(),glucoseMmol,lower:null,upper:null,
    }));
    const versionId='GFConsensus@'+version;
    const {timeAlignment, ...grounding}=first;
    return {...selection,row:{id:[first.forecastAt,first.sourceTime,versionId].join('|'),kind:'research_forecast',
      payload:{...grounding,modelId:'GFConsensus',modelVersion:version,version:versionId,points,uncertainty:null,
        snapshot:{sensorSourceId:sourceId,flags:['research_consensus']},selection}}};
  }

  function readScenario({host,evidence,nowMs}) {
    const port=host.connect('graph'), data=port.getSnapshot();
    const withRevision={sourceRevision:data.revision};
    if(data.graphPreferences.autoConsensus===false)return blocked('AUTO_SELECTION_OFF',withRevision);
    if(evidence.status!=='OK'||evidence.sourceStatus!=='DEVICE_DECLARED')return blocked('CGM_NOT_ELIGIBLE',withRevision);
    if(data.revision!==evidence.revision||port.getRevision()!==data.revision)
      return blocked('REVISION_CHANGED',withRevision);
    const minimumRevision=port.getForecastInputRevision();
    const current=data.forecasts.map(unpack).filter(row=>row.modelId==='GFConsensus'&&row.selection?.contract===CONTRACT&&
      row.clinicalUse===false&&sensor(row)===evidence.sourceDeviceId&&row.sourceTime===evidence.latestAt&&
      row.sourceRevision>=minimumRevision&&issuedAt(row)<=nowMs&&nowMs-issuedAt(row)<=12*minute)
      .sort((a,b)=>issuedAt(b)-issuedAt(a)||b.sourceRevision-a.sourceRevision);
    const forecast=current[0];
    if(!forecast)return blocked('NO_CURRENT_SELECTION',withRevision);
    return {...withRevision,contract:CONTRACT,version,status:forecast.selection.status,clinicalUse:false,
      forecastAt:forecast.forecastAt,archivedInputRevision:forecast.sourceRevision,modelIds:forecast.selection.modelIds,
      leader:forecast.selection.leader,baselineMmol:forecast.points[0].glucoseMmol,
      horizons:[30,60,120].map(horizonMin=>{
        const glucoseMmol=forecast.points[horizonMin/5].glucoseMmol;
        return {horizonMin,glucoseMmol,deltaMmol:glucoseMmol-forecast.points[0].glucoseMmol};
      })};
  }

  function history(host,nowMs=Date.now()) {
    const port=host.connect('graph'),graph=port.getSnapshot();
    const adapter=host.connect('cgmAdapter').getSnapshot();
    if(port.getRevision()!==graph.revision||adapter.revision!==graph.revision)return blocked('REVISION_CHANGED');
    const source=adapter.cgmMetadata;
    if(source?.sourceType!=='device_recorded')return blocked('CGM_NOT_ELIGIBLE');
    const issued=graph.forecasts.map(unpack)
      .filter(row=>cleanSeries(row)&&sensor(row)===source.sourceDeviceId&&issuedAt(row)<=nowMs);
    issued.sort((a,b)=>issuedAt(b)-issuedAt(a)||b.sourceRevision-a.sourceRevision);
    const newest=issued[0];
    if(!newest)return blocked('NO_ISSUED_FORECASTS');
    const current=issued.filter(row=>row.forecastAt===newest.forecastAt&&row.sourceRevision===newest.sourceRevision);
    return assess({issued,actual:graph.cgm,current,asOf:nowMs,reviewOnly:true});
  }

  function current(host,nowMs=Date.now()) {
    return readScenario({host,evidence:root.GFCgmEvidencePolicy.inspect(host,{nowMs}),nowMs});
  }

  const api=Object.freeze({CONTRACT,assess,readScenario,history,current});
  root.GFConsensusEvidence=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
