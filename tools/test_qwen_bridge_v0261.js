// v0.26.1 regression tests for local Qwen diagnostics and async bridge.
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='app/src/main/';
const html=fs.readFileSync(base+'assets/index.html','utf8');
const activity=fs.readFileSync(base+'java/ru/family/glucodiary/MainActivity.java','utf8');
const model=fs.readFileSync(base+'java/ru/family/glucodiary/LocalLlm.java','utf8');
const cpp=fs.readFileSync(base+'cpp/local_llm.cpp','utf8');
const cases=[
['preflight before native analyze',html.includes('localAiDiagnostics()')&&html.includes('!d.nativeLoaded')&&html.includes('!d.modelPresent')],
['status distinguishes readiness',html.includes('inferenceVerified')&&html.includes('GGUF обнаружен')],
['correct timeout units',html.includes('за 120 секунд')&&html.includes('},120000')&&!html.includes('за 35 секунд')],
['duplicate UI guard',html.includes('if(gf026LocalWorking)')],
['native progress callback',html.includes('window.gf026LocalProgress=function(message)')],
['error resets UI busy flag',html.includes('gf026LocalWorking=false;clearTimeout(gf026LocalTimeout)')],
['native global duplicate guard',activity.includes('llmInferenceBusy.compareAndSet(false,true)')],
['native busy resets even after failure', (activity.match(/finally \{llmInferenceBusy.set\(false\);\}/g)||[]).length>=2],
['progress emitted from Android',activity.includes('window.gf026LocalProgress(')],
['generation limit for phone',model.includes('modelFile().getAbsolutePath(),prompt,180)')],
['log model load duration',cpp.includes('GGUF loaded; duration_ms=')],
['log total generation duration',cpp.includes('generation complete; duration_ms=')],
['logs omit prompts',!cpp.includes('prompt.c_str())')||cpp.includes('llama_tokenize')]];
for(const [name,ok] of cases){assert.ok(ok,name);console.log('PASS',name)}
console.log('Qwen bridge checks:',cases.length+'/'+cases.length);
