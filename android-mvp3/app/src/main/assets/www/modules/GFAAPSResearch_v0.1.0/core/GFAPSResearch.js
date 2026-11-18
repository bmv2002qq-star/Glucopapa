/* GFAPSResearch: convenience facade, no storage writes, no hardware side-effects. */
(function(root,f){const b=typeof module==='object'&&module.exports;const load=(name,file)=>b?require('./'+file):root[name];const api=f({guard:load('GFAPSInputGuard','GFAPSInputGuard'),insulin:load('GFAPSIOB','GFAPSIOB'),cob:load('GFAPSCOB','GFAPSCOB'),forecast:load('GFAPSPrediction','GFAPSPrediction'),smooth:load('GFAPSSmoothing','GFAPSSmoothing'),sensitivity:load('GFAPSSensitivity','GFAPSSensitivity'),stats:load('GFAPSStats','GFAPSStats'),replay:load('GFAPSReplay','GFAPSReplay'),adapter:load('GFAPSAdapter','GFAPSAdapter')});if(b)module.exports=api;root.GFAPSResearch=api;})(typeof globalThis!=='undefined'?globalThis:this,function(parts){
'use strict';
function analyze(s){
 const validation=parts.guard.inspect(s);if(!validation.ok)return {ok:false,validation,forecast:{ok:false,status:'insufficient_data',points:[]}};
 const forecast=parts.forecast.predict(s);
 const iob=parts.insulin.at(s.insulin,s.nowTs,s.parameters);
 const cob=parts.cob.estimate(s);
 const smooth=parts.smooth.exponential(s.cgm);
 const tir=parts.stats.tir(s.cgm);
 return {ok:forecast.ok,validation,forecast,iob,cob,smooth,tir,model:'GFAAPSResearch/0.1.0',pumpFunctions:false,canPrescribe:false};
}
return Object.freeze({...parts,analyze,version:'0.1.0',isResearchOnly:true});
});
