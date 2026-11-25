/* ГлюкоПапа: approved GFSafety v0.1.0 <-> GFStorage v0.4.0.
 * This module is an isolated read-only projection. It never modifies either approved module.
 * No dosing, clinical clearance, remote authorizations, or separate persistent store.
 */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GFSafetyStorageBridge=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='0.1.1';
  const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&/(?:Z|[+-]\d\d:\d\d)$/.test(s);
  const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const fail=(code,details)=>Object.freeze({status:'BLOCKED',bridge:'GFSafetyStorageBridge',version:VERSION,safetyReport:null,code,details:String(details||''),forecastInputEligible:false,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false});
  const copy=x=>JSON.parse(JSON.stringify(x));
  function readCurrent(host){
    if(!host||typeof host.connect!=='function')throw new Error('Требуется GFStorage host');
    const research=host.connect('research');const injectionAnalytics=host.connect('injectionAnalytics');
    // Two public snapshots must belong to the same immutable revision.
    const before=research.getRevision();
    const a=research.getSnapshot(),b=injectionAnalytics.getSnapshot();
    const after=research.getRevision();
    if(before!==a.revision||a.revision!==b.revision||b.revision!==after||injectionAnalytics.getRevision()!==after)
      throw new Error('REVISION_CHANGED');
    if(![4,5].includes(a.schemaVersion)||a.schemaVersion!==b.schemaVersion)throw new Error('UNSUPPORTED_STORAGE_SCHEMA');
    return {research:a,analytics:b,revision:before};
  }
  function normalize(s,nowIso,candidateInjection){
    const a=s.research,b=s.analytics;
    if(!iso(nowIso))throw new Error('INVALID_NOW_ISO');
    if(!b.cgmMetadata||!b.cgmMetadata.sourceDeviceId||!['device_recorded','synthetic'].includes(b.cgmMetadata.sourceType))
      throw new Error('CGM_SOURCE_METADATA_MISSING');
    const activeId=b.cgmMetadata.sourceDeviceId;
    if(!Array.isArray(a.cgm)||!Array.isArray(a.events)||!Array.isArray(a.mealSessions)||!Array.isArray(b.conditionPeriods))
      throw new Error('INCOMPLETE_STORAGE_SNAPSHOT');
    // Reject anonymous/synthetic sensor IDs instead of inventing physical provenance.
    if(b.cgmMetadata.qualityScore<0.8)throw new Error('CGM_QUALITY_TOO_LOW');
    // Safety evaluates a bounded recent window; old CGM remain in the archive.
    // Do not synthesize missing/foreign readings or receipt times.
    const cutoff=Date.parse(nowIso)-72*3600000;
    const readings=a.cgm.filter(r=>r.ts>=cutoff&&r.ts<=Date.parse(nowIso)+60000).map(r=>{
      if(!Number.isSafeInteger(r.ts)||!Number.isFinite(r.mmol))throw new Error('INVALID_CGM_RECORD');
      if(!r.sourceDeviceId)throw new Error('LEGACY_CGM_SENSOR_UNKNOWN');
      return {measuredAt:new Date(r.ts).toISOString(),
        glucoseMmol:r.mmol,sourceId:r.sourceDeviceId,sensorId:r.sourceDeviceId,
        ...(r.receivedAt===undefined?{}:{receivedAt:r.receivedAt}),
        ...(r.valid===undefined?{}:{valid:r.valid}),
        ...(r.qualityFlag===undefined?{}:{qualityFlag:r.qualityFlag})};
    });
    if(readings.length>20000)throw new Error('SAFETY_CAPACITY_EXCEEDED');
    if(!readings.some(r=>r.sensorId===activeId))throw new Error('CURRENT_SENSOR_NO_MEASUREMENTS');
    const c=a.coverage;
    // Confirmed coverage is explicitly asserted by parent; never inferred from data.
    const coverage=c&&obj(c)?{
      confirmedComplete:c.confirmedComplete===true,
      declaredBy:c.declaredBy,provenance:'gfstorage',startIso:c.startIso,endIso:c.endIso
    }:{confirmedComplete:false,declaredBy:null,provenance:'gfstorage'};
    const injections=[];
    const meals=[];
    for(const e of a.events){
      if(e.type==='insulin_injection'){
        injections.push({id:e.id,insulinId:e.insulinId,status:e.status,units:e.units,
          administeredAt:e.administeredAt,...(e.doseErrorSuspected===undefined?{}:{doseErrorSuspected:e.doseErrorSuspected})});
      } else if(e.type==='meal'){
        // Legacy meal items describe weights, not consumed carbohydrate content.
        // Cannot convert this to a confirmed GFSafety meal without provenance.
        if(!e.sessionId||!a.mealSessions.some(x=>x.id===e.sessionId))
          throw new Error('LEGACY_MEAL_UNVERIFIED');
      }
    }
    for(const session of a.mealSessions){
      if(!session.startedAt&&session.status!=='completed')continue; // future plan, not a consumed meal
      if(!session.actualPlate||!session.actualPlate.totals||!Number.isFinite(session.actualPlate.totals.carbs))
        throw new Error('MEAL_ACTUAL_UNVERIFIED');
      if(!iso(session.startedAt))throw new Error('MEAL_START_UNKNOWN');
      meals.push({id:session.id,status:session.status==='completed'?'confirmed':'unconfirmed',
        carbsG:session.actualPlate.totals.carbs,eatenAt:session.startedAt});
    }
    const active=kind=>b.conditionPeriods.some(p=>p.kind===kind&&iso(p.start)&&Date.parse(p.start)<=Date.parse(nowIso)&&(p.end===null||iso(p.end)&&Date.parse(p.end)>=Date.parse(nowIso)));
    const result={sourceSchema:'GFStorage/'+a.schemaVersion,nowIso,readings,injections,meals,coverage,
      conditions:{illness:active('illness'),activity:active('activity')},
      sourceStatus:{type:b.cgmMetadata.sourceType==='synthetic'?'synthetic':'device_recorded'}};
    if(candidateInjection!==undefined)result.candidateInjection=copy(candidateInjection);
    return result;
  }
  function connect(host,approvedSafety){
    if(!approvedSafety||approvedSafety.VERSION!=='0.1.0'||typeof approvedSafety.evaluate!=='function')
      throw new Error('Нужен утверждённый GFSafety v0.1.0');
    return Object.freeze({
      VERSION,
      check({nowIso=new Date().toISOString(),candidateInjection}={}){
        try{
          const s=readCurrent(host);
          const input=normalize(s,nowIso,candidateInjection);
          const report=approvedSafety.evaluate(input);
          if(!report||report.clinicalUseAllowed!==false||report.insulinDoseDecisionAllowed!==false)
            return fail('INVALID_SAFETY_REPORT','Некорректные поля ограничений GFSafety');
          // Explicitly return observational diagnostics; never turn status into permission.
          return Object.freeze({bridge:'GFSafetyStorageBridge',version:VERSION,status:report.status,
            sourceRevision:s.revision,sourceSchema:s.research.schemaVersion,safetyReport:report,
            forecastInputEligible:report.forecastInputEligible===true,
            clinicalUseAllowed:false,insulinDoseDecisionAllowed:false});
        }catch(e){
          return fail(String(e&&e.message||'READ_FAILED'),'Адаптер заблокировал некорректный/неполный снимок');
        }
      }
    });
  }
  return Object.freeze({VERSION,connect});
});
