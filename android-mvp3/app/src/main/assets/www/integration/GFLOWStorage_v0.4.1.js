/* LOW candidate. Facts use a scoped GFStorage read port and the existing actionWriter. */
(function (root) {
  'use strict';
  const minute = 60_000;
  const nutrients = ['carbs', 'fat', 'protein', 'kcal'];
  const validNumber = Number.isFinite;
  const time = Date.parse;
  const activityLabels = {low: 'низкая', usual: 'обычная', high: 'высокая', sport: 'спорт'};

  function selectCoefficients(profile, coefficients, nowIso) {
    const rows = root.GFSettings.coefficientTimeline(coefficients, nowIso, profile.timeZone);
    const read = kind => {
      if (profile.coefficientModes?.[kind] !== 'manual') return null;
      const active = rows.filter(row => row.kind === kind && row.isEffectiveAt);
      if (active.length !== 1) return null;
      const row = active[0];
      return ['manual', 'doctor'].includes(row.source) && root.GFTimeGrid.slotOf(row.windowLocal) &&
        validNumber(row.value) && row.value > 0
        ? {value: row.value, origin: row.source, window: row.windowLocal, id: row.id}
        : null;
    };
    return {isf: read('isf_mmol_per_u'), uk: read('carb_g_per_u')};
  }

  function catalog(snapshot) {
    const items = new Map();
    for (const session of [...snapshot.mealSessions].reverse()) {
      const plate = session.actualPlate ?? session.plannedPlate;
      if (!plate) continue;
      for (const item of plate.items) {
        const source = item.nutritionStatus;
        if (!source || /unknown|missing|not_provided/i.test(source) ||
            !validNumber(item.amount) || item.amount <= 0 || !['г', 'мл'].includes(item.unit) ||
            !nutrients.every(key => validNumber(item[key]) && item[key] >= 0)) continue;
        const key = JSON.stringify([item.foodId ?? item.name, item.unit]);
        if (!items.has(key)) items.set(key, {key, item, from: session.id,
          reference: {...plate, items: [item], containsEstimatedValues: plate.containsEstimatedValues}});
      }
    }
    return [...items.values()];
  }

  function observed(cgm, nowMs, mode) {
    const synthetic = mode === 'demo';
    const sourceMatches = !cgm.sourceType || (synthetic ? cgm.sourceType === 'synthetic' : cgm.sourceType !== 'synthetic');
    const age = validNumber(cgm.ageMinutes) ? cgm.ageMinutes : null;
    const stale = age !== null && age > 12;
    const timeMs = time(cgm.latestAt);
    const latest = cgm.readings.at(-1);
    const receipt = time(latest?.receivedAt);
    const receiptKnown = validNumber(receipt) && receipt >= timeMs - minute && receipt <= nowMs;
    const value = sourceMatches && !stale && receiptKnown ? cgm.currentMmol ?? cgm.reportedMmol ?? null : null;
    const trend = validNumber(value) ? root.GFCgmEvidencePolicy.forEvent(cgm, timeMs, {journal: root.GFJournal}) : null;
    const validSeries = cgm.status === 'OK' && sourceMatches && !stale && receiptKnown;
    const readings = validSeries ? cgm.readings.filter(row => row.ts >= nowMs - 45 * minute &&
      validNumber(time(row.receivedAt)) && time(row.receivedAt) <= nowMs).map(row => ({
        measuredAt: new Date(row.ts).toISOString(), receivedAt: row.receivedAt,
        glucoseMmol: row.mmol, sourceId: row.sourceDeviceId, kind: 'observed'
      })) : [];
    const alert = readings.length && readings.at(-1).measuredAt === cgm.latestAt
      ? root.GFXDripLowAlert.predict({readings, nowIso: new Date(nowMs).toISOString(), thresholdMmol: 3.9,
          warningWindowMin: 30, horizonMin: 30})
      : null;
    return {value, age, measuredAt: cgm.latestAt, source: cgm.sourceStatus, trend: trend?.direction ?? null,
      code: stale ? 'CGM_STALE' : !sourceMatches ? 'CGM_SOURCE_NOT_ELIGIBLE' :
        latest && !receiptKnown && cgm.status === 'OK' ? 'CGM_RECEIPT_MISSING' : cgm.code, alert,
      low: validNumber(value) && value < 3.9};
  }

  function inspect({host, nowMs = Date.now(), mode = 'local', foodOptions = {}} = {}) {
    if (host?.getSchemaVersion?.() !== 5) return {code: 'GFSTORAGE_UNAVAILABLE', revision: null, products: []};
    if (!Number.isSafeInteger(nowMs)) return {code: 'CLOCK_INVALID', revision: null, products: []};
    const port = host.connect('lowReview');
    const snapshot = port.getSnapshot();
    const {revision, profile} = snapshot;
    const nowIso = new Date(nowMs).toISOString();
    const cgm = root.GFCgmEvidencePolicy.inspect(host, {nowMs});
    const glucose = observed(cgm, nowMs, mode);
    const rates = selectCoefficients(profile, snapshot.coefficients, nowIso);
    const food = root.GFMealAbsorption.inspect({host, snapshot, nowMs, options: foodOptions});
    const range = snapshot.coverage;
    const historyComplete = range?.confirmedComplete === true && range.declaredBy === 'parent' &&
      time(range.startIso) <= nowMs - 360 * minute && time(range.endIso) >= nowMs;
    const active = kind => snapshot.conditionPeriods.some(row => row.kind === kind &&
      time(row.start) <= nowMs && (row.end === null || nowMs < time(row.end)));
    const activity = active('sport') ? 'sport' : profile.activityBaseLevel;
    const illness = active('illness');
    const products = catalog(snapshot);
    if (cgm.revision !== revision || food.sourceRevision !== revision || port.getRevision() !== revision)
      return {code: 'REVISION_CHANGED', revision: null, products: []};

    const blockers = [];
    if (cgm.status !== 'OK' || !validNumber(glucose.value)) blockers.push(glucose.code);
    if (!historyComplete) blockers.push('JOURNAL_COVERAGE_UNKNOWN');
    if (!rates.isf || !rates.uk) blockers.push('SETTINGS_INCOMPLETE');
    if (snapshot.mealSessions.some(row => row.status === 'started')) blockers.push('MEAL_PARTIAL');
    if (!food.forecastReady) blockers.push(food.forecastCode ?? food.code);
    if (illness) blockers.push('ILLNESS_EFFECT_UNMODELED');
    if (activity !== 'usual') blockers.push('ACTIVITY_EFFECT_UNMODELED');
    if (!products.length) blockers.push('PRODUCT_COMPOSITION_UNKNOWN');
    // GFStorage currently has no verified product-to-tau contract. The global engines and LOW
    // also use different baselines. Neither a fixed research tau nor an unrelated CDF fills them.
    blockers.push(food.model.id === 'GFCOB' ? 'GFCOB_PORT_UNAVAILABLE' : 'LOW_CANONICAL_PARITY_MISSING',
      'PRODUCT_PROFILE_UNVERIFIED');

    const iob = root.GFInsulinEvidenceGate.calculateFromHost(host, nowIso);
    const measurements = snapshot.measurements.filter(row => validNumber(row.weightKg) &&
      validNumber(time(row.measuredAt)) && time(row.measuredAt) <= nowMs);
    const weight = measurements.reduce((latest, row) => !latest || time(latest.measuredAt) < time(row.measuredAt)
      ? row : latest, null)?.weightKg;
    const syntheticReference = mode === 'demo' && glucose.source === 'SYNTHETIC' && glucose.low
      ? root.GFLOWCore.ispad(weight, glucose.value) : null;
    if (port.getRevision() !== revision) return {code: 'REVISION_CHANGED', revision: null, products: []};
    return {code: blockers[0], blockers: [...new Set(blockers)], revision, nowIso, mode, products, glucose, rates,
      activity: activityLabels[activity] ?? null, illness, food, syntheticReference,
      iob: iob.totalModelUnits};
  }

  function prepareFact({view, productKey, amount, id, decidedAt}) {
    const product = view.products.find(row => row.key === productKey);
    if (!product || !validNumber(amount) || amount <= 0 || amount > 200)
      throw Error('Укажите продукт и фактически съеденное количество');
    const plate = root.GFMealActualPanel.scalePlate(product.reference, [amount]);
    plate.createdAt = decidedAt;
    return {sessionId: id, opId: id + ':confirmed', eatenAt: decidedAt, actualPlate: plate};
  }

  function recordFact({host, confirmation, pending, expectedRevision}) {
    if (confirmation !== true) throw Error('Требуется подтверждение фактически съеденной еды');
    return host.connect('actionWriter').confirmCompletedMeal({...pending, parentConfirmed: true}, expectedRevision);
  }

  const api = Object.freeze({inspect, selectCoefficients, prepareFact, recordFact});
  root.GFLOWStorage = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
