/* ГлюкоПапа · GFCOBResearch v0.1.0 CANDIDATE · ONLY RESEARCH.
 * GFStorage schema5 read-only. No universal absorption profile. An explicit parent
 * history declaration and per-meal experimentally chosen kinetics are mandatory.
 * A model range is never a dose, verified patient physiology or recommendation.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFCOBResearch=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.0-research-candidate',WINDOW_MS=12*3600000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function freeze(x){if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function result(status,code,revision=null,extra={}){return freeze({version:VERSION,status,code,sourceRevision:revision,value:null,lowerG:null,upperG:null,allowDose:false,allowRecommendation:false,clinicalCalibration:false,...extra});}
function isoTime(s){return typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s))?Date.parse(s):NaN;}
function active(p,now){const t=isoTime(p?.start),end=p?.end==null?Infinity:isoTime(p.end);return Number.isFinite(t)&&t<=now&&end>=now;}
function inspect({host,nowMs=Date.now(),historyDeclaration=null,kineticsByMealId=null}={}){
 if(!Number.isSafeInteger(nowMs))return result('UNKNOWN','INVALID_CLOCK');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return result('UNKNOWN','GFSTORAGE_SCHEMA');
 try{
  const research=host.connect('research'),journal=host.connect('journal'),settings=host.connect('settings');
  const rev=research.getRevision(),r=research.getSnapshot(),j=journal.getSnapshot(),s=settings.getSnapshot(),after=research.getRevision();
  if(rev!==after||rev!==r.revision||rev!==j.revision||rev!==s.revision)return result('UNKNOWN','REVISION_CHANGED',after);
  const context={activityLevel:s.profile?.activityBaseLevel||null,sportActive:(j.conditionPeriods||[]).some(p=>p.kind==='sport'&&active(p,nowMs)),illnessActive:(j.conditionPeriods||[]).some(p=>p.kind==='illness'&&active(p,nowMs)),appliedToAbsorption:false};
  const sessions=(j.mealSessions||[]).filter(m=>{
    const t=isoTime(m.startedAt||m.completedAt);return Number.isFinite(t)&&t<=nowMs&&t>=nowMs-WINDOW_MS;
  });
  const base={context,recordedMealCount:sessions.length,coverageStatus:'UNCONFIRMED',model:'EXPLICIT_USER_SCENARIO_LINEAR_INTERVAL',readOnly:true};
  if(!historyDeclaration||historyDeclaration.confirmedComplete!==true||historyDeclaration.source!=='user_declared'||isoTime(historyDeclaration.startIso)>nowMs-WINDOW_MS||isoTime(historyDeclaration.endIso)<nowMs||isoTime(historyDeclaration.declaredAtIso)>nowMs||![historyDeclaration.startIso,historyDeclaration.endIso,historyDeclaration.declaredAtIso].every(v=>Number.isFinite(isoTime(v))))
   return result('UNKNOWN','FOOD_COVERAGE_MISSING',rev,base);
  const attested={...base,coverageStatus:'PARENT_DECLARED_UNVERIFIED'};
  if(!Array.isArray(j.mealSessions))return result('UNKNOWN','MEAL_SESSIONS_NOT_AVAILABLE',rev,attested);
  if(j.mealSessions.some(m=>{const t=isoTime(m.startedAt||m.completedAt);return Number.isFinite(t)&&t>nowMs&&t<=nowMs+WINDOW_MS&&m.status==='completed';}))return result('UNKNOWN','FUTURE_MEAL',rev,attested);
  if(sessions.some(m=>m.status!=='completed'||!m.actualPlate||!Number.isFinite(isoTime(m.completedAt))||isoTime(m.completedAt)>nowMs))return result('UNKNOWN','MEAL_NOT_CONFIRMED',rev,attested);
  if(sessions.some(m=>{
    const p=m.actualPlate;
    return p.schema!=='GFPlate.v1'||p.containsEstimatedValues!==false||!p.totals||!finite(p.totals.carbs)||p.totals.carbs<0||!Array.isArray(p.items)||p.items.some(x=>!finite(x.amount)||x.amount<0||!['г','мл'].includes(x.unit)||!finite(x.carbs)||x.carbs<0||!['label_verified','verified','user_confirmed'].includes(x.nutritionStatus));
  }))return result('UNKNOWN','FOOD_COMPOSITION_INCOMPLETE',rev,attested);
  if(!kineticsByMealId||typeof kineticsByMealId!=='object'||Array.isArray(kineticsByMealId))return result('UNKNOWN','KINETICS_NOT_DEFINED',rev,attested);
  let lo=0,hi=0;const contributions=[];
  for(const m of sessions){
    const k=kineticsByMealId[m.id];
    if(!k||k.origin!=='explicit_research_scenario'||!finite(k.lagMinutes)||k.lagMinutes<0||k.lagMinutes>120||!finite(k.fastDurationMinutes)||!finite(k.slowDurationMinutes)||k.fastDurationMinutes<15||k.fastDurationMinutes>720||k.slowDurationMinutes<k.fastDurationMinutes||k.slowDurationMinutes>720)return result('UNKNOWN','KINETICS_NOT_DEFINED',rev,attested);
    const started=isoTime(m.startedAt), elapsed=(nowMs-started)/60000;
    if(!Number.isFinite(started)||elapsed<0)return result('UNKNOWN','MEAL_START_INVALID',rev,attested);
    const rMinutes=Math.max(0,elapsed-k.lagMinutes),carbs=m.actualPlate.totals.carbs;
    const lower=carbs*Math.max(0,1-rMinutes/k.fastDurationMinutes);
    const upper=carbs*Math.max(0,1-rMinutes/k.slowDurationMinutes);
    lo+=lower;hi+=upper;
    contributions.push({mealId:m.id,carbsRecordedG:carbs,lowerG:lower,upperG:upper,assumption:k.origin});
  }
  if(research.getRevision()!==rev)return result('UNKNOWN','REVISION_CHANGED',research.getRevision());
  // Bounds are for sensitivity tests ONLY. Never form a point estimate or dose.
  return result('RESEARCH_INTERVAL','MODEL_ASSUMPTIONS_ONLY',rev,{...attested,recordedCarbsG:sessions.reduce((z,m)=>z+m.actualPlate.totals.carbs,0),lowerG:lo,upperG:hi,contributions});
 }catch(err){return result('UNKNOWN','READ_FAILED_'+String(err?.code||'CONTRACT').replace(/[^a-z0-9_]/gi,'_').slice(0,40).toUpperCase());}
}
return Object.freeze({VERSION,inspect});
});
