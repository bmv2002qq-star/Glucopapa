const fs=require('fs');
const path=require('path');
const s=fs.readFileSync(path.join(__dirname,'../app/src/main/assets/index.html'),'utf8');
for(const key of ['gfLocalAiSettings','gfLocalModelImport','gfLocalModelAnalyze','gfLocalAiObservations','gfLocalAiResult']){
  if(!s.includes(key))throw Error('Missing '+key);
}
const scripts=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
for(const t of scripts)new Function(t);
console.log('Local-AI UI JS syntax validated');
