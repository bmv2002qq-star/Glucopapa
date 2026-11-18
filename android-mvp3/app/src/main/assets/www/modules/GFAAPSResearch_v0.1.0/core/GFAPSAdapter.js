/* READ-ONLY projection of GFStorage v5 into research contract.
 * Parameters must be explicitly supplied by a caller; no medicine profile mutations.
 * Neither injection nor meal coverage can be inferred from an empty list.
 */
(function(root,f){const U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;const api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSAdapter=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function fromGFStorage(researchPort,{nowTs=Date.now(),parameters=null,historyHours=7}={}){
  U.assert(researchPort&&typeof researchPort.getSnapshot==='function','Требуется GFStorage.connect("research") — только чтение');
  const src=researchPort.getSnapshot();U.assert(src&&src.schemaVersion===5,'Поддерживается GFStorage schemaVersion=5');
  const now=U.ts(nowTs),start=now-historyHours*3600000;
  const coverage=src.coverage;
  const complete=coverage?.confirmedComplete===true&&coverage?.declaredBy==='parent'&&U.ts(coverage.startIso)<=start&&U.ts(coverage.endIso)>=now-10*U.MIN;
  const drugMap=src.drugs||{};
  const insulin=(src.events||[]).filter(x=>x.type==='insulin_injection'&&x.status==='confirmed').map(x=>{
    const drug=drugMap[x.insulinId];const type=drug?.type==='rapid'||x.insulinId==='rinfast'?'rapid':drug?.type==='basal'||x.insulinId==='levemir'?'basal':'unknown';
    return {ts:U.ts(x.administeredAt),units:x.units,type,status:'actual',sourceId:x.id};
  }).filter(x=>x.ts<=now&&x.ts>=start);
  const unfinished=(src.mealSessions||[]).some(x=>x.status==='started'&&U.ts(x.startedAt)<=now);
  const meals=(src.mealSessions||[]).filter(x=>x.status==='completed'&&x.actualPlate).map(x=>({ts:U.ts(x.startedAt),carbs:x.actualPlate.totals?.carbs,status:'actual',sourceId:x.id})).filter(x=>x.ts<=now&&x.ts>=start);
  const cgm=(src.cgm||[]).filter(x=>x.ts<=now+U.MIN&&x.ts>=start).map(x=>({ts:x.ts,mmol:x.mmol,valid:x.valid,qualityFlag:x.qualityFlag,kind:x.kind||'observed',sourceDeviceId:x.sourceDeviceId})).sort((a,b)=>a.ts-b.ts);
  return {nowTs:now,cgm,insulin,meals,parameters:parameters??{},completeness:{cgm:cgm.length>=4?'confirmed_complete':'unknown',insulin:complete?'confirmed_complete':'unknown',meals:complete&&!unfinished?'confirmed_complete':'unknown'},context:{activity:'unknown',illness:null},source:{name:'GFStorage v5 read-only projection',revision:src.revision,coverageConfirmed:complete,pumpCommands:false},warnings:unfinished?['Есть незавершённый приём пищи']:[]};
}
return {fromGFStorage};
});
