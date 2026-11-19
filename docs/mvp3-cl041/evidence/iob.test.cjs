const assert = require('node:assert/strict');
const {test} = require('node:test');
const {resolve} = require('node:path');
const root = process.env.GLUCOPAPA_QA_SOURCE;
const {at, minute, iso, Rinfast, testJournal, mutate, Evidence} =
    require(resolve(root,'qa/mvp3-calculators/fixture.cjs'));
const close = (a,b) => assert.ok(Math.abs(a-b) < 5e-9, `expected ${b}, got ${a}`);

function remaining(age) {
    const integral = (left,right) => {
        const n = 20000, step = (right-left)/n;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const t = left + (i + 0.5) * step;
            sum += t * (300-t) * Math.exp(-t/112.5);
        }
        return step * sum;
    };
    return integral(age,300)/integral(0,300);
}
const fact = (id,age,units) => ({id,units,administeredAt:iso(at - age*minute),
    type:'insulin_injection',insulinId:'rinfast',status:'confirmed'});

test('IOB-01: 75/300 independent quadrature at the exact CL-040 minutes', () => {
    for (const age of [0,15,30,60,75,120,300]) close(Rinfast.getCurve(age).remainingFraction,remaining(age));
    close(Rinfast.getCurve(0).remainingFraction,1);
    close(Rinfast.getCurve(300).remainingFraction,0);
});

test('IOB-02 / IOB-07: four overlapping facts, ordering invariance and mutation through actual consumer', () => {
    const events = [[22,0.5],[73,1.5],[126,1],[258,0.5]].map(([age,units],index)=>fact('test-'+index,age,units));
    const expected = events.reduce((sum,row)=>sum + row.units * remaining((at-Date.parse(row.administeredAt))/minute),0);
    const original = Rinfast.calculate({nowIso:iso(at),events});
    const reversed = Rinfast.calculate({nowIso:iso(at),events:events.slice().reverse()});
    close(original.modelRemainingUnits,expected);
    close(reversed.modelRemainingUnits,expected);
    const changed = events.map((row,i)=>i===1?{...row,units:row.units+0.5}:row);
    const mutated = Rinfast.calculate({nowIso:iso(at),events:changed});
    for (const [index,row] of mutated.contributions.entries()) {
        close(row.remainingModelUnits - original.contributions[index].remainingModelUnits,index===1?0.5*remaining(73):0);
    }
    for (const [rows,value] of [[events,expected],[changed,expected+0.5*remaining(73)]]) {
        const host = testJournal();
        for (const row of rows) {
            const {id,insulinId,units,administeredAt} = row;
            mutate(host,'actionWriter','recordInjection',{id,insulinId,units,administeredAt});
        }
        const result = Evidence.inspect({host,route:'high',nowMs:at});
        assert.equal(result.trace.iob.status,'MODEL_ESTIMATE');
        close(result.trace.iob.valueU,value);
    }
});

test('IOB-03 / IOB-05: unknown history, full empty history, and rejected facts', () => {
    const full = testJournal();
    assert.equal(Evidence.inspect({host:full,route:'high',nowMs:at}).trace.iob.valueU,0);
    for (const entries of [[{...fact('not-confirmed',30,0.5),status:'planned'}],
        [{...fact('cancelled',30,0.5),status:'cancelled'}],
        [fact('duplicate',30,0.5),fact('duplicate',30,0.5)]]) {
        const result = Rinfast.calculate({nowIso:iso(at),events:entries});
        assert.equal(result.status,'INCOMPLETE');
        assert.equal(result.modelRemainingUnits,null);
    }
    const empty = globalThis.GFStorage.createHost({clock:()=>iso(at)});
    assert.equal(Evidence.inspect({host:empty,route:'high',nowMs:at}).trace.iob.valueU,null);
});
