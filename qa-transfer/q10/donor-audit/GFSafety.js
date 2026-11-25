/* ГлюкоПапа GFSafety v0.1.0 — read-only input integrity diagnostics.
 * Independent of forecast, storage, dose calculators and UI. MIT.
 * NOT a clinical safety system. Never authorizes insulin decisions.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFSafety=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.0',MINUTE=60000,MAX_ITEMS=20000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const clean=x=>typeof x==='string'&&x.length>0&&x===x.trim()&&x.length<=180;
const median=a=>{const x=[...a].sort((u,v)=>u-v),p=x.length>>1;return x.length%2?x[p]:(x[p-1]+x[p])/2;};
function parseIso(s){
 if(!clean(s))throw new Error('Требуется ISO 8601 с часовым поясом');
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(s);
 if(!m)throw new Error('Неверный ISO 8601');
 const y=+m[1],mon=+m[2],d=+m[3],h=+m[4],min=+m[5],sec=+(m[6]||0),zh=+(m[10]||0),zm=+(m[11]||0);
 if(y<2000||y>2100||h>23||min>59||sec>59||zh>14||zm>59||(zh===14&&zm!==0))throw new Error('Недопустимая дата или UTC-смещение');
 const c=new Date(0);c.setUTCHours(0,0,0,0);c.setUTCFullYear(y,mon-1,d);
 if(c.getUTCFullYear()!==y||c.getUTCMonth()!==mon-1||c.getUTCDate()!==d)throw new Error('Недопустимая календарная дата');
 const t=Date.parse(s);if(!Number.isFinite(t))throw new Error('Дата вне диапазона');return t;
}
function safeCopy(v,depth=0,counter={n:0}){
 if(++counter.n>500000)throw new Error('Слишком большой снимок');
 if(depth>16)throw new Error('Слишком большая вложенность');
 if(v===null||typeof v==='string'||typeof v==='boolean'||finite(v))return v;
 if(Array.isArray(v)){if(v.length>MAX_ITEMS)throw new Error('Слишком большой массив');return v.map(e=>safeCopy(e,depth+1,counter));}
 if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)){
  const o=Object.create(null);for(const k of Reflect.ownKeys(v)){
   if(typeof k!=='string'||['__proto__','constructor','prototype'].includes(k))throw new Error('Недопустимый ключ');
   const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!Object.hasOwn(d,'value'))throw new Error('Снимок содержит вычисляемое поле');
   o[k]=safeCopy(d.value,depth+1,counter);
  }return o;
 }throw new Error('Недопустимый тип данных');
}
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const k of Object.keys(v))freeze(v[k]);Object.freeze(v);}return v;}
function report(nowIso,issues,metadata={}){
 const blocked=issues.some(x=>x.level==='block');
 const caution=issues.some(x=>x.level==='warning');
 const out={module:'GFSafety',version:VERSION,checkedAt:nowIso||null,
  status:blocked?'BLOCKED':caution?'CAUTION':'DATA_OK',
  forecastInputEligible:!blocked&&!caution,
  clinicalUseAllowed:false,insulinDoseDecisionAllowed:false,automaticInjectionAllowed:false,
  issues,summary:{blocks:issues.filter(x=>x.level==='block').length,warnings:issues.filter(x=>x.level==='warning').length},
  metadata,notAClinicalValidation:true};
 return freeze(out);
}
function evaluate(input){
 const issues=[],seen=new Set(),meta={};
 function add(code,level,message,details=''){
  if(seen.has(code))return;seen.add(code);issues.push({code,level,message,details});
 }
 let s,now;
 try{
  s=safeCopy(input);
  if(!s||typeof s!=='object'||Array.isArray(s))throw new Error('Ожидается объект');
  now=parseIso(s.nowIso);
  if(now<Date.UTC(2020,0,1))throw new Error('Некорректное время проверки');
  if(!Array.isArray(s.readings)||!Array.isArray(s.injections)||!Array.isArray(s.meals))
    throw new Error('Не хватает массивов readings/injections/meals');
  if(!s.coverage||typeof s.coverage!=='object'||Array.isArray(s.coverage))
    throw new Error('Нет сведений о полноте истории');
 }catch(err){return report(null,[{code:'INVALID_SNAPSHOT',level:'block',message:'Некорректный входной снимок',details:String(err.message||err)}]);}
 const iso=new Date(now).toISOString();meta.sourceSchema=s.sourceSchema||'normalized/1';
 // Historical coverage is explicit user assertion, never inferred from an empty event array.
 try{
  const c=s.coverage;
  if(c.confirmedComplete!==true||!['user','parent'].includes(c.declaredBy)||!['gfstorage','synthetic_demo','external_adapter'].includes(c.provenance))
    add('INCOMPLETE_HISTORY','block','Не подтверждена полнота истории еды и инсулина');
  else {
   const start=parseIso(c.startIso),end=parseIso(c.endIso);
   if(start>now-36*60*MINUTE||end<now-5*MINUTE||end>now+MINUTE)
    add('COVERAGE_WINDOW','block','История не покрывает требуемое окно','Для этого прототипа требуется подтверждённая история за 36 часов и актуальное окончание интервала.');
  }
 }catch(e){add('COVERAGE_INVALID','block','Некорректная дата покрытия истории',String(e.message));}
 // CGM: all rows must be reliable, duplicates idempotent only if identical.
 const byTime=new Map(),readings=[];
 for(const r of s.readings){
  try{
   if(!r||!finite(r.glucoseMmol)||r.glucoseMmol<1.5||r.glucoseMmol>33)throw new Error('Глюкоза вне формата');
   if(!clean(r.sourceId))throw new Error('Нет подтверждённого sourceId');
   for(const key of ['sensorId','patientId'])if(r[key]!==undefined&&r[key]!==null&&!clean(r[key]))throw new Error('Неверный '+key);
   if(r.valid===false||r.qualityFlag==='invalid')add('CGM_INVALID_FLAG','block','Датчик пометил измерение недостоверным');
   if(r.valid!==undefined&&typeof r.valid!=='boolean'||r.qualityFlag!==undefined&&!['ok','invalid'].includes(r.qualityFlag))throw new Error('Неверная метка качества');
   const t=parseIso(r.measuredAt);
   if(t>now+MINUTE)throw new Error('Измерение из будущего');
   let received=null;
   if(r.receivedAt!==undefined&&r.receivedAt!==null){received=parseIso(r.receivedAt);
    if(received<t-MINUTE||received>now+MINUTE)throw new Error('Получение раньше измерения или в будущем');
   }
   const row={t,received,value:r.glucoseMmol,source:r.sourceId,sensor:r.sensorId||null,patient:r.patientId||null};
   if(byTime.has(t)){
    const other=byTime.get(t);
    if(other.value!==row.value||other.source!==row.source||other.sensor!==row.sensor||other.patient!==row.patient)
     add('CGM_CONFLICT','block','Противоречащие CGM в одно время');
    if(other.received!==null&&received!==null)other.received=Math.min(other.received,received);
    else other.received=null;
   }else byTime.set(t,row);
  }catch(e){add('CGM_INVALID_RECORD','block','Повреждённая запись CGM',String(e.message));}
 }
 readings.push(...byTime.values());readings.sort((a,b)=>a.t-b.t);
 meta.cgmPoints=readings.length;
 if(!readings.length)add('NO_CGM','block','Нет проверенных показаний CGM');
 else {
  const last=readings.at(-1),age=(now-last.t)/MINUTE;
  meta.lastCgmMmol=last.value;meta.lastCgmMeasuredAt=new Date(last.t).toISOString();meta.cgmAgeMinutes=+age.toFixed(2);
  if(age>12)add('STALE_CGM','block','Последний CGM старше 12 минут');
  if(last.value<=3.9)add('LOW_CGM','block','Низкое значение CGM: численный прогноз недоступен','Показание датчика не заменяет проверку по установленному порядку действий.');
  if(last.value<2||last.value>33)add('CGM_MODEL_RANGE','block','CGM вне диапазона модели прогноза');
  const recent40=readings.filter(r=>last.t-r.t<=40*MINUTE),recent25=readings.filter(r=>last.t-r.t<=25*MINUTE);
  const distinct=new Set(recent40.map(r=>r.source));
  if(distinct.size!==1)add('CGM_MIXED_SOURCE','block','В рабочем окне смешаны источники CGM');
  for(const key of ['sensor','patient']){
   const set=new Set(recent40.map(r=>r[key]));if(set.size>1)add('CGM_MIXED_'+key.toUpperCase(),'block','Разные идентификаторы CGM: '+key);
  }
  if(recent40.some(r=>r.received===null))add('CGM_RECEIPT_UNKNOWN','warning','Неизвестно время получения хотя бы одного CGM','GFStorage v0.3.0 не сохраняет эту метку; не подменяем её временем измерения.');
  if(last.received!==null){meta.transportLagMinutes=+((last.received-last.t)/MINUTE).toFixed(2);}
  const delays=recent40.filter(r=>r.received!==null).map(r=>(r.received-r.t)/MINUTE);
  if(delays.length){meta.maxTransportLagMinutes=+Math.max(...delays).toFixed(2);
   if(meta.maxTransportLagMinutes>10)add('CGM_TRANSPORT_DELAY','warning','Значительная задержка поступления CGM');}
  if(recent25.length>60)add('CGM_IMPLAUSIBLE_DENSITY','block','Неправдоподобная плотность CGM: защита от чрезмерных расчётов');
  else if(recent25.length<4)add('CGM_FEW_POINTS','block','Для тренда меньше четырёх точек CGM за 25 минут');
  else {
   for(let i=1;i<recent25.length;i++)if(recent25[i].t-recent25[i-1].t>10*MINUTE)
    add('CGM_GAP','block','Большой пропуск в последних показаниях CGM');
   const slopes=[];
   for(let i=0;i<recent25.length;i++)for(let j=i+1;j<recent25.length;j++){
    const dt=(recent25[j].t-recent25[i].t)/MINUTE;if(dt>=4)slopes.push((recent25[j].value-recent25[i].value)/dt);
   }
   if(slopes.length<3)add('CGM_TREND_UNCERTAIN','block','Нельзя вычислить устойчивый тренд CGM');
   else{
    const slope=median(slopes);meta.trendMmolPerMinute=+slope.toFixed(5);
    if(Math.abs(slope)>0.22)add('CGM_FAST_TREND','block','Тренд CGM слишком быстрый для модели');
    const offsets=recent25.map(r=>r.value-slope*(r.t-last.t)/MINUTE);
    const resid=median(offsets),mad=median(offsets.map(v=>Math.abs(v-resid)));
    if(mad>0.9)add('CGM_NOISY','block','Сильный разброс CGM');
    const before=recent25.slice(0,-1);
    if(before.length>=3){
     const baseSlopes=[];
     for(let i=0;i<before.length;i++)for(let j=i+1;j<before.length;j++){
      const dt=(before[j].t-before[i].t)/MINUTE;if(dt>=4)baseSlopes.push((before[j].value-before[i].value)/dt);
     }
     if(baseSlopes.length>=3){
      const bSlope=median(baseSlopes),prev=before.at(-1),dt=(last.t-prev.t)/MINUTE;
      const expect=prev.value+bSlope*dt;
      const residuals=before.map(r=>r.value-(prev.value+bSlope*(r.t-prev.t)/MINUTE));
      const med=median(residuals),scatter=median(residuals.map(v=>Math.abs(v-med)));
      if(Math.abs(last.value-expect)>Math.max(1.25,0.22*dt+4*scatter))
       add('CGM_LAST_SPIKE','block','Последний CGM резко расходится с предыдущими');
     }
    }
   }
  }
 }
 // Validate user-entered historical injections; do not decide whether the dose was correct.
 const injectionIds=new Set(),injs=[];
 for(const e of s.injections){
  try{
   if(!e||!clean(e.id))throw new Error('Нет ID');
   if(injectionIds.has(e.id))add('INJECTION_DUPLICATE_ID','block','Повторяется идентификатор инъекции');
   injectionIds.add(e.id);
   if(!['rinfast','levemir'].includes(e.insulinId))throw new Error('Неизвестный вид инсулина');
   if(e.status!=='confirmed')add('INJECTION_UNCONFIRMED','block','В истории есть неподтверждённая инъекция');
   if(!finite(e.units)||e.units<=0||e.units>200)throw new Error('Некорректное количество единиц');
   const t=parseIso(e.administeredAt);if(t>now+MINUTE)throw new Error('Время инъекции в будущем');
   if(e.doseErrorSuspected===true)add('INJECTION_ERROR_MARKED','block','Отмечена возможная ошибка записи инъекции');
   injs.push({id:e.id,t,insulinId:e.insulinId,units:e.units});
  }catch(err){add('INJECTION_INVALID','block','Повреждённая запись инъекции',String(err.message));}
 }
 injs.sort((a,b)=>a.t-b.t);
 const lastBySignature=new Map();
 for(const cur of injs){
  const signature=cur.insulinId+'|'+cur.units;
  if(lastBySignature.has(signature)&&cur.t-lastBySignature.get(signature)<=3*MINUTE)
   add('INJECTION_POSSIBLE_DUPLICATE','block','Возможный повтор записи инъекции','Два близких события могут быть и реальными отдельными уколами. Требуется проверить журнал, не удалять автоматически.');
  lastBySignature.set(signature,cur.t);
 }
 meta.injections=injs.length;
 // Meal history: recorded intent is not proof of eaten food.
 const mealIds=new Set();
 for(const e of s.meals){
  try{
   if(!e||!clean(e.id))throw new Error('Нет ID еды');
   if(mealIds.has(e.id))add('MEAL_DUPLICATE_ID','block','Повтор ID приёма пищи');mealIds.add(e.id);
   if(e.status!=='confirmed')add('MEAL_UNCONFIRMED','block','Еда не подтверждена как фактически съеденная');
   if(!finite(e.carbsG)||e.carbsG<0||e.carbsG>500)throw new Error('Некорректные граммы углеводов');
   const t=parseIso(e.eatenAt);if(t>now+MINUTE)throw new Error('Время еды в будущем');
  }catch(err){add('MEAL_INVALID','block','Повреждённая запись еды',String(err.message));}
 }
 meta.meals=s.meals.length;
 if(s.sourceStatus?.type==='synthetic')add('CGM_SYNTHETIC_SOURCE','block','Поток CGM помечен как синтетический, не реальный датчик');
 const conditions=s.conditions||{};
 if(conditions.illness===true)add('ILLNESS_CONTEXT','warning','Отмечена болезнь: численный эффект не определён');
 if(conditions.activity===true||conditions.activity==='high'||conditions.activity==='low')
  add('ACTIVITY_CONTEXT','warning','Отмечена активность: численный эффект не определён');
 // Candidate only checks duplicate possibility; never commits a new injection.
 if(s.candidateInjection!==undefined&&s.candidateInjection!==null){
  const e=s.candidateInjection;
  try{
   if(!e||!clean(e.id)||!['rinfast','levemir'].includes(e.insulinId)||!finite(e.units)||e.units<=0||e.units>200)
    throw new Error('Некорректная запись-предпросмотр');
   const t=parseIso(e.administeredAt);if(t>now+MINUTE)throw new Error('Время в будущем');
   if(injectionIds.has(e.id))add('CANDIDATE_REPEATED_ID','block','Инъекция уже есть в журнале');
   if(injs.some(prev=>prev.insulinId===e.insulinId&&Math.abs(prev.units-e.units)<0.000001&&Math.abs(prev.t-t)<=3*MINUTE))
    add('CANDIDATE_POSSIBLE_DUPLICATE','block','Новая запись может повторять существующую','Это проверка записи, не медицинское решение об инъекции.');
  }catch(err){add('CANDIDATE_INVALID','block','Неверный предпросмотр записи инъекции',String(err.message));}
 }
 return report(iso,issues,meta);
}
return Object.freeze({VERSION,evaluate,parseIso});
});
