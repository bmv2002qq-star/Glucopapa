/* ГлюкоПапа GFTimeGrid v0.1.0 — общая сетка пользовательских почасовых коэффициентов.
 * Только границы времени, без коэффициентов, дозирования и изменения истории.
 * Интервалы полуоткрытые [from,to), в местном часовом поясе профиля.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFTimeGrid=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VERSION='0.1.0';
 const SLOTS=Object.freeze([
  Object.freeze({id:'night',from:'00:00',to:'06:00',title:'Ночь'}),
  Object.freeze({id:'morning',from:'06:00',to:'12:00',title:'Утро'}),
  Object.freeze({id:'day',from:'12:00',to:'18:00',title:'День'}),
  Object.freeze({id:'evening',from:'18:00',to:'00:00',title:'Вечер'})
 ]);
 const WINDOW_KINDS=Object.freeze(['carb_g_per_u','isf_mmol_per_u']);
 const minute=v=>{if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))throw Error('Нужно время HH:mm');return Number(v.slice(0,2))*60+Number(v.slice(3,5));};
 const isTimed=kind=>WINDOW_KINDS.includes(kind);
 const slotOf=w=>{if(!w||typeof w!=='object'||Array.isArray(w))return null;return SLOTS.find(x=>x.from===w.from&&x.to===w.to)||null;};
 const segments=w=>{if(!w)return [[0,1440]];const a=minute(w.from),b=minute(w.to);if(a===b)throw Error('Пустой временной интервал');return a<b?[[a,b]]:[[a,1440],[0,b]];};
 const overlaps=(a,b)=>segments(a).some(([a0,a1])=>segments(b).some(([b0,b1])=>Math.max(a0,b0)<Math.min(a1,b1)));
 function validate(kind,windowLocal){
  if(isTimed(kind)){if(!slotOf(windowLocal))throw Error('COEFFICIENT_WINDOW_NOT_ON_GRID: выберите одно из 4 окон по 6 часов');}
  else if(windowLocal!==undefined&&windowLocal!==null)throw Error('COEFFICIENT_DAILY_NO_WINDOW: суточный показатель вводится без временного окна');
  return slotOf(windowLocal);
 }
 function audit(rows){
  const invalid=[];for(const x of rows||[]){if(isTimed(x.kind)&&!slotOf(x.windowLocal)){invalid.push({id:x.id,kind:x.kind,windowLocal:x.windowLocal||null,issue:'LEGACY_WINDOW_REQUIRES_REVIEW'});}
   if(!isTimed(x.kind)&&x.windowLocal)invalid.push({id:x.id,kind:x.kind,windowLocal:x.windowLocal,issue:'DAILY_WINDOW_REQUIRES_REVIEW'});}
  return Object.freeze({version:VERSION,slots:SLOTS,invalid,hasLegacy:invalid.length>0,rewritten:0,therapyUse:false});
 }
 return Object.freeze({VERSION,SLOTS,WINDOW_KINDS,slotOf,isTimed,validate,overlaps,audit,minute});
});
