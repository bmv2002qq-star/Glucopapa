/* ГлюкоПапа W06a · проверка доступности фактов для утверждённых LOW/HIGH.
 * Только чтение из GFStorage schema v5. Утверждённые HTML v5 и формулы неизменны.
 * UNKNOWN !== 0; любая вычисленная величина здесь — модельная диагностика,
 * а не доза, не разрешение на лечение, не доказательство полноты журнала.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFHighLowInputGate=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.0-candidate';
const NONE=Object.freeze({status:'UNKNOWN',value:null,code:'NOT_COMPUTED'});
function frozen(x){if(!x||typeof x!=='object')return x;Object.freeze(x);Object.values(x).forEach(y=>{if(y&&typeof y==='object'&&!Object.isFrozen(y))frozen(y);});return x;}
function blocked(code,revision=null){return frozen({version:VERSION,status:'BLOCKED',code,sourceRevision:revision,glucose:{...NONE},iob:{...NONE},cob:{status:'UNKNOWN',value:null,code:'COB_MODEL_NOT_CONNECTED'},food:{status:'UNKNOWN',recentCompleted:0,hasUnverified:false},activity:{level:null,sportActive:false,illnessActive:false},coefficients:{status:'UNAVAILABLE'},allowDose:false,allowRecommendation:false,approvedScreenModified:false});}
function activePeriod(p,now){const a=Date.parse(p.start),b=p.end===null?Infinity:Date.parse(p.end);return Number.isFinite(a)&&a<=now&&b>=now;}
function evaluate({host,nowMs=Date.now(),cgmPolicy,insulinGate,rinfastEngine,cobResearch=null,foodHistoryDeclaration=null,kineticsByMealId=null}={}){
 if(!Number.isSafeInteger(nowMs))return blocked('INVALID_CLOCK');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return blocked('GFSTORAGE_SCHEMA');
 if(!cgmPolicy?.inspect||!insulinGate?.calculateFromHost)return blocked('DEPENDENCY_MISSING');
 try{
  const research=host.connect('research'),journal=host.connect('journal'),settings=host.connect('settings');
  const r0=research.getRevision(),a=research.getSnapshot(),b=journal.getSnapshot(),c=settings.getSnapshot(),r1=research.getRevision();
  if(r0!==r1||r0!==a.revision||r0!==b.revision||r0!==c.revision)return blocked('REVISION_CHANGED',r1);
  const g=cgmPolicy.inspect(host,{nowMs});
  if(g.revision!==null&&g.revision!==r0)return blocked('REVISION_CHANGED',r0);
  const io=insulinGate.calculateFromHost(host,new Date(nowMs).toISOString(),rinfastEngine);
  if(host.connect('journal').getRevision()!==r0)return blocked('REVISION_CHANGED',r0);
  const glucose={status:g.status,code:g.code,value:g.status==='OK'?g.currentMmol:null,measuredAt:g.latestAt||null,source:g.sourceStatus||'UNKNOWN'};
  const iob=io.status==='MODEL_ESTIMATE'&&Number.isFinite(io.totalModelUnits)?{status:'MODEL_ESTIMATE',code:'PARENT_DECLARED_HISTORY',value:io.totalModelUnits,method:io.method}:{status:'UNKNOWN',code:io.code||'IOB_UNAVAILABLE',value:null};
  const cutoff=nowMs-6*3600000;
  const meals=(b.mealSessions||[]).filter(s=>{
   const t=Date.parse(s.startedAt||s.completedAt||'');return Number.isFinite(t)&&t>=cutoff&&t<=nowMs;
  });
  const recentCompleted=meals.filter(m=>m.status==='completed'&&m.actualPlate&&Number.isFinite(m.actualPlate?.totals?.carbs));
  const hasUnverified=meals.some(m=>m.status!=='completed'||!m.actualPlate||!Number.isFinite(m.actualPlate?.totals?.carbs)||m.actualPlate.containsEstimatedValues===true);
  const food={status:hasUnverified?'PARTIAL':'HISTORY_UNCONFIRMED',recentCompleted:recentCompleted.length,hasUnverified,carbsRecordedG:recentCompleted.reduce((n,m)=>n+m.actualPlate.totals.carbs,0)};
  const conditions=b.conditionPeriods||[];
  const isActive=kind=>conditions.some(p=>p.kind===kind&&activePeriod(p,nowMs));
  const activity={level:c.profile?.activityBaseLevel||null,sportActive:isActive('sport'),illnessActive:isActive('illness')};
  const coefficientModes=c.profile?.coefficientModes||null;
  const coefficients={status:coefficientModes?'STORED_NOT_APPLIED':'UNAVAILABLE',modes:coefficientModes};
  const cobReport=cobResearch?.inspect?cobResearch.inspect({host,nowMs,historyDeclaration:foodHistoryDeclaration,kineticsByMealId}):null;
  if(host.connect('research').getRevision()!==r0||cobReport?.code==='REVISION_CHANGED')return blocked('REVISION_CHANGED',r0);
  const cob=cobReport?.status==='RESEARCH_INTERVAL'?{status:'RESEARCH_INTERVAL',code:cobReport.code,value:null,lowerG:cobReport.lowerG,upperG:cobReport.upperG,coverageStatus:cobReport.coverageStatus,therapeutic:false}:{status:'UNKNOWN',value:null,code:cobReport?.code||'COB_MODEL_NOT_CONNECTED'};
  const result={version:VERSION,status:'INCOMPLETE',code:'THERAPEUTIC_INPUT_NOT_READY',sourceRevision:r0,
    glucose,iob,
    cob,
    food,activity,coefficients,
    coverage:{injectionHistoryParentDeclared:iob.status==='MODEL_ESTIMATE',foodHistoryVerified:false},
    allowDose:false,allowRecommendation:false,approvedScreenModified:false};
  return frozen(result);
 }catch(error){return blocked('READ_FAILED_'+String(error?.code||error?.message||'UNKNOWN').replace(/[^A-Z0-9_]/gi,'_').slice(0,72));}
}
function lineStatus(k){const descriptions={OK:'CGM есть (техническая проверка)',MODEL_ESTIMATE:'модельный остаток (не доза)',UNKNOWN:'нет проверенного значения',PARTIAL:'есть неполные факты',HISTORY_UNCONFIRMED:'полнота истории еды не подтверждена',BLOCKED:'нет доступа к данным'};return descriptions[k]||k;}
function renderPanel(node,result){
 if(!node||!result)throw Error('RENDER_INPUT_MISSING');
 const p=result;
 const lines=[
  'Проверка данных · GFStorage ревизия '+(p.sourceRevision??'—'),
  'CGM: '+lineStatus(p.glucose.status)+(p.glucose.value===null?'':' · '+p.glucose.value.toFixed(1)+' ммоль/л'),
  'РинФаст (IOB): '+lineStatus(p.iob.status)+(p.iob.value===null?'':' · '+p.iob.value.toFixed(2)+' ЕД, модель'),
  'Углеводы в организме (COB): '+(p.cob.status==='RESEARCH_INTERVAL'?'исследовательский сценарий '+p.cob.lowerG.toFixed(1)+'–'+p.cob.upperG.toFixed(1)+' г (НЕ для лечения)': 'не рассчитаны · '+p.cob.code),
  'История еды: '+lineStatus(p.food.status)+'; подтверждённых приёмов за 6 ч: '+p.food.recentCompleted,
  'Контекст: активность '+(p.activity.level||'не задана')+(p.activity.sportActive?' · спорт':'')+(p.activity.illnessActive?' · болезнь':''),
  'Неподтверждённые входы нельзя заменять нулями. Эта панель не даёт доз и не изменяет утверждённый экран.'
 ];
 node.textContent=lines.join('\n');return node.textContent;
}
return Object.freeze({VERSION,evaluate,renderPanel});
});