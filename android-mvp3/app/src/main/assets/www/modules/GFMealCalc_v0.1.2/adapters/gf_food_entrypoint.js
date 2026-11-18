/* GFMealCalc v0.1.1 integration-only patch. GFPlate.v1 -> GFStorage 2/3/4/5.
 * Preserves meal workflow and immutable factual injection semantics.
 * Strictly allows two GFNutrition 0.4.6 display-only GI fields; no dose calculation.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFFoodMealEntry=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const ITEMS=new Set(['kind','foodId','name','amount','unit','carbs','protein','fat','kcal','note','nutritionStatus']);
const OPTIONAL_GI=new Set(['glycemicIndex','glycemicIndexStatus']);
function normalizePlate(p){
 if(!p||p.schema!=='GFPlate.v1'||p.source!=='GFFoodOnly'||!Array.isArray(p.items))throw Error('Ожидался GFPlate.v1 из GFFoodOnly');
 const keys=['schema','source','createdAt','items','totals','containsEstimatedValues'];
 if(Object.keys(p).some(k=>!keys.includes(k)))throw Error('Неизвестное поле тарелки');
 let discardedGI=false;
 const items=p.items.map((item,i)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Некорректная строка тарелки '+i);
  const out={};
  for(const [k,v] of Object.entries(item)){
   if(ITEMS.has(k))out[k]=v;
   else if(OPTIONAL_GI.has(k))discardedGI=true;
   else throw Error('Неизвестное поле продукта: '+k);
  }
  return out;
 });
 return {plate:{schema:p.schema,source:p.source,createdAt:p.createdAt,items,totals:p.totals,containsEstimatedValues:p.containsEstimatedValues},discardedGI};
}
function makeFoodBridge(host,controller,{onOpened=()=>{}}={}){
 if(!host||!(host.getSchemaVersion?.()===5)||!controller||typeof controller.createFromFood!=='function')throw Error('Нужен GFStorage schema 2/3/4 и контроллер');
 return Object.freeze({async openCalculation(plateSnapshot,{sessionId=null}={}){
  if(!sessionId)return Object.freeze({accepted:false,stored:false,code:'STABLE_ID_REQUIRED',reason:'Нужен постоянный sessionId, созданный один раз в UI'});
  try{
   const normalized=normalizePlate(plateSnapshot);
   const existing=sessionId?host.connect('calculator').read('mealSessions').find(x=>x.id===sessionId):null;
   if(existing){
    if(JSON.stringify(existing.plannedPlate)!==JSON.stringify(normalized.plate))throw Error('Конфликт: ID приёма пищи уже существует с другим планом');
    onOpened(sessionId);return Object.freeze({accepted:true,stored:true,reused:true,sessionId,storageRevision:host.connect('calculator').getRevision(),sessionVersion:existing.version,giMetadataNotPersisted:normalized.discardedGI});
   }
   const id=controller.createFromFood(normalized.plate,sessionId);
   const stored=host.connect('calculator').read('mealSessions').find(x=>x.id===id);
   if(!stored||stored.plannedPlate.schema!=='GFPlate.v1')throw Error('Тарелка не сохранена в GFStorage');
   onOpened(id);
   return Object.freeze({accepted:true,stored:true,reused:false,sessionId:id,storageRevision:host.connect('calculator').getRevision(),sessionVersion:stored.version,giMetadataNotPersisted:normalized.discardedGI});
  }catch(e){return Object.freeze({accepted:false,stored:false,reason:String(e.message||e)});}
 }});
}
return Object.freeze({VERSION:'0.1.1',normalizePlate,makeFoodBridge});
});
