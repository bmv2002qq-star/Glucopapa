const fs=require('fs'), vm=require('vm'), assert=require('assert');
const raw=fs.readFileSync('app/src/main/assets/index.html','utf8');
const code=raw.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/, '');
const ctx={window:{},document:{addEventListener(){},createElement(){return {style:{},remove(){},querySelectorAll(){return []},innerHTML:''}},body:{appendChild(){}},querySelector(){return {innerHTML:''}},querySelectorAll(){return []},getElementById(){return null}},localStorage:{getItem(){return null},setItem(){}},console,Date,JSON,Math,Number,String,setTimeout(){},clearTimeout(){},navigator:{},confirm(){return true},alert(){},Intl};ctx.window=ctx;
vm.createContext(ctx);vm.runInContext(code,ctx);const val=e=>vm.runInContext(e,ctx);
const profiles=JSON.parse(fs.readFileSync('app/src/main/assets/insulin_action_reference_v0.11.1.json','utf8'));
assert.equal(Object.keys(profiles).length,16);
for(const [key,profile] of Object.entries(profiles)){
  const live=val('INSULIN_ACTION_REFERENCE['+JSON.stringify(key)+']');
  assert.equal(live.onset,profile.onset);
  assert.equal(live.peak,profile.peak);
  assert.equal(live.duration,profile.duration);
  assert.equal(live.sourceUrl,profile.sourceUrl);
}
assert(val('actionReferenceText(INSULIN_REFERENCE.find(x=>x.key==="novorapid"))').includes('10–20'));
assert(val('actionReferenceText(INSULIN_REFERENCE.find(x=>x.key==="levemir"))').includes('24'));
assert(!val('INSULIN_ACTION_REFERENCE.novorapid').dose);
assert(fs.readFileSync('app/src/main/java/ru/family/glucodiary/AiObservationContext.java','utf8').includes('InsulinActionProfiles.describe'));
assert(fs.readFileSync('app/src/main/java/ru/family/glucodiary/MainActivity.java','utf8').includes('InsulinActionProfiles.setReference'));
console.log('Passed 0.11.1: 16 documented insulin profiles and AI context integration.');
