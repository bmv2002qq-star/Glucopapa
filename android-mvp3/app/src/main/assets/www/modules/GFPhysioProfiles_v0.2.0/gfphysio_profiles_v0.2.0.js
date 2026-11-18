/* GFPhysioProfiles v0.2.0: research reference; use COMPLETE original synthetic record only.
   Published population aggregates are NOT individual physiology and NEVER substitute for 46 coefficients.
   Source: simglucose MIT, Dalla Man S2013 and Visentin S2017. No dosing or real-person personalization.
*/
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GFPhysioProfiles=api})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
const V='0.2.0';
function finite(n){return typeof n==='number'&&Number.isFinite(n)}
function validateDatabase(db){
 if(!db||db.meta?.version!==V||!Array.isArray(db.profiles)||db.profiles.length!==30||!Array.isArray(db.aggregate_metrics)||db.aggregate_metrics.length!==30)throw Error('Недоступен полный проверенный справочник GFPhysioProfiles v0.2.0');
 const ids=new Set();for(const p of db.profiles){if(ids.has(p.id)||!finite(p.physiology?.BW)||!finite(p.demographics?.age_years)||!p.initial_states||Object.keys(p.initial_states).length!==13)throw Error('Повреждён виртуальный профиль');ids.add(p.id)}
 return true;
}
function cohortForAge(age){return age<=12?'child':age<=19?'adolescent':'adult'}
function nearest(data,input){validateDatabase(data);
 const age=input?.ageYears,weight=input?.weightKg;
 if(!finite(age)||age<0||age>110||!finite(weight)||weight<1||weight>400)throw Error('Требуются возраст и вес из существующего профиля GFSettings/GFStorage');
 if(input.heightCm!==null&&input.heightCm!==undefined&&(!finite(input.heightCm)||input.heightCm<20||input.heightCm>250))throw Error('Некорректный рост');
 if(input.sex!==null&&input.sex!==undefined&&!['male','female'].includes(input.sex))throw Error('Неизвестный пол');
 const cohort=cohortForAge(age);
 const candidates=data.profiles.filter(p=>p.cohort===cohort).map(p=>{
 const ageGap=Math.abs(p.demographics.age_years-age),weightGapPct=100*Math.abs(p.demographics.weight_kg-weight)/weight;
 return {id:p.id,ageYears:p.demographics.age_years,weightKg:p.demographics.weight_kg,ageGapYears:ageGap,weightGapPercent:weightGapPct,score:(ageGap/2)**2+(weightGapPct/25)**2};
 }).sort((a,b)=>a.score-b.score||a.id.localeCompare(b.id));
 if(!candidates.length)throw Error('Нет виртуальных моделей возрастной группы');
 const selected=candidates[0];
 const exact=selected.ageGapYears<1e-8&&selected.weightGapPercent<1e-8;
 const nearby=selected.ageGapYears<=1&&selected.weightGapPercent<=15;
 const groupWeights=candidates.map(p=>p.weightKg);
 const withinStudyRanges=data.aggregate_metrics.filter(x=>x.cohort===cohort&&x.metric==='body_weight_kg').map(r=>({study:r.study_id,within:weight>=r.min&&weight<=r.max,min:r.min,max:r.max}));
 return {version:V,mode:'RESEARCH_SYNTHETIC_ONLY',status:exact?'EXACT_AGE_WEIGHT_VIRTUAL_ONLY':nearby?'NEAREST_RESEARCH_VIRTUAL_ONLY':'DISTANT_RESEARCH_VIRTUAL_ONLY',selectedId:selected.id,selected,alternatives:candidates.slice(1,4), exactAgeWeight:exact,cohort, ageRange:[Math.min(...candidates.map(p=>p.ageYears)),Math.max(...candidates.map(p=>p.ageYears))],weightRange:[Math.min(...groupWeights),Math.max(...groupWeights)],populationWeightCoverage:withinStudyRanges,
 unsupportedFields:['sex','heightCm'],warning:'Параметры принадлежат целому ВИРТУАЛЬНОМУ пациенту, не ребёнку из настроек. Рост и пол не применялись при подборе. Клиническое использование и дозирование запрещены.',
 input:{ageYears:age,weightKg:weight,heightCm:input.heightCm??null,sex:input.sex??null},source:'Simglucose S2008 research virtual profile',eligibleForDosing:false,personalized:false};
}
function getSelectedParameters(data,match){
 validateDatabase(data);if(!match||match.mode!=='RESEARCH_SYNTHETIC_ONLY'||!match.selectedId)throw Error('Ожидался исследовательский подбор');
 const p=data.profiles.find(p=>p.id===match.selectedId);if(!p)throw Error('Не найден исходный виртуальный пациент');
 // Clone once: never mutate original records and never overwrite BW/initial states with real child's values.
 const params={Name:p.id,...p.initial_states,...p.physiology};
 return {params,virtualPatientId:p.id,originalBodyWeightKg:p.demographics.weight_kg,profileSource:'Simglucose original virtual parameter vector',researchOnly:true,individualized:false};
}
return Object.freeze({version:V,validateDatabase,nearest,getSelectedParameters});
});
