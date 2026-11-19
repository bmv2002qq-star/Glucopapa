/* MVP3. Pure read-only research access to GFStorage v5; no network, medical dosing or second store. */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GPMvp3ResearchUI=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const BLOCKED='INCOMPLETE';
function snapshot(host){if(!host||host.getSchemaVersion?.()!==5)throw Error('Требуется единый GFStorage schema5');
 const read=host.connect('research'),before=read.getRevision(),s=read.getSnapshot();
 if(read.getRevision()!==before||s.revision!==before)throw Error('GFStorage: ревизия изменилась во время чтения');return s;
}
function physio(host,now=Date.now(),mode='local'){
 const snap=snapshot(host);
 if(mode!=='demo')return {status:'VIRTUAL_PROFILE_REQUIRED',reason:'Исследовательское ядро требует виртуальный профиль. Для локального профиля персональная модель недоступна.',canDose:false,revision:snap.revision};
 const engine=root.GFPhysioProfiles,data=root.GFPhysioProfilesDataV020,
 bridge=root.GFPhysioStorageBridge,connector=root.GFPhysioResearchConnector,core=root.GlucoPapaPhysio;
 if(!engine||!data||!bridge||!connector||!core)return {status:BLOCKED,reason:'Не загружен оригинальный GFPhysio v0.1.2 или справочник v0.2.0',canDose:false,revision:snap.revision};
 let run=null;try{
 // The upstream connector reads only GFStorage.research, never writes or copies real patient coefficients.
 run=connector.connect({source:host.connect('research'),database:data,profilesEngine:engine,storageBridge:bridge,physioEngine:core,
   clock:()=>new Date(now).toISOString()});
 const result=run.refresh();
 if(!result?.virtualModel || result.virtualModel.originalInitState?.length!==13)throw Error('Не получено 13 исходных состояний виртуального пациента');
 return {status:'VIRTUAL_ONLY',revision:snap.revision,selectedId:result.matched.selectedId,matchStatus:result.matched.status,
  cohort:result.matched.cohort,stateCount:result.virtualModel.originalInitState.length,canDose:false,personalized:false,
  sourceVersion:engine.version,coreVersion:result.modelVersion,
  warning:'Оригинальный 13-компонентный GFPhysio: только виртуальный пациент; не модель реального ребёнка и не лечебная формула.'};
 }catch(e){return {status:BLOCKED,reason:String(e.message||e),canDose:false,revision:snap.revision};}
 finally{run?.dispose?.();}
}
function aaps(host,now=Date.now()){
 const s=snapshot(host),metadata=s.cgmMetadata||{};
 if(!root.GFAPSResearch||!root.GFAPSEnhancer||!root.GFConsensus)return {status:BLOCKED,reason:'Исходные исследовательские модули AAPS v0.1.0/v0.1.1 не загружены',canDose:false,revision:s.revision};
 if(metadata.sourceType!=='device_recorded'||!metadata.sourceDeviceId||!finite(metadata.qualityScore)||metadata.qualityScore<0.8)
  return {status:BLOCKED,reason:'Нет проверенного реального источника CGM: демонстрационные данные не допускаются к исследовательской кривой',canDose:false,revision:s.revision};
 if(s.coverage?.confirmedComplete!==true)return {status:BLOCKED,reason:'Не подтверждена полнота истории инъекций',canDose:false,revision:s.revision};
 try{const v=root.GFAPSEnhancer.compute({researchSnapshot:s,nowTs:now,storageSnapshot:{...s,
   forecasts:s.forecasts.filter(row=>!row.payload.modelId||row.payload.modelId==='GFForecast')}});
 return {status:'RESEARCH_ONLY',revision:s.revision,canDose:false,canWritePump:false,clinicalValidation:false,
 availableModels:v.comparison?.rows?.[0]?.count||0,reason:'Только исследовательская сверка; личная точность не доказана.'};}
 catch(e){return {status:BLOCKED,reason:'Модель отклонила входные данные: '+String(e.message||e),canDose:false,revision:s.revision};}
}
function inspect({host,now=Date.now(),mode='local'}={}){
 if(!Number.isFinite(now))throw Error('Неверное время');const s=snapshot(host);
 const p=physio(host,now,mode),a=aaps(host,now);
 if(host.connect('research').getRevision()!==s.revision)throw Error('Данные изменились в процессе анализа');
 return Object.freeze({revision:s.revision,physio:Object.freeze(p),aaps:Object.freeze(a),replay:{status:'ISOLATED_SYNTHETIC',canImportUserHistory:false},
 xdrip:{status:s.cgmMetadata?.sourceType==='xdrip_local'?'LOCAL_OBSERVATIONS':'NO_LOCAL_OBSERVATIONS'},sync:{status:'SERVER_NOT_CONNECTED'},doseAllowed:false,source:'GFStorage.research_read_only'});
}
function attach(){
 if(typeof document==='undefined')return;
 const button=document.getElementById('runAllResearch'),p=document.getElementById('researchPhysio'),a=document.getElementById('researchAaps'),r=document.getElementById('researchStatus');
 if(!button||!p||!a||!r)return;
 button.addEventListener('click',()=>{try{const x=inspect({host:root.GPApp.getStorage(),mode:root.GPApp.mode()});
 p.textContent=x.physio.status==='VIRTUAL_ONLY'?'Виртуальная модель: '+x.physio.selectedId+' · '+x.physio.matchStatus+'. Только для исследования.':'Недоступно: '+(x.physio.reason||x.physio.status);
 a.textContent=x.aaps.status==='RESEARCH_ONLY'?'Исследовательская проверка: доступно '+x.aaps.availableModels+' кривых; выводы о дозах отключены.':'Недоступно: '+(x.aaps.reason||x.aaps.status);
 r.textContent='Ревизия GFStorage #'+x.revision+' · только чтение, запись не создавалась. Утверждённые формулы не менялись.';}
 catch(e){p.textContent='Проверка остановлена: '+String(e.message||e);a.textContent='Нет результата';r.textContent='Никаких записей не создано.';}});

}
if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',attach,{once:true});else attach();}
return Object.freeze({VERSION:'0.1.0',inspect,physio,aaps});
});
