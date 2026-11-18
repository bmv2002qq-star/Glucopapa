'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {at, minute, iso, fromWeb, archivedEngine, testJournal, addPlate, mutate,
    syntheticInputs, MealCalc, Rinfast, sessionId} = require('./fixture.cjs');

const folder = path.resolve(process.argv[2] || 'qa-evidence');
fs.mkdirSync(folder, {recursive: true});
const output = fs.openSync(path.join(folder, 'stress-cases.jsonl'), 'w');
const seed = 0x20261119;
let state = seed;
const rng = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
};
const reference = archivedEngine();
const count = 10_000;
const summary = {seed, count, completed: 0, checks: {}, failures: [], clinical: 'NOT_VALIDATED',
    mode: 'SYNTHETIC_ONLY', timingRecommendation: 'FORMULA_SPEC_GAP'};
const start = performance.now();
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
function log(row) {
    fs.writeSync(output, JSON.stringify(row) + '\n');
}
function caseFor(index) {
    const route = ['low', 'high', 'meal', 'low', 'high'][index % 5];
    const glucose = round(6 + 3 * rng(), 3);
    const rate = round((rng() - 0.5) * 0.12, 4);
    const scenario = index % 17;
    const delay = scenario === 1 ? 30 : 0;
    const coverage = scenario !== 2;
    const grams = Math.round(40 + 160 * rng());
    const carbs = round(grams * (0.1 + 0.3 * rng()), 3);
    const gi = [33, 50, 76][index % 3];
    const fat = round(rng() * 15, 2), protein = round(rng() * 15, 2);
    return {route, glucose: scenario === 0 ? null : glucose, rate, delay, coverage, grams, carbs, gi, fat, protein, scenario};
}
function verifyCase(index, input) {
    const host = testJournal(input);
    const {route} = input;
    if (route === 'meal') {
        addPlate(host, input);
        const rev = host.diagnostics().revision;
        const run = MealCalc.createCalculator(host, {rinfastEngine: Rinfast}).inspect(sessionId, {atIso: iso(at)});
        const expected = input.carbs / 12;
        assert.equal(run.researchArithmetic.unroundedEquivalentUnits, expected);
        assert.equal(run.therapyRecommendation, null);
        assert.equal(run.plateSource, 'planned');
        assert.equal(host.diagnostics().revision, rev);
        return {revision: rev, expected, actual: run.researchArithmetic, checks: 'Carbs / test ratio, no write, plan only'};
    }
    if (input.scenario >= 3 && index % 7 === 0) {
        for (const [n, age] of [25, 90].entries()) {
            mutate(host, 'actionWriter', 'recordInjection', {
                id: 'fictional-dose-' + n, insulinId: 'rinfast', administeredAt: iso(at - age * minute), units: 0.5,
            });
        }
    }
    const rev = host.diagnostics().revision;
    const synced = syntheticInputs(host);
    const expected = input.scenario <= 2 ? 'BLOCKED' : 'READY';
    assert.equal(synced.status, expected);
    if (expected === 'BLOCKED') return {revision: rev, expected, actual: synced};
    const request = {...synced.referenceOptions, horizon: route === 'low' ? 30 : 120,
        goal: 6, fastCarbs: true, carbFactor: 1, carbsPer100: 10};
    const without = reference.forecast({...request, carbs: 0, dose: 0});
    const changed = reference.forecast({...request, carbs: route === 'low' ? 4 : 0, dose: route === 'high' ? 1 : 0});
    assert(without.ok && changed.ok && changed.synthetic && without.synthetic);
    assert(Number.isFinite(without.predicted) && Number.isFinite(changed.predicted));
    assert.equal(without.parts.oldInsulin, changed.parts.oldInsulin);
    assert.equal(without.parts.trend, changed.parts.trend);
    if (route === 'low') {
        assert(changed.predicted > without.predicted);
        const fixedCheck = round(4 * 0.15 * (1 - Math.exp(-1)), 3);
        assert.equal(changed.parts.meal, fixedCheck);
    } else {
        assert(changed.predicted < without.predicted);
        const result = reference.toyCorrection(request);
        assert(result && result.dose % 0.5 === 0 && result.dose >= 0);
    }
    const reordered = reference.forecast({...request, shots: request.shots.slice().reverse(), carbs: 0, dose: 0});
    assert.equal(reordered.predicted, without.predicted);
    assert.equal(host.diagnostics().revision, rev);
    return {revision: rev, expected: route === 'low' ? 'Added carb contribution is positive' : 'Added insulin contribution is negative',
        actual: {without, changed}, checkedFactCount: request.shots.length};
}
try {
    for (let index = 0; index < count; index++) {
        const input = caseFor(index);
        const sample = summary.checks[input.route] ?? (summary.checks[input.route] = {pass: 0, expectedBlocked: 0});
        try {
            const evidence = verifyCase(index, input);
            log({index, input, status: 'PASS', evidence});
            sample.pass++;
            if (evidence.expected === 'BLOCKED') sample.expectedBlocked++;
        } catch (error) {
            const failure = {index, input, status: 'FAIL', error: error.message, stack: error.stack};
            summary.failures.push(failure);
            log(failure);
        }
        summary.completed++;
    }
} finally {
    fs.closeSync(output);
    summary.wallClockMs = Math.round(performance.now() - start);
    summary.heapUsedBytes = process.memoryUsage().heapUsed;
    summary.rssBytes = process.memoryUsage().rss;
    fs.writeFileSync(path.join(folder, 'stress-summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
assert.equal(summary.completed, count);
assert.equal(summary.failures.length, 0, JSON.stringify(summary.failures.slice(0, 2)));
console.log(JSON.stringify(summary));
