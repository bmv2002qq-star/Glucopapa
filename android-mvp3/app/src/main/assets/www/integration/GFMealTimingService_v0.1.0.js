/* Same-revision GFStorage handoff of the unchanged GFInjectionAnalytics result. */
(function (root) {
  'use strict';

  function refresh(host, {sessionId, units, site, atIso, mode}) {
    const output = host.connect('mealTimingPublisher');
    const settings = host.connect('settings').getSnapshot();
    const revision = settings.revision;
    const publish = (code, estimate = null) =>
      output.publish({sessionId, units, site, referenceAt: atIso, code, estimate}, revision);

    if (mode !== 'local') return publish('NON_LOCAL_HISTORY');
    if (!Number.isFinite(units) || units < 0.5 || units > 50 || !Number.isInteger(units * 2)) {
      return publish('DOSE_MISSING');
    }
    const model = root.GFInjectionFact.modelEvidence({host, atIso, revision, settings});
    if (!model) return publish('IOB_INCOMPLETE');
    const at = Date.parse(atIso);
    const sport = settings.conditionPeriods.some(p => p.kind === 'sport' &&
      Date.parse(p.start) <= at && (p.end === null || at < Date.parse(p.end)));
    const context = {activity: sport ? 'sport' : model.activity, iobU: model.modelUnits,
      plannedDoseU: units, sourceRevision: revision, settingRevision: model.settingKey, site};
    const result = root.GFInjectionAnalyticsV2.createAnalyzer(host).inspect({sessionId, atIso, context});
    if (result.status !== 'HISTORICAL_ESTIMATE') return publish(result.code);
    if (result.automaticInjectionTiming !== false) return publish('EVIDENCE_INVALID');
    return publish(null, {
      version: result.version, estimator: result.estimator, minutes: result.descriptiveLagMinutes,
      rangeMinutes: result.rangeMinutes, matchedCases: result.matchedCases, distinctDays: result.distinctDays,
      clinicalUse: result.clinicalUse,
    });
  }

  function countdown(shot, now = Date.now()) {
    const timing = shot?.mealTiming;
    if (!timing || shot.status !== 'confirmed' || shot.type !== 'insulin_injection' ||
        timing.injectionId !== shot.id || timing.sessionId !== shot.linkedMealSessionId ||
        !Number.isFinite(now) || !(Date.parse(shot.administeredAt) <= now)) return null;
    return Math.max(0, timing.estimate.minutes * 60 - Math.floor((now - Date.parse(shot.administeredAt)) / 1000));
  }

  const api = Object.freeze({refresh, countdown});
  root.GFMealTimingService = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
