/* GFTimeGrid V3 v0.2.0: independent, pure, immutable local-time contract.
 * Not a glucose or insulin model. No writes, no reads from another module.
 * Storage adapters use the same canonical slot IDs and independent contract tests.
 */
(function(root, factory) { 'use strict';
  const api=factory();
  if (typeof module==='object' && module.exports) module.exports=api;
  if (root) root.GFTimeGridV3=api;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  'use strict';
  const VERSION='0.2.0';
  const SLOTS=Object.freeze([
    Object.freeze({id:'00-06',from:'00:00',to:'06:00',title:'Ночь'}),
    Object.freeze({id:'06-12',from:'06:00',to:'12:00',title:'Утро'}),
    Object.freeze({id:'12-18',from:'12:00',to:'18:00',title:'День'}),
    Object.freeze({id:'18-00',from:'18:00',to:'00:00',title:'Вечер'})
  ]);
  const TIMED=Object.freeze(['carb_g_per_u','isf_mmol_per_u']);
  const SLOT_SET=new Set(SLOTS.map(s=>s.id));
  function fail(code){throw Object.assign(new Error(code),{code});}
  function validIso(iso) {
    if(typeof iso!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(iso)) fail('TIME_INSTANT_REQUIRED');
    const f=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
    const [y,mo,da,h,mi,ss]=f.slice(1).map(Number);
    const c=new Date(Date.UTC(y,mo-1,da));
    if(c.getUTCFullYear()!==y||c.getUTCMonth()+1!==mo||c.getUTCDate()!==da||h>23||mi>59||ss>59)fail('TIME_INSTANT_INVALID');
    const offset=/([+-])(\d{2}):(\d{2})$/.exec(iso);
    if(offset&&(Number(offset[2])>14||Number(offset[3])>59||(Number(offset[2])===14&&Number(offset[3])!==0)))fail('TIME_INSTANT_INVALID');
    const d=new Date(iso);
    if(!Number.isFinite(d.getTime()))fail('TIME_INSTANT_INVALID');
    return d;
  }
  function validZone(tz) {
    if(typeof tz!=='string'||!tz.trim()||tz.length>100) fail('TIME_ZONE_REQUIRED');
    try{return new Intl.DateTimeFormat('en',{timeZone:tz}).resolvedOptions().timeZone;}
    catch(_){return fail('TIME_ZONE_INVALID');}
  }
  function validClock(v) {
    if(typeof v!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) fail('LOCAL_CLOCK_INVALID');
    return Number(v.slice(0,2))*60+Number(v.slice(3,5));
  }
  function slotForMinute(minute) {
    if(!Number.isSafeInteger(minute)||minute<0||minute>=1440)fail('MINUTE_OUT_OF_RANGE');
    return SLOTS[Math.floor(minute/360)];
  }
  function slotForInstant(iso,tz) {
    const d=validIso(iso),zone=validZone(tz);
    const fields=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
    const p=Object.fromEntries(fields.filter(x=>x.type==='hour'||x.type==='minute').map(x=>[x.type,Number(x.value)]));
    if(!Number.isInteger(p.hour)||!Number.isInteger(p.minute)||p.hour>23||p.hour<0||p.minute<0||p.minute>59)fail('LOCAL_CLOCK_CONVERSION_FAILED');
    return slotForMinute(p.hour*60+p.minute);
  }
  function requireSlotId(slotId,kind) {
    if(TIMED.includes(kind)) {
      if(!SLOT_SET.has(slotId))fail('COEFFICIENT_SLOT_NOT_ON_GRID');
    } else if(slotId!==null&&slotId!==undefined) fail('DAILY_VALUE_MUST_NOT_HAVE_SLOT');
    return slotId??null;
  }
  function fromLegacyWindow(windowLocal) {
    if(!windowLocal||typeof windowLocal!=='object')return null;
    const slot=SLOTS.find(s=>s.from===windowLocal.from&&s.to===windowLocal.to);
    return slot?slot.id:null;
  }
  function auditLegacy(rows) {
    if(!Array.isArray(rows))fail('HISTORY_ARRAY_REQUIRED');
    const warnings=[];
    for(const row of rows) {
      if(!row||typeof row!=='object')fail('HISTORY_ROW_INVALID');
      const kind=row.kind;const desired=fromLegacyWindow(row.windowLocal);
      if(TIMED.includes(kind)&&!desired)warnings.push(Object.freeze({id:row.id??null,kind,issue:'LEGACY_WINDOW_REQUIRES_MANUAL_REVIEW'}));
      if(!TIMED.includes(kind)&&row.windowLocal!=null)warnings.push(Object.freeze({id:row.id??null,kind,issue:'DAILY_VALUE_WINDOW_REQUIRES_MANUAL_REVIEW'}));
    }
    return Object.freeze({warnings:Object.freeze(warnings),rewritten:0,hasLegacy:warnings.length>0});
  }
  function slotCoverage() {
    return Object.freeze(SLOTS.map(s=>Object.freeze({id:s.id,minutes:360,from:s.from,to:s.to})));
  }
  return Object.freeze({VERSION,SLOTS,TIMED,validIso,validZone,validClock,slotForMinute,slotForInstant,requireSlotId,fromLegacyWindow,auditLegacy,slotCoverage});
});
