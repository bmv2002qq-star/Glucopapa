'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const [programDir, stage11Dir, rerun] = process.argv.slice(2);
if (!programDir || !stage11Dir || (rerun && rerun !== '--full-replay')) {
  throw Error('Usage: node replay-food-audit.cjs <ПРОГРАММА> <Stage11-root> [--full-replay]');
}
const loadModule = filename => require(path.resolve(programDir, filename));
const labRoot = path.resolve(stage11Dir, 'vendor/GFReplayLab_v0.1.0');
const bundle = JSON.parse(fs.readFileSync(path.join(labRoot, 'examples/ТРИ_ДНЯ_ГОТОВЫЙ_ПРОГОН.json')));
const Storage = loadModule('modules/GFStorage_v0.5.11/src/gfstorage_core.js');
const Journal = loadModule('modules/GFJournal_v0.1.3/src/gfjournal.js');
const JournalAdapter = loadModule('modules/GFJournal_v0.1.3/src/gfjournal_storage_adapter.js');
const AuditExport = loadModule('modules/GFAuditExport_v0.1.4/src/gfaudit_export_storage_adapter.js');
const CgmPolicy = loadModule('integration/GFCgmEvidencePolicy_v0.1.0.js');
const AutoCob = loadModule('integration/GFAutoCOBProfile_v0.1.0.js');
const Coverage = loadModule('integration/GFMealCoverageStudy_v0.1.1.js');
const Cob = loadModule('integration/GFCOBResearch_v0.1.1.js');
const Forecast = loadModule('modules/GFForecast_v0.1.3/src/gfforecast.js');
const ForecastAdapter = loadModule('modules/GFForecast_v0.1.3/src/gfforecast_storage_adapter.js');
const RinfastEngine = loadModule('shared/RinfastEngine_v0.3.0_UNMODIFIED.js');
const minute = 60000;
const balances = ['protein', 'fat', 'carbs', 'kcal'];
const horizons = [30, 60, 90, 120];
const lowMmol = 3.9;
const round = (value, precision = 3) => Number(value.toFixed(precision));
const only = (array, callback) => {
  const matches = array.filter(callback);
  assert.equal(matches.length, 1);
  return matches[0];
};

function auditFood() {
  const archived = bundle.storage;
  assert.equal(archived.schemaVersion, 3);
  const readOnlyDriver = {
    load: () => structuredClone(archived),
    save() { throw Error('The archive audit must not write'); },
  };
  const open = () => Storage.createHost({driver: readOnlyDriver, clock: () => bundle.createdAt});
  const host = open();
  const current = host.exportState();
  assert.equal(current.schemaVersion, 5);
  assert.equal(current.revision, archived.revision);
  for (const key of ['mealSessions', 'workflowLog', 'events', 'cgm', 'coverage', 'history']) {
    assert.deepEqual(current[key], archived[key], `Migrated ${key}`);
  }
  assert.deepEqual(open().exportState(), current);

  const snapshot = host.connect('journal').getSnapshot();
  const exported = JSON.parse(AuditExport.exportJson(host));
  const nowMs = Date.parse(bundle.createdAt);
  const diary = CgmPolicy.journalView(host, Journal, JournalAdapter, {nowMs});
  assert.equal(snapshot.revision, diary.revision);
  assert.equal(snapshot.revision, exported.revision);
  assert.deepEqual(snapshot.mealSessions, archived.mealSessions);
  assert.deepEqual(exported.mealSessions, archived.mealSessions);
  assert.deepEqual(exported.events, archived.events);
  assert.equal(diary.sourceStatus, 'SYNTHETIC');
  assert.equal(diary.rows.filter(x => x.kind === 'meal').length, 10);
  assert.equal(diary.rows.filter(x => x.kind === 'injection').length, 12);
  assert.equal(diary.rows.filter(x => x.kind === 'legacy_meal').length, 0);

  const meals = archived.mealSessions.map(session => {
    const {id, actualPlate, plannedPlate, startedAt, completedAt, injectionIds} = session;
    assert.equal(session.status, 'completed');
    assert.ok(Date.parse(startedAt) <= Date.parse(completedAt));
    const entry = only(diary.rows, x => x.id === id && x.kind === 'meal');
    assert.equal(entry.ts, Date.parse(startedAt));
    assert.equal(entry.sessionVersion, session.version);
    assert.equal(entry.glucose.source, 'synthetic');
    assert.equal(entry.nutritionIssue, false);
    for (const [plate, summary] of [[actualPlate, entry.meal], [plannedPlate, entry.plan]]) {
      for (const [index, item] of plate.items.entries()) {
        const listed = summary.items[index];
        for (const key of ['name', 'amount', 'unit', ...balances]) {
          assert.equal(listed[key], item[key], `${id} item ${index} ${key}`);
        }
        assert.equal(listed.status, item.nutritionStatus);
      }
      for (const key of balances) {
        const sum = plate.items.reduce((total, item) => total + item[key], 0);
        assert.equal(round(sum, 2), plate.totals[key], `${id} ingredient sum ${key}`);
        assert.equal(summary[key], plate.totals[key]);
      }
      assert.equal(plate.totals.count, plate.items.length);
      assert.equal(plate.totals.amount, plate.items.reduce((total, item) => total + item.amount, 0));
    }
    for (const injectionId of injectionIds) {
      const confirmed = only(exported.events, x => x.id === injectionId);
      const row = only(diary.rows, x => x.id === injectionId && x.kind === 'injection');
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.linkedMealSessionId, session.id);
      assert.equal(row.link, session.id);
      assert.equal(row.ts, Date.parse(confirmed.administeredAt));
    }
    const sessionOps = archived.workflowLog.filter(x => x.sessionId === id);
    const actualOp = only(sessionOps, x => x.action === 'record_actual_plate');
    assert.equal(actualOp.before.actualPlate, null);
    assert.deepEqual(actualOp.after.actualPlate, actualPlate);
    assert.deepEqual(sessionOps.at(-1).after, session);
    const research = AutoCob.profilePlate(actualPlate);
    assert.equal(research.code, 'GI_NOT_TRANSFERRED_OR_UNKNOWN');
    assert.equal(research.kinetics, null);
    assert.equal(research.allowDose, false);
    return {
      id, startedAt, completedAt, itemCount: actualPlate.items.length,
      gramsRecorded: actualPlate.totals.amount, gramsWithExplicitUnit: actualPlate.items.filter(x => x.unit === 'г' && Number.isFinite(x.amount)).length,
      nutrients: Object.fromEntries(balances.map(key => [key, actualPlate.totals[key]])),
      giKnown: actualPlate.items.filter(x => Number.isFinite(x.glycemicIndex)).length,
      verifiedNutrientItems: actualPlate.items.filter(x => ['verified', 'label_verified', 'user_confirmed'].includes(x.nutritionStatus)).length,
      researchProfile: research.code, linkedConfirmedInjections: injectionIds.length, operations: sessionOps.length,
    };
  });
  const coverage = Coverage.inspect({host, nowMs});
  const cob = Cob.inspect({host, nowMs});
  const autoCob = AutoCob.inspect({host, nowMs});
  assert.equal(coverage.code, 'FOOD_DATA_UNKNOWN');
  assert.equal(coverage.eligible, false);
  assert.equal(cob.code, 'FOOD_COVERAGE_MISSING');
  assert.equal(cob.value, null);
  assert.equal(cob.allowDose, false);
  assert.equal(autoCob.status, 'PROFILE_PARTIAL');
  assert.equal(autoCob.kineticsByMealId, null);
  const forecastGate = ForecastAdapter.trustedReadings(host);
  assert.equal(forecastGate.available, false);
  assert.equal(forecastGate.code, 'SOURCE_NOT_TRUSTED');
  assert.deepEqual(forecastGate.readings, []);
  assert.deepEqual(host.exportState(), current);
  return {
    sourceSchema: archived.schemaVersion, migratedSchema: current.schemaVersion, storageVersion: Storage.VERSION, revision: current.revision,
    storageWriteCount: 0, sessions: meals.length, itemCount: meals.reduce((a, x) => a + x.itemCount, 0),
    explicitGramItems: meals.reduce((a, x) => a + x.gramsWithExplicitUnit, 0),
    giKnown: meals.reduce((a, x) => a + x.giKnown, 0),
    verifiedNutrientItems: meals.reduce((a, x) => a + x.verifiedNutrientItems, 0),
    carbsG: round(meals.reduce((a, x) => a + x.nutrients.carbs, 0), 2),
    exportedMeals: exported.mealSessions.length, diaryMeals: diary.rows.filter(x => x.kind === 'meal').length,
    confirmedInjections: archived.events.length, linkedConfirmedInjections: meals.reduce((a, x) => a + x.linkedConfirmedInjections, 0),
    mealAuditOperations: archived.workflowLog.length, rawHistoryCoverageWasDeclaredInSyntheticRun: archived.coverage.confirmedComplete,
    coverageStatus: coverage.status, coverageCode: coverage.code, cobStatus: cob.status, cobCode: cob.code, cobValue: cob.value,
    autoCobStatus: autoCob.status, autoCobProfileCount: autoCob.rows.filter(x => x.kinetics !== null).length,
    runtimeForecastGate: forecastGate.code, meals,
  };
}

function summarize(pairs, field) {
  assert.ok(pairs.length);
  let lowObserved = 0;
  let lowMissed = 0;
  let falsePositives = 0;
  let sum = 0;
  let sumAbsolute = 0;
  let sumSquared = 0;
  for (const pair of pairs) {
    const predicted = pair[field];
    const error = pair.actual - predicted;
    sum += error;
    sumAbsolute += Math.abs(error);
    sumSquared += error ** 2;
    if (pair.actual < lowMmol) {
      lowObserved++;
      if (predicted >= lowMmol) lowMissed++;
    } else if (predicted < lowMmol) {
      falsePositives++;
    }
  }
  return {
    matches: pairs.length, mae: round(sumAbsolute / pairs.length),
    biasActualMinusPredicted: round(sum / pairs.length), rmse: round(Math.sqrt(sumSquared / pairs.length)),
    lowObserved, lowMissed, truePositives: lowObserved - lowMissed, falsePositives,
  };
}

function verifyCurrentModel(forecast, observations) {
  const issued = forecast.forecastAt;
  const archived = bundle.storage;
  const overlaps = kind => archived.conditionPeriods.some(p => p.kind === kind && p.start <= issued && issued < p.end);
  const result = Forecast.predict({
    nowIso: issued,
    settings: bundle.settings,
    sourceIsComplete: true,
    rinfastEngine: RinfastEngine,
    readings: observations.filter(x => x.receivedAt <= issued).map(x => ({
      measuredAt: x.measuredAt, receivedAt: x.receivedAt, glucoseMmol: x.mmol,
      sourceId: x.sourceDeviceId, sensorId: x.sensorId, patientId: x.patientId,
    })),
    injections: archived.events.filter(e => e.administeredAt <= issued),
    meals: archived.mealSessions.filter(m => m.completedAt <= issued).map(m => ({
      id: m.id, carbsG: m.actualPlate.totals.carbs, eatenAt: m.startedAt, status: 'confirmed',
    })),
    conditions: {illness: overlaps('illness'), activity: overlaps('activity')},
  });
  assert.equal(result.status, 'EXPERIMENTAL');
  assert.equal(result.clinicalUse, false);
  assert.deepEqual(result.points, forecast.points, `Forecast points ${issued}`);
  assert.deepEqual(result.snapshot, forecast.snapshot, `Forecast inputs ${issued}`);
  assert.deepEqual(result.peaks, forecast.peaks, `Forecast peaks ${issued}`);
}

function auditForecast() {
  const asOf = Date.parse(bundle.createdAt);
  const receipts = new Map(bundle.transportReceipts.map(r => [Date.parse(r.measuredAt), r]));
  assert.equal(receipts.size, bundle.storage.cgm.length);
  const observed = bundle.storage.cgm.map(point => {
    const receipt = receipts.get(point.ts);
    assert.equal(point.source, 'synthetic');
    assert.equal(point.kind, 'observed');
    assert.equal(receipt.sourceDeviceId, point.sourceDeviceId);
    assert.equal(point.valid, true);
    return {...point, ...receipt, received: Date.parse(receipt.receivedAt)};
  }).sort((a, b) => a.ts - b.ts);
  assert.ok(observed.every(x => x.received >= x.ts && x.received <= asOf));
  const assessments = new Map(bundle.forecastAssessments.map(x => [x.forecastId, x]));
  assert.equal(assessments.size, bundle.researchForecasts.length);
  const pairsByHorizon = Object.fromEntries(horizons.map(horizon => [horizon, []]));
  const unmatchedByHorizon = Object.fromEntries(horizons.map(horizon => [horizon, {pending: 0, missing: 0}]));
  for (const item of bundle.researchForecasts) {
    const f = item.forecast;
    const issued = Date.parse(f.forecastAt);
    verifyCurrentModel(f, observed);
    const specifiedSource = x => x.sourceDeviceId === f.snapshot.sensorSourceId && x.sensorId === f.snapshot.sensorId && x.patientId === f.snapshot.patientId;
    const latestBefore = observed.filter(x => x.received <= issued && specifiedSource(x)).at(-1);
    assert.equal(latestBefore.ts, Date.parse(f.sourceTime));
    assert.equal(latestBefore.mmol, f.snapshot.lastCgmMmol);
    assert.equal(f.status, 'EXPERIMENTAL');
    for (const h of horizons) {
      const point = only(f.points, x => x.horizonMin === h);
      const target = issued + h * minute;
      assert.equal(Date.parse(point.at), target);
      const previous = only(assessments.get(item.id).checks, x => x.horizonMin === h);
      if (asOf < target + 2.5 * minute) {
        assert.equal(previous.status, 'PENDING');
        unmatchedByHorizon[h].pending++;
        continue;
      }
      const near = observed.filter(x => Math.abs(x.ts - target) <= 2.5 * minute);
      if (!near.length) {
        assert.equal(previous.status, 'MISSING_CGM');
        unmatchedByHorizon[h].missing++;
        continue;
      }
      assert.ok(near.every(specifiedSource));
      const matched = near.reduce((best, x) => Math.abs(x.ts - target) < Math.abs(best.ts - target) ? x : best);
      assert.equal(previous.status, 'MATCHED');
      assert.equal(previous.actualMeasuredAt, matched.measuredAt);
      assert.equal(previous.actualReceivedAt, matched.receivedAt);
      assert.equal(previous.actualMmol, matched.mmol);
      assert.equal(previous.predictedMmol, point.glucoseMmol);
      assert.equal(previous.errorMmol, round(matched.mmol - point.glucoseMmol, 2));
      pairsByHorizon[h].push({forecast: point.glucoseMmol, persistence: latestBefore.mmol, actual: matched.mmol, ts: matched.ts, issuanceDate: f.forecastAt.slice(0, 10)});
    }
  }
  const allPairs = Object.values(pairsByHorizon).flat();
  const start = Date.parse(bundle.researchForecasts[0].forecast.forecastAt);
  const low = observed.filter(x => x.ts >= start && x.mmol < lowMmol);
  const episodes = [];
  for (const item of low) {
    const previous = episodes.at(-1);
    if (previous && item.ts - previous.at(-1).ts <= 5 * minute) previous.push(item);
    else episodes.push([item]);
  }
  const lowEpisodes = episodes.map(episode => {
    const ticks = new Set(episode.map(x => x.ts));
    const relevant = allPairs.filter(p => ticks.has(p.ts));
    const assessed = new Set(relevant.map(x => x.ts));
    const predicted = new Set(relevant.filter(x => x.forecast < lowMmol).map(x => x.ts));
    return {
      firstObservedAt: episode[0].measuredAt, lastObservedAt: episode.at(-1).measuredAt,
      lowReadings: ticks.size, assessedReadings: assessed.size, predictedReadings: predicted.size,
      status: !assessed.size ? 'NOT_ASSESSED' : predicted.size ? 'AT_LEAST_ONE_HIT' : 'ALL_MATCHED_FORECASTS_MISSED',
    };
  });
  const dates = Array.from(new Set(allPairs.map(x => x.issuanceDate)));
  return {
    modelVersion: bundle.modelVersions.forecast, archivedForecasts: bundle.researchForecasts.length,
    currentCoreReproduction: {version: Forecast.VERSION, matchedForecasts: bundle.researchForecasts.length, numericalDelta: 0},
    unavailableForecasts: bundle.summary.forecastUnavailable, rawCgmPoints: observed.length,
    comparisonThresholdMmol: lowMmol, distinctLowEpisodes: episodes.length, lowEpisodes,
    allMatchedHorizonPairs: {forecast: summarize(allPairs, 'forecast'), persistence: summarize(allPairs, 'persistence')},
    byHorizon: Object.fromEntries(horizons.map(horizon => [horizon, {
      forecast: summarize(pairsByHorizon[horizon], 'forecast'),
      persistence: summarize(pairsByHorizon[horizon], 'persistence'), ...unmatchedByHorizon[horizon],
    }])),
    byIssuanceUtcDate: Object.fromEntries(dates.map(date => {
      const pairs = allPairs.filter(x => x.issuanceDate === date);
      return [date, {forecast: summarize(pairs, 'forecast'), persistence: summarize(pairs, 'persistence')}];
    })),
  };
}

function fullReplay() {
  const start = Date.now();
  const engine = require(path.join(labRoot, 'src/gfreplaylab.js'));
  const lab = engine.createLab();
  lab.advance(engine.STEPS);
  const fresh = lab.exportBundle();
  const compared = ['storage', 'transportReceipts', 'researchForecasts', 'forecastAssessments', 'virtualActions', 'summary'];
  for (const section of compared) assert.deepEqual(fresh[section], bundle[section], `Replay ${section}`);
  return {status: 'PASS', steps: engine.STEPS, comparedSections: compared, runtimeMs: Date.now() - start};
}

assert.equal(bundle.schema, 'GFReplayLab.synthetic-test-bundle/1');
assert.equal(bundle.synthetic, true);
assert.equal(bundle.clinicalUseAllowed, false);
const output = {
  status: 'PASS', mode: 'SYNTHETIC_RESEARCH_ONLY', clinicalUseAllowed: false,
  food: auditFood(), forecast: auditForecast(),
  freshReplay: rerun === '--full-replay' ? fullReplay() : {status: 'NOT_RUN'},
};
console.log(JSON.stringify(output, null, 2));
