const {test} = require('node:test');
const assert = require('node:assert/strict');
const Consensus = require('../../android-mvp3/app/src/main/assets/www/integration/GFConsensusReview_v0.1.0.js');
const Basal = require('../../android-mvp3/app/src/main/assets/www/integration/GFLevemirReview_v0.1.0.js');
const MIN = 60_000, STEP = 5 * MIN, HOUR = 60 * MIN, DAY = 24 * HOUR;
const START = Date.parse('2026-02-01T00:00:00Z');
const iso = at => new Date(at).toISOString();
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
  `expected ${expected}, got ${actual}`);

function issue(at, errors, inputDigest = 'a'.repeat(64)) {
  return Consensus.MODELS.map((modelId, model) => ({
    modelId, modelVersion: 'synthetic-1', forecastAt: iso(at), sourceTime: iso(at - MIN), sourceId: 'test-cgm',
    sourceRevision: 90, inputDigest,
    points: Array.from({length: 25}, (_, n) => ({
      at: iso(at + n * STEP), horizonMin: n * 5, glucoseMmol: 6 + errors(model, n * 5),
    })),
  }));
}

function observation(at, mmol = 6) {
  return {ts: at, receivedAt: iso(at + MIN), valid: true, sourceId: 'test-cgm', mmol};
}

function benchmark(errors, count = 288) {
  const issued = Array.from({length: count}, (_, n) => issue(START + n * STEP, errors)).flat();
  const actual = Array.from({length: count + 30}, (_, n) => observation(START + n * STEP));
  return {issued, actual, asOf: START + (count + 31) * STEP};
}

test('CONS-01 / PRED-05: independent signed metrics, ordered source, future receipts excluded', () => {
  const issued = issue(START, index => [-1, 2, 0][index]);
  const actual = [observation(START + 29 * MIN, 7), observation(START + 30 * MIN, 6),
    {...observation(START + HOUR), sourceId: 'other'},
    {...observation(START + HOUR), receivedAt: iso(START + 4 * HOUR)},
    observation(START + 2 * HOUR, 5)];
  const snapshot = JSON.stringify(issued);
  const result = Consensus.evaluate({issued, actual, asOf: START + 3 * HOUR});
  assert.equal(JSON.stringify(issued), snapshot);
  assert.deepEqual(result.results.map(row => row.n), [1, 0, 1]);
  const first = result.results[0].metrics.GFForecast;
  assert.deepEqual(first, {n: 1, coverage: 1, mae: 1, rmse: 1, bias: -1, missedLow: 0, falseLow: 0});
  assert.equal(result.results[0].metrics.GFxDrip.bias, 2);
  assert.equal(result.results[1].metrics.GFForecast.mae, null);
  assert.equal(result.results[2].metrics.GFForecast.bias, 0);
  const conflicted = Consensus.evaluate({issued, actual: [...actual, observation(START + 30 * MIN, 8)],
    asOf: START + 3 * HOUR});
  assert.equal(conflicted.results[0].n, 0);
});

test('CONS-02 / CONS-03: 24 hours of paired data before lead; tie and singular winner', () => {
  const errors = index => [0, 0.5, 1][index];
  const short = Consensus.evaluate(benchmark(errors, 287));
  const empty = Consensus.evaluate({...benchmark(errors), actual: []});
  const enough = Consensus.evaluate(benchmark(errors));
  assert.equal(short.status, 'NO_LEADER');
  assert.equal(empty.status, 'NO_LEADER');
  assert.equal(enough.status, 'LEADER');
  assert.equal(enough.leader, 'GFForecast');
  assert.ok(enough.results.every(row => row.pairedMinutes === 1440 && row.qualifyingBlocks >= 3));
  const tie = Consensus.evaluate(benchmark(index => [0, 0.05, -0.05][index]));
  assert.equal(tie.status, 'TIE');
  assert.equal(tie.leader, null);
});

test('CONS-04: continuous, normalized weights and exact common horizon; no future-trained fit', () => {
  const errors = (index, horizon) => index === (horizon <= 30 ? 0 : horizon <= 60 ? 1 : 2) ? 0 : 1;
  const review = Consensus.evaluate(benchmark(errors));
  assert.equal(review.status, 'COMPOSITE');
  assert.deepEqual(review.results.map(row => row.leader), Consensus.MODELS);
  const future = issue(review.asOf + STEP, errors);
  const curve = Consensus.compose(review, future);
  assert.equal(curve.therapyUse, false);
  assert.equal(curve.points.length, 25);
  assert.equal(curve.points.at(-1).horizonMin, 120);
  for (const point of curve.points) {
    const weights = Object.values(point.weights);
    close(weights.reduce((sum, x) => sum + x, 0), 1);
    assert.ok(weights.every(x => x >= 0));
    assert.ok(point.glucoseMmol >= 6 && point.glucoseMmol <= 7);
  }
  for (const boundary of [30, 60]) {
    const at = curve.sample(boundary), left = curve.sample(boundary - 0.001), right = curve.sample(boundary + 0.001);
    close(left.glucoseMmol, right.glucoseMmol, 1e-5);
    close((at.glucoseMmol - left.glucoseMmol) / 0.001, (right.glucoseMmol - at.glucoseMmol) / 0.001, 0.001);
  }
  assert.equal(Consensus.compose(review, issue(review.asOf - STEP, errors)), null);
  assert.equal(Consensus.compose(review, [future[0], future[1], null]), null);
});

test('CONS-07 / CONS-08 / CONS-09: malformed groups, calendar cutoff and both low errors', () => {
  const end = Date.parse('2024-05-31T12:00:00Z');
  const cutoff = Date.parse('2024-02-29T12:00:00Z');
  const issued = [
    ...issue(cutoff - STEP, () => 0),
    ...issue(cutoff, i => [-3, 0, 0][i]),
    ...issue(cutoff + STEP, () => 0),
  ];
  issued.at(-1).points = [];
  const actual = [observation(cutoff + 30 * MIN, 6), observation(cutoff + 60 * MIN, 3.5), observation(cutoff + 120 * MIN)];
  const result = Consensus.evaluate({issued, actual, asOf: end});
  assert.equal(result.windowStart, cutoff);
  assert.equal(result.windowZone, 'UTC');
  assert.equal(result.matchedIssueGroups, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.status, 'NO_LEADER');
  assert.equal(result.results[0].metrics.GFForecast.falseLow, 1);
  assert.equal(result.results[1].metrics.GFxDrip.missedLow, 1);
  assert.equal(result.results[1].metrics.GFForecast.missedLow, 0);
});

function basalJournal({missing = false, food = false, stale = false} = {}) {
  const now = START + 14 * DAY;
  const morning = now - DAY + 7 * HOUR;
  const evening = morning + 12 * HOUR - DAY;
  const events = [
    {type: 'insulin_injection', status: 'confirmed', insulinId: 'levemir', administeredAt: iso(evening), units: 2},
    {type: 'insulin_injection', status: 'confirmed', insulinId: 'levemir', administeredAt: iso(morning), units: 1.5},
    {type: 'insulin_injection', status: 'planned', insulinId: 'levemir', administeredAt: iso(morning + HOUR), units: 9},
  ];
  const cgm = [morning, evening].flatMap((at, group) => Array.from({length:49}, (_, index) => ({
    ts:at + 3 * HOUR + index * STEP, receivedAt: iso(at + 3 * HOUR + index * STEP + MIN),
    mmol: 6 + (group ? -1 : 1) * index / 48, sourceDeviceId:'test-cgm', valid:true,
  }))).filter((_, index) => !missing || (index >= 10 && index < 40));
  const research = {revision:90, profile: {timeZone:'UTC'}, events,
    mealSessions: food ? [{actualPlate:[{}], startedAt:iso(morning + 4 * HOUR)}] : [], conditionPeriods:[],
    coverage:{confirmedComplete:true, declaredBy:'parent', startIso:iso(now - 14 * DAY), endIso:iso(now)}};
  const metadata = {revision:90, cgm, cgmMetadata:{sourceType:'synthetic',qualityScore:1,sourceDeviceId:'test-cgm'}};
  const host = {connect: name => ({getSnapshot:() => name === 'research' ? research : metadata,
    getRevision:() => stale ? 91 : 90})};
  return {host, now, events, research};
}

test('BASAL-02 / BASAL-03 / BASAL-09: manual observer keeps actual dose and read-only sections', () => {
  const {host, now, events} = basalJournal();
  const original = JSON.stringify(events);
  for (const [days, stage] of [[3,'PRELIMINARY'],[7,'MAIN'],[14,'EXTENDED']]) {
    const result = Basal.inspect(host, days, now);
    assert.equal(result.stage, stage);
    assert.equal(result.code, 'FORMULA_SPEC_GAP');
    assert.equal(result.sourceRevision, 90);
    assert.equal(result.candidateUnits, null);
    assert.equal(result.candidateDelta, null);
    assert.equal(result.sections.morning.lastConfirmedUnits, 1.5);
    close(result.sections.morning.observedMedianDelta, 1);
    close(result.sections.evening.observedMedianDelta, -1);
    assert.equal(result.sections.morning.windows[0].possibleBasalOverlap, true);
  }
  assert.equal(JSON.stringify(events), original);
});

test('BASAL-04 / BASAL-05: late food, CGM gaps or changed revision become explicit', () => {
  const food = basalJournal({food:true});
  assert.deepEqual(Basal.inspect(food.host, 7, food.now).sections.morning.windows[0].issues, ['FOOD_OVERLAP']);
  const gaps = basalJournal({missing:true});
  assert.equal(Basal.inspect(gaps.host, 14, gaps.now).code, 'INSUFFICIENT_HISTORY');
  const stale = basalJournal({stale:true});
  assert.equal(Basal.inspect(stale.host, 7, stale.now).code, 'REVISION_CHANGED');
});
