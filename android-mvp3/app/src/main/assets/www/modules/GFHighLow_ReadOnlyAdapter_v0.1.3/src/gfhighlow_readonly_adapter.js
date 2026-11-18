/* GlucoPapa GFHighLow read-only host adapter v0.1.3.
 * Research observability: segments high/low CGM readings, creates NO events,
 * prescriptions, confirmations, persistent storage, or separate action UI.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFHighLowReadOnly=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.4-sport';
function connect(host){
 if(!host||typeof host.connect!=='function'||![3,4,5].includes(host.getSchemaVersion?.()))throw Error('Требуется GFStorage schema 3/4/5');
 const port=host.connect('injectionAnalytics'); // only authorized read access to cgm + cgmMetadata
 function analyze({lowMmol=3.9,highMmol=10,gapMinutes=15}={}){
  if(!Number.isFinite(lowMmol)||!Number.isFinite(highMmol)||lowMmol<2||lowMmol>=highMmol||highMmol>33)throw Error('Недопустимые пороги исследовательского анализа');
  if(!Number.isSafeInteger(gapMinutes)||gapMinutes<5||gapMinutes>60)throw Error('Недопустимый интервал');
  const initialRevision=port.getRevision();
  const meta=port.read('cgmMetadata'),data=port.read('cgm'),periods=port.read('conditionPeriods');
  if(initialRevision!==port.getRevision())return Object.freeze({version:VERSION,status:'SOURCE_CHANGED',episodes:Object.freeze([]),sourceRevision:port.getRevision()});
  if(!meta||!meta.sourceDeviceId)return Object.freeze({version:VERSION,status:'SOURCE_UNVERIFIED',episodes:Object.freeze([]),sourceRevision:initialRevision});
  const rows=data.filter(r=>r&&r.kind==='observed'&&r.sourceDeviceId===meta.sourceDeviceId&&
     Number.isSafeInteger(r.ts)&&typeof r.mmol==='number'&&Number.isFinite(r.mmol)&&r.valid!==false&&r.qualityFlag!=='invalid')
    .sort((a,b)=>a.ts-b.ts);
  let current=null;const out=[];
  function finish(){if(current){
    const sports=periods.filter(p=>p.kind==='sport'&&Date.parse(p.start)<=current.lastAtMs&&(p.end===null||Date.parse(p.end)>=current.startAtMs))
      .map(p=>Object.freeze({id:p.id,start:p.start,end:p.end}));
    out.push(Object.freeze({...current,sportSessions:Object.freeze(sports),duringRecordedSport:sports.length>0}));current=null;}}
  for(const r of rows){
   const kind=r.mmol<lowMmol?'low':r.mmol>highMmol?'high':null;
   if(!kind){finish();continue;}
   if(current&&(current.kind!==kind||r.ts-current.lastAtMs>gapMinutes*60000||r.ts<current.lastAtMs))finish();
   if(!current){current={id:kind+'|'+meta.sourceDeviceId+'|'+r.ts,kind,sourceDeviceId:meta.sourceDeviceId,startAtMs:r.ts,lastAtMs:r.ts,readings:0,minMmol:r.mmol,maxMmol:r.mmol};}
   current.lastAtMs=r.ts;current.readings++;current.minMmol=Math.min(current.minMmol,r.mmol);current.maxMmol=Math.max(current.maxMmol,r.mmol);
  }
  finish();
  return Object.freeze({version:VERSION,status:'OBSERVATIONAL_ONLY',sourceRevision:initialRevision,sourceDeviceId:meta.sourceDeviceId,episodes:Object.freeze(out),note:'Пороговые интервалы — только описание CGM; это не лечебные рекомендации.'});
 }
 return Object.freeze({version:VERSION,analyze});
}
return Object.freeze({VERSION,connect});
});
