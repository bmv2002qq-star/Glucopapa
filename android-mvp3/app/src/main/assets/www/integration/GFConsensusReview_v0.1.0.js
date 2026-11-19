/* Independent retrospective candidate. Reads saved predictions; never writes treatment or changes visibility. */
(function (root) {
  'use strict';
  const VERSION = '0.1.0';
  const MODELS = Object.freeze(['GFForecast', 'GFxDrip', 'GFAPSEnhancer']);
  const HORIZONS = Object.freeze([30, 60, 120]);
  const MIN = 60_000, TOLERANCE = 2.5 * MIN, LOW = 3.9;
  const BUCKET = 5 * MIN, BLOCK = 8 * 60 * MIN, MIN_BUCKETS = 288, MARGIN = 0.2;
  const MMM = value => typeof value === 'number' && Number.isFinite(value) && value >= 1.5 && value <= 40;
  const ts = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : Number.isSafeInteger(value) ? value : NaN;
  const mean = xs => xs.reduce((total, x) => total + x, 0) / xs.length;

  function subtractMonths(end) {
    const d = new Date(end), day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 3);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(last, day));
    return d.getTime();
  }

  function validForecast(entry, end) {
    if (!entry || typeof entry !== "object") return false;
    const origin = ts(entry.forecastAt), sourceAt = ts(entry.sourceTime);
    return MODELS.includes(entry.modelId) && typeof entry.modelVersion === 'string' && entry.modelVersion !== '' &&
      Number.isSafeInteger(entry.sourceRevision) && entry.sourceRevision >= 0 &&
      typeof entry.sourceId === 'string' && entry.sourceId !== '' && /^[0-9a-f]{64}$/.test(entry.inputDigest || '') &&
      sourceAt <= origin && origin - sourceAt <= 15 * MIN && origin <= end &&
      Array.isArray(entry.points) && entry.points.length === 25 &&
      entry.points.every((p, i) => p && p.horizonMin === i * 5 && ts(p.at) === origin + i * BUCKET && MMM(p.glucoseMmol));
  }

  function indexFacts(facts, asOf) {
    const index = new Map();
    for (const p of facts) {
      if (!p || typeof p !== "object") continue;
      const measured = ts(p.ts), received = ts(p.receivedAt);
      if (!p.sourceId || !Number.isFinite(measured) || !(received >= measured && received <= asOf)) continue;
      if (!index.has(p.sourceId)) index.set(p.sourceId, new Map());
      const list = index.get(p.sourceId), eligible = p.valid === true &&
        p.qualityFlag !== 'invalid' && MMM(p.mmol);
      const old = list.get(measured);
      if (old && (!eligible || old.mmol !== p.mmol)) list.set(measured, {at: measured, valid: false});
      else if (!old) list.set(measured, {at: measured, received, valid: eligible, mmol: p.mmol});
      else if (old.valid && received < old.received) old.received = received;
    }
    return new Map([...index].map(([id, values]) => [id, [...values.values()].sort((a,b) => a.at-b.at)]));
  }

  function nearest(list, target, origin) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (list[middle].at < target - TOLERANCE) lo = middle + 1;
      else hi = middle;
    }
    let result = null;
    for (let i = lo; i < list.length && list[i].at <= target + TOLERANCE; i++) {
      const p = list[i];
      // Do not replace a conflicting nearest measurement by a conveniently available sample further away.
      if (p.at <= origin) continue;
      if (!result || Math.abs(p.at - target) < Math.abs(result.at - target)) result = p;
    }
    return result?.valid ? result : null;
  }

  function summarize(rows, model, eligible) {
    const data = rows.map(row => ({actual: row.actual, prediction: row.predictions[model]}));
    const errors = data.map(item => item.prediction - item.actual);
    return {n: errors.length, coverage: eligible ? errors.length / eligible : null,
      mae: errors.length ? mean(errors.map(Math.abs)) : null,
      rmse: errors.length ? Math.sqrt(mean(errors.map(x => x*x))) : null,
      bias: errors.length ? mean(errors) : null,
      missedLow: data.filter(x => x.actual < LOW && x.prediction >= LOW).length,
      falseLow: data.filter(x => x.actual >= LOW && x.prediction < LOW).length};
  }

  function horizonResult(rows, eligible, horizon) {
    const bins = new Set(rows.map(row => Math.floor(row.actualAt / BUCKET)));
    const windows = new Map();
    for (const row of rows) {
      const key = Math.floor(row.actualAt / BLOCK);
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push(row);
    }
    const blocks = [...windows.values()].filter(xs => xs.length >= 12);
    const metrics = Object.fromEntries(MODELS.map(model => [model, summarize(rows, model, eligible)]));
    const base = {horizon, eligible, n: rows.length, pairedMinutes: bins.size * 5, qualifyingBlocks: blocks.length, metrics, rows};
    if (bins.size < MIN_BUCKETS || blocks.length < 3) return {...base, status:'NO_LEADER', leader:null, reason:'INSUFFICIENT_COMPARABLE_HISTORY'};
    const sorted = MODELS.slice().sort((a,b) => metrics[a].mae-metrics[b].mae);
    const [first,...peers] = sorted;
    const ahead = peers.every(peer => metrics[peer].mae - metrics[first].mae >= MARGIN &&
      metrics[first].missedLow <= metrics[peer].missedLow &&
      blocks.every(block => mean(block.map(row => Math.abs(row.predictions[peer]-row.actual) -
        Math.abs(row.predictions[first]-row.actual))) >= MARGIN));
    return {...base, status:ahead?'LEADER':'TIE', leader:ahead?first:null, reason:ahead?null:'MARGIN_NOT_REPRODUCED'};
  }

  function evaluate({issued, actual, asOf}) {
    const end = ts(asOf);
    if (!Number.isFinite(end) || !Array.isArray(issued) || !Array.isArray(actual)) throw Error('CONSENSUS_INPUT');
    const start = subtractMonths(end), grouped = new Map();
    let rejected = 0;
    for (const row of issued) {
      if (!validForecast(row,end)) { rejected++; continue; }
      if (ts(row.forecastAt) < start) continue;
      const key = JSON.stringify([ts(row.forecastAt),ts(row.sourceTime),row.sourceId,row.sourceRevision,row.inputDigest]);
      if (!grouped.has(key)) grouped.set(key,{origin:ts(row.forecastAt),sourceId:row.sourceId,byModel:new Map(),conflict:false});
      const group = grouped.get(key), prior = group.byModel.get(row.modelId);
      if (prior && JSON.stringify(prior)!==JSON.stringify(row)) group.conflict = true;
      else group.byModel.set(row.modelId,row);
    }
    const complete = [...grouped.values()].filter(group => !group.conflict && group.byModel.size === MODELS.length)
      .sort((a,b) => a.origin-b.origin);
    const latestGroup = complete.at(-1);
    const trainedVersions = Object.fromEntries(MODELS.map(id => [id,latestGroup?.byModel.get(id)?.modelVersion??null]));
    const all = complete.filter(group => MODELS.every(id=>group.byModel.get(id).modelVersion===trainedVersions[id]));
    const facts = indexFacts(actual,end);
    const results = HORIZONS.map(horizon => {
      const rows = [], paired = new Set();
      let eligible = 0;
      for (const group of all) {
        const target = group.origin+horizon*MIN;
        if (target+TOLERANCE>end) continue;
        eligible++;
        const hit = nearest(facts.get(group.sourceId)||[],target,group.origin);
        if (!hit) continue;
        const key = JSON.stringify([group.sourceId,hit.at]);
        if (paired.has(key)) continue;
        paired.add(key);
        const predictions = Object.fromEntries(MODELS.map(id => [id,group.byModel.get(id).points[horizon/5].glucoseMmol]));
        rows.push({origin:group.origin,actualAt:hit.at,actualReceivedAt:hit.received,actual:hit.mmol,predictions});
      }
      return horizonResult(rows,eligible,horizon);
    });
    const winners = new Set(results.map(row => row.leader));
    const status = winners.has(null) ? results.some(row => row.status === 'TIE') ? 'TIE' : 'NO_LEADER' :
      winners.size === 1 ? 'LEADER' : 'COMPOSITE';
    return {version:VERSION,status,leader:status==='LEADER'?[...winners][0]:null,asOf:end,windowStart:start,
      windowZone:'UTC',trainedVersions,rejected,matchedIssueGroups:all.length,results,therapeuticUse:false};
  }

  const blend = (a,b,t) => a+(b-a)*t*t*(3-2*t);
  function compose(review, forecasts) {
    if (review.status!=='COMPOSITE' || !Array.isArray(forecasts) || forecasts.length!==3) return null;
    const first = forecasts[0];
    if (!first) return null;
    const origin = ts(first.forecastAt);
    if (review.asOf>origin || forecasts.some(f=>!f) || new Set(forecasts.map(f=>f.modelId)).size!==3 ||
        forecasts.some(f=>!validForecast(f,origin) || f.modelVersion!==review.trainedVersions[f.modelId] || ts(f.forecastAt)!==origin || ts(f.sourceTime)!==ts(first.sourceTime) ||
          f.sourceRevision!==first.sourceRevision || f.sourceId!==first.sourceId || f.inputDigest!==first.inputDigest)) return null;
    const anchorWeights = review.results.map(row => {
      const values = MODELS.map(id=>1/(0.05+row.metrics[id].mae)**2);
      const total = values.reduce((sum,x)=>sum+x,0);
      return values.map(x=>x/total);
    });
    function sample(horizon) {
      if (!(horizon>=0 && horizon<=120)) throw Error('CONSENSUS_HORIZON');
      const segment = horizon<=60 ? 0 : 1;
      const ratio = Math.min(1,Math.max(0,(horizon-HORIZONS[segment])/(HORIZONS[segment+1]-HORIZONS[segment])));
      const weights = anchorWeights[segment].map((a,i)=>blend(a,anchorWeights[segment+1][i],ratio));
      const left = Math.floor(horizon/5), right = Math.min(24,left+1);
      const points = MODELS.map(id => forecasts.find(f=>f.modelId===id).points);
      const values = points.map(list=>blend(list[left].glucoseMmol,list[right].glucoseMmol,horizon/5-left));
      return {horizonMin:horizon,at:origin+horizon*MIN,glucoseMmol:values.reduce((sum,x,i)=>sum+x*weights[i],0),
        weights:Object.fromEntries(MODELS.map((id,i)=>[id,weights[i]]))};
    }
    return {modelId:'GFConsensus',modelVersion:VERSION,sourceRevision:first.sourceRevision,
      therapyUse:false,trainedThrough:review.asOf,points:Array.from({length:25},(_,i)=>sample(i*5)),sample};
  }

  // Descriptive assessment of already archived curves, including when a third model is unavailable.
  // These rows never qualify an incomplete set for ranking or an automatic combined curve.
  const RANGES = Object.freeze([[0,30],[30,60],[60,120]]);
  function assessStored({issued, actual, asOf}) {
    const end = ts(asOf), begin = subtractMonths(end);
    const facts = indexFacts(actual,end);
    return issued.filter(row=>row && row.contract==='glucopapa.research-forecast/2' &&
      validForecast(row,end) && ts(row.forecastAt)>=begin && ts(row.forecastAt)+120*MIN+TOLERANCE<=end)
      .map(row=>{
        const origin=ts(row.forecastAt), used=new Set(), matches=[];
        const series=facts.get(row.sourceId)||[];
        for (const point of row.points.slice(1)) {
          const fact=nearest(series,ts(point.at),origin);
          const check={horizonMin:point.horizonMin,predictedMmol:point.glucoseMmol,status:'MISSING_CGM'};
          if (!fact || used.has(fact.at)) { matches.push(check); continue; }
          used.add(fact.at);
          const errorMmol=point.glucoseMmol-fact.mmol;
          matches.push({...check,status:'MATCHED',actualMmol:fact.mmol,errorMmol,absoluteErrorMmol:Math.abs(errorMmol),
            actualMeasuredAt:new Date(fact.at).toISOString(),actualReceivedAt:new Date(fact.received).toISOString()});
        }
        const intervals=RANGES.map(([from,to])=>{
          const selected=matches.filter(p=>p.horizonMin>from&&p.horizonMin<=to);
          const pairs=selected.filter(p=>p.status==='MATCHED');
          const errors=pairs.map(p=>p.errorMmol);
          return {fromMin:from,toMin:to,available:selected.length,n:pairs.length,
            mae:errors.length?mean(errors.map(Math.abs)):null,rmse:errors.length?Math.sqrt(mean(errors.map(x=>x*x))):null,
            bias:errors.length?mean(errors):null,
            missedLow:pairs.filter(p=>p.actualMmol<LOW&&p.predictedMmol>=LOW).length,
            falseLow:pairs.filter(p=>p.actualMmol>=LOW&&p.predictedMmol<LOW).length};
        });
        return {forecastId:row.id,modelId:row.modelId,modelVersion:row.modelVersion,sourceRevision:row.sourceRevision,
          forecastAt:row.forecastAt,checks:matches,intervals};
      });
  }

  function readHistory(data) {
    const issued=data.forecasts.map(r=>({...r.payload,id:r.id,modelId:r.payload.modelId??'GFForecast',
      modelVersion:r.payload.modelVersion??r.payload.version,sourceId:r.payload.snapshot?.sensorSourceId}));
    const actual=data.cgm.map(row=>({...row,sourceId:row.sourceDeviceId}));
    return {issued,actual};
  }

  function archiveAssessment(host, asOf = Date.now()) {
    const research=host.connect('research'), data=research.getSnapshot();
    const reports=assessStored({...readHistory(data),asOf});
    const lastByForecast=new Map();
    for (const record of data.forecastAssessments) {
      const p=record.payload;
      if (!lastByForecast.has(p.forecastId)||ts(lastByForecast.get(p.forecastId).assessedAt)<ts(p.assessedAt)) {
        lastByForecast.set(p.forecastId,p);
      }
    }
    const assessedAt=new Date(ts(asOf)).toISOString();
    // Limit one manual transaction. A subsequent run skips rows that already match.
    const update=reports.filter(report=>report.checks.some(row=>row.status==='MATCHED') &&
      JSON.stringify(report.checks)!==JSON.stringify(lastByForecast.get(report.forecastId)?.checks)).slice(0,128);
    const writer=host.connect('forecastWriter');
    if (writer.getRevision()!==data.revision) return {status:'BLOCKED',reason:'REVISION_CHANGED',archived:0};
    const report=fromHost(host,asOf);
    if (report.status==='BLOCKED') return {...report,archived:0};
    if (!update.length) return {...report,archived:0};
    const assessments=update.map(row=>({id:row.forecastId+'|'+assessedAt,kind:'research_forecast_assessment',
      payload:{...row,assessedAt,peaks:[],metricVersion:VERSION}}));
    try {
      const receipt=writer.appendResearchEvents({schema:'gfforecast.research-events/1',writerRequired:true,
        forecasts:[],assessments},data.revision);
      return {...report,archived:update.length,archiveRevision:receipt.revision};
    } catch {
      return {...report,archived:0,assessmentStatus:'ASSESSMENT_ARCHIVE_FAILED'};
    }
  }

  function fromHost(host, asOf = Date.now()) {
    const port = host.connect('research'), data = port.getSnapshot();
    const inputs = {...readHistory(data), asOf};
    const review = evaluate(inputs);
    const assessed = assessStored(inputs);
    if (port.getRevision()!==data.revision) return {status:'BLOCKED',reason:'REVISION_CHANGED'};
    return {...review, sourceRevision:data.revision, assessed};
  }

  const api = Object.freeze({VERSION,MODELS,evaluate,compose,fromHost,assessStored,archiveAssessment});
  root.GFConsensusReview = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
