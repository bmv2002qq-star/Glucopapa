/* ГлюкоПапа · GFShell module hub v0.2.0.
 * One GFStorage host. Approved nutrition is opened by the shell.
 * Read-only analytics and visualization; no dose recommendations and no independent journal.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GPModuleHub=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function requireModule(name){const x=globalThis[name];if(!x)throw Error('Не загружен модуль '+name);return x;}
function chart(host,options={}){
 const bridge=requireModule('GFGraphEvidenceBridge');
 return bridge.render({host,renderer:requireModule('GPCgmWhiteChart'),engine:requireModule('RinfastEngine'),nowMs:Number.isSafeInteger(options.now)?options.now:Date.now(),historyH:options.hours||12,showInsulin:options.showInsulin!==false});
}
function rinfastModel(host,atIso=new Date().toISOString()){
 const gate=globalThis.GFInsulinEvidenceGate;if(!gate)return {kind:'research_curve',status:'INCOMPLETE',code:'EVIDENCE_GATE_UNAVAILABLE',parts:null,totalModelUnits:null,safeForTreatment:false};return gate.calculateFromHost(host,atIso,requireModule('RinfastEngine'));
}
function levemirModel(host,atIso=new Date().toISOString()){
 const eng=requireModule('LevemirEngine'),s=host.connect('levemir').getSnapshot();
 const measured=(s.measurements||[]).filter(m=>Number.isFinite(m.weightKg)&&Date.parse(m.measuredAt)<=Date.parse(atIso)).sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt));
 if(!measured.length)return {status:'INCOMPLETE',issues:['В настройках не указан фактически измеренный вес.'],remainingModelActionUnits:null};
 const cv=s.coverage||{};
 return eng.calculate({nowIso:atIso,patientWeightKg:measured.at(-1).weightKg,events:s.events||[],coverage:cv,horizonsMinutes:[60,180,360]});
}
function sitesAnalysis(host,now=Date.now()){
 const a=requireModule('GFInjectionAnalytics'),s=host.connect('injectionAnalytics').getSnapshot();
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
return Object.freeze({VERSION:'0.2.0',chart,rinfastModel,levemirModel,sitesAnalysis,report,reportTxt});
});
