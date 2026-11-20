/* ГлюкоПапа LOW v0.4.0: clinical threshold + independent CGM alert +
 * one-revision GFStorage snapshot -> historical math engines.
 * No event persistence, dosage authority, or direct module-to-module storage.
 * Forecasting and nutrition equations are research-only, NOT medical treatment.
 */
(function(root,factory){'use strict';const api=factory(typeof module==='object'&&module.exports?{
  GFHypoScenario:require('./GFHypoScenario_v0.3.2.js'),
  GFForecastHypo:require('./GFForecastHypo_v0.3.0.js'),
  GFXDripLowAlert:require('./GFXDripLowAlert_v0.1.0.js'),
  RinfastEngine:require('./rinfast_engine_v0.3.1_UNCHANGED.js')
}:root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFLOWCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(engines){
'use strict';
const VERSION='0.4.0',MINUTE=60000;
const has=(o,k)=>o&&Object.prototype.hasOwnProperty.call(o,k);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const goodString=x=>typeof x==='string'&&x.trim().length>0;
const time=x=>typeof x==='string'&&/T/.test(x)&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const result=(status,code,detail,extras={})=>Object.freeze({version:VERSION,status,code,detail,clinicalUse:false,...extras});
const no=(code,detail,extras={})=>result('INCOMPLETE',code,detail,extras);
function ispad(weight,glucose){
 if(!finite(weight)||weight<5||weight>200)return {state:'NO_WEIGHT',visible:false,initialCarbsG:null};
 const severe=finite(glucose)&&glucose<3.0;
 const hypo=finite(glucose)&&glucose<3.9;
 return Object.freeze({state:severe?'LEVEL2':hypo?'LEVEL1':'NOT_HYPO',visible:hypo,
  initialCarbsG:hypo?Math.round(weight*0.3*100)/100:null,
  appleJuiceEquivMl:null,rule:'ISPAD_WEIGHT_BASELINE_0_3_G_PER_KG',medicalThresholdMmol:3.9,
  note:'Демонстрация справочного пересчёта быстрых углеводов, не персональная доза сока; глюкоза предпочтительнее.'});
}
function validateSnapshot(s){
 if(!s||typeof s!=='object'||Array.isArray(s))return no('SNAPSHOT_MISSING','GFStorage: отсутствует снимок данных');
 if(s.schemaVersion!==5)return no('SCHEMA_MISMATCH','Нужна совместимая схема GFStorage v5');
 if(!Number.isInteger(s.revision)||s.revision<0)return no('REVISION_MISSING','Нет номера единой ревизии GFStorage');
 if(!goodString(s.nowIso)||!finite(time(s.nowIso)))return no('NOW_MISSING','Нет проверенного времени снимка');
 if(!Array.isArray(s.cgm)||!s.cgm.length)return no('CGM_MISSING','Нет измерений CGM');
 if(!Array.isArray(s.injections)||!Array.isArray(s.meals))return no('HISTORY_MISSING','Нет журналов фактических инъекций или еды');
 if(!s.coverage||s.coverage.cgmComplete!==true||s.coverage.injectionsComplete!==true||s.coverage.mealsComplete!==true)return no('COVERAGE_INCOMPLETE','Не подтверждена полнота источников CGM/инсулина/еды');
 if(!s.profile||!finite(s.profile.weightKg)||s.profile.weightKg<5||s.profile.weightKg>200)return no('PROFILE_MISSING','Нет проверенного веса из GFSettings');
 if(!s.settings||!finite(s.settings.isfMmolPerUnit)||!finite(s.settings.carbRatioGPerUnit)||s.settings.isfMmolPerUnit<=0||s.settings.carbRatioGPerUnit<=0)return no('SETTINGS_INCOMPLETE','Нет ФЧИ или УК из одной ревизии GFStorage');
 if(!s.products||typeof s.products!=='object')return no('CATALOG_MISSING','Не найден каталог продуктов');
 const ids=new Set();for(const e of [...s.injections,...s.meals]){if(!goodString(e?.id)||ids.has(e.id))return no('EVENT_ID_INVALID','Отсутствующий или повторный ID события');ids.add(e.id);}
 // Do not silently interpret planned/partial or ambiguous records as complete history.
 for(const e of s.injections){if(e.status!=='confirmed'||!['rinfast','levemir'].includes(e.insulinId)||!finite(time(e.administeredAt))||!finite(e.units)||e.units<=0)return no('INSULIN_EVENT_INVALID','Неоднозначная или неподтверждённая инъекция');}
 for(const e of s.meals){if(e.status!=='confirmed'||!finite(time(e.eatenAt))||!finite(e.carbsG)||e.carbsG<0||!finite(e.absorptionTauMin))return no('MEAL_EVENT_INVALID','Неполные данные фактически съеденной еды');}
 return null;
}
function readSnapshot(port){
 if(!port||typeof port.readSnapshot!=='function')return no('GFSTORAGE_PORT_MISSING','Codex должен предоставить readSnapshot из единого GFStorage');
 let s;try{s=port.readSnapshot();}catch(err){return no('GFSTORAGE_READ_ERROR',String(err.message||err));}
 if(s?.status==='INCOMPLETE')return s;
 const error=validateSnapshot(s);return error||s;
}
function evaluate(raw,options={}){
 const snapErr=validateSnapshot(raw);if(snapErr)return snapErr;
 const {GFHypoScenario,GFForecastHypo,GFXDripLowAlert,RinfastEngine}=engines;
 if(!GFHypoScenario||!GFForecastHypo||!GFXDripLowAlert||!RinfastEngine)return no('MATH_ENGINE_MISSING','Недостающие исходные расчётные ядра');
 const productId=options.productId,product=raw.products[productId];
 if(!goodString(productId)||!product)return no('PRODUCT_NOT_FOUND','Нет выбранного продукта из подтверждённого каталога');
 if(!finite(product.carbsPer100)||product.carbsPer100<=0||product.carbsPer100>100||!['мл','г'].includes(product.unit)||!goodString(product.name)||!finite(product.absorptionTauMin)||product.absorptionTauMin<20||product.absorptionTauMin>240)return no('PRODUCT_PROFILE_INVALID','Не подтверждены состав/скорость продукта');
 const target=options.targetMmol,horizon=options.horizonMin??120;
 if(!finite(target)||target<3.9||target>12||![30,60,90,120].includes(horizon))return no('TARGET_OR_HORIZON_INVALID','Неверная цель или горизонт');
 const amount=options.amount===undefined?null:options.amount;
 if(amount!==null&&(!finite(amount)||amount<0||amount>2000))return no('AMOUNT_INVALID','Неправильное количество продукта');
 const last=raw.cgm.reduce((p,c)=>!p||time(c.measuredAt)>time(p.measuredAt)?c:p,null);
 const level=ispad(raw.profile.weightKg,last?.glucoseMmol);
 const emergency=Object.freeze({...level,
  appleJuiceEquivMl:level.visible&&productId==='dobry_apple'&&finite(product.carbsPer100)?Math.round(level.initialCarbsG*100/product.carbsPer100):null,
  unit:product.unit,productName:product.name});
 const alert=GFXDripLowAlert.predict({readings:raw.cgm,nowIso:raw.nowIso,
  thresholdMmol:3.9,warningWindowMin:30,horizonMin:30});
 const selection=raw.settings.absorptionModel??'GFForecast';
 const conditions=raw.conditions||{};
 if(selection!=='GFForecast'&&selection!=='GFCOB')return no('MODEL_SELECTION_INVALID','Неизвестный выбор модели еды',{emergency,alert});
 // Existing verified LOW research engine is not identical to global GFForecast or GFCOB.
 // Until Codex proves model-parity, any selected model is flagged not canonical.
 const modelMismatch=selection==='GFCOB';
 const context={nowIso:raw.nowIso,readings:raw.cgm,injections:raw.injections,meals:raw.meals,
  settings:{...raw.settings},conditions:{...conditions,activity:conditions.activity==='ordinary'?null:conditions.activity},sourceIsComplete:true};
 const scenario=GFHypoScenario.run({...context,product,targetMmol:target,horizonMin:horizon,amount,synthetic:false},GFForecastHypo,RinfastEngine);
 if(scenario.status!=='MODEL_SCENARIO')return no(scenario.code||'MODEL_UNAVAILABLE',scenario.message||'Невозможно рассчитать сценарий',{revision:raw.revision,emergency,alert,forecastResult:scenario.forecastResult||null});
 let issues=[];
 if(modelMismatch)issues.push('GFCOB_PORT_UNAVAILABLE');
 if(conditions.illness)issues.push('ILLNESS_EFFECT_UNMODELED');
 if(conditions.activity&&conditions.activity!=='ordinary')issues.push('ACTIVITY_EFFECT_UNMODELED');
 if(raw.coverage.foodProfilesVerified!==true)issues.push('FOOD_PROFILE_UNVERIFIED');
 if(raw.coverage.coefficientsVerified!==true)issues.push('COEFFICIENTS_UNVERIFIED');
 const source=scenario.source||{};
 if(source.flags?.includes('illness_unmodeled')&&!issues.includes('ILLNESS_EFFECT_UNMODELED'))issues.push('ILLNESS_EFFECT_UNMODELED');
 if(source.flags?.includes('activity_unmodeled')&&!issues.includes('ACTIVITY_EFFECT_UNMODELED'))issues.push('ACTIVITY_EFFECT_UNMODELED');
 // Do not label research inverse values as treatment or calculate outside safe display range.
 const inverseAvailable=issues.length===0&&scenario.modelAmountStatus==='MODEL_AMOUNT'&&
   finite(scenario.modelAmount)&&scenario.modelAmount<=200;
 const items=scenario.points.map(p=>({minute:p.horizonMin,withoutMmol:p.withoutMmol,withMmol:p.withMmol,
   foodEffectMmol:p.foodEffectMmol,lower:p.lower,upper:p.upper}));
 const crossed=amount===null?null:items.find(p=>p.withMmol!==null&&p.withMmol>=target);
 return Object.freeze({status:'MODEL_SCENARIO',code:inverseAvailable?'MODEL_READY':'MODEL_LIMITED',version:VERSION,clinicalUse:false,
  revision:raw.revision,observedAt:last.measuredAt,emergency,alert,productId,productName:product.name,unit:product.unit,
  selectedAbsorptionModel:selection,modelMismatch,targetMmol:target,horizonMin:horizon,amount,
  modelAmount:inverseAvailable?scenario.modelAmount:null,
  modelAmountStatus:inverseAvailable?'MODEL_AMOUNT':scenario.modelAmountStatus==='OUTSIDE_RANGE'?'OUTSIDE_RANGE':'NOT_AUTHORIZED',
  baselineAtHorizon:scenario.baselineAtHorizon,withAtHorizon:scenario.withAtHorizon,
  firstTargetCrossingMin:crossed?crossed.minute:null,
  points:items,issues,flags:scenario.flags,modelVersions:{low:GFHypoScenario.VERSION,forecast:GFForecastHypo.VERSION,
   rinfast:RinfastEngine.ENGINE_VERSION,alert:GFXDripLowAlert.VERSION},
  notMedicalAdvice:true});
}
return Object.freeze({VERSION,ispad,validateSnapshot,readSnapshot,evaluate});
});
