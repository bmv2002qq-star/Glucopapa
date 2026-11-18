/* ГлюкоПапа GFCoefficientReview v0.1.0 — read-only safety diagnostics.
 * No medical validation, no automatic coefficient selection, no writes.
 * Explicitly checks active window conflicts using the same GFSettings timeline.
 */
(function(root,factory){
 'use strict';
 const api=factory(typeof module==='object'&&module.exports?require('../../../modules/GFSettings_v0.1.6/src/gfsettings.js'):root.GFSettings);
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.GFCoefficientReview=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Settings){
 'use strict';
 const VERSION='0.1.0';
 const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
 const copy=v=>JSON.parse(JSON.stringify(v));
 const KINDS=['carb_g_per_u','isf_mmol_per_u','target_range_mmol','tdd_u'];
 function evaluate({settingsPort,atIso}={}){
  if(!Settings||!Settings.coefficientTimeline)throw Error('GFSettings dependency missing');
  if(!settingsPort||typeof settingsPort.getSnapshot!=='function'||typeof settingsPort.getRevision!=='function')throw Error('GFStorage settings read port required');
  if(!atIso||!Number.isFinite(Date.parse(atIso)))throw Error('ISO asOf timestamp required');
  const s=settingsPort.getSnapshot(),rows=s.coefficients||[];
  if(!Array.isArray(rows))throw Error('Missing coefficients array');
  const zone=s.profile?.timeZone||null;
  const timeline=Settings.coefficientTimeline(rows,atIso,zone);
  const byKind=KINDS.map(kind=>{
   const active=timeline.filter(x=>x.kind===kind&&x.isEffectiveAt);
   return {kind,status:active.length===0?'MISSING':active.length===1?'DISPLAY_UNVERIFIED':'AMBIGUOUS',activeIds:active.map(x=>x.id),count:active.length};
  });
  const conflicts=byKind.filter(x=>x.status==='AMBIGUOUS');
  const noZone=zone===null&&rows.some(x=>x.windowLocal);
  return freeze(copy({version:VERSION,sourceRevision:s.revision,asOfIso:atIso,timeZone:zone,
   status:conflicts.length?'AMBIGUOUS':noZone?'TIMEZONE_REQUIRED':'READ_ONLY',byKind,conflicts,
   therapyUse:false,automaticDoseSelection:false,automaticCoefficientChange:false,
   message:conflicts.length?'Пересекаются действующие записи коэффициентов. Требуется ручная проверка их интервалов.':
    noZone?'Не задан часовой пояс. Проверка почасовых коэффициентов неполна.':'Данные только для просмотра; медицинская пригодность не установлена.'}));
 }
 return Object.freeze({VERSION,evaluate});
});
