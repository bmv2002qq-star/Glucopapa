/* Research only. Captures independent engines and commits a single revisioned archive packet. */
(function (root) {
  'use strict';
  const VERSION = '0.1.1';
  const CONTRACT = 'glucopapa.research-forecast/2';
  const IDS = Object.freeze(['GFForecast', 'GFAPSEnhancer', 'GFxDrip']);
  const STEP = 300_000, FORECAST_STEPS = 24;

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined)
        .map(k => [k, canonical(value[k])]));
    }
    return value;
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  async function digest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
    const hash = new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, byte => byte.toString(16).padStart(2,'0')).join('');
  }

  function frameFrom(state) {
    const {nowIso, readings, injections, meals, settings, conditions} = state.input;
    const origin = Date.parse(nowIso);
    const last = readings.slice().sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt)).at(-1);
    const research = state.snapshot;
    const start = origin - 7*60*60_000;
    const cgm = research.cgm.filter(p => p.ts >= start && p.ts <= origin &&
      Number.isFinite(Date.parse(p.receivedAt)) && Date.parse(p.receivedAt) <= origin &&
      p.sourceDeviceId === last.sourceId);
    const virtualPort = {
      revision: research.revision, schemaVersion: 5, coverage: research.coverage, cgm, drugs: research.drugs,
      events: injections, mealSessions: research.mealSessions.filter(m => meals.some(x => x.id === m.id)),
    };
    return freeze(canonical({
      forecastAt: nowIso, sourceRevision: research.revision,
      sourceTime: new Date(Date.parse(last.measuredAt)).toISOString(),
      sourceReceivedAt: new Date(Date.parse(last.receivedAt)).toISOString(),
      sourceId:last.sourceId, readings, injections, meals, settings, conditions, sourceIsComplete:true,
      timezone:research.profile.timeZone, coefficients:state.coefficients,
      mealCoverage:state.foodHistoryDeclaration,mealModel:state.mealModel,
      rapidProfile:research.models?.rinfast?.profile ?? null, aapsSnapshot: virtualPort,
    }));
  }

  function gff(frame,rapid) {
    const {forecastAt:nowIso, readings, injections, meals, settings, conditions, sourceIsComplete} = frame;
    const run = root.GFForecast.predict({
      nowIso,readings,injections,meals,settings,conditions,sourceIsComplete,rinfastEngine:rapid,
    });
    if (run.status !== 'EXPERIMENTAL') return {code:run.code ?? 'ENGINE_REFUSED', details:run.reason ?? null};
    return {version:run.version,points:run.points,uncertainty:run.uncertainty ?? null,
      flags:run.snapshot.flags,summary:run.snapshot};
  }

  function aaps(frame,rapid) {
    if (!root.GFAPSResearch || !root.GFAPSEnhancer) return {code:'ENGINE_UNAVAILABLE'};
    const profile = rapid.DEFAULT_PROFILE;
    const input = root.GFAPSResearch.adapter.fromGFStorage({getSnapshot:()=>frame.aapsSnapshot},{
      nowTs:Date.parse(frame.forecastAt),
      parameters:{
        isfMmolPerU:frame.settings.isfMmolPerUnit,crGPerU:frame.settings.carbRatioGPerUnit,
        diaMinutes:profile.diaMinutes,peakMinutes:profile.peakMinutes,rapidCurve:rapid.getCurve,
      },historyHours:7,
    });
    const measuredAt = Date.parse(frame.sourceTime);
    const issueAt = Date.parse(frame.forecastAt);
    const offset = (issueAt-measuredAt)/STEP;
    if (offset<0 || offset>3 || input.cgm.at(-1)?.ts!==measuredAt) return {code:'HORIZON_ANCHOR_MISMATCH'};
    const sampleCount = FORECAST_STEPS+Math.ceil(offset);
    const result = root.GFAPSResearch.forecast.predict(input,{horizonMinutes:sampleCount*5,stepMinutes:5});
    if (!result.ok) return {code:'ENGINE_REFUSED', details:result.errors?.join(' · ') ?? null};
    if (result.points.length!==sampleCount+1 ||
        !result.points.every((p,i)=>p.ts===measuredAt+i*STEP&&Number.isFinite(p.COB))) return {code:'HORIZON_ANCHOR_MISMATCH'};

    const whole = Math.floor(offset), fraction = offset-whole;
    const points = Array.from({length:FORECAST_STEPS+1},(_,i)=>{
      const left = result.points[whole+i].COB;
      const value = fraction===0 ? left : left+fraction*(result.points[whole+i+1].COB-left);
      return {horizonMin:i*5,at:new Date(issueAt+i*STEP).toISOString(),glucoseMmol:value};
    });
    return {version:root.GFAPSEnhancer.VERSION,uncertainty:null,points,
      timeAlignment:{originalOrigin:frame.sourceTime,method:offset===0?'direct':'linear-on-measured-grid-v1'},
      flags:[...(frame.conditions.activity?['activity_unmodeled']:[]),...(frame.conditions.illness?['illness_unmodeled']:[])]};
  }

  function prepareRow(frame, modelId, result, inputDigest) {
    const origin = Date.parse(frame.forecastAt);
    if (!/^\d+\.\d+\.\d+$/.test(result.version ?? '') || !Array.isArray(result.points) ||
        result.points.length !== 25) return {code:'ENGINE_RESULT_INVALID'};
    const points = [];
    for (let index=0; index<25; index++) {
      const point = result.points[index];
      if (!point || point.horizonMin !== index*5 || Date.parse(point.at) !== origin+index*STEP) {
        return {code:'HORIZON_ANCHOR_MISMATCH'};
      }
      if (!Number.isFinite(point.glucoseMmol) || point.glucoseMmol < 0 || point.glucoseMmol > 40) {
        return {code:'ENGINE_RESULT_INVALID'};
      }
      points.push({horizonMin:index*5,at:new Date(origin+index*STEP).toISOString(),
        glucoseMmol:point.glucoseMmol,lower:point.lower??null,upper:point.upper??null});
    }
    const version = modelId+'@'+result.version;
    const id = [frame.forecastAt,frame.sourceTime,version].join('|');
    return {row:{id,kind:'research_forecast',payload:{
      contract:CONTRACT,modelId,modelVersion:result.version,version,mode:'RESEARCH_FORECAST',
      status:'EXPERIMENTAL',forecastAt:frame.forecastAt,sourceTime:frame.sourceTime,
      sourceReceivedAt:frame.sourceReceivedAt,sourceRevision:frame.sourceRevision,inputDigest,
      mealModel:frame.mealModel,...(result.timeAlignment?{timeAlignment:result.timeAlignment}:{}),
      snapshot:{sensorSourceId:frame.sourceId,flags:result.flags??[]},
      clinicalUse:false,modelValidated:false,horizonMinutes:120,stepMinutes:5,
      uncertainty:result.uncertainty??null,points,
    }}};
  }

  async function run(options) {
    const capture = root.GFForecastReadout.prepare(options);
    const unavailable = {modelId:'GFxDrip',status:'UNAVAILABLE',code:'LICENSE_BLOCKED'};
    if (capture.status !== 'READY') return {...capture,engines:[unavailable]};
    const frame = frameFrom(capture);
    const writer = options.host.connect('forecastWriter');
    if (writer.getRevision() !== frame.sourceRevision || options.isCurrent?.() === false) {
      return {status:'UNAVAILABLE',code:'REVISION_CHANGED',engines:[unavailable]};
    }
    let inputDigest;
    try { inputDigest = await digest(frame); }
    catch { return {status:'UNAVAILABLE',code:'INPUT_DIGEST_UNAVAILABLE',engines:[unavailable]}; }
    const rows = [];
    const engines = [unavailable];
    for (const [modelId, engine] of [[IDS[0],gff],[IDS[1],aaps]]) {
      try {
        const result = engine(frame,capture.input.rinfastEngine);
        const prepared = result.code ? result : prepareRow(frame,modelId,result,inputDigest);
        if (prepared.row) {
          rows.push(prepared.row);
          engines.push({modelId,status:'EXPERIMENTAL',row:prepared.row,summary:result.summary??null});
        } else {
          engines.push({modelId,status:'UNAVAILABLE',code:prepared.code,details:prepared.details??null});
        }
      } catch {
        engines.push({modelId,status:'UNAVAILABLE',code:'ENGINE_FAILED'});
      }
    }
    if (writer.getRevision() !== frame.sourceRevision || options.isCurrent?.() === false) {
      return {status:'UNAVAILABLE',code:'REVISION_CHANGED',engines:[unavailable]};
    }
    if (!rows.length) return {status:'UNAVAILABLE',code:'NO_COMPARABLE_CURVE',sourceRevision:frame.sourceRevision,engines};
    try {
      const receipt = writer.appendResearchEvents({schema:'gfforecast.research-events/1',
        writerRequired:true,forecasts:rows,assessments:[]},frame.sourceRevision);
      return {status:'ARCHIVED',sourceRevision:frame.sourceRevision,archiveRevision:receipt.revision,
        inputDigest,mealModel:frame.mealModel,coefficients:capture.coefficients,engines};
    } catch {
      return {status:'UNAVAILABLE',code:'FORECAST_ARCHIVE_FAILED',sourceRevision:frame.sourceRevision,engines:[unavailable]};
    }
  }

  const api = Object.freeze({VERSION,run});
  root.GFResearchForecastRun = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
