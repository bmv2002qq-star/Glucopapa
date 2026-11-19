/* GFHighTarget GFStorage v5 adapter v0.1.0. Reads ONE revision, no second database.
 * Role-based access; no direct reads of sibling module internals.
 * Actual injection logging remains an explicit user-confirmed action.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFHighTargetStorage=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';const VERSION='0.1.0';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const iso=v=>typeof v==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
const err=(code,detail,revision=null)=>({status:'BLOCKED',code,detail,sourceRevision:revision,candidate:null,clinicalUse:false});
function clockParts(nowMs,tz){if(typeof tz!=='string'||!tz)return null;try{const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const parts=fmt.formatToParts(new Date(nowMs));return +parts.find(p=>p.type==='hour').value*60+(+parts.find(p=>p.type==='minute').value);}catch{return null;}}
function coefficient(rows,kind,minute,now){
 if(!finite(minute))return null;
 const all=(rows||[]).filter(x=>x.kind===kind&&finite(x.value)&&iso(x.effectiveFrom)<=now&&(x.effectiveUntil==null||iso(x.effectiveUntil)>now));
 const active=all.filter(x=>{const w=x.windowLocal;if(!w)return kind==='target_range_mmol';const a=+w.from.slice(0,2)*60+(+w.from.slice(3)),b=+w.to.slice(0,2)*60+(+w.to.slice(3));return a<b?minute>=a&&minute<b:minute>=a||minute<b;});
 active.sort((a,b)=>iso(b.effectiveFrom)-iso(a.effectiveFrom));
 if(!active.length)return null;
 if(active.length>1&&iso(active[0].effectiveFrom)===iso(active[1].effectiveFrom))return null;
 return active[0].value;
}
function chooseTarget(coeffs,now){const active=(coeffs||[]).filter(x=>x.kind==='target_range_mmol'&&x.value&&finite(x.value.low)&&finite(x.value.high)&&iso(x.effectiveFrom)<=now&&(x.effectiveUntil==null||iso(x.effectiveUntil)>now)).sort((a,b)=>iso(b.effectiveFrom)-iso(a.effectiveFrom));return active[0]?.value||null;}
function activePeriod(rows,kind,now){return (rows||[]).some(x=>x.kind===kind&&iso(x.start)<=now&&(x.end===null||iso(x.end)>=now));}
function inspect({host,nowMs=Date.now(),core=root.GFHighTarget,rinfastEngine=root.RinfastEngine,autoProfile=root.GFAutoCOBProfile,foodHistoryDeclaration=null,modifiers=null}={}){
 if(!Number.isSafeInteger(nowMs))return err('CLOCK_INVALID','Неверные локальные часы');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return err('GFSTORAGE_SCHEMA','Требуется GFStorage schema v5');
 if(!core?.analyse)return err('TARGET_ENGINE_MISSING','Не загружено ядро HIGH');
 try{
  const a=host.connect('research'),b=host.connect('settings'),c=host.connect('cgmAdapter'),rev=a.getRevision();
  const s=a.getSnapshot(),set=b.getSnapshot(),sensor=c.getSnapshot();
  if(rev!==s.revision||rev!==set.revision||rev!==sensor.revision||rev!==a.getRevision())return err('REVISION_CHANGED','Данные изменились при чтении',rev);
  const zone=set.profile?.timeZone||null, minute=clockParts(nowMs,zone),targetRange=chooseTarget(set.coefficients,nowMs);
  const isf=coefficient(set.coefficients,'isf_mmol_per_u',minute,nowMs),uk=coefficient(set.coefficients,'carb_g_per_u',minute,nowMs);
  if(!targetRange||!finite(isf)||!finite(uk))return err('SETTINGS_INCOMPLETE','Не найден датированный ФЧИ, УК или целевой диапазон в сетке 4×6 часов',rev);
  const cgmRows=(s.cgm||[]).filter(x=>Number.isSafeInteger(x.ts)&&x.ts>=nowMs-35*60000&&x.ts<=nowMs);
  const sourceId=sensor.cgmMetadata?.sourceDeviceId||null;
  if(!sourceId)return err('CGM_SOURCE_MISSING','Не зарегистрирован источник CGM',rev);
  const readings=cgmRows.map(x=>({...x,sourceDeviceId:x.sourceDeviceId||sourceId}));
  const foodModel=set.profile?.foodAbsorptionModel||'GFForecast'; // pending GFSettings schema migration, explicit default
  if(!['GFForecast','GFCOB'].includes(foodModel))return err('FOOD_MODEL_INVALID','Неподдерживаемый выбор модели еды',rev);
  // Normalized meals from confirmed actual plates; no plannedPlate substitution.
  const sessions=s.mealSessions||[], meals=[];
  for(const meal of sessions){
   const when=iso(meal.startedAt||'');if(finite(when)&&when>=nowMs-12*3600000&&when<=nowMs){
    const p=autoProfile?.profilePlate?.(meal.actualPlate);
    const kinetics=p?.status==='RESEARCH_PROFILE'?p.kinetics:null;
    meals.push({id:meal.id,status:meal.status,startedAt:meal.startedAt,actualPlate:meal.actualPlate,kinetics});
   }
  }
  const confirmedFood=!!foodHistoryDeclaration&&foodHistoryDeclaration.confirmedComplete===true&&foodHistoryDeclaration.source==='user_declared'&&iso(foodHistoryDeclaration.startIso)<=nowMs-12*3600000&&iso(foodHistoryDeclaration.endIso)>=nowMs;
  const coveredInsulin=!!s.coverage&&s.coverage.confirmedComplete===true&&s.coverage.declaredBy==='parent'&&iso(s.coverage.startIso)<=nowMs-48*3600000&&iso(s.coverage.endIso)>=nowMs;
  const activity=activePeriod(s.conditionPeriods,'sport',nowMs)?'sport':set.profile?.activityBaseLevel||'low';
  const illness=activePeriod(s.conditionPeriods,'illness',nowMs);
  const input={origin:'live',nowIso:new Date(nowMs).toISOString(),revision:rev,rinfastEngine,readings,meals,injections:s.events||[],
   settings:{target:(targetRange.low+targetRange.high)/2,isf,uk,foodModel},coverage:{injectionsConfirmed:coveredInsulin,mealsConfirmed:confirmedFood},
   context:{activity,illness,physioApplied:!!modifiers?.physio},modifiers};
  const result=core.analyse(input);
  if(rev!==a.getRevision())return err('REVISION_CHANGED','Во время анализа изменился GFStorage',rev);
  return {...result,integration:{adapterVersion:VERSION,sourceRevision:rev,usesSingleGFStorage:true,modelDefaultNotPersisted:!set.profile?.foodAbsorptionModel,foodCoverageDeclared:confirmedFood,insulinCoverageDeclared:coveredInsulin,sourceDeviceId:sourceId,coefficientTimeZone:zone}};
 }catch(e){return err('STORAGE_READ_FAILED',String(e?.message||'READ_ERROR').slice(0,180));}
}
function recordActualInjection({host,record,confirmedAlreadyInjected=false,nowMs=Date.now()}={}){
 if(confirmedAlreadyInjected!==true)return err('NO_FACT_CONFIRMATION','Запись возможна только для фактически выполненного укола');
 if(!host||host.getSchemaVersion?.()!==5||typeof host.connect!=='function')return err('GFSTORAGE_SCHEMA','Недоступно общее хранилище');
 if(!record||typeof record.id!=='string'||!/^[-\w:.]{1,100}$/.test(record.id)||record.insulinId!=='rinfast'||!finite(record.units)||record.units<=0||Math.abs(record.units*2-Math.round(record.units*2))>1e-9||!finite(iso(record.administeredAt))||iso(record.administeredAt)>nowMs+60000)return err('FACT_INVALID','Проверьте фактический РинФаст, время, ID и шаг 0,5 ЕД');
 try{
  const writer=host.connect('actionWriter');const revision=writer.getRevision();
  const fact={id:record.id,insulinId:'rinfast',units:record.units,administeredAt:record.administeredAt};
  if(record.injectionSite)fact.injectionSite=record.injectionSite;
  const receipt=writer.recordInjection(fact,revision);
  return {status:writer.getRevision()===revision?'ALREADY_RECORDED':'RECORDED',source:'GFStorage.actionWriter',revision:writer.getRevision(),receipt,clinicalUse:false};
 }catch(e){return err('STORAGE_WRITE_REJECTED',String(e?.message||'WRITE_ERROR').slice(0,180));}
}
return Object.freeze({VERSION,inspect,recordActualInjection,clockParts,coefficient});
});
