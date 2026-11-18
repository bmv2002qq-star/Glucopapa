/* Retrospective deviation summaries inspired by AAPS Autosens/Autotune.
 * No pump basal, no applied profile changes, no prescriptions. */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;const api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSSensitivity=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function summarizeDeviations(rows,{nowTs,windowsHours=[8,24]}={}){
 U.assert(Array.isArray(rows),'Ожидался массив отклонений');const now=U.ts(nowTs??rows.at(-1)?.ts);
 U.assert(Number.isFinite(now),'Нет времени');
 return windowsHours.map(h=>{
   U.requireFinite(h,'длительность окна',1,168);
   const selected=rows.filter(r=>{const t=U.ts(r.ts);return U.finite(r.deviationMmol)&&r.valid!==false&&r.mealConfounded!==true&&r.activityConfounded!==true&&r.illnessConfounded!==true&&t<=now&&t>now-h*3600000;});
   const values=selected.map(x=>x.deviationMmol);const count=values.length;
   return {hours:h,count,ready:count>=Math.max(6,Math.floor(h*3)),medianDeviationMmol:U.round(U.median(values)),meanDeviationMmol:U.round(U.mean(values)),weightedMeanDeviationMmol:count?U.round(values.reduce((s,v,i)=>s+v*(i+1),0)/(count*(count+1)/2)):null,kind:'descriptive, not ISF coefficient',unreliableIfIncomplete:true};
 });
}
function auditMealEpisodes(episodes){
 U.assert(Array.isArray(episodes),'Нет списка эпизодов');
 const usable=episodes.filter(e=>e.confirmedComplete===true&&e.activityConfounded!==true&&e.illnessConfounded!==true&&U.finite(e.carbsG)&&U.finite(e.recordedInsulinU)&&U.finite(e.initialIobU)&&U.finite(e.startMmol)&&U.finite(e.endMmol)&&U.finite(e.isfMmolPerU)&&e.isfMmolPerU>0);
 const flags=usable.map(e=>{
   const modeledInsulin=e.initialIobU+e.recordedInsulinU+(e.endMmol-e.startMmol)/e.isfMmolPerU;
   return {episodeId:e.id??null,knownCarbsG:e.carbsG,modelledInsulinTermU:U.round(modeledInsulin),eligibleForNumericalResearch:modeledInsulin>0};
 });
 // We deliberately do not emit a recommended CR or ISF from these retrospective values.
 return {eligible:flags.filter(x=>x.eligibleForNumericalResearch).length,total:episodes.length,rows:flags,automaticCoefficientUpdate:false,limitation:'No coefficient proposal: selection bias, dosing confounding and retrospective artifacts require independent validation'};
}
return {summarizeDeviations,auditMealEpisodes};
});
