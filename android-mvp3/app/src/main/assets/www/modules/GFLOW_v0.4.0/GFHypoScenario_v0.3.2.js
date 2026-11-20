/* ГлюкоПапа V2 · two-stage low-glucose research scenario, v0.3.2.
   Uses approved RinfastEngine and the adapted GFForecastHypo engine; does not
   use IOB as a second glucose subtraction. Model output is not a treatment rule.
*/
(function(root,factory){'use strict'; const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api; if(root)root.GFHypoScenario=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.3.2',round=(x,n=2)=>Number(x.toFixed(n));
function valid(x,min,max){return typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;}
function fail(code,message,more={}){return {status:'UNAVAILABLE',version:VERSION,code,message,...more};}
// 2-stage meal absorption CDF (experimental). No generic food-speed defaults.
function F(t,tau){return t<=0?0:1-(1+t/tau)*Math.exp(-t/tau);}
function run(input,forecastEngine,rinfastEngine,activityEngine){
 if(!input||typeof input!=='object')return fail('BAD_INPUT','Не передан снимок данных');
 if(!forecastEngine||typeof forecastEngine.predict!=='function'||!rinfastEngine?.getCurve)
   return fail('MISSING_ENGINE','Нет единого прогнозного движка или РинФаста');
 const product=input.product||{}, settings=input.settings||{};
 if(!valid(input.targetMmol,3.9,12))return fail('TARGET_MISSING','Не указана цель');
 if(![30,60,90,120].includes(input.horizonMin))return fail('HORIZON_MISSING','Выберите горизонт прогноза');
 if(!valid(settings.isfMmolPerUnit,0.1,30)||!valid(settings.carbRatioGPerUnit,1,200))
   return fail('COEFFICIENTS_MISSING','Нет заданных ФЧИ и УК');
 if(!valid(product.carbsPer100,0.1,100)||!['г','мл'].includes(product.unit)||!product.name)
   return fail('PRODUCT_MISSING','Нет проверенного состава продукта');
 if(!valid(product.absorptionTauMin,20,240))return fail('FOOD_PROFILE_MISSING','Для продукта не задан профиль усвоения');
 const r=forecastEngine.predict({
   nowIso:input.nowIso,readings:input.readings,injections:input.injections,
   meals:input.meals,settings,conditions:input.conditions||{},
   sourceIsComplete:input.sourceIsComplete===true,rinfastEngine
 });
 if(r.status!=='EXPERIMENTAL')return fail(r.code||'FORECAST_UNAVAILABLE',r.reason||'Невозможно построить прогноз без новой еды',{forecastResult:r});
 const base=r.points, idx=input.horizonMin/5;
 const baseTarget=base[idx].glucoseMmol;
 // Derived from explicit individual ISF and carbohydrate ratio; uncalibrated.
 const k=settings.isfMmolPerUnit/settings.carbRatioGPerUnit;
 const absorbed=F(input.horizonMin,product.absorptionTauMin);
 if(absorbed<0.001)return fail('NO_ABSORPTION','Нет ожидаемого действия еды в выбранный момент');
 const activityConfig=input.synthetic===true ? (input.hypoActivity||{enabled:false,level:'none'}) : {enabled:false,level:input.hypoActivity?.level||'none'};
 if(activityConfig.enabled!==false && activityConfig.level!=='none' && !activityEngine?.select)
   return fail('ACTIVITY_MODULE_MISSING','Нет расчетного модуля активности');
 let activity;
 try{activity=activityEngine?.select ? activityEngine.select(activityConfig) : {factor:1,enabled:false,level:'none',applied:false,source:'inactive'};}
 catch(e){return fail('ACTIVITY_INVALID',String(e.message||e));}
 // A single phenomenological multiplier reduces the modelled response per gram
 // and increases the what-if solver amount. Do NOT also multiply insulin action,
 // trend, COB or IOB (would double count unknown exercise physiology).
 const activityFactor=activity.factor;
 const denom=product.carbsPer100/100*(k/activityFactor)*absorbed;
 const suggested=Math.max(0,(input.targetMmol-baseTarget)/denom);
 const solveStatus=suggested>2000?'OUTSIDE_RANGE':'MODEL_AMOUNT';
 const amount=input.amount===null||input.amount===undefined||input.amount===''?null:Number(input.amount);
 if(amount!==null&&!valid(amount,0,2000))return fail('AMOUNT_INVALID','Введите количество от 0 до 2000 г или мл');
 // Without a typed amount, solver does not claim the model amount was eaten.
 const carbohydrate=amount===null?null:amount*product.carbsPer100/100;
 const points=base.map(p=>{
   const effect=carbohydrate===null?null:carbohydrate*(k/activityFactor)*F(p.horizonMin,product.absorptionTauMin);
   return {...p,withoutMmol:p.glucoseMmol,withMmol:effect===null?null:round(p.glucoseMmol+effect),foodEffectMmol:effect===null?null:round(effect,4)};
 });
 const atTarget=points[idx];
 const baselineMin=round(Math.min(...points.map(p=>p.withoutMmol)));
 const scenarioMin=carbohydrate===null?null:round(Math.min(...points.map(p=>p.withMmol)));
 const flags=[...new Set([...(r.snapshot.flags||[]), 'hypo_counterfactual_uncalibrated', 'absorption_model_unvalidated',...(activity.applied?['activity_multiplier_experimental']:[])])];
 return {status:'MODEL_SCENARIO',version:VERSION,modelValidated:false,clinicalUse:false,
  targetMmol:input.targetMmol,horizonMin:input.horizonMin,modelAmount:solveStatus==='MODEL_AMOUNT'?round(suggested,1):null,modelAmountStatus:solveStatus,
  amount:amount===null?null:round(amount,1),unit:product.unit,carbsG:carbohydrate===null?null:round(carbohydrate,2),
  productName:product.name,kCarbsMmolPerG:round(k,5),kEffectiveCarbsMmolPerG:round(k/activityFactor,5),activity,
  baselineAtHorizon:baseTarget,withAtHorizon:atTarget.withMmol,
  baselineMin,scenarioMin,points,source:r.snapshot,flags,
  math:{k:'ФЧИ / УК',baseline:'GFForecastHypo (CGM + остаточный тренд + будущее действие РинФаста и уже съеденной еды)',
   food:'Граммы × углеводы на 100 / 100 × (ФЧИ / УК) / МножительАктивности × F(t,τ)',
   curve:'F(t,τ)=1−(1+t/τ)exp(−t/τ)',target:`через ${input.horizonMin} мин`}};
}
return Object.freeze({VERSION,F,run});
});
