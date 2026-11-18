/* Observed deviation based COB research. NOT a measurement of actual absorption.
   Inspired by AAPS PrepareGraphDataRunner.kt; separate conservative independent code. */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils,I=typeof module==='object'&&module.exports?require('./GFAPSIOB'):root.GFAPSIOB;const api=f(U,I);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSCOB=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U,IOB){
'use strict';
function estimate(snapshot){
 U.assert(snapshot?.completeness?.meals==='confirmed_complete'&&snapshot?.completeness?.insulin==='confirmed_complete','COB: неполный дневник, расчёт заблокирован');
 const cgm=snapshot.cgm.slice().sort((a,b)=>U.ts(a.ts)-U.ts(b.ts));
 const meals=snapshot.meals.slice().sort((a,b)=>U.ts(a.ts)-U.ts(b.ts));
 const p=snapshot.parameters;
 if(meals.some(x=>U.ts(x.ts)<U.ts(cgm[0]?.ts)))throw new Error('COB: приём пищи раньше истории CGM');
 U.requireFinite(p.isfMmolPerU,'ISF',0.1,30);U.requireFinite(p.crGPerU,'CR',1,200);
 let cob=0,mealAt=0,absorbed=0;const rows=[];
 if(!cgm.length)return {remainingCarbsG:0,rows:[],model:'AAPS-inspired deviation proxy'};
 for(let k=0;k<cgm.length;k++){
   const c=cgm[k]; const time=U.ts(c.ts);
   // Add meals for the current CGM interval exactly once, do not assume meal data if coverage absent.
   while(mealAt<meals.length&&U.ts(meals[mealAt].ts)<=time){cob+=meals[mealAt].carbs;mealAt++;}
   if(k===0){rows.push({ts:time,remainingCarbsG:U.round(cob),absorbedCarbsG:0});continue;}
   const before=cgm[k-1],dt=(time-U.ts(before.ts))/U.MIN;
   if(dt<=0||dt>8){rows.push({ts:time,remainingCarbsG:U.round(cob),gap:true});continue;}
   const activity=IOB.at(snapshot.insulin,time,p).activityUPerMin;
   const bgi=-activity*p.isfMmolPerU*dt;
   const deviation=c.mmol-before.mmol-bgi;
   // No invented minimum impact; positive deviation may also arise from illness or sensor error.
   const absorption=U.clamp(Math.max(0,deviation)*p.crGPerU/p.isfMmolPerU,0,cob);
   cob=Math.max(0,cob-absorption);absorbed+=absorption;
   rows.push({ts:time,remainingCarbsG:U.round(cob),absorbedCarbsG:U.round(absorption),bgiMmol:U.round(bgi),deviationMmol:U.round(deviation),conflatedCauses:true});
 }
 return {remainingCarbsG:U.round(cob),totalModelledAbsorbedG:U.round(absorbed),rows,model:'deviation proxy (not measured COB)',limitation:'Positive deviations may reflect meals, activity, stress, illness, CGM lag, model error'};
}
return {estimate};
});
