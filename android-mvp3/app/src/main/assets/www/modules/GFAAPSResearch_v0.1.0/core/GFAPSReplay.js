/* Retrospective blind backtesting: forecast at t sees no CGM from after t. */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils,P=typeof module==='object'&&module.exports?require('./GFAPSPrediction'):root.GFAPSPrediction;const api=f(U,P);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSReplay=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U,P){
'use strict';
function compare(snapshot,{horizons=[30,60,90,120],stride=3}={}){
 U.assert(Array.isArray(snapshot.cgm),'Нет CGM');U.assert(Number.isInteger(stride)&&stride>=1,'Неверный шаг перебора');
 const cgm=snapshot.cgm.slice().sort((a,b)=>U.ts(a.ts)-U.ts(b.ts)),results=[];
 for(let i=3;i<cgm.length-1;i+=stride){
   const time=U.ts(cgm[i].ts),past=cgm.slice(0,i+1);const inj=snapshot.insulin.filter(e=>U.ts(e.ts)<=time),meals=snapshot.meals.filter(e=>U.ts(e.ts)<=time);
   const current={...snapshot,nowTs:time,cgm:past,insulin:inj,meals};
   const prediction=P.predict(current,{horizonMinutes:Math.max(...horizons)});
   if(!prediction.ok)continue;
   for(const m of horizons){const target=time+m*U.MIN,actual=cgm.find(q=>Math.abs(U.ts(q.ts)-target)<=U.MIN);
     const point=prediction.points.find(q=>q.minute===m);if(!actual||actual.valid===false||!point)continue;
     for(const branch of ['IOB','COB','UAM'])results.push({forecastTs:time,horizon:m,branch,predictedMmol:point[branch],actualMmol:actual.mmol,errorMmol:U.round(point[branch]-actual.mmol),lowMiss:actual.mmol<3.9&&point[branch]>=3.9});
   }
 }
 const metrics=[];
 for(const m of horizons)for(const branch of ['IOB','COB','UAM']){
   const a=results.filter(r=>r.horizon===m&&r.branch===branch);const n=a.length;
   metrics.push({horizon:m,branch,n,mae:n?U.round(a.reduce((s,r)=>s+Math.abs(r.errorMmol),0)/n):null,rmse:n?U.round(Math.sqrt(a.reduce((s,r)=>s+r.errorMmol**2,0)/n)):null,bias:n?U.round(a.reduce((s,r)=>s+r.errorMmol,0)/n):null,lowMissed:a.filter(x=>x.lowMiss).length});
 }
 return {metrics,comparisons:results,leakageGuard:'Only historical CGM and events were passed to the model at anchor time',notClinicallyValidated:true};
}
return {compare};
});
