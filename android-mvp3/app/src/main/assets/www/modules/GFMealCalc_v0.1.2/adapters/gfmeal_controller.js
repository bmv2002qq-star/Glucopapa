/* GlucoPapa GFMealCalc workflow controller: calls approved GFStorage ports, not medical decisions.
 * No direct writing to calculator, no ability to overwrite old injection events.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFMealController=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const iso=s=>typeof s==='string'&&/T\d\d:\d\d/.test(s)&&/(Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s));
const units=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=50&&Math.abs(n*2-Math.round(n*2))<1e-9;
function createController(host,{makeId=prefix=>prefix+'-'+(typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2))}={}){
 if(!host||host.getSchemaVersion()!==5)throw Error('Нужен GFStorage schemaVersion 5');
 const ports={food:host.connect('food'),mealFlow:host.connect('mealFlow'),actionWriter:host.connect('actionWriter'),calculator:host.connect('calculator')};
 const lookup=id=>{const s=ports.calculator.getSnapshot(),m=s.mealSessions.find(x=>x.id===id);if(!m)throw Error('Нет такого приёма пищи');return m;};
 const v=id=>{const m=lookup(id);return {sessionId:id,expectedVersion:m.version,opId:makeId('op')};};
 function createFromFood(plate,sessionId,mealType=null){
  if(!sessionId||typeof sessionId!=='string')throw Error('Нужен устойчивый sessionId: создаётся один раз при начале действия');
  ports.food.createDraft({id:sessionId,plate,...(mealType===null?{}:{mealType})},ports.food.getRevision());return sessionId;
 }
 function updatePlan(id,plate,mealType){
  return ports.food.updatePlannedPlate({...v(id),plate,...(mealType===undefined?{}:{mealType})},ports.food.getRevision());
 }
 function ready(id){return ports.mealFlow.markReady(v(id),ports.mealFlow.getRevision());}
 function setParentIntent(id,amount,{explicitParentConfirmation=false}={}){
  if(!explicitParentConfirmation)throw Error('Нужно явное подтверждение выбранного родителем решения');
  if(!units(amount))throw Error('В учебном интерфейсе требуется число кратное шагу ручки 0,5 ЕД');
  return ports.mealFlow.setUserDoseIntent({...v(id),insulinId:'rinfast',units:amount},ports.mealFlow.getRevision());
 }
 function recordActualInjection(id,amount,atIso,{explicitlyInjected=false,injectionId=null,distinctActionAcknowledged=false,distinctActionReason=null}={}){
  if(!injectionId)throw Error('Нужен постоянный injectionId физического действия');
  if(!explicitlyInjected)throw Error('Подтвердите, что инъекция действительно выполнена');
  if(!units(amount)||amount===0)throw Error('Фактически введённая доза должна быть >0 и кратна 0,5 ЕД');
  if(!iso(atIso))throw Error('Требуется явное время с часовым поясом');
  return ports.actionWriter.recordSessionInjection({...v(id),injectionId,insulinId:'rinfast',units:amount,administeredAt:atIso,...(distinctActionAcknowledged?{distinctActionAcknowledged,distinctActionReason}: {})},ports.actionWriter.getRevision());
 }
 function startMeal(id,atIso,{actuallyStarted=false}={}){
  if(!actuallyStarted)throw Error('Нужно подтвердить фактическое начало еды');
  if(!iso(atIso))throw Error('Нужна дата с часовым поясом');
  return ports.actionWriter.confirmMealStart({...v(id),startedAt:atIso},ports.actionWriter.getRevision());
 }
 function actualFood(id,plate,{parentConfirmed=false,reason=null}={}){
  if(!parentConfirmed)throw Error('Нужно явное подтверждение фактически съеденного');
  const previous=lookup(id).actualPlate;
  if(previous&&(!reason||!String(reason).trim()))throw Error('Для исправления факта еды укажите причину');
  return ports.actionWriter.recordActualPlate({...v(id),plate,...(previous?{reason:String(reason)}:{})},ports.actionWriter.getRevision());
 }
 function finishMeal(id,atIso,{confirmed=false}={}){
  if(!confirmed)throw Error('Нужно подтвердить фактическое завершение еды');
  if(!iso(atIso))throw Error('Требуется время ISO с поясом');
  return ports.actionWriter.confirmMealFinished({...v(id),finishedAt:atIso},ports.actionWriter.getRevision());
 }
 return Object.freeze({createFromFood,updatePlan,ready,setParentIntent,recordActualInjection,startMeal,actualFood,finishMeal,lookup});
}
return Object.freeze({createController});
});
