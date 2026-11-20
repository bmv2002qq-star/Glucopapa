
/* Imported unmodified: GFConsensus AutoSelection v0.1.2 candidate */
/* GFConsensus AutoSelection v0.1.2 — optional non-therapeutic integration candidate.
 * Does not modify the approved GFConsensus v0.1.1 or existing forecasts.
 * Uses only previously issued, identically grounded 2/3-model forecasts and later CGM.
 */
(function(root, build) {
  'use strict';
  const api = build();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.GFConsensusAutoSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const VERSION = '0.1.2';
  const MODELS = Object.freeze(['GFForecast','GFxDrip','GFAPSEnhancer']);
  const HORIZONS = Object.freeze([30,60,120]);
  const MIN = 60000, STEP = 5*MIN, TOL = 2.5*MIN, BLOCK = 8*60*MIN;
  const LOW = 3.9, MARGIN = 0.2, MIN_BUCKETS = 288, MIN_BLOCKS = 3;
  const mmol = v => typeof v === 'number' && Number.isFinite(v) && v >= 1.5 && v <= 40;
  const time = v => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : Number.isSafeInteger(v) ? v : NaN;
  const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
  const unique = xs => [...new Set(xs)];
  const foodKey = m => m && typeof m.id === 'string' && typeof m.version === 'string' ? m.id+'@'+m.version : null;
  function cutoff(end) {
    const d = new Date(end), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()-3);
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    d.setUTCDate(Math.min(day,monthEnd));
    return d.getTime();
  }
  function normalizeIssued(record,end) {
    const f = record?.payload || record;
    if(!f || typeof f !== 'object' || !MODELS.includes(f.modelId)) return null;
    if(f.contract && f.contract !== 'glucopapa.research-forecast/2') return null;
    const origin=time(f.forecastAt), source=time(f.sourceTime);
    const sourceId = f.sourceId || f.snapshot?.sensorSourceId;
    if(!Number.isSafeInteger(origin) || !Number.isSafeInteger(source) || origin>end ||
       source>origin || origin-source>15*MIN || typeof sourceId!=='string' || !sourceId ||
       !Number.isSafeInteger(f.sourceRevision) || f.sourceRevision<0 ||
       !/^[a-f0-9]{64}$/.test(f.inputDigest||'') ||
       typeof f.modelVersion!=='string' || !f.modelVersion ||
       !Array.isArray(f.points) || f.points.length!==25) return null;
    if(f.sourceReceivedAt && !(time(f.sourceReceivedAt)>=source && time(f.sourceReceivedAt)<=origin)) return null;
    if(!f.points.every((p,i)=>p && p.horizonMin===i*5 &&
       time(p.at)===origin+i*STEP && mmol(p.glucoseMmol))) return null;
    return {...f,sourceId,origin};
  }
  function indexFacts(actual,end) {
    const bySource = new Map();
    for(const f of actual) {
      const source = f?.sourceId || f?.sourceDeviceId;
      const at=time(f?.ts), received=time(f?.receivedAt);
      if(!source || !Number.isSafeInteger(at) || !Number.isSafeInteger(received) || received<at || received>end) continue;
      if(!bySource.has(source)) bySource.set(source,new Map());
      const items=bySource.get(source);
      const good=f.valid===true && f.qualityFlag!=='invalid' && mmol(f.mmol);
      const previous=items.get(at);
      // A conflicting measurement invalidates that timestamp; duplicates do not create extra evidence.
      if(previous && (!good || !previous.valid || previous.mmol!==f.mmol)) items.set(at,{at,valid:false});
      else if(!previous) items.set(at,{at,received,mmol:f.mmol,valid:good});
      else if(received<previous.received) previous.received=received;
    }
    return new Map([...bySource].map(([k,v])=>[k,[...v.values()].sort((a,b)=>a.at-b.at)]));
  }
  function nearest(rows,target,origin) {
    let best=null;
    for(const row of rows) {
      if(row.at<target-TOL) continue;
      if(row.at>target+TOL) break;
      if(row.at<=origin) continue;
      if(!best || Math.abs(row.at-target)<Math.abs(best.at-target) ||
         (Math.abs(row.at-target)===Math.abs(best.at-target)&&row.at<best.at)) best=row;
    }
    // Do not skip invalid nearest reading to cherry-pick an eligible one.
    return best?.valid ? best : null;
  }
  function stats(rows,model,eligible) {
    const err=rows.map(row=>row.predictions[model]-row.actual);
    return {n:err.length,coverage:eligible?err.length/eligible:null,
      mae:err.length?mean(err.map(Math.abs)):null,
      rmse:err.length?Math.sqrt(mean(err.map(x=>x*x))):null,
      bias:err.length?mean(err):null,
      missedLow:rows.filter(r=>r.actual<LOW&&r.predictions[model]>=LOW).length,
      falseLow:rows.filter(r=>r.actual>=LOW&&r.predictions[model]<LOW).length};
  }
  function summarize(rows, eligible, models, horizon) {
    const buckets=new Set(rows.map(r=>Math.floor(r.actualAt/STEP)));
    const blockMap=new Map();
    for(const r of rows) {
      const key=Math.floor(r.actualAt/BLOCK);
      if(!blockMap.has(key)) blockMap.set(key,[]);
      blockMap.get(key).push(r);
    }
    const blocks=[...blockMap.values()].filter(b=>b.length>=12);
    const metrics=Object.fromEntries(models.map(m=>[m,stats(rows,m,eligible)]));
    const base={horizon,eligible,n:rows.length,pairedMinutes:buckets.size*5,
      qualifyingBlocks:blocks.length,metrics};
    if(buckets.size<MIN_BUCKETS||blocks.length<MIN_BLOCKS)
      return {...base,status:'NO_LEADER',leader:null,reason:'INSUFFICIENT_COMPARABLE_HISTORY'};
    const ranked=models.slice().sort((a,b)=>metrics[a].mae-metrics[b].mae);
    const winner=ranked[0];
    const wins=ranked.slice(1).every(peer=>metrics[peer].mae-metrics[winner].mae>=MARGIN &&
      metrics[winner].missedLow<=metrics[peer].missedLow &&
      blocks.every(block=>mean(block.map(r=>Math.abs(r.predictions[peer]-r.actual)-
        Math.abs(r.predictions[winner]-r.actual)))>=MARGIN));
    return {...base,status:wins?'LEADER':'TIE',leader:wins?winner:null,
      reason:wins?null:'MARGIN_NOT_REPRODUCED'};
  }
  function candidatesFrom(arg) {
    if(arg===undefined || arg===null) return null;
    if(!Array.isArray(arg) || unique(arg).length!==arg.length ||
       arg.some(v=>!MODELS.includes(v)) || arg.length<2) throw Error('CONSENSUS_CANDIDATES');
    return MODELS.filter(m=>arg.includes(m));
  }
  function evaluate({issued,actual,asOf,mealModel,candidates}={}) {
    const end=time(asOf);
    if(!Number.isSafeInteger(end)||!Array.isArray(issued)||!Array.isArray(actual)) throw Error('CONSENSUS_INPUT');
    const begin=cutoff(end), groups=new Map();
    let rejected=0;
    for(const row of issued) {
      const f=normalizeIssued(row,end);
      if(!f) {rejected++;continue;}
      if(f.origin<begin||(mealModel!==undefined&&foodKey(f.mealModel)!==foodKey(mealModel))) continue;
      const key=JSON.stringify([f.origin,time(f.sourceTime),f.sourceId,f.sourceRevision,f.inputDigest,foodKey(f.mealModel)]);
      if(!groups.has(key)) groups.set(key,{origin:f.origin,sourceId:f.sourceId,byModel:new Map(),conflict:false});
      const group=groups.get(key),prior=group.byModel.get(f.modelId);
      if(prior && JSON.stringify(prior)!==JSON.stringify(f)) group.conflict=true;
      else group.byModel.set(f.modelId,f);
    }
    const allGroups=[...groups.values()].filter(g=>!g.conflict&&g.byModel.size>=2).sort((a,b)=>a.origin-b.origin);
    const selected=candidatesFrom(candidates)||MODELS.filter(m=>allGroups.at(-1)?.byModel.has(m));
    if(selected.length<2) return {version:VERSION,status:'NO_LEADER',leader:null,modelIds:selected,
      asOf:end,windowStart:begin,reason:'INSUFFICIENT_MODELS',results:[],rejected,matchedIssueGroups:0,therapeuticUse:false};
    const compatible=allGroups.filter(g=>selected.every(m=>g.byModel.has(m)));
    const latest=compatible.at(-1);
    const versions=Object.fromEntries(selected.map(m=>[m,latest?.byModel.get(m)?.modelVersion||null]));
    const modelFoodKey=foodKey(latest?.byModel.get(selected[0])?.mealModel);
    const training=compatible.filter(g=>selected.every(m=>g.byModel.get(m).modelVersion===versions[m] &&
      foodKey(g.byModel.get(m).mealModel)===modelFoodKey));
    const facts=indexFacts(actual,end);
    const results=HORIZONS.map(horizon=>{
      let eligible=0;const pairs=[],seen=new Set();
      for(const g of training) {
        const target=g.origin+horizon*MIN;
        if(target+TOL>end)continue;
        eligible++;
        const match=nearest(facts.get(g.sourceId)||[],target,g.origin);
        if(!match) continue;
        const pairKey=JSON.stringify([g.sourceId,match.at]);
        if(seen.has(pairKey))continue;
        seen.add(pairKey);
        pairs.push({actual:match.mmol,actualAt:match.at,
          predictions:Object.fromEntries(selected.map(m=>[m,g.byModel.get(m).points[horizon/5].glucoseMmol]))});
      }
      return summarize(pairs,eligible,selected,horizon);
    });
    const leaders=unique(results.map(r=>r.leader));
    const status=leaders.includes(null) ? results.some(r=>r.status==='TIE')?'TIE':'NO_LEADER' :
      leaders.length===1?'LEADER':'COMPOSITE';
    return {version:VERSION,status,leader:status==='LEADER'?leaders[0]:null,modelIds:selected,
      asOf:end,windowStart:begin,windowZone:'UTC',reason:status==='NO_LEADER'?'INSUFFICIENT_COMPARABLE_HISTORY':null,
      trainedVersions:versions,trainedMealModel:modelFoodKey,rejected,matchedIssueGroups:training.length,
      results,therapeuticUse:false};
  }
  const smooth=(a,b,t)=>a+(b-a)*t*t*(3-2*t);
  function compose(review,forecasts) {
    if(review?.status!=='COMPOSITE'||!Array.isArray(forecasts)||
       !Array.isArray(review.modelIds)||forecasts.length!==review.modelIds.length)return null;
    const fById=new Map(forecasts.map(f=>[f.modelId,f]));
    if(fById.size!==review.modelIds.length ||review.modelIds.some(m=>!fById.has(m)))return null;
    const first=fById.get(review.modelIds[0]),origin=time(first.forecastAt);
    if(!Number.isSafeInteger(origin) || origin<review.asOf ||
       !review.modelIds.every(m=>{
         const f=fById.get(m);
         return normalizeIssued(f,origin) && f.modelVersion===review.trainedVersions[m] &&
           time(f.forecastAt)===origin && time(f.sourceTime)===time(first.sourceTime) &&
           f.sourceId===first.sourceId && f.sourceRevision===first.sourceRevision &&
           f.inputDigest===first.inputDigest && foodKey(f.mealModel)===review.trainedMealModel;
       })) return null;
    const weights=review.results.map(result=>{
      const vals=review.modelIds.map(m=>1/(0.05+result.metrics[m].mae)**2);
      const sum=vals.reduce((a,b)=>a+b,0);
      return vals.map(v=>v/sum);
    });
    function sample(minute) {
      if(!Number.isFinite(minute)||minute<0||minute>120) throw Error('CONSENSUS_HORIZON');
      const i=minute<=60?0:1;
      const fraction=Math.min(1,Math.max(0,(minute-HORIZONS[i])/(HORIZONS[i+1]-HORIZONS[i])));
      const ws=weights[i].map((v,n)=>smooth(v,weights[i+1][n],fraction));
      const left=Math.floor(minute/5),right=Math.min(24,left+1),position=minute/5-left;
      const vals=review.modelIds.map(m=>{
        const p=fById.get(m).points;
        return p[left].glucoseMmol+(p[right].glucoseMmol-p[left].glucoseMmol)*position;
      });
      return {horizonMin:minute,at:origin+minute*MIN,
        glucoseMmol:vals.reduce((sum,x,k)=>sum+x*ws[k],0),
        weights:Object.fromEntries(review.modelIds.map((m,k)=>[m,ws[k]]))};
    }
    return {modelId:'GFConsensus',modelVersion:VERSION,therapyUse:false,trainedThrough:review.asOf,
      points:Array.from({length:25},(_,i)=>sample(i*5)),sample};
  }
  function fromHost(host,asOf=Date.now()) {
    if(host?.getSchemaVersion?.()!==5) return {status:'BLOCKED',reason:'STORAGE_SCHEMA'};
    const port=host.connect('research'),s=port.getSnapshot();
    const issued=s.forecasts.map(r=>({...r.payload,sourceId:r.payload?.snapshot?.sensorSourceId ?? r.payload?.sourceId}));
    const actual=s.cgm.map(r=>({...r,sourceId:r.sourceDeviceId ?? r.sourceId}));
    const report=evaluate({issued,actual,asOf});
    if(port.getRevision()!==s.revision)return {status:'BLOCKED',reason:'REVISION_CHANGED'};
    return {...report,sourceRevision:s.revision};
  }
  return Object.freeze({VERSION,MODELS,HORIZONS,evaluate,compose,fromHost});
});

