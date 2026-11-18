/* ГлюкоПапа W06d — GFPlate v0.4.6 -> research-only carbohydrate appearance profile.
 * Only GFStorage schema5 read ports. No external nutrition catalog, no duplicate event DB.
 * GI is a GI proxy, NOT an absorption clock. The hours below are UNVALIDATED model presets,
 * and never authorize food/insulin treatment or a single-point true COB measurement.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFAutoCOBProfile=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.0-research-candidate',WINDOW_MS=12*3600000;
const PRESETS=Object.freeze({
 fast:Object.freeze({fastDurationMinutes:60,slowDurationMinutes:120,label:'Быстрые углеводы · ориентир до 2 ч'}),
 medium:Object.freeze({fastDurationMinutes:120,slowDurationMinutes:240,label:'Средние углеводы · ориентир до 4 ч'}),
 slow:Object.freeze({fastDurationMinutes:240,slowDurationMinutes:360,label:'Медленные углеводы · исследовательский диапазон 4–6 ч'}),
 fatty:Object.freeze({fastDurationMinutes:180,slowDurationMinutes:360,label:'Смешанная жирная еда · ориентир 3–6 ч'})
});
const number=x=>typeof x==='number'&&Number.isFinite(x);
const date=s=>typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s))?Date.parse(s):NaN;
function freeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function unknown(code,extra={}){return freeze({version:VERSION,status:'UNKNOWN',code,profile:null,kinetics:null,allowDose:false,allowRecommendation:false,clinicalCalibration:false,...extra});}
function profilePlate(plate){
 if(!plate||plate.schema!=='GFPlate.v1'||plate.source!=='GFFoodOnly'||!Array.isArray(plate.items)||!plate.items.length)return unknown('NOT_GFPLATE_ACTUAL');
 const totals=plate.totals;
 if(!totals||!number(totals.carbs)||!number(totals.fat)||!number(totals.protein)||totals.carbs<0||totals.fat<0||totals.protein<0)return unknown('MACROS_UNKNOWN');
 let knownCarbs=0,weighted=0,calcCarbs=0,calcFat=0,calcProtein=0;const giSources=new Set();
 for(const item of plate.items){
  if(!item||!number(item.carbs)||!number(item.fat)||!number(item.protein)||item.carbs<0||item.fat<0||item.protein<0)return unknown('ITEM_MACROS_UNKNOWN');
  if(!number(item.amount)||item.amount<=0||!['г','мл'].includes(item.unit))return unknown('ITEM_QUANTITY_UNKNOWN',{affectedFoodId:item.foodId||null});
  calcCarbs+=item.carbs;calcFat+=item.fat;calcProtein+=item.protein;
  if(item.carbs===0)continue;
  if(!number(item.glycemicIndex)||item.glycemicIndex<0||item.glycemicIndex>100)return unknown('GI_NOT_TRANSFERRED_OR_UNKNOWN',{affectedFoodId:item.foodId||null});
  if(typeof item.glycemicIndexStatus!=='string'||!item.glycemicIndexStatus)return unknown('GI_PROVENANCE_MISSING',{affectedFoodId:item.foodId||null});
  knownCarbs+=item.carbs;weighted+=item.carbs*item.glycemicIndex;giSources.add(item.glycemicIndexStatus);
 }
 if(Math.abs(calcCarbs-totals.carbs)>0.1+plate.items.length*0.01||Math.abs(calcFat-totals.fat)>0.1+plate.items.length*0.01||Math.abs(calcProtein-totals.protein)>0.1+plate.items.length*0.01)return unknown('MACROS_SUM_CONFLICT');
 if(totals.carbs===0)return unknown('NO_CARBOHYDRATES_CONFIRMED',{recordedCarbsG:0,recordedFatG:totals.fat});
 if(knownCarbs<=0||Math.abs(knownCarbs-totals.carbs)>0.1+plate.items.length*0.01)return unknown('GI_COVERAGE_PARTIAL');
 const weightedGI=weighted/knownCarbs;
 // Research-only configuration. Threshold is a candidate UI heuristic, not a medical boundary.
 const fatty=totals.fat>=15&&(totals.fat/Math.max(1,totals.carbs)>=0.35||totals.fat>=25);
 const key=fatty?'fatty':weightedGI>=70?'fast':weightedGI>55?'medium':'slow';
 const chosen=PRESETS[key];
 const allVerified=plate.containsEstimatedValues===false&&plate.items.every(i=>i.nutritionStatus==='label_verified');
 return freeze({version:VERSION,status:'RESEARCH_PROFILE',code:'PLATE_AUTO_GI_FAT_PRESET',profile:key,label:chosen.label,weightedGI:Math.round(weightedGI*10)/10,recordedCarbsG:totals.carbs,recordedFatG:totals.fat,recordedProteinG:totals.protein,giSources:[...giSources].sort(),confidence:'LOW',estimatedGI:[...giSources].some(s=>s!=='measured'&&s!=='verified'),compositionVerified:allVerified,kinetics:{origin:'plate_auto_research_preset_v1',lagMinutes:0,fastDurationMinutes:chosen.fastDurationMinutes,slowDurationMinutes:chosen.slowDurationMinutes},allowDose:false,allowRecommendation:false,clinicalCalibration:false});
}
function inspect({host,nowMs=Date.now()}={}){
 if(!Number.isSafeInteger(nowMs))return unknown('INVALID_CLOCK',{kineticsByMealId:null,rows:[]});
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return unknown('GFSTORAGE_SCHEMA',{kineticsByMealId:null,rows:[]});
 try{
  const read=host.connect('research'),journal=host.connect('journal'),revision=read.getRevision(),a=read.getSnapshot(),b=journal.getSnapshot();
  if(revision!==a.revision||revision!==b.revision||revision!==read.getRevision())return unknown('REVISION_CHANGED',{rows:[],kineticsByMealId:null});
  if(!Array.isArray(b.mealSessions))return unknown('MEALS_UNAVAILABLE',{rows:[],kineticsByMealId:null});
  const rows=[],kineticsByMealId={},seen=new Set();
  for(const meal of b.mealSessions){
   if(!meal||typeof meal.id!=='string'||!meal.id||seen.has(meal.id))return unknown('MEAL_ID_INVALID',{rows:[],kineticsByMealId:null});
   seen.add(meal.id);
   if(['draft','ready','planned'].includes(meal.status)&&meal.startedAt==null&&meal.completedAt==null&&meal.actualPlate==null)continue;
   const started=date(meal.startedAt);
   if(!Number.isFinite(started))return unknown('MEAL_START_UNKNOWN',{rows:[],kineticsByMealId:null,affectedMealId:meal.id});
   if(started>nowMs)return unknown('MEAL_IN_FUTURE',{rows:[],kineticsByMealId:null,affectedMealId:meal.id});
   if(started<nowMs-WINDOW_MS){const completed=date(meal.completedAt);if(!Number.isFinite(completed)||completed>=nowMs-WINDOW_MS)return unknown('MEAL_SPANS_WINDOW',{rows:[],kineticsByMealId:null,affectedMealId:meal.id});continue;}
   if(meal.status!=='completed'||!meal.actualPlate)return unknown('MEAL_NOT_COMPLETED',{rows:[],kineticsByMealId:null,affectedMealId:meal.id});
   const p=profilePlate(meal.actualPlate);rows.push({mealId:meal.id,startedAt:meal.startedAt,completedAt:meal.completedAt,...p});
   if(p.status==='RESEARCH_PROFILE')kineticsByMealId[meal.id]=p.kinetics;
  }
  if(revision!==read.getRevision())return unknown('REVISION_CHANGED',{rows:[],kineticsByMealId:null});
  if(!rows.length)return unknown('NO_COMPLETED_MEALS',{rows:[],kineticsByMealId:null,sourceRevision:revision});
  return freeze({version:VERSION,status:rows.every(r=>r.status==='RESEARCH_PROFILE')?'RESEARCH_PROFILES_READY':'PROFILE_PARTIAL',code:'GFPLATE_SOURCE_ONLY',sourceRevision:revision,rows,kineticsByMealId:rows.every(r=>r.status==='RESEARCH_PROFILE')?kineticsByMealId:null,readOnly:true,allowDose:false,allowRecommendation:false});
 }catch(e){return unknown('GFSTORAGE_READ_FAILED',{rows:[],kineticsByMealId:null});}
}
return Object.freeze({VERSION,PRESETS,profilePlate,inspect});
});
