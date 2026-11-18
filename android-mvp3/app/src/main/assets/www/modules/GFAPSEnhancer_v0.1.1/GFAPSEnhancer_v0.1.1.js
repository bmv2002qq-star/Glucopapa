/* GFAPSEnhancer v0.1.1: read-only GFStorage bridge and third AAPS-inspired prediction. */
(function(root,f){const isNode=typeof module==='object'&&module.exports;const C=isNode?require('./GFConsensus'):root.GFConsensus;
 const A=isNode?require('./aaps/GFAPSResearch'):root.GFAPSResearch;const api=f(C,A);
 if(isNode)module.exports=api;root.GFAPSEnhancer=api;})(typeof globalThis!=='undefined'?globalThis:this,function(C,A){
'use strict';const M=60000;
const isFiniteNumber=x=>typeof x==='number'&&Number.isFinite(x);
const iso=t=>new Date(t).toISOString();
function resolveParameters(storageSnapshot,nowTs){
 const date=iso(nowTs),coef=storageSnapshot.coefficients||[];
 function current(kind){
  // This bridge does not choose among overlapping day-part profiles; ambiguity blocks calculation.
  const matches=coef.filter(c=>c.kind===kind&&c.windowLocal===undefined&&Date.parse(c.effectiveFrom)<=nowTs&&(!c.effectiveUntil||Date.parse(c.effectiveUntil)>nowTs))
    .sort((a,b)=>Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom));
  if(matches.length!==1||!isFiniteNumber(matches[0]?.value))return null;
  return matches[0].value;
 }
 const model=storageSnapshot.models?.rinfast?.profile;
 return {isfMmolPerU:current('isf_mmol_per_u'),crGPerU:current('carb_g_per_u'),
   diaMinutes:model?.diaMinutes??null,peakMinutes:model?.peakMinutes??null,
   provenance:date};
}
function latestGF(storage,nowTs,sourceTime){
 const forecasts=(storage.forecasts||[]).filter(x=>x.kind==='research_forecast'&&x.payload?.mode==='RESEARCH_FORECAST');
 const valid=forecasts.filter(x=>Math.abs(Date.parse(x.payload.forecastAt)-nowTs)<=M*10 && x.payload.snapshot?.sensorSourceId&&
   (sourceTime===null||Math.abs((typeof x.payload.sourceTime==='number'?x.payload.sourceTime:Date.parse(x.payload.sourceTime))-sourceTime)<=M));
 valid.sort((a,b)=>Date.parse(b.payload.forecastAt)-Date.parse(a.payload.forecastAt));
 return valid[0]?.payload||null;
}
function compute({researchSnapshot,storageSnapshot=null,otherForecasts={},nowTs=Date.now(),parameters=null}={}){
 if(!researchSnapshot||researchSnapshot.schemaVersion!==5)throw Error('Нужен GFStorage research snapshot v5');
 if(!Number.isSafeInteger(nowTs))throw Error('Некорректное время');
 const adapter=A.adapter;
 const readOnlyPort={getSnapshot:()=>researchSnapshot};
 const p=parameters||resolveParameters(researchSnapshot,nowTs);
 const input=adapter.fromGFStorage(readOnlyPort,{nowTs,parameters:{isfMmolPerU:p.isfMmolPerU,crGPerU:p.crGPerU,
  diaMinutes:p.diaMinutes,peakMinutes:p.peakMinutes},historyHours:7});
 // Observed CGM may be missing quality marks: inherit guard warnings. Never invent markers.
 const result=A.forecast.predict(input,{horizonMinutes:120,stepMinutes:5});
 const actualLast=input.cgm.at(-1)?.ts??null;
 const realGFForecast=otherForecasts.GFForecast||latestGF(storageSnapshot||researchSnapshot,nowTs,actualLast);
 const gff=realGFForecast?C.normalize('GFForecast',realGFForecast,{asOf:nowTs,sourceTime:actualLast}):C.unavailable('GFForecast','Нет свежего прогноза в GFStorage');
 // GFxDrip is NOT invented or silently calculated. Must be supplied via a GFStorage-backed integration record.
 const xd=otherForecasts.GFxDrip?C.normalize('GFxDrip',otherForecasts.GFxDrip,{asOf:nowTs,sourceTime:actualLast}):C.unavailable('GFxDrip','Нет сохранённого прогноза GFxDrip');
 const aps=result.ok?C.normalize('GFAPSEnhancer',{originTs:nowTs,sourceTime:actualLast,points:result.points.map(q=>({minute:q.minute,glucoseMmol:q.COB}))},{asOf:nowTs}):
   C.unavailable('GFAPSEnhancer',(result.errors||['Недостаточно данных']).join('; '));
 const comparison=C.compare({GFForecast:gff,GFxDrip:xd,GFAPSEnhancer:aps});
 return {version:'0.1.1',asOf:nowTs,sourceRevision:researchSnapshot.revision,displayOnly:true,
    clinicalValidation:false,canModifyDoses:false,canWriteToPump:false,sourceLabel:'AAPS-inspired approximation; not original AndroidAPS forecast',
    comparison,details:{guard:A.guard.inspect(input),aaps:result,inputCounts:{cgm:input.cgm.length,meals:input.meals.length,insulin:input.insulin.length},
      caveats:['Оценка COB не является измерением количества углеводов','Левемир, болезнь и активность не учтены полностью','Расхождение кривых не позволяет установить причину с уверенностью']}};
}
function connect(host,{onUpdate=()=>{},clock=()=>Date.now(),parameters=null}={}){
 if(host?.getSchemaVersion?.()!==5)throw Error('Нужен GFStorage v5');
 const port=host.connect('research');let disposed=false;
 function refresh(){if(disposed)return;try{const snap=port.getSnapshot();onUpdate(compute({researchSnapshot:snap,nowTs:clock(),parameters}));}
 catch(e){onUpdate({version:'0.1.1',error:e.message,comparison:C.compare({}),displayOnly:true});}}
 const unsubscribe=port.subscribe(refresh);refresh();
 return Object.freeze({refresh,dispose:()=>{disposed=true;unsubscribe();}});
}
return Object.freeze({VERSION:'0.1.1',resolveParameters,latestGF,compute,connect,assess:C.assess});
});
