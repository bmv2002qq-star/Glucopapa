const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const html = fs.readFileSync('android-app/app/src/main/assets/www/q04/nutrition.html', 'utf8');
const source = html.match(/<script>(\/\* Q04 QA: only native GFStorage user drafts[\s\S]*?)<\/script>/)[1];
const render = html.match(/function renderPlate\(\)\{[\s\S]*?\n \}/)[0];
let current = 'first';
let revision = 10;
const writes = [];
const state = {first: {plate: []}, second: {plate: []}};
const bridge = {
  readDraft: () => JSON.stringify({profileId: current, revision, state: state[current],
    trustStatus: 'USER_DRAFT_UNVERIFIED', source: 'GFStorage_NATIVE'}),
  saveDraft(raw) {
    const command = JSON.parse(raw);
    assert.equal(command.expectedRevision, revision);
    writes.push({current, command});
    state[current][command.kind] = command.value;
    return JSON.stringify({recorded: true, trustStatus: 'USER_DRAFT_UNVERIFIED', revision: ++revision});
  }
};
const ctx = vm.createContext({GPV3Q04Drafts: bridge, crypto: webcrypto});
vm.runInContext(source, ctx);
const port = ctx.GFStorageNutritionPort;
const plate = port.getPlate();
current = 'second';
revision = 20;
try { port.savePlate(plate); } catch (error) { console.log('stale request rejected:', error.message); }
const staleWrite = writes.some(entry => entry.current === 'second');
console.log('stale draft sent to second profile:', staleWrite);
Object.assign(ctx, {plate: [], insulinWorkflow: {}, platePayload: () => ({items: [], totals: {}}),
  $: () => ({}), GFMealSupport: {plateGI: () => ({value: null, label: 'empty'})},
  esc: String, renderCompare() {}, nutritionPort: port});
const before = writes.length;
vm.runInContext(render + '\nrenderPlate()', ctx);
console.log('unchanged empty plate render requested saves:', writes.length - before);
assert.deepEqual([staleWrite, writes.length - before], [false, 0],
  'UI must reject stale context and rendering an unchanged plate must be read-only');
