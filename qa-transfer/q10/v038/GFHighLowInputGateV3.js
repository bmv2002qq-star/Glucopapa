/* Q10 standalone read-only input availability contract. No numerical treatment model.
 * Legacy GFHighLowInputGate remains immutable. V3 consumes only the permitted
 * validated snapshot adapter, not another module's mathematical core. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./GFSafetyV3DiagnosticAdapter.js'));else root.GFHighLowInputGateV3=factory(root.GFSafetyV3DiagnosticAdapter);})(globalThis,function(port){
'use strict';
const VERSION='0.3.8-qa';
const unknown=()=>({status:'UNKNOWN',value:null});
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const result=(code,stamp=null,issues=[])=>freeze({version:VERSION,status:'BLOCKED',code,stamp,issues,glucose:unknown(),iob:unknown(),cob:unknown(),foodCoverage:'NOT_PROVEN',insulinCoverage:'NOT_PROVEN',cgmCoverage:'NOT_PROVEN',qualityScore:null,activityEffect:'NOT_APPLIED',allowDose:false,allowRecommendation:false,forecastInputEligible:false,clinicalUseAllowed:false,insulinDoseDecisionAllowed:false,automaticInjectionAllowed:false});
function inspect(raw,current,nowMs){
 try{
  if(!port||port.VERSION!=='0.3.5-qa'||typeof port.prepare!=='function')return result('PORT_UNAVAILABLE');
  const p=port.prepare(raw,current,nowMs);
  // Expose availability codes only; no inferred zero, numerical score, dose or timing.
  return result('THERAPEUTIC_INPUT_NOT_READY',p.stamp,[...p.issues,'IOB_NOT_PROVEN','COB_NOT_PROVEN','COEFFICIENTS_NOT_APPLIED']);
 }catch(e){return result(typeof e?.message==='string'&&/^[A-Z0-9_]{1,128}$/.test(e.message)?e.message:'READ_FAILED');}
}
return Object.freeze({VERSION,inspect});
});
