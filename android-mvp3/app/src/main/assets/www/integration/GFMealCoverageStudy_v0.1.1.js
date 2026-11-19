/* ГлюкоПапа · W06c / GFMealCoverageStudy v0.1.0 · TECHNICAL CANDIDATE
 * Independent read-only audit of meal history and user-entered research assumptions.
 * UNKNOWN is not 0. A parent's declaration does NOT prove history is complete.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFMealCoverageStudy=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';const VERSION='0.1.1-auto-plate-candidate',WINDOW_MS=12*3600000,MAX_ACK_AGE_MS=10*60000;
const goodTime=v=>typeof v==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
const num=x=>typeof x==='number'&&Number.isFinite(x);
function deepFreeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v)}return v}
function report(status,code,revision=null,extras={}){return deepFreeze({version:VERSION,status,code,sourceRevision:revision,eligible:false,attestationVerified:false,allowDose:false,allowRecommendation:false,coverageIsEvidence:false,mealIds:[],mealRows:[],researchOptions:null,...extras})}
function inspect({host,nowMs=Date.now(),acknowledgement=null,kineticsByMealId=null}={}){
 if(!Number.isSafeInteger(nowMs))return report('BLOCKED','INVALID_CLOCK');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return report('BLOCKED','GFSTORAGE_SCHEMA');
 try{
  const research=host.connect('research'),journal=host.connect('journal');const rev=research.getRevision(),a=research.getSnapshot(),b=journal.getSnapshot();
  if(rev!==a.revision||rev!==b.revision||rev!==research.getRevision())return report('BLOCKED','REVISION_CHANGED',rev);
  if(!Array.isArray(b.mealSessions))return report('BLOCKED','SESSIONS_UNAVAILABLE',rev);
  const cutoff=nowMs-WINDOW_MS,inside=[];const ids=new Set();
  for(const meal of b.mealSessions){
   if(!meal||typeof meal.id!=='string'||!meal.id||ids.has(meal.id))return report('BLOCKED','AMBIGUOUS_MEAL_ID',rev);
   ids.add(meal.id);
   const start=goodTime(meal.startedAt),completed=goodTime(meal.completedAt);
   // A plan without any recorded act does not count as eaten or establish complete history.
   if(['draft','ready','planned'].includes(meal.status)&&meal.startedAt==null&&meal.completedAt==null&&meal.actualPlate==null)continue;
   if(!Number.isFinite(start))return report('BLOCKED','AMBIGUOUS_MEAL_TIME',rev,{affectedMealId:meal.id});
   if(start>nowMs)return report('BLOCKED','FUTURE_MEAL',rev,{affectedMealId:meal.id});
   if(start<cutoff){
    if(!Number.isFinite(completed)||completed>=cutoff)return report('BLOCKED','CROSS_WINDOW_MEAL',rev,{affectedMealId:meal.id});
    continue;
   }
   if(meal.status!=='completed'||!meal.actualPlate||!Number.isFinite(completed)||completed>nowMs||completed<start)
    return report('BLOCKED','UNFINISHED_MEAL',rev,{affectedMealId:meal.id});
   const plate=meal.actualPlate;
   if(plate.schema!=='GFPlate.v1'||plate.containsEstimatedValues!==false||!num(plate.totals?.carbs)||plate.totals.carbs<0||!Array.isArray(plate.items)||!plate.items.length||plate.items.some(x=>!num(x.amount)||x.amount<=0||!['г','мл'].includes(x.unit)||!num(x.carbs)||x.carbs<0||!['label_verified','verified','user_confirmed'].includes(x.nutritionStatus)))
    return report('BLOCKED','FOOD_DATA_UNKNOWN',rev,{affectedMealId:meal.id});
   inside.push({id:meal.id,startedAt:meal.startedAt,completedAt:meal.completedAt,carbsRecordedG:plate.totals.carbs});
  }
  if(research.getRevision()!==rev)return report('BLOCKED','REVISION_CHANGED',rev);
  const base={mealIds:inside.map(x=>x.id),mealRows:inside,sourceRevision:rev};
  const ack=acknowledgement;
  if(!ack||ack.source!=='user_declared'||ack.scope!=='all_meals'||ack.confirmedComplete!==true||ack.sourceRevision!==rev||!Number.isFinite(goodTime(ack.declaredAtIso))||goodTime(ack.declaredAtIso)>nowMs||nowMs-goodTime(ack.declaredAtIso)>MAX_ACK_AGE_MS||goodTime(ack.startIso)>cutoff||goodTime(ack.endIso)<nowMs||!Number.isFinite(goodTime(ack.startIso))||!Number.isFinite(goodTime(ack.endIso)))
   return report('UNKNOWN',inside.length?'NEEDS_FRESH_USER_ATTESTATION':'NO_CONFIRMED_MEALS_IN_WINDOW',rev,base);
  const declared={source:'user_declared',confirmedComplete:true,startIso:ack.startIso,endIso:ack.endIso,declaredAtIso:ack.declaredAtIso};
  const acknowledged={...base,coverageLabel:'PARENT_DECLARED_UNVERIFIED',attestationVerified:false,historyDeclaration:declared};
  if(!inside.length)return report('RESEARCH_READY','PARENT_ATTESTED_EMPTY_WINDOW',rev,{
   ...acknowledged,eligible:true,researchOptions:{historyDeclaration:declared,kineticsByMealId:{}}
  });
  if(!kineticsByMealId||typeof kineticsByMealId!=='object'||Array.isArray(kineticsByMealId))return report('UNKNOWN','RESEARCH_PARAMETERS_REQUIRED',rev,acknowledged);
  for(const meal of inside){const p=kineticsByMealId[meal.id];if(!p||!['explicit_research_scenario','plate_auto_research_preset_v1'].includes(p.origin)||!num(p.lagMinutes)||p.lagMinutes<0||p.lagMinutes>120||!num(p.fastDurationMinutes)||p.fastDurationMinutes<15||p.fastDurationMinutes>720||!num(p.slowDurationMinutes)||p.slowDurationMinutes<p.fastDurationMinutes||p.slowDurationMinutes>720)return report('UNKNOWN','RESEARCH_PARAMETERS_REQUIRED',rev,acknowledged)}
  if(research.getRevision()!==rev)return report('BLOCKED','REVISION_CHANGED',rev);
  const options={historyDeclaration:declared,kineticsByMealId:Object.fromEntries(inside.map(m=>[m.id,{...kineticsByMealId[m.id]}]))};
  return report('RESEARCH_READY','PARENT_ATTESTED_AND_SCENARIO_ENTERED',rev,{...acknowledged,eligible:true,researchOptions:options});
 }catch(e){return report('BLOCKED','READ_FAILED',null,{errorCode:String(e?.code||'CONTRACT')})}
}
return Object.freeze({VERSION,inspect,WINDOW_MS});
});
