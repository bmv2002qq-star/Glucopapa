/* GlucoPapa W04b/W05a: GFGraphEvidenceBridge v0.1.0 (technical candidate).
 * Read-only GFStorage ports -> UNMODIFIED approved CGM chart + RinFast engine.
 * Unknown insulin history never turns into a zero/complete model history.
 * Source freshness/quality is explicit; real xDrip ingestion is NOT implemented here.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFGraphEvidenceBridge=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const HOUR=3600000, MINUTE=60000, LOOKBACK_HOURS=48;
const plain=(status,code,reason,extra={})=>({status,code,reason,svg:null,count:0,shotCount:0,shownShots:[],currentMmol:null,sourceStatus:'UNKNOWN',historyVerified:false,...extra});
function render({host,renderer,engine,nowMs=Date.now(),historyH=12,showInsulin=true}={}){
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return plain('BLOCKED','GFSTORAGE_UNAVAILABLE','Отсутствует GFStorage schema 5');
 if(!Number.isSafeInteger(nowMs))return plain('BLOCKED','INVALID_CLOCK','Нужен числовой timestamp');
 if(!renderer||typeof renderer.renderSvg!=='function'||!engine||typeof engine.getCurve!=='function')return plain('BLOCKED','RENDERER_UNAVAILABLE','Нет утверждённых исходников графика/РинФаста');
 if(typeof historyH!=='number'||historyH<2||historyH>24)return plain('BLOCKED','INVALID_WINDOW','Окно истории за пределами 2–24 часов');
 const policy=typeof require==='function'?require('./GFCgmEvidencePolicy_v0.1.0.js'):globalThis.GFCgmEvidencePolicy;
 const evidence=policy.inspect(host,{nowMs});
 const graphPort=host.connect('graph'),graph=graphPort.getSnapshot();
 const source=host.connect('cgmAdapter').getSnapshot(),rinfast=host.connect('rinfast').getSnapshot();
 if(evidence.revision!==graph.revision||source.revision!==graph.revision||rinfast.revision!==graph.revision||
   graphPort.getRevision()!==graph.revision)return plain('BLOCKED','REVISION_CHANGED','Данные изменились во время чтения');
 const cgm=source.cgmMetadata;
 if(evidence.status==='BLOCKED')return plain('BLOCKED',evidence.code,'CGM недоступен: '+evidence.code,{sourceStatus:evidence.sourceStatus});
 if(!cgm&&!evidence.archive)return plain('BLOCKED','CGM_SOURCE_UNKNOWN','Источник CGM не зарегистрирован в GFStorage');
 if(cgm&&!['synthetic','device_recorded','xdrip_local'].includes(cgm.sourceType))return plain('BLOCKED','SOURCE_INVALID','Неизвестный тип CGM');
 const sourceStatus=evidence.sourceStatus;
 const clean=evidence.timelineReadings??evidence.readings;
 if(clean.length<2)return plain('BLOCKED',evidence.status==='FUTURE_BLOCKED'?evidence.code:'CGM_NOT_ENOUGH','Недостаточно достоверных точек CGM данного источника',{count:clean.length,sourceStatus});
 const latest=clean.at(-1),fresh=evidence.status==='OK';
 const futureBlocked=evidence.status==='FUTURE_BLOCKED',qualityBlocked=evidence.status==='QUALITY_BLOCKED';
 const cov=rinfast.coverage;const start=Date.parse(cov?.startIso||''),end=Date.parse(cov?.endIso||'');
 const coverageConfirmed=Boolean(cov?.confirmedComplete===true&&cov.declaredBy==='parent'&&Number.isFinite(start)&&Number.isFinite(end)&&start<=nowMs-LOOKBACK_HOURS*HOUR&&end>=nowMs&&start<=end);
 const events=(rinfast.events||[]);
 const confirmed=events.filter(e=>e.type==='insulin_injection'&&e.status==='confirmed'&&e.insulinId==='rinfast'&&Number.isFinite(Date.parse(e.administeredAt))).map(e=>({id:e.id,insulinId:'rinfast',status:'confirmed',units:e.units,ts:Date.parse(e.administeredAt)}));
 const missingHistory=!coverageConfirmed;
 // If coverage is unknown, render observed CGM but NEVER pass insulin events to the renderer.
 const canRenderShots=Boolean(showInsulin&&coverageConfirmed);
 let picture;
 const inRangeShots=confirmed.filter(shot=>shot.ts<=nowMs);
 try{picture=renderer.renderSvg({readings:clean.map(p=>({ts:p.ts,mmol:p.mmol})),shots:canRenderShots?inRangeShots:[],engine,now:nowMs,historyH,futureH:6,offsetH:0,showInsulin:canRenderShots,showTotal:false,layout:'guided'});}
 catch(e){return plain('BLOCKED','RENDER_FAILED','График отклонил противоречивую историю',{sourceStatus,reasonDetail:String(e.message||e)});}
 const status=evidence.status;
 const notice=[sourceStatus==='SYNTHETIC'?'CGM: СИНТЕТИЧЕСКИЕ ТЕСТОВЫЕ ДАННЫЕ':sourceStatus==='XDRIP_LOCAL'?'CGM: локальный источник xDrip+ · наблюдения':sourceStatus==='REAL_CGM_IMPORT'?'Архив xDrip+':'CGM: источник заявлен как устройство',
 futureBlocked?'Время измерения или получения CGM находится в будущем':qualityBlocked?'Последнее CGM отклонено по качеству: текущий сахар не показывать':fresh?'Текущее значение допускается только с отметкой источника':status==='OBSERVED_ONLY'?'Качество для прогноза не подтверждено':'CGM устарел: актуальное значение не определено',
 missingHistory?'История инъекций не подтверждена полной: кривые РинФаста скрыты':!showInsulin?'Кривые РинФаста отключены':'История уколов подтверждена пользователем, кривые схематические'].join(' · ');
 return {status,code:evidence.code,reason:notice,svg:picture.svg,count:picture.readings,shotCount:picture.shownShots.length,shownShots:picture.shownShots,
 sourceRevision:graph.revision,window:picture.view,sensorSourceId:cgm?.sourceDeviceId??null,
 currentMmol:(fresh&&!qualityBlocked&&!futureBlocked)?latest.mmol:null,latestAt:new Date(latest.ts).toISOString(),sourceStatus,historyVerified:coverageConfirmed,
 insulinCurvesShown:canRenderShots,coverageSource:coverageConfirmed?'PARENT_DECLARED':'UNKNOWN',safetyNote:'Не использовать визуальные кривые как измерение остатка инсулина или основание для дозировки'};
}
return Object.freeze({VERSION:'0.1.0-candidate',render});
});
