/* Read-only retrospective projection for GFInjectionAnalytics v0.2.1. */
(function (root) {
  'use strict';
  const at=Date.parse;
  const noData=(code,revision=null)=>({status:'NO_DATA',code,sourceRevision:revision,
    descriptiveLagMinutes:null,rangeMinutes:null,clinicalUse:false,automaticInjectionTiming:false});
  const complete=(s,asOf)=>s.status==='completed'&&s.actualPlate&&
    Number.isFinite(at(s.startedAt))&&at(s.completedAt)>=at(s.startedAt)&&at(s.completedAt)<=asOf;

  function list(host,nowMs=Date.now()) {
    const port=host.connect('research'), state=port.getSnapshot();
    const sessions=state.mealSessions.filter(s=>complete(s,nowMs)).sort((a,b)=>at(b.startedAt)-at(a.startedAt));
    return port.getRevision()===state.revision?sessions.map(s=>({id:s.id,startedAt:s.startedAt})):[];
  }

  function contextOf(event){
    if(event.injectionContext)return event.injectionContext;
    const evidence=event.iobEvidence;
    if(evidence?.contract!=='glucopapa.preinjection-iob/1'||evidence.clinicalUse!==false||evidence.atIso!==event.administeredAt)
      return null;
    return {iobU:evidence.modelUnits,activity:evidence.activity,settingRevision:evidence.settingKey,mealGroup:'with_meal'};
  }

  function inspect({host,sessionId,nowMs=Date.now(),mode='local'}={}) {
    if(host?.getSchemaVersion?.()!==5)return noData('GFSTORAGE_SCHEMA');
    if(mode!=='local')return noData('SYNTHETIC_HISTORY_EXCLUDED');
    const port=host.connect('research'), analytics=host.connect('injectionAnalytics');
    const state=port.getSnapshot(), sensor=analytics.getSnapshot(), revision=state.revision;
    const sameRevision=()=>port.getRevision()===revision&&analytics.getRevision()===revision;
    if(sensor.revision!==revision||!sameRevision())return noData('REVISION_CHANGED');
    const target=state.mealSessions.find(s=>s.id===sessionId);
    if(!target||!complete(target,nowMs))return noData('MEAL_NOT_CONFIRMED',revision);
    const cutoff=at(target.startedAt);
    const actualShots=sensor.events.filter(e=>e.type==='insulin_injection'&&e.status==='confirmed'&&e.insulinId==='rinfast');
    const linked=actualShots.filter(e=>target.injectionIds.includes(e.id));
    if(linked.length!==1||
       !Number.isFinite(at(linked[0].administeredAt))||at(linked[0].administeredAt)>cutoff)
      return noData('CONFIRMED_MEAL_INJECTION_REQUIRED',revision);
    const shot=linked[0], context=contextOf(shot);
    if(!Number.isFinite(context?.iobU)||context.iobU<0)return noData('HISTORICAL_IOB_UNKNOWN',revision);
    if(context.mealGroup!=='with_meal')return noData('CONFIRMED_MEAL_INJECTION_REQUIRED',revision);

    const sportAt=t=>sensor.conditionPeriods.some(p=>p.kind==='sport'&&at(p.start)<=t&&t<at(p.end)&&at(p.end)<=nowMs);
    const projectedContext={
      activity:sportAt(at(shot.administeredAt))?'sport':context.activity,
      iobU:context.iobU,settingRevision:context.settingRevision,
      site:shot.injectionSite?.region,sourceRevision:revision
    };
    const earlier=state.mealSessions.filter(s=>s.id!==target.id&&complete(s,cutoff)&&at(s.lastChangedAt)<=cutoff);
    const idsInAnyMeal=new Set(state.mealSessions.flatMap(s=>s.injectionIds));
    const priorEvents=actualShots.filter(e=>at(e.administeredAt)<cutoff).map(e=>{
      const c=contextOf(e);
      if(!c)return e;
      // Linked but ineligible events still exclude contaminated glucose windows.
      // Preserve those events, without allowing them to become a correction example by projection.
      return {type:e.type,status:e.status,insulinId:e.insulinId,id:e.id,units:e.units,administeredAt:e.administeredAt,
        injectionSite:e.injectionSite,injectionContext:{activity:c.activity,iobU:c.iobU,settingRevision:c.settingRevision,
          carbsG:c.carbsG,mealGroup:c.mealGroup==='with_meal'||idsInAnyMeal.has(e.id)?'with_meal':c.mealGroup}};
    });
    const projected={revision,profile:{timeZone:state.profile.timeZone},events:priorEvents,
      mealSessions:[...earlier,{...target,injectionIds:[]}],cgm:sensor.cgm,cgmMetadata:sensor.cgmMetadata,
      conditionPeriods:sensor.conditionPeriods.filter(p=>p.kind==='sport'&&at(p.end)<=cutoff)};
    const result=root.GFInjectionAnalyticsV2.analyzeSnapshot(projected,{sessionId,atIso:target.startedAt,context:projectedContext});
    return sameRevision()?{...result,sourceRevision:revision,asOf:target.startedAt,scope:'retrospective'}:
      noData('REVISION_CHANGED');
  }

  const api=Object.freeze({list,inspect});
  root.GFInjectionTimingStorage=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
