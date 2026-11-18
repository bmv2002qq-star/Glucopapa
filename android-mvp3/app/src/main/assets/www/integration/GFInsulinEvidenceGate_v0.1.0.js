/* GlucoPapa GFInsulinEvidenceGate v0.1.0 — W04a technical working candidate.
 * Read-only GFStorage -> approved RinfastEngine. The approved engine is unchanged.
 * This adapter prevents an EMPTY/INCOMPLETE journal from being displayed as zero IOB.
 * No therapeutic recommendations, no writes. Parent's declared coverage is not an external proof.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFInsulinEvidenceGate=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const VERSION='0.1.0-candidate';
 function incomplete(code,detail){return {status:'INCOMPLETE',code,detail,kind:'research_curve',source:'RinfastEngine v0.3.0',parts:null,totalModelUnits:null,safeForTreatment:false,confirmedCoverage:false,method:'OpenAPS exponential rapid, original unchanged'};}
 function calculateFromHost(host,nowIso,engine=root?.RinfastEngine){
   if(!host||typeof host.connect!=='function'||host.getSchemaVersion?.()!==5)return incomplete('GFSTORAGE_SCHEMA','Единый GFStorage schema 5 недоступен');
   const now=Date.parse(nowIso);
   if(typeof nowIso!=='string'||!Number.isFinite(now)||!/(?:Z|[+-]\d\d:\d\d)$/i.test(nowIso))return incomplete('CLOCK_INVALID','Нужна текущая временная метка с часовым поясом');
   const snap=host.connect('rinfast').getSnapshot(),coverage=snap.coverage;
   if(!coverage||coverage.confirmedComplete!==true||coverage.declaredBy!=='parent')return incomplete('JOURNAL_COVERAGE_UNKNOWN','Полнота истории уколов не подтверждена');
   const start=Date.parse(coverage.startIso),end=Date.parse(coverage.endIso);
   if(!Number.isFinite(start)||!Number.isFinite(end)||start>now-48*3600000||end<now||start>end)return incomplete('JOURNAL_COVERAGE_INSUFFICIENT','Не хватает подтверждённой истории минимум за 48 часов');
   if(!engine||typeof engine.calculate!=='function')return incomplete('ENGINE_UNAVAILABLE','Утверждённое расчётное ядро отсутствует');
   const audit=engine.calculate({nowIso,events:snap.events||[],profile:engine.DEFAULT_PROFILE});
   if(audit.status!=='MODEL_ESTIMATE'||!Number.isFinite(audit.modelRemainingUnits))return incomplete('SOURCE_INCOMPLETE',(audit.issues||[]).join('; ')||'История инъекций противоречива');
   return {status:'MODEL_ESTIMATE',kind:'research_curve',source:'RinfastEngine v'+(engine.ENGINE_VERSION||'0.3.0'),
     parts:audit.contributions.map(x=>({id:x.id,units:x.doseUnits,ageMinutes:x.ageMinutes,phase:x.phase,remainingModelUnits:x.remainingModelUnits})),
     totalModelUnits:audit.modelRemainingUnits,safeForTreatment:false,confirmedCoverage:true,
     coverageDeclaredBy:'parent',coverageStartIso:coverage.startIso,coverageEndIso:coverage.endIso,
     method:'OpenAPS exponential rapid, original unchanged',note:'Подтверждение полноты родителем не является измерением точности расчёта'};
 }
 return Object.freeze({VERSION,calculateFromHost});
});
