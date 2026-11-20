/* GFAuditExport v0.1.4: one read-only GFStorage input for complete raw data.
 * New adapter only; does NOT claim to reproduce full PDF/ZIP exporter v0.1.2.
 */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;if(root)root.GFAuditExportStorageAdapter=a;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const Normalizer=typeof require==='function'?require('../../../shared/GFNormalizedFacts_v0.1.0.js'):globalThis.GFNormalizedFacts;
function collect(host){
 if(!host||![4,5].includes(host.getSchemaVersion?.()))throw Error('Требуется GFStorage schemaVersion 4');
 const j=host.connect('journal'),c=host.connect('cgmAdapter'),research=host.connect('research');
 let x,y,z;for(let attempt=0;attempt<5;attempt++){x=j.getSnapshot();y=c.getSnapshot();z=research.getSnapshot();if(x.revision===y.revision&&y.revision===z.revision)break;}
 if(x.revision!==y.revision||y.revision!==z.revision)throw Error('Снимки GFStorage имеют разные ревизии');
 if(!Normalizer)throw Error('Не подключён GFNormalizedFacts');
 const normalized=Normalizer.reconcile(x);
 const payload={schema:'glucopapa.audit.unified/1',status:'research_only',schemaVersion:x.schemaVersion,revision:x.revision,
  profile:{timeZone:x.profile.timeZone},events:x.events,mealSessions:x.mealSessions,conditionPeriods:x.conditionPeriods,
  cgm:y.cgm,cgmMetadata:y.cgmMetadata,forecasts:x.forecasts,forecastAssessments:x.forecastAssessments,
  coefficientObservations:z.proposals,mealReconciliation:{ambiguousLegacy:normalized.ambiguousLegacy,linkedLegacy:normalized.legacyLinked,legacyStandaloneCount:normalized.legacyStandalone.length}};
 return JSON.parse(JSON.stringify(payload));
}
function exportJson(host){return JSON.stringify(collect(host),null,2);}
return Object.freeze({VERSION:'0.1.4',collect,exportJson});
});
