/* GFNormalizedFacts v0.1.0 — one read-only fact projection for Journal, Coefficients and Export.
 * Never merges, deletes, rewrites or double-counts raw records. Ambiguity is explicit.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFNormalizedFacts=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const clone=x=>JSON.parse(JSON.stringify(x));
function reconcile(snapshot){
 if(!snapshot||!Array.isArray(snapshot.events)||!Array.isArray(snapshot.mealSessions))throw Error('Нужны события и приёмы пищи');
 const sessions=snapshot.mealSessions,confirmed=sessions.filter(s=>s.status==='completed'&&s.actualPlate&&Number.isFinite(s.actualPlate?.totals?.carbs)&&typeof s.startedAt==='string'&&Number.isFinite(Date.parse(s.startedAt)));
 const legacy=snapshot.events.filter(e=>e.type==='meal'&&e.status==='recorded');
 const ambiguous=[],standalone=[],linked=[];
 for(const event of legacy){
  const ts=Date.parse(event.startedAt);
  const targets=sessions.filter(s=>(event.sessionId&&event.sessionId===s.id)||(event.linkedMealSessionId&&event.linkedMealSessionId===s.id)||
   (Number.isFinite(ts)&&s.startedAt&&Math.abs(Date.parse(s.startedAt)-ts)<=60000));
  if(targets.length){const row={legacyId:event.id,sessionIds:targets.map(s=>s.id),reason:targets.length===1&& (event.sessionId||event.linkedMealSessionId)?'EXPLICIT_LINK':'POSSIBLE_DUPLICATE_TIMESTAMP'};
   if(row.reason==='EXPLICIT_LINK')linked.push(row);else ambiguous.push(row);
  }else standalone.push(event);
 }
 const normalized=confirmed.map(s=>({id:s.id,startedAt:s.startedAt,source:'mealSessions',carbsGrams:s.actualPlate.totals.carbs,carbsSource:s.actualPlate.containsEstimatedValues?'manual_estimate':'food_catalog'}));
 normalized.push(...standalone.filter(x=>Number.isFinite(Date.parse(x.startedAt))).map(x=>({id:x.id,startedAt:x.startedAt,source:'legacy_unverified',carbsGrams:null,carbsSource:null})));
 return clone({version:'0.1.0',confirmedSessions:confirmed,legacyStandalone:standalone,legacyLinked:linked,ambiguousLegacy:ambiguous,normalizedMeals:normalized,warnings:ambiguous.map(x=>({code:'MEAL_DUPLICATE_UNRESOLVED',legacyId:x.legacyId,relatedSessionIds:x.sessionIds}))});
}
return Object.freeze({VERSION:'0.1.0',reconcile});
});
