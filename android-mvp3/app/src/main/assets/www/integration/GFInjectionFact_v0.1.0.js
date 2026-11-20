/* Explicit injection recording. Optional meal link and retrospective evidence in one actionWriter transaction. */
(function (root) {
  'use strict';
  const ts=Date.parse;
  const contract='glucopapa.preinjection-iob/1';
  const allowedStates=['draft','planned','started','completed'];

  function modelEvidence({host,atIso,revision,settings}) {
    const result=root.GFInsulinEvidenceGate.calculateFromHost(host,atIso,root.RinfastEngine);
    if(result.status!=='MODEL_ESTIMATE'||result.totalModelUnits<0||result.totalModelUnits>100)return null;
    const at=ts(atIso);
    const inPeriod=period=>ts(period.start)<=at&&(period.end===null||at<ts(period.end));
    const explicit=settings.conditionPeriods.find(period=>period.kind==='activity'&&inPeriod(period));
    const laterActivity=settings.history.some(row=>ts(row.at)>at&&row.domain==='profile'&&row.changes?.activityBaseLevel);
    const base=laterActivity?null:settings.profile.activityBaseLevel;
    const level=explicit?.level??base;
    const activity=['low','usual','high'].includes(level)?level:null;
    const timeZone=settings.profile.timeZone;
    const effective=timeZone?root.GFSettings.coefficientTimeline(settings.coefficients,atIso,timeZone)
      .filter(row=>row.isEffectiveAt):[];
    const setting=effective.length?JSON.stringify([timeZone,...effective.map(row=>row.id).sort()]):null;
    return {contract,atIso,sourceRevision:revision,modelVersion:root.RinfastEngine.ENGINE_VERSION,
      modelUnits:result.totalModelUnits,priorInjectionIds:result.parts.map(part=>part.id),
      coverageStart:result.coverageStartIso,coverageEnd:result.coverageEndIso,
      activity,settingKey:setting?.length<=512?setting:null,clinicalUse:false};
  }

  function record({host,item,mealId=null,confirmed,revision}) {
    if(confirmed!==true)throw Error('INJECTION_CONFIRMATION_REQUIRED');
    const writer=host.connect('actionWriter');
    const existing=writer.read('events').find(row=>row.id===item.id);
    if(existing&&mealId){
      const same=existing.status==='confirmed'&&existing.linkedMealSessionId===mealId&&
        existing.insulinId===item.insulinId&&existing.units===item.units&&
        existing.administeredAt===item.administeredAt&&
        JSON.stringify(existing.injectionSite??null)===JSON.stringify(item.injectionSite??null);
      if(same)return {revision:writer.getRevision(),idempotent:true};
      throw Error('INJECTION_ID_CONFLICT');
    }
    if(writer.getRevision()!==revision)throw Error('REVISION_CHANGED');
    if(!mealId)return writer.recordInjection(item,revision);
    if(item.insulinId!=='rinfast')throw Error('MEAL_LINK_RAPID_ONLY');
    const meal=writer.read('mealSessions').find(row=>row.id===mealId);
    if(!meal||!allowedStates.includes(meal.status))throw Error('MEAL_LINK_UNAVAILABLE');
    if(meal.startedAt&&ts(item.administeredAt)>ts(meal.startedAt))throw Error('MEAL_LINK_AFTER_START');
    const settings=host.connect('settings').getSnapshot();
    if(settings.revision!==revision)throw Error('REVISION_CHANGED');
    const iobEvidence=modelEvidence({host,atIso:item.administeredAt,revision,settings});
    return writer.recordSessionInjection({
      sessionId:meal.id,expectedVersion:meal.version,opId:'confirm:'+item.id,injectionId:item.id,
      insulinId:item.insulinId,units:item.units,administeredAt:item.administeredAt,
      ...(item.injectionSite?{injectionSite:item.injectionSite}:{}),
      ...(iobEvidence?{iobEvidence}:{}),
    },revision);
  }

  const api=Object.freeze({record,allowedStates:Object.freeze(allowedStates)});
  root.GFInjectionFact=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
