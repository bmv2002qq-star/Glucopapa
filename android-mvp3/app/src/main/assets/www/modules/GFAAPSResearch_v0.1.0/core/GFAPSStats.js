/* Time-in-range / descriptive injection statistics; AAPS TIR/TDD-inspired. */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;const api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSStats=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function tir(cgm,{lowMmol=3.9,highMmol=10,maxGapMinutes=8}={}){
 U.requireFinite(lowMmol,'нижний порог',2,25);U.requireFinite(highMmol,'верхний порог',lowMmol+0.01,30);
 const a=cgm.slice().sort((x,y)=>U.ts(x.ts)-U.ts(y.ts));const out={below:0,inRange:0,above:0,unknown:0};let observed=0;
 for(let i=1;i<a.length;i++){
   const x=a[i-1],y=a[i],dt=(U.ts(y.ts)-U.ts(x.ts))/U.MIN;
   if(dt<=0)continue;
   const period=Math.min(dt,maxGapMinutes);
   const valid=x.valid!==false&&x.qualityFlag!=='invalid'&&U.finite(x.mmol)&&x.mmol>=2&&x.mmol<=30&&dt<=maxGapMinutes;
   if(!valid){out.unknown+=dt;continue;}
   if(x.mmol<lowMmol)out.below+=period;else if(x.mmol>highMmol)out.above+=period;else out.inRange+=period;
   observed+=period;
 }
 return {durationMinutes:Object.fromEntries(Object.entries(out).map(([k,v])=>[k,U.round(v,1)])),totalObservedMinutes:U.round(observed,1),percentObserved:observed?Object.fromEntries(['below','inRange','above'].map(k=>[k,U.round(100*out[k]/observed,2)])):null,notClinicalAGP:true,reason:'No interpolation through gaps; time weighted by valid intervals only'};
}
function doses(injections,{startTs,endTs,coverageConfirmed=false}={}){
 U.assert(Array.isArray(injections),'Нет списка инъекций');const a=U.ts(startTs),b=U.ts(endTs);U.assert(Number.isFinite(a)&&Number.isFinite(b)&&b>a,'Неверный интервал');
 const selected=injections.filter(x=>x.status==='actual'&&U.ts(x.ts)>=a&&U.ts(x.ts)<b),rapid=selected.filter(x=>x.type==='rapid').reduce((s,x)=>s+x.units,0),basal=selected.filter(x=>x.type==='basal').reduce((s,x)=>s+x.units,0);
 return {rapidU:U.round(rapid),basalU:U.round(basal),totalRecordedU:U.round(rapid+basal),completeTDD:coverageConfirmed?U.round(rapid+basal):null,complete:coverageConfirmed,doesNotInferMissingInjections:true};
}
return {tir,doses};
});
