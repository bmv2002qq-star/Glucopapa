/* CGM alternative smoothing for research plots only. Original CGM must not be replaced. */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;const api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSSmoothing=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function exponential(cgm,{alpha=0.5,beta=0.25}={}){
 U.requireFinite(alpha,'alpha',0.01,1);U.requireFinite(beta,'beta',0.01,1);U.assert(Array.isArray(cgm),'Нет CGM');
 const a=cgm.slice().sort((x,y)=>U.ts(x.ts)-U.ts(y.ts));let level=null,trend=0,previous=null;
 const result=[];
 for(const e of a){const t=U.ts(e.ts);
  if(!Number.isFinite(t)||!U.finite(e.mmol)||e.valid===false||e.qualityFlag==='invalid'||e.mmol<2||e.mmol>30){result.push({ts:t,rawMmol:e.mmol,smoothedMmol:null,invalid:true});level=null;trend=0;previous=null;continue;}
  if(level===null||previous===null||t-previous>8*U.MIN){level=e.mmol;trend=0;}else{
   const gap=(t-previous)/(5*U.MIN),pred=level+trend*gap;
   const nextLevel=alpha*e.mmol+(1-alpha)*pred;
   trend=beta*(nextLevel-level)/gap+(1-beta)*trend;
   level=nextLevel;
  }
  previous=t;result.push({ts:t,rawMmol:e.mmol,smoothedMmol:U.round(level),trendMmolPer5m:U.round(trend),researchOnly:true});
 }
 return {points:result,method:'Holt exponential smoothing; independent, AAPS concept inspiration',notForAlarms:true};
}
return {exponential};
});
