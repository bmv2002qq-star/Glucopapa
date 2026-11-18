/* V2: privileged host integration only. Single GFStorage forecastWriter is persistent.
 * GFForecast journal stays read-only/ephemeral until explicitly persisted by host.
 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFForecastStorageAdapter=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function connect(host){
 if(!host||![4,5].includes(host.getSchemaVersion?.()))throw Error('Требуется GFStorage schemaVersion 4 с forecastWriter');
 const port=host.connect('forecastWriter');
 if(typeof port.appendResearchEvents!=='function')throw Error('Порт прогнозов отсутствует');
 return Object.freeze({
  persistJournal(journal,actualReadings,assessedAt){
   if(!journal||typeof journal.prepareEvents!=='function')throw Error('Нужен проверенный GFForecast Journal');
   const batch=journal.prepareEvents(actualReadings,assessedAt);
   return port.appendResearchEvents(batch,port.getRevision());
  },
  read:()=>Object.freeze({revision:port.getRevision(),forecasts:port.read('forecasts'),assessments:port.read('forecastAssessments')})
 });
}
function trustedReadings(host,{safetyVerdict}={}){
 if(!host||![4,5].includes(host.getSchemaVersion?.()))throw Error('Требуется GFStorage schemaVersion 4/5');
 const port=host.connect('cgmAdapter'),s=port.getSnapshot(),blocked=(code)=>Object.freeze({available:false,code,readings:[]});
 if(!s.cgmMetadata||!s.cgmMetadata.sourceDeviceId)return blocked('NO_SOURCE');
 if(s.cgmMetadata.sourceType!=='device_recorded'||s.cgmMetadata.qualityScore<0.8)return blocked('SOURCE_NOT_TRUSTED');
 if(!safetyVerdict||safetyVerdict.forecastInputEligible!==true||safetyVerdict.status!=='DATA_OK')return blocked('SAFETY_VERDICT_REQUIRED');
 if(safetyVerdict.sourceRevision!==s.revision)return blocked('STALE_SAFETY_VERDICT');
 const all=s.cgm.filter(x=>x.sourceDeviceId===s.cgmMetadata.sourceDeviceId);
 const incomplete=all.some(x=>typeof x.receivedAt!=='string'||x.valid===false||x.qualityFlag==='invalid');
 if(incomplete)return blocked('CGM_RECEIPT_OR_QUALITY_UNKNOWN');
 return Object.freeze({available:true,code:'OK',readings:all.map(x=>({measuredAt:new Date(x.ts).toISOString(),receivedAt:x.receivedAt,glucoseMmol:x.mmol,sourceId:x.sourceDeviceId}))});
}
return Object.freeze({VERSION:'0.1.3',connect,trustedReadings});
});
