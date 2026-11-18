/* ГлюкоПапа · GFJournal v0.1.3 · read-only journal views.
   Не считает дозы, не назначает питание и не изменяет утверждённые модули.
   Вход: read-only проекции общего GFStorage; дополнительные факты — только из внешнего контрактного порта.
*/
(function(root,factory){'use strict';const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;if(root)root.GFJournal=a;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const NORMALIZER=typeof require==='function'?require('../../../shared/GFNormalizedFacts_v0.1.0.js'):globalThis.GFNormalizedFacts;
const VERSION='0.1.4-sport',M=60000,DAY=86400000;
const SITE_LABELS={abdomen:'Живот',arm:'Плечо',thigh:'Бедро',buttock:'Ягодица'};
const DRUG_LABELS={rinfast:'РинФаст',levemir:'Левемир'};
function fail(s){throw new Error(s)}
function isObj(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)}
function isNum(v){return typeof v==='number'&&Number.isFinite(v)}
function isoMs(s){
  // Date.parse silently rolls impossible dates (e.g. February 30) into March.
  // Validate calendar parts *before* parsing, including leap years and UTC offsets.
  if(typeof s!=='string')return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+\-])(\d{2}):(\d{2}))$/.exec(s);
  if(!m)return null;
  const year=+m[1],month=+m[2],day=+m[3],hour=+m[4],minute=+m[5],second=+m[6];
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
  if(m[8]!=='Z'){
    const oh=+m[10],om=+m[11];
    if(oh>14||om>59||(oh===14&&om!==0))return null;
  }
  const ms=Date.parse(s);
  return Number.isFinite(ms)?ms:null;
}
function msOf(t){return isNum(t)?t:isoMs(t)}
function validTimeZone(tz){if(typeof tz!=='string')fail('Укажите часовой пояс');try{new Intl.DateTimeFormat('en',{timeZone:tz})}catch{fail('Неизвестный часовой пояс')}return tz}
function ymd(ts,tz){const pieces=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts));let a={};for(const p of pieces)if(p.type==='year'||p.type==='month'||p.type==='day')a[p.type]=p.value;return a.year+'-'+a.month+'-'+a.day}
function hm(ts,tz){return new Intl.DateTimeFormat('ru-RU',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(ts))}
function num(v){return isNum(v)&&v>=0?v:0}
function round(v,d=1){return Number(v.toFixed(d))}
function plateSummary(p){
  if(!isObj(p)||!Array.isArray(p.items)||p.items.length===0||!isObj(p.totals))return null;
  const fields=['protein','fat','carbs','kcal'],validMacro=v=>isNum(v)&&v>=0;
  if(fields.some(k=>!validMacro(p.totals[k])))return null;
  // Fail closed on damaged input: a missing nutrient is UNKNOWN, never 0 g.
  // Do not count any part of a corrupted plate in daily/monthly nutritional totals.
  if(p.items.some(it=>!isObj(it)||fields.some(k=>!validMacro(it[k]))))return null;
  const t=p.totals;
  return {protein:t.protein,fat:t.fat,carbs:t.carbs,kcal:t.kcal,items:p.items.map(it=>({
    name:String(it.name||'Без названия').slice(0,250),
    amount:isNum(it.amount)?it.amount:null,unit:it.unit||null,
    protein:it.protein,fat:it.fat,carbs:it.carbs,kcal:it.kcal,status:it.nutritionStatus||null
  }))};
}
function siteFromNote(note){if(typeof note!=='string')return null;const match=note.match(/(?:^|;)\s*Место укола:\s*(живот|плечо|бедро|ягодица)(?:\s*;|\s*$)/i);if(!match)return null;const vals={'живот':'abdomen','плечо':'arm','бедро':'thigh','ягодица':'buttock'};return vals[match[1].toLowerCase()]||null}
function normalizeReadings(rows){if(!Array.isArray(rows))return [];const m=new Map();for(const it of rows){if(!it||!Number.isSafeInteger(it.ts)||!isNum(it.mmol)||it.mmol<1.5||it.mmol>30)continue;if(m.has(it.ts)&&m.get(it.ts).mmol!==it.mmol)fail('Противоречивые CGM');m.set(it.ts,{ts:it.ts,mmol:it.mmol,direction:typeof it.direction==='string'?it.direction:null})}return Array.from(m.values()).sort((a,b)=>a.ts-b.ts)}
function glucoseAt(readings,at){let l=0,r=readings.length;while(l<r){const m=(l+r)>>1;if(readings[m].ts<=at)l=m+1;else r=m}const i=l-1;if(i<0)return {value:null,direction:null,trendLabel:'Нет данных',source:null,ageMin:null};const a=readings[i];if(at-a.ts>10*M)return {value:null,direction:null,trendLabel:'Нет свежей CGM',source:null,ageMin:null};const ageMin=round((at-a.ts)/M,1);const labels={Flat:['→','Ровно'],FortyFiveUp:['↗','Рост'],SingleUp:['↑','Рост'],DoubleUp:['⇈','Быстрый рост'],FortyFiveDown:['↘','Снижение'],SingleDown:['↓','Снижение'],DoubleDown:['⇊','Быстрое снижение'],NOT_COMPUTABLE:['—','Нет тенденции']};if(a.direction&&labels[a.direction])return {value:a.mmol,direction:labels[a.direction][0],trendLabel:labels[a.direction][1],source:'xdrip',ageMin};
  // При отсутствии направления xDrip — только приближённое изменение по предыдущим двум точкам.
  const prev=readings[i-1];if(!prev||a.ts-prev.ts<3*M||a.ts-prev.ts>15*M)return {value:a.mmol,direction:'—',trendLabel:'Недостаточно точек',source:'observed',ageMin};
  const per5=(a.mmol-prev.mmol)*5*M/(a.ts-prev.ts);let arrow='→',label='Почти без изменений';if(per5>=0.3){arrow='↑';label='Приблизительно растёт'}else if(per5>=0.08){arrow='↗';label='Приблизительно растёт'}else if(per5<=-0.3){arrow='↓';label='Приблизительно снижается'}else if(per5<=-0.08){arrow='↘';label='Приблизительно снижается'}return {value:a.mmol,direction:arrow,trendLabel:label,source:'derived',ageMin};
}
function normalizePeriods(periods){if(!Array.isArray(periods))return [];const out=[];for(const x of periods){if(!isObj(x))continue;const a=msOf(x.startedAt),hasEnd=x.endedAt!==null&&x.endedAt!==undefined,b=hasEnd?msOf(x.endedAt):null;if(a===null||(hasEnd&&b===null)||(b!==null&&b<=a))continue;out.push({id:String(x.id||'ill-'+a),start:a,end:b,label:typeof x.label==='string'?x.label.slice(0,120):'Болезнь'})}return out.sort((x,y)=>x.start-y.start)}
function inIllness(t,periods){return periods.some(p=>t>=p.start&&(p.end===null||t<p.end))}
function toInput(inp){if(!isObj(inp))fail('Ожидался объект данных');const journal=inp.journal,graph=inp.graph;if(!isObj(journal)||!Array.isArray(journal.events)||!Array.isArray(journal.mealSessions))fail('Нужен снимок порта journal из GFStorage');if(!isObj(graph)||!Array.isArray(graph.cgm))fail('Нужен снимок порта graph с CGM');if(journal.revision!==graph.revision)fail('Снимки хранилища разных ревизий: перечитать');const zone=validTimeZone(inp.timeZone||journal.profile?.timeZone||'Europe/Minsk');return {journal,graph,zone,illness:normalizePeriods(inp.illnessEpisodes||[]),annotations:isObj(inp.injectionAnnotations)?inp.injectionAnnotations:{},extraEvents:Array.isArray(inp.extraEvents)?inp.extraEvents:[]};}
function buildAll(inp){const {journal,graph,zone,illness,annotations,extraEvents}=toInput(inp);const cgm=normalizeReadings(graph.cgm),rows=[];const push=(x)=>{x.day=ymd(x.ts,zone);x.time=hm(x.ts,zone);x.ill=inIllness(x.ts,illness);x.glucose=glucoseAt(cgm,x.ts);rows.push(x)};
  if(!NORMALIZER)fail('Не подключён единый GFNormalizedFacts');
  const mealReconciliation=NORMALIZER.reconcile(journal);
  const standaloneIds=new Set(mealReconciliation.legacyStandalone.map(x=>x.id));
  const linkedIds=new Set();for(const session of journal.mealSessions)for(const id of session.injectionIds||[])linkedIds.add(id);
  for(const e of journal.events){if(!isObj(e))continue;if(e.type==='insulin_injection'&&e.status==='confirmed'){const t=msOf(e.administeredAt),u=e.units;if(t===null||!isNum(u)||u<=0)continue;const site=annotations[e.id]?.site||e.injectionSite?.region||e.site||siteFromNote(e.note);const validSite=Object.hasOwn(SITE_LABELS,site)?site:null;push({id:String(e.id),kind:'injection',ts:t,insulinId:e.insulinId,insulinName:DRUG_LABELS[e.insulinId]||String(e.insulinId||'Инсулин'),dose:u,site:validSite,siteLabel:validSite?SITE_LABELS[validSite]:null,description:'Фактическая инъекция',link: e.linkedMealSessionId||null,detail:typeof e.note==='string'?e.note:null,recordSource:'GFStorage.events'});
    }else if(e.type==='meal'&&e.status==='recorded'&&standaloneIds.has(e.id)){const t=msOf(e.startedAt);if(t===null)continue;push({id:String(e.id),kind:'legacy_meal',ts:t,description:'Еда · старая запись (состав неизвестен)',detail:'БЖУ в старой записи не подтверждены — в итог не входят',meal:null,status:'unknown',recordSource:'GFStorage.events'});}}
  for(const s of journal.mealSessions){if(!isObj(s))continue;const t=msOf(s.startedAt||s.createdAt||s.plannedPlate?.createdAt);if(t===null)continue;const meal=plateSummary(s.actualPlate);const plan=plateSummary(s.plannedPlate);const nutritionIssue=s.actualPlate!=null&&!meal;let label='Еда · план';if(s.status==='started')label=meal?'Еда · фактически съедено':'Еда · начата (состав не подтверждён)';if(s.status==='completed')label='Еда · завершена';if(s.status==='draft')label='Еда · черновик';if(nutritionIssue)label='Еда · неполные данные БЖУ';push({id:String(s.id),kind:'meal',ts:t,description:label,status:String(s.status),meal,plan,nutritionIssue,detail:nutritionIssue?'Данные продуктов неполные: БЖУ неизвестны, в итоги не включены':null,recordSource:'GFStorage.mealSessions',sessionVersion:s.version});}
  // A sporting session is one journal row: the start remains visible while open.
  // No injection/food totals are changed. Duration is derived from confirmed timestamps.
  for(const p of journal.conditionPeriods||[]){
    if(!isObj(p)||p.kind!=='sport')continue;
    const start=msOf(p.start),end=p.end===null?null:msOf(p.end);
    if(start===null||(p.end!==null&&(end===null||end<=start)))continue;
    const minutes=end===null?null:Math.round((end-start)/60000*10)/10;
    const zEnd=end===null?'идёт':hm(end,zone);
    const label='Спорт · '+hm(start,zone)+'–'+zEnd+(minutes===null?'':' · '+minutes+' мин');
    push({id:p.id,kind:'sport',ts:start,endedAtMs:end,durationMinutes:minutes,status:end===null?'active':'completed',description:label,detail:p.note||'Факт занятия, не расчёт дозы',recordSource:'GFStorage.conditionPeriods'});
  }
  for(const p of illness){push({id:p.id+'-start',kind:'illness_start',ts:p.start,description:'Начало периода болезни',detail:p.label,recordSource:'external.illnessEpisodes'});if(p.end!==null)push({id:p.id+'-end',kind:'illness_end',ts:p.end,description:'Завершение периода болезни',detail:p.label,recordSource:'external.illnessEpisodes'});}
  for(const ev of extraEvents){if(!isObj(ev)||!['activity','note'].includes(ev.kind)||msOf(ev.ts)===null)continue;push({id:String(ev.id||'event-'+ev.ts),kind:ev.kind,ts:msOf(ev.ts),description:ev.kind==='activity'?'Активность':'Заметка',detail:String(ev.text||'').slice(0,300),recordSource:'external.extraEvents'});}
  // Forecast entries are observations of an algorithm, not insulin/meal actions.
  // Never add them to therapeutic or nutrition totals.
  for(const rec of journal.forecasts||[]){const t=msOf(rec.payload?.forecastAt);if(t===null||rec.kind!=='research_forecast')continue;
    push({id:rec.id,kind:'research_forecast',ts:t,description:'Исследовательский прогноз CGM',
      detail:'Не подтверждён на реальных данных; не используется для назначения действий',recordSource:'GFStorage.forecasts'});
  }
  rows.sort((a,b)=>a.ts-b.ts||a.id.localeCompare(b.id));return {zone,revision:journal.revision,rows,illness,cgm,mealConflicts:mealReconciliation.warnings};
}
function filterDay(all,date,kinds=null){const dateMs=typeof date==='string'&&/^\d{4}-\d\d-\d\d$/.test(date)?Date.parse(date+'T00:00:00Z'):NaN;if(!Number.isFinite(dateMs)||new Date(dateMs).toISOString().slice(0,10)!==date)fail('Некорректная дата');const kindList=Array.isArray(kinds)?new Set(kinds):null;const filtered=all.rows.filter(x=>x.day===date&&(!kindList||kindList.has(x.kind)));return {date,revision:all.revision,zone:all.zone,rows:filtered,summary:totals(all.rows.filter(x=>x.day===date)),illness:all.illness.some(p=>{const s=ymd(p.start,all.zone),e=p.end===null?null:ymd(p.end-1,all.zone);return date>=s&&(e===null||date<=e)})};}
function totals(rows){const t={protein:0,fat:0,carbs:0,kcal:0,rinfast:0,levemir:0,meals:0,unconfirmedMeals:0,injections:0};for(const e of rows){if(e.kind==='injection'){t.injections++;if(e.insulinId==='rinfast')t.rinfast+=e.dose;else if(e.insulinId==='levemir')t.levemir+=e.dose}else if(e.kind==='meal'){if(e.meal){t.meals++;for(const k of ['protein','fat','carbs','kcal'])t[k]+=e.meal[k]}else t.unconfirmedMeals++;}}for(const k of ['protein','fat','carbs','kcal','rinfast','levemir'])t[k]=round(t[k],2);return t}
function monthSummary(all,month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('Неверный месяц');return totals(all.rows.filter(x=>x.day.startsWith(month)))}
function forHome(all,day){const filtered=filterDay(all,day);return Object.freeze({date:day,revision:all.revision,illness:filtered.illness,summary:{...filtered.summary},lastEventTime:filtered.rows.length?filtered.rows[filtered.rows.length-1].ts:null});}
return Object.freeze({VERSION,SITE_LABELS,DRUG_LABELS,buildAll,filterDay,totals,monthSummary,glucoseAt,normalizeReadings,forHome,ymd});
});
