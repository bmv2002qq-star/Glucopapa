/* Observational basal review. Observed glucose change does not identify a dose-response relationship. */
(function (root) {
  'use strict';
  const VERSION = '0.1.0', MIN = 60_000, HOUR = 60 * MIN;
  const WINDOWS = {3:'PRELIMINARY',7:'MAIN',14:'EXTENDED'};

  function time(value) { return typeof value==='string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN; }
  function median(values) {
    const xs = values.slice().sort((a,b)=>a-b);
    return !xs.length ? null : (xs[(xs.length - 1) >>> 1] + xs[xs.length >>> 1]) / 2;
  }

  function inspect(host, days, now = Date.now()) {
    if (!Object.hasOwn(WINDOWS, days) || !Number.isSafeInteger(now)) throw Error('BASAL_WINDOW');
    const research = host.connect('research'), sensor = host.connect('cgmAdapter');
    const r = research.getSnapshot(), metadata = sensor.getSnapshot();
    const finish = (code, sections, timezone = null) => ({
      version:VERSION,sourceRevision:r.revision,days,stage:WINDOWS[days],timezone,status:'NOT_ESTIMABLE',code,
      clinicalValidation:false,candidateUnits:null,candidateDelta:null,penStepUnits:0.5,
      model:'OBSERVED_WINDOW_DELTA',sections
    });
    if (metadata.revision!==r.revision || research.getRevision()!==r.revision) {
      return {...finish('REVISION_CHANGED',null),sourceRevision:null};
    }
    if (!r.profile.timeZone) return finish('TIMEZONE_UNKNOWN',null);
    const zone = r.profile.timeZone;
    const hour = new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'});
    const cutoff = now-days*24*HOUR;
    const basal = r.events.filter(e=>e.type==='insulin_injection' && e.status==='confirmed' &&
      e.insulinId==='levemir' && time(e.administeredAt)<=now).sort((a,b)=>time(a.administeredAt)-time(b.administeredAt));
    const short = r.events.filter(e=>e.type==='insulin_injection' && e.status==='confirmed' && e.insulinId==='rinfast');
    const provenance = metadata.cgmMetadata;
    const quality = provenance && ['device_recorded','synthetic'].includes(provenance.sourceType) &&
      Number.isFinite(provenance.qualityScore) && provenance.qualityScore>=0.8;
    const points = metadata.cgm.filter(p=>quality && p.sourceDeviceId===provenance.sourceDeviceId &&
      Number.isFinite(p.mmol) && p.valid!==false && p.qualityFlag!=='invalid' &&
      time(p.receivedAt)>=p.ts && time(p.receivedAt)<=now).sort((a,b)=>a.ts-b.ts);
    const coverage = r.coverage?.confirmedComplete===true && r.coverage.declaredBy==='parent' &&
      time(r.coverage.startIso)<=cutoff && time(r.coverage.endIso)>=now;
    const sections = {
      morning:{lastConfirmedUnits:null, lastConfirmedAt:null, observedMedianDelta:null, windows:[]},
      evening:{lastConfirmedUnits:null, lastConfirmedAt:null, observedMedianDelta:null, windows:[]},
    };

    for (const [index, row] of basal.entries()) {
      const at = time(row.administeredAt);
      if (at<cutoff) continue;
      const label = Number(hour.format(at))<12?'morning':'evening', group = sections[label];
      group.lastConfirmedUnits = row.units;
      group.lastConfirmedAt = row.administeredAt;
      const start = at+3*HOUR, end=at+7*HOUR;
      const issues = [];
      if (!coverage) issues.push('INJECTION_HISTORY_INCOMPLETE');
      if (!quality) issues.push('CGM_SOURCE_UNVERIFIED');
      if (end>now) issues.push('WINDOW_PENDING');
      const cgm = points.filter(p=>p.ts>=start-5*MIN && p.ts<=end+5*MIN);
      if (!cgm.length || cgm[0].ts>start+5*MIN || cgm.at(-1).ts<end-5*MIN ||
          cgm.some((p,i)=>i && p.ts-cgm[i-1].ts>15*MIN)) issues.push('CGM_GAPS');
      if (short.some(e=>time(e.administeredAt)>start-5*HOUR && time(e.administeredAt)<=end)) issues.push('RAPID_INSULIN_OVERLAP');
      if (r.mealSessions.some(m=>m.actualPlate && time(m.startedAt)>start-6*HOUR &&
          time(m.startedAt)<=end)) issues.push('FOOD_OVERLAP');
      if (r.conditionPeriods.some(p=>time(p.start)<end &&
          (p.end===null || time(p.end)>start))) issues.push('ACTIVITY_OR_ILLNESS');
      const previous = basal[index-1];
      const possibleBasalOverlap = !!previous && at-time(previous.administeredAt)<24*HOUR;
      const next = basal[index+1];
      if (next && time(next.administeredAt)<end) issues.push('ANOTHER_BASAL_IN_WINDOW');
      const lowObservations = cgm.filter(p=>p.mmol<3.9).length;
      if (lowObservations) issues.push('LOW_OBSERVED');
      group.windows.push({startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),
        possibleBasalOverlap,lowObservations,issues,observedDelta:issues.length?null:cgm.at(-1).mmol-cgm[0].mmol});
    }
    for (const group of Object.values(sections)) {
      group.observedMedianDelta = median(group.windows.map(w=>w.observedDelta).filter(Number.isFinite));
      group.eligibleWindows = group.windows.filter(w=>Number.isFinite(w.observedDelta)).length;
    }
    if (research.getRevision()!==r.revision) return {...finish('REVISION_CHANGED',null),sourceRevision:null};
    return finish(Object.values(sections).some(group=>group.eligibleWindows)?'FORMULA_SPEC_GAP':'INSUFFICIENT_HISTORY',sections,zone);
  }

  const api = Object.freeze({VERSION,inspect});
  root.GFLevemirReview = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
