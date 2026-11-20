/* Read-only bridge from *actual* GFStorage v5 research projection to GFLOWCore.
 * The existing host supports host.connect('research').getSnapshot() on GFStorage
 * v0.5.8/v0.5.10, NOT connect('hypo'). Research projection is atomic per revision.
 * No direct calls to other modules. For unavailable food/coefficients, fail closed.
 * Codex should replace the broad research role with a scoped LOW read role.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFLOWGFStorageBridge=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.4.0',M=60000;
const validTime=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&/(Z|[+-]\d\d:\d\d)$/.test(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const missing=(code,message)=>({status:'INCOMPLETE',code,message});
const normTime=x=>new Date(x).toISOString();
const before=(a,at)=>validTime(a)&&Date.parse(a)<=at;
function fromProjection(raw,config={}){
 if(!raw||raw.schemaVersion!==5||!Number.isSafeInteger(raw.revision)||raw.revision<0)return missing('SCHEMA_OR_REVISION','Нет корректной ревизии GFStorage v5');
 if(!validTime(config.nowIso))return missing('CURRENT_TIME_MISSING','Требуется доверенное nowIso');
 const now=Date.parse(config.nowIso);
 // GFStorage coverage has ONE parent-confirmed historical interval. Verify the entire window.
 const c=raw.coverage;
 if(!c||c.confirmedComplete!==true||c.declaredBy!=='parent'||!before(c.startIso,now-360*M)||!before(c.endIso,now)||Date.parse(c.endIso)<now)
  return missing('COVERAGE_NOT_PROVEN','Период истории последних 360 минут не подтверждён полностью');
 if(!Array.isArray(raw.cgm)||!Array.isArray(raw.events)||!Array.isArray(raw.mealSessions)||!Array.isArray(raw.coefficients)||!Array.isArray(raw.measurements)||!Array.isArray(raw.conditionPeriods))
  return missing('MISSING_SECTIONS','Отсутствует одна из обязательных секций GFStorage');
 // No independent parallel storage. Coefficients MUST be resolved from the same projection by approved GFTimeGrid.
 if(typeof config.resolveCoefficients!=='function'||typeof config.resolveMealProfile!=='function'||typeof config.resolveCatalog!=='function')
  return missing('EVIDENCE_RESOLVERS_REQUIRED','Нужны подтверждённые функции GFTimeGrid, профиля еды и каталога');
 let resolved,products;
 try {resolved=config.resolveCoefficients(raw,config.nowIso);products=config.resolveCatalog(raw,config.nowIso);}catch(e){return missing('RESOLVER_ERROR',String(e.message||e));}
 if(!resolved||resolved.revision!==raw.revision||!finite(resolved.isfMmolPerUnit)||!finite(resolved.carbRatioGPerUnit)||!products||products.revision!==raw.revision||typeof products.catalog!=='object')
  return missing('COEFFICIENT_OR_PRODUCT_PROVENANCE','Не получены коэффициенты и продукты той же ревизии');
 const weights=raw.measurements.filter(x=>finite(x?.weightKg)&&validTime(x.measuredAt)&&Date.parse(x.measuredAt)<=now).sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt));
 if(!weights.length)return missing('WEIGHT_UNKNOWN','Нет фактически измеренного веса');
 const cgm=[];
 for(const r of raw.cgm){
  if(!finite(r?.ts)||!finite(r?.mmol)||r.mmol<2||r.mmol>33||r.valid===false||r.qualityFlag==='invalid')continue;
  // Timestamp transport delay must remain explicit, not guessed from now or ts.
  if(!validTime(r.receivedAt))return missing('CGM_RECEIPT_MISSING','Нет точного receivedAt CGM');
  if(r.ts>now||Date.parse(r.receivedAt)<r.ts-60000)return missing('CGM_CLOCK_CONFLICT','Повреждённые времена CGM');
  const source=r.sourceDeviceId||r.source;
  if(!source||r.kind!=='observed')return missing('CGM_SOURCE_MISSING','CGM не является подтверждённым измерением');
  cgm.push({measuredAt:normTime(r.ts),receivedAt:normTime(r.receivedAt),glucoseMmol:r.mmol,sourceId:source});
 }
 if(!cgm.length)return missing('CGM_EMPTY','Не найдены подтверждённые измерения CGM');
 const injections=[];
 for(const e of raw.events){
  if(!e||typeof e!=='object')return missing('INVALID_EVENT','Повреждённое событие');
  if(['meal','food','carbohydrate','snack'].includes(e.type))return missing('UNMIGRATED_FOOD_EVENT','Найдена запись еды вне подтверждённой mealSession: требуется миграция и устранение дублирования');
  if(e.type!=='insulin_injection')continue;
  if(e.status!=='confirmed'||!validTime(e.administeredAt)||!['rinfast','levemir'].includes(e.insulinId)||!finite(e.units))return missing('UNCONFIRMED_INSULIN','Неподтверждённая или неполная инъекция');
  injections.push({id:e.id,insulinId:e.insulinId,status:'confirmed',administeredAt:normTime(e.administeredAt),units:e.units});
 }
 const meals=[];
 for(const m of raw.mealSessions){
  if(!m||typeof m!=='object')return missing('INVALID_MEAL_SESSION','Неверная сессия еды');
  if(m.status==='draft'||m.status==='ready')continue; // explicit planned vs actual
  // Complete actual meal only; started but unfinished might contain partial food: cannot infer intake.
  if(m.status!=='completed')return missing('MEAL_PARTIAL','История содержит частично подтверждённую еду');
  const carbs=m.actualPlate?.totals?.carbs;
  if(!finite(carbs)||carbs<0||!validTime(m.startedAt))return missing('MEAL_CONTENT_MISSING','Нет точного времени или подтверждённых углеводов');
  let profile;try{profile=config.resolveMealProfile(m,raw,config.nowIso)}catch(e){return missing('MEAL_PROFILE_ERROR',String(e.message||e));}
  if(!profile||profile.revision!==raw.revision||!finite(profile.absorptionTauMin))return missing('MEAL_PROFILE_UNVERIFIED','Отсутствует профиль усвоения подтверждённой еды');
  meals.push({id:m.id,status:'confirmed',eatenAt:normTime(m.startedAt),carbsG:carbs,absorptionTauMin:profile.absorptionTauMin});
 }
 const active=kind=>raw.conditionPeriods.filter(p=>p.kind===kind&&before(p.start,now)&&(p.end===null||Date.parse(p.end)>=now));
 const illness=active('illness').length>0;
 const sport=active('sport').length>0,activityPeriod=active('activity').length>0;
 const activity=sport?'sport':activityPeriod?'high':raw.profile?.activityBaseLevel==='low'?'low':'ordinary';
 return {schemaVersion:5,revision:raw.revision,nowIso:config.nowIso,
  profile:{weightKg:weights.at(-1).weightKg},
  settings:{isfMmolPerUnit:resolved.isfMmolPerUnit,carbRatioGPerUnit:resolved.carbRatioGPerUnit,
   absorptionModel:resolved.absorptionModel||'GFForecast'},
  coverage:{cgmComplete:true,injectionsComplete:true,mealsComplete:true,
   coefficientsVerified:resolved.validated===true,foodProfilesVerified:products.validated===true},
  cgm,injections,meals,conditions:{illness,activity},products:products.catalog};
}
function createPort(host,config={}){
 if(!host||typeof host.connect!=='function')return {readSnapshot:()=>missing('HOST_MISSING','Нет GFStorage host')};
 let port;try{port=host.connect('research');}catch(e){return {readSnapshot:()=>missing('ROLE_UNAVAILABLE',String(e.message||e))};}
 if(!port||typeof port.getSnapshot!=='function')return {readSnapshot:()=>missing('SNAPSHOT_UNAVAILABLE','Нет getSnapshot в GFStorage')};
 return Object.freeze({readSnapshot:()=>{
  try{const effectiveConfig={...config,nowIso:typeof config.nowIso==='function'?config.nowIso():config.nowIso};return fromProjection(port.getSnapshot(),effectiveConfig)}catch(e){return missing('STORAGE_FAILURE',String(e.message||e))}
 }});
}
return Object.freeze({VERSION,createPort,fromProjection});
});
