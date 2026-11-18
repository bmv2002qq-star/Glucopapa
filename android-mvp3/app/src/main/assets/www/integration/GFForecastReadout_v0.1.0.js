/* Explicit, read-only model run from a single GFStorage revision. No treatment output. */
(function (root) {
  'use strict';
  const HOUR = 3_600_000;
  const stopped = (code, reason) => ({status: 'UNAVAILABLE', code, reason, points: []});

  function run({host, safetyVerdict, foodHistoryDeclaration, mealCoverageRevision, nowMs = Date.now(), mode}) {
    if (mode !== 'local') return stopped('TEST_JOURNAL', 'Тестовый журнал проверяется в изолированном стенде.');
    const trusted = root.GFForecastStorageAdapter.trustedReadings(host, {safetyVerdict});
    if (!trusted.available) return stopped(trusted.code, 'Требуются свежие показания с известным качеством и проверка GFSafety.');

    const research = host.connect('research');
    const snapshot = research.getSnapshot();
    if (snapshot.revision !== safetyVerdict.sourceRevision) {
      return stopped('REVISION_CHANGED', 'История изменилась во время чтения.');
    }
    const coverage = snapshot.coverage;
    if (!coverage?.confirmedComplete || coverage.declaredBy !== 'parent' ||
        !(Date.parse(coverage.startIso) <= nowMs - 48 * HOUR && Date.parse(coverage.endIso) >= nowMs)) {
      return stopped('INJECTION_COVERAGE', 'Требуется подтверждённая история инъекций за 48 часов.');
    }
    const mealCoverage = foodHistoryDeclaration;
    if (!mealCoverage || mealCoverage.source !== 'user_declared' || mealCoverage.confirmedComplete !== true ||
        mealCoverageRevision !== snapshot.revision ||
        !(Date.parse(mealCoverage.startIso) <= nowMs - 12 * HOUR && Date.parse(mealCoverage.endIso) >= nowMs &&
          Date.parse(mealCoverage.declaredAtIso) <= nowMs && Date.parse(mealCoverage.declaredAtIso) >= nowMs - 15 * 60_000)) {
      return stopped('MEAL_COVERAGE', 'Для этой ревизии нужна подтверждённая история фактической еды.');
    }
    const nowIso = new Date(nowMs).toISOString();
    const timeline = root.GFSettings.coefficientTimeline(snapshot.coefficients, nowIso, snapshot.profile.timeZone);
    const settings = {};
    const coefficients = [];
    for (const [kind, field] of [['carb_g_per_u', 'carbRatioGPerUnit'], ['isf_mmol_per_u', 'isfMmolPerUnit']]) {
      const rows = timeline.filter(x => x.kind === kind && x.isEffectiveAt);
      if (snapshot.profile.coefficientModes?.[kind] !== 'manual' || rows.length !== 1 ||
          !['manual', 'doctor'].includes(rows[0].source) || !Number.isFinite(rows[0].value)) {
        return stopped('COEFFICIENT_UNKNOWN', 'Нет однозначной действующей ручной записи УК и ФЧИ.');
      }
      settings[field] = rows[0].value;
      coefficients.push({kind, id: rows[0].id, value: rows[0].value, source: rows[0].source});
    }
    const at = date => Date.parse(date);
    const started = snapshot.mealSessions.filter(m => at(m.startedAt) >= nowMs - 12 * HOUR);
    if (started.some(m => m.status !== 'completed' || at(m.startedAt) > nowMs ||
        !Number.isFinite(at(m.completedAt)) || at(m.completedAt) > nowMs || !m.actualPlate ||
        m.actualPlate.containsEstimatedValues || m.actualPlate.items.some(x => x.amount == null) ||
        !Number.isFinite(m.actualPlate.totals?.carbs))) {
      return stopped('ACTUAL_PLATE_INCOMPLETE', 'В окне расчёта есть еда с неполным фактическим составом или временем.');
    }
    const active = kind => snapshot.conditionPeriods.some(p => p.kind === kind && at(p.start) <= nowMs &&
      (p.end === null || at(p.end) > nowMs));
    const input = {nowIso, readings: trusted.readings.filter(r => at(r.measuredAt) >= nowMs - HOUR),
      injections: snapshot.events.filter(e => e.type === 'insulin_injection' && e.status === 'confirmed' &&
        at(e.administeredAt) >= nowMs - 48 * HOUR),
      meals: started.map(m => ({id: m.id, status: 'confirmed', eatenAt: m.startedAt, carbsG: m.actualPlate.totals.carbs})),
      settings, conditions: {illness: active('illness'), activity: active('sport') || active('activity')},
      sourceIsComplete: true, rinfastEngine: root.RinfastEngine};
    const result = root.GFForecast.predict(input);
    return research.getRevision() === snapshot.revision
      ? {...result, sourceRevision: snapshot.revision, coefficients}
      : stopped('REVISION_CHANGED', 'История изменилась во время вычисления.');
  }

  const api = Object.freeze({run});
  root.GFForecastReadout = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
