
/* Imported unmodified: GFGraphFourLines v0.1.0 candidate */
/* ГлюкоПапа GFGraphFourLines v0.1.0 — UI-only forecast visibility.
 * Four independent checkboxes: arithmetic mean of 2–3 available forecasts + three model lines.
 * Reads immutable GFStorage snapshot via calling app; never stores alternate forecasts or doses.
 * The arithmetic mean is NOT the statistically weighted GFConsensus AutoSelection prediction.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GFGraphFourLines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const VERSION = '0.1.0';
  const IDS = Object.freeze(['GFForecast', 'GFxDrip', 'GFAPSEnhancer']);
  const MEAN = 'GFConsensus';
  const COLORS = Object.freeze({GFForecast:'#2541a0',GFxDrip:'#26705e',GFAPSEnhancer:'#96428a',GFConsensus:'#243548'});
  const MIN=60000, STEP=5*MIN, MAX_AGE=12*MIN;
  const ts = x => typeof x==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) ? Date.parse(x) : NaN;
  const validVal = v=>typeof v==='number' && Number.isFinite(v) && v>=1.5 && v<=40;
  const foodKey = v=>v && typeof v.id==='string' && typeof v.version==='string' ? v.id+'@'+v.version : null;
  const sameString = x=>JSON.stringify(x);
  function canonical(f) {
    const origin=ts(f?.forecastAt);
    if(f?.contract!=='glucopapa.research-forecast/2'||!IDS.includes(f.modelId)||
       !Number.isSafeInteger(origin)||!Number.isSafeInteger(f.sourceRevision)||
       typeof f.modelVersion!=='string'||!f.modelVersion||
       typeof f.inputDigest!=='string'||!/^[a-f0-9]{64}$/.test(f.inputDigest)||
       !Array.isArray(f.points)||f.points.length!==25 ||
       !f.points.every((p,i)=>p && p.horizonMin===i*5 && ts(p.at)===origin+i*STEP && validVal(p.glucoseMmol)))return false;
    return true;
  }
  function eligible(f,{sourceId,sourceTime,nowMs,minimumSourceRevision}) {
    return canonical(f) && f.snapshot?.sensorSourceId===sourceId && ts(f.sourceTime)===sourceTime &&
      Number.isSafeInteger(nowMs)&&ts(f.forecastAt)<=nowMs&&nowMs-ts(f.forecastAt)<=MAX_AGE&&
      f.sourceRevision>=minimumSourceRevision;
  }
  const key=f=>sameString([f.forecastAt,f.sourceTime,f.snapshot.sensorSourceId,
    f.sourceRevision,f.inputDigest,foodKey(f.mealModel)]);
  function getCurrent(forecasts, options) {
    const candidates=forecasts.map(x=>x?.payload??x).filter(x=>eligible(x,options));
    candidates.sort((a,b)=>ts(b.forecastAt)-ts(a.forecastAt)||b.sourceRevision-a.sourceRevision);
    if(!candidates.length)return [];
    const group=candidates.filter(x=>key(x)===key(candidates[0]));
    const byId=new Map(), invalid=new Set();
    for(const f of group) {
      const older=byId.get(f.modelId);
      if(older && sameString(older)!==sameString(f))invalid.add(f.modelId);
      else if(!older)byId.set(f.modelId,f);
    }
    return IDS.filter(id=>byId.has(id)&&!invalid.has(id)).map(id=>byId.get(id));
  }
  function average(current) {
    if(current.length<2)return null;
    const count=current.length, origin=ts(current[0].forecastAt);
    const points=Array.from({length:25},(_,i)=>({
      horizonMin:i*5,at:new Date(origin+i*STEP).toISOString(),
      glucoseMmol:current.reduce((s,f)=>s+f.points[i].glucoseMmol,0)/count,
    }));
    return {modelId:MEAN,points,color:COLORS[MEAN],highlight:false,
      isMean:true,meanOf:current.map(f=>f.modelId),label:`Средний прогноз (${count} из 3)`};
  }
  function select({forecasts=[],sourceId,sourceTime,nowMs,preferences={},minimumSourceRevision=0}={}) {
    if(!Array.isArray(forecasts) || typeof sourceId!=='string'||!sourceId ||
       !Number.isSafeInteger(sourceTime)||!Number.isSafeInteger(nowMs))
      return {version:VERSION,status:'INVALID_INPUT',lines:[],availableModels:[],missingModels:IDS.slice(),meanOf:0};
    const current=getCurrent(forecasts,{sourceId,sourceTime,nowMs,minimumSourceRevision});
    const availableModels=current.map(f=>f.modelId);
    const missingModels=IDS.filter(id=>!availableModels.includes(id));
    const visible=id=>preferences?.forecastVisibility?.[id]!==false;
    const lines=[];
    const mean=average(current);
    if(mean && visible(MEAN))lines.push(mean);
    for(const f of current)if(visible(f.modelId))lines.push({modelId:f.modelId,points:f.points,
      color:COLORS[f.modelId],highlight:false,label:f.modelId});
    const status=current.length===0?'NO_CURRENT_FORECAST':current.length<2?'ONLY_ONE_MODEL':
      current.length<3?'PARTIAL':'READY';
    return {version:VERSION,status,lines,availableModels,missingModels,meanOf:current.length>=2?current.length:0,
      visibleModels:lines.map(x=>x.modelId)};
  }
  function statusText(result) {
    if(result.status==='INVALID_INPUT')return 'Нет подходящих входных данных графика.';
    if(result.status==='NO_CURRENT_FORECAST')return 'Свежих сопоставимых прогнозов пока нет.';
    if(result.status==='ONLY_ONE_MODEL')return 'Доступен один прогноз. Средняя линия появится при наличии второго.';
    const parts=[`Средний прогноз: ${result.meanOf} из 3 доступных моделей.`];
    if(result.missingModels.length)parts.push('Нет прогноза: '+result.missingModels.join(', ')+'.');
    if(!result.lines.length)parts.push('Все линии скрыты выбранными галочками.');
    return parts.join(' ');
  }
  function overlay(svg,chart,window,lines) {
    if(!svg || !root.GFResearchForecastGraph?.overlay)return;
    root.GFResearchForecastGraph.overlay(svg,chart,window,lines);
    const avg=lines.find(x=>x.isMean);
    if(!avg)return;
    const path=svg.querySelector('path[data-forecast-model="GFConsensus"]');
    if(path){
      path.setAttribute('stroke-width','2.5');
      path.setAttribute('stroke-dasharray','7 3');
      const title=path.querySelector('title');
      if(title)title.textContent=avg.label+' · арифметическое среднее для отображения';
    }
  }
  return Object.freeze({VERSION,IDS,MEAN,select,statusText,overlay});
});

