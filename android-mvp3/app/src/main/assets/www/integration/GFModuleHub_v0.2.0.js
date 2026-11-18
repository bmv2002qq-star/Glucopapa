/* ГлюкоПапа · GFShell module hub v0.2.0.
 * One GFStorage host only. UI-only basket; source is GFNutrition v0.4.0 FALLBACK.
 * Read-only analytics and visualization; no dose recommendations and no independent journal.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GPModuleHub=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const basket=[];
function copy(x){return JSON.parse(JSON.stringify(x));}
function requireModule(name){const x=globalThis[name];if(!x)throw Error('Не загружен модуль '+name);return x;}
function getCatalog(){const F=requireModule('GFFoodOnly'),d=requireModule('GPCatalogFallbackData');return F.createCatalog({items:d.items,venues:d.venues});}
let catalog=null;
function foodCatalog(){if(!catalog)catalog=getCatalog();return catalog;}
function queryFood(text,options={}){return foodCatalog().query({text,venueId:options.venueId||null,category:options.category||'Все',limit:options.limit||20});}
function addFood(id,amount){const f=foodCatalog().find(id);if(!f)throw Error('Нет продукта в каталоге');const p=foodCatalog().portion(id,amount);if(basket.length>=50)throw Error('Тарелка заполнена');basket.push({...p,kind:'catalog',foodId:id,note:f.note||'',nutritionStatus:f.nutritionStatus||'unknown'});return basketSnapshot();}
function dropFood(index){if(!Number.isInteger(index)||index<0||index>=basket.length)throw Error('Нет строки тарелки');basket.splice(index,1);return basketSnapshot();}
function clearBasket(){basket.length=0;return basketSnapshot();}
function basketSnapshot(){const items=copy(basket);return {items,totals:requireModule('GFFoodOnly').totals(items)};}
function makePlate(){if(!basket.length)throw Error('Тарелка пуста');const items=basket.map(p=>({kind:'catalog',foodId:p.foodId,name:p.name,amount:p.amount,unit:p.unit,carbs:p.carbs,protein:p.protein,fat:p.fat,kcal:p.kcal,note:p.note,nutritionStatus:p.nutritionStatus}));
 const t=requireModule('GFFoodOnly').totals(items);const p={schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:new Date().toISOString(),items,totals:t,containsEstimatedValues:items.some(x=>x.nutritionStatus!=='label_verified')};return requireModule('GFFoodMealEntry').normalizePlate(p).plate;}
function confirmedShots(state,id){return (state.events||[]).filter(e=>e.type==='insulin_injection'&&e.status==='confirmed'&&e.insulinId===id&&Number.isFinite(Date.parse(e.administeredAt))).map(e=>({id:e.id,insulinId:e.insulinId,status:e.status,units:e.units,ts:Date.parse(e.administeredAt)}));}
function chart(host,options={}){
 const bridge=requireModule('GFGraphEvidenceBridge');
 return bridge.render({host,renderer:requireModule('GPCgmWhiteChart'),engine:requireModule('RinfastEngine'),nowMs:Number.isSafeInteger(options.now)?options.now:Date.now(),historyH:options.hours||12,showInsulin:options.showInsulin!==false});
}
function rinfastModel(host,atIso=new Date().toISOString()){
 const gate=globalThis.GFInsulinEvidenceGate;if(!gate)return {kind:'research_curve',status:'INCOMPLETE',code:'EVIDENCE_GATE_UNAVAILABLE',parts:null,totalModelUnits:null,safeForTreatment:false};return gate.calculateFromHost(host,atIso,requireModule('RinfastEngine'));
}
function levemirModel(host,atIso=new Date().toISOString()){
 const eng=requireModule('LevemirEngine'),s=host.exportState();
 const measured=(s.measurements||[]).filter(m=>Number.isFinite(m.weightKg)&&Date.parse(m.measuredAt)<=Date.parse(atIso)).sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt));
 if(!measured.length)return {status:'INCOMPLETE',issues:['В настройках не указан фактически измеренный вес.'],remainingModelActionUnits:null};
 const cv=s.coverage||{};
 return eng.calculate({nowIso:atIso,patientWeightKg:measured.at(-1).weightKg,events:s.events||[],coverage:cv,horizonsMinutes:[60,180,360]});
}
function sitesAnalysis(host,now=Date.now()){
 const a=requireModule('GFInjectionAnalytics'),s=host.exportState();
 const input={schema:a.SCHEMA,revision:s.revision,cgm:s.cgm||[],cgmMetadata:s.cgmMetadata||undefined,
 injections:(s.events||[]).filter(x=>x.type==='insulin_injection'&&x.status==='confirmed').map(x=>({id:x.id,insulinId:x.insulinId,administeredAt:x.administeredAt,units:x.units,site:x.injectionSite||null,context:x.injectionContext||null}))};
 if(!input.cgmMetadata)delete input.cgmMetadata;
 return a.analyze(input,{asOf:now,referenceRegion:'abdomen'});
}
function report(host){const adapter=requireModule('GFAuditExportStorageAdapter');return adapter.collect(host);}
function reportTxt(host){const x=report(host);const lines=['ГЛЮКОПАПА — ИССЛЕДОВАТЕЛЬСКАЯ ВЫГРУЗКА','Время экспорта: '+new Date().toISOString(),'Ревизия: '+x.revision,'CGM: '+(x.cgm?.length||0)+' точек','События: '+(x.events?.length||0),'Приёмы еды: '+(x.mealSessions?.length||0),'','ИНЪЕКЦИИ'];
 for(const e of x.events||[])if(e.type==='insulin_injection')lines.push([e.administeredAt,e.insulinId,e.units,'ЕД',e.injectionSite?.region||'место не указано'].join(' | '));
 lines.push('','ЕДА');for(const m of x.mealSessions||[])lines.push([m.id,m.status,m.actualPlate?.totals?.carbs??'не подтверждена','г У',m.completedAt||''].join(' | '));
 lines.push('','Исходные CGM и прочие события полностью сохранены в отдельной JSON-выгрузке.','Нет медицинских рекомендаций и автоматических назначений.');return lines.join('\n');}
return Object.freeze({VERSION:'0.2.0',queryFood,foodCatalog,addFood,dropFood,clearBasket,basketSnapshot,makePlate,chart,rinfastModel,levemirModel,sitesAnalysis,report,reportTxt});
});
