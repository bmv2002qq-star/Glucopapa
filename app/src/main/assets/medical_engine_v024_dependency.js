/* GlucoFamily 0.13 medical OBSERVATION engine.
 * No therapeutic dose, ICR/ISF determination, bolus timing or insulin titration.
 * Clinical safety checks are deliberately outside selectable 'AI' providers.
 */
(function(global){'use strict';
 const MINUTE=60000,DAY=86400000;
 const valid=(x)=>Number.isFinite(Number(x));
 function closest(rows,time,margin){let hit=null,d=margin+1;for(const r of rows){const dt=Math.abs(Number(r.ts)-time);if(dt<d&&valid(r.mmol)&&Number(r.mmol)>1.5&&Number(r.mmol)<35){hit=r;d=dt}}return hit;}
 function goodReadings(data,now){const map=new Map();for(const r of data||[]){if(!valid(r.ts)||!valid(r.mmol))continue;const t=Number(r.ts),n=Number(r.mmol);if(n<=1.5||n>=35||t>now+2*MINUTE||t<now-90*DAY)continue;map.set(t,{ts:t,mmol:n,direction:String(r.direction||'')});}return [...map.values()].sort((a,b)=>a.ts-b.ts);}
 function checkData(input,now=Date.now()){
  const rows=goodReadings(input.readings,now),events=input.events||[],latest=rows.at(-1)||null;
  const missing=[];
  if(!latest)missing.push('Нет показаний xDrip+');
  else if(now-latest.ts>10*MINUTE)missing.push('Последнее показание старше 10 минут');
  if(!events.some(e=>e.type==='insulin'))missing.push('Нет записей о фактических инъекциях');
  if(!events.some(e=>e.type==='meal'&&e.status==='eaten'))missing.push('Нет подтверждённых порций еды');
  return {latest,readings:rows.length,events:events.length,dataFresh:!!latest&&now-latest.ts<=10*MINUTE,missing};
 }
 function insulinOverlap(input,now=Date.now()){
  const rows=(input.events||[]).filter(e=>e.type==='insulin'&&e.insulinType==='short'&&valid(e.ts)&&Number(e.ts)<=now&&now-Number(e.ts)<=4*60*MINUTE).sort((a,b)=>b.ts-a.ts);
  return {count:rows.length,hasRecentMultiple:rows.length>=2,mostRecentAt:rows[0]?.ts||null,explanation:'В журнале есть несколько коротких инъекций в пределах четырёх часов. Их действие может перекрываться. Это не расчёт остаточного инсулина (IOB) и не инструкция по дозированию.'};
 }
 function mealEpisodes(input,now=Date.now()){
  const rows=goodReadings(input.readings,now);
  return (input.events||[]).filter(e=>e.type==='meal'&&e.status==='eaten'&&valid(e.ts)&&now-Number(e.ts)<60*DAY&&now-Number(e.ts)>2*60*MINUTE).map(e=>{
   const before=closest(rows,Number(e.ts)-5*MINUTE,15*MINUTE);
   const after=closest(rows,Number(e.ts)+120*MINUTE,25*MINUTE);
   if(!before||!after||after.ts<=before.ts||!valid(e.carbs))return null;
   return {ts:Number(e.ts),carbs:Number(e.carbs),fat:Number(e.fat||0),protein:Number(e.protein||0),delta:+(after.mmol-before.mmol).toFixed(2),name:String(e.name||''),hour:new Date(e.ts).getHours()};
  }).filter(Boolean);
 }
 const median=xs=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b);return (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2;};
 function similarMeals(input,meal,now=Date.now()){
  const episodes=mealEpisodes(input,now),carbs=Number(meal.carbs||0),fat=Number(meal.fat||0),hour=Number(meal.hour||new Date(now).getHours());
  if(!Number.isFinite(carbs)||carbs<=0)return {status:'missing',total:episodes.length,message:'Для сравнения укажи количество углеводов.'};
  const ranked=episodes.map(e=>({e,d:Math.abs(e.carbs-carbs)/Math.max(12,carbs)+0.15*Math.abs(e.fat-fat)/Math.max(8,fat)+Math.min(12,Math.abs(e.hour-hour))*0.04})).filter(x=>x.d<=1.2).sort((a,b)=>a.d-b.d).slice(0,7);
  if(ranked.length<3)return {status:'few',total:episodes.length,similar:ranked.length,message:'Для локального ML-анализа пока мало похожих приёмов пищи с CGM до и через 2 часа.'};
  const deltas=ranked.map(x=>x.e.delta),s=[...deltas].sort((a,b)=>a-b);
  return {status:'observed',total:episodes.length,similar:ranked.length,medianDelta:median(deltas),low:s[0],high:s.at(-1),message:'Медиана изменения CGM через ~2 часа в похожих прошлых эпизодах. Это ассоциация, а не прогноз дозы или самостоятельный совет менять инсулин.'};
 }
 function basalWindow(input,now=Date.now()){
  const rows=goodReadings(input.readings,now),events=input.events||[],groups=new Map();
  for(const r of rows){const d=new Date(r.ts),h=d.getHours();if(h>7)continue;const key=[d.getFullYear(),d.getMonth(),d.getDate()].join('-');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  const obs=[];
  for(const pts of groups.values()){
   const early=pts.filter(x=>new Date(x.ts).getHours()<1),late=pts.filter(x=>new Date(x.ts).getHours()>=5&&new Date(x.ts).getHours()<7);
   if(!early.length||!late.length)continue;
   const a=early[0],b=late.at(-1);if(b.ts-a.ts<4*60*MINUTE)continue;
   const confound=events.some(e=>(e.type==='insulin'&&e.insulinType==='short'&&Number(e.ts)>a.ts-4*60*MINUTE&&Number(e.ts)<b.ts)||(e.type==='activity'&&Number(e.ts)>a.ts-12*60*MINUTE&&Number(e.ts)<b.ts));
   obs.push({start:a.ts,end:b.ts,delta:b.mmol-a.mmol,confounded:confound});
  }
  const pure=obs.filter(x=>!x.confounded);
  return {nights:obs.length,unconfounded:pure.length,medianChange:median(pure.map(x=>x.delta)),message:pure.length>=3?'Ночной тренд найден. Даже без зарегистрированного болюса остаются неучтённые факторы; нельзя использовать это для изменения базальной дозы.':'Для сравнения ночных тенденций пока недостаточно независимых наблюдений. Наличие вечерней еды, болюсов, активности и болезни может менять результат.'};
 }
 function summary(input,now=Date.now()){
  const quality=checkData(input,now),overlap=insulinOverlap(input,now),basal=basalWindow(input,now);
  return {quality,overlap,basal,mealEpisodes:mealEpisodes(input,now).length};
 }

  // v0.13 — retrospective trend only; never use as a 15-minute clinical forecast.
  function cgmTrend(input,now=Date.now()){
   const all=goodReadings(input.readings,now);
   const latest=all.at(-1);
   if(!latest||now-latest.ts>10*MINUTE)return {status:'stale',rate:null,delta:null};
   const recent=all.filter(r=>r.ts>=latest.ts-30*MINUTE&&r.ts<=latest.ts);
   const span=recent.length>=2?(latest.ts-recent[0].ts)/MINUTE:0;
   if(recent.length<3||span<10)return {status:'insufficient',rate:null,delta:null,count:recent.length};
   const xs=recent.map(r=>(r.ts-recent[0].ts)/MINUTE),ys=recent.map(r=>r.mmol);
   const xm=xs.reduce((a,b)=>a+b,0)/xs.length,ym=ys.reduce((a,b)=>a+b,0)/ys.length;
   const den=xs.reduce((a,x)=>a+(x-xm)*(x-xm),0);
   const rate=den?xs.reduce((a,x,i)=>a+(x-xm)*(ys[i]-ym),0)/den:NaN;
   if(!Number.isFinite(rate)||Math.abs(rate)>0.5)return {status:'unreliable',rate:null,delta:null};
   return {status:'observed',rate:+rate.toFixed(3),delta:+(latest.mmol-recent[0].mmol).toFixed(2),minutes:+span.toFixed(1),count:recent.length,source:'retrospective-regression'};
  }
  // Time window classification from reference profiles, not a pharmacokinetic IOB.
  function shortInsulinWindow(input,now=Date.now()){
   const recent=(input.events||[]).filter(e=>e.type==='insulin'&&e.insulinType==='short'&&valid(e.ts)&&Number(e.ts)<=now&&Number(e.ts)>now-12*60*MINUTE&&valid(e.units)&&Number(e.units)>0);
   const items=recent.map(e=>{
    const n=String(e.insulinName||'').toLowerCase();
    const regular=/актрапид|actrapid|regular|хумулин.*р|insuman.*rapid|инсуман.*рапид|ринсулин.*р/.test(n);
    const rapid=/ново.?рапид|novorapid|novolog|аспарт|aspart|фиасп|fiasp|хумалог|humalog|apidra|апидра|lispro|лизпро|glulisine|глулизин/.test(n);
    const minH=regular?5:rapid?3:null,maxH=regular?8:rapid?5:null;
    const minutesAgo=(now-Number(e.ts))/MINUTE;
    return {name:String(e.insulinName||'Без названия'),units:Number(e.units),minutesAgo:+minutesAgo.toFixed(1),windowMinHours:minH,windowMaxHours:maxH,
      possibleAction:maxH===null?null:minutesAgo<=maxH*60,
      uncertainty:minH===null?'unknown':minutesAgo<=minH*60?'in-window':'variable-tail'};
   }).sort((a,b)=>a.minutesAgo-b.minutesAgo);
   const possible=items.filter(x=>x.possibleAction===true);
   return {items,possibleCount:possible.length,overlapPossible:possible.length>=2,unknownCount:items.filter(x=>x.possibleAction===null).length,
      knownUnits:+items.reduce((sum,x)=>sum+x.units,0).toFixed(2),
      message:'Время после введения сопоставлено с диапазонами длительности действия из справочника препаратов. Остаточный IOB в ЕД НЕ рассчитан. Отсутствие записи не доказывает отсутствие инсулина.'};
  }
  // Patient state is transient form data. No cloud transfer and no dose selection.
  function triage(input,exam={},now=Date.now()){
   const q=checkData(input,now),v=valid(exam.meter)&&exam.meter!==''&&Number(exam.meter)>=1.5&&Number(exam.meter)<=35?Number(exam.meter):null;
   const measured=v!==null?v:q.dataFresh&&q.latest?Number(q.latest.mmol):null;
   const source=v!==null?'glucometer':measured!==null?'CGM':'none';
   const low=measured!==null&&measured<3.9,high=measured!==null&&measured>10;
   const severe=(exam.conscious==='no'||exam.swallow==='no'||exam.neuro==='yes');
   const dkaSigns=exam.dkaSigns==='yes';
   const ketones=valid(exam.ketones)&&exam.ketones!==''&&Number(exam.ketones)>=0&&Number(exam.ketones)<20?Number(exam.ketones):null;
   const dangerKetones=ketones!==null&&ketones>=3;
   const urgentKetones=ketones!==null&&ketones>=1.5;
   const context=(input.profile||{});
   let status=low&&severe?'emergency-low':severe?'emergency-general':low?'low':(dkaSigns||dangerKetones)?'emergency-dka':high?'high':measured===null?'unknown':'in-range';
   let action=low&&severe?'Не давать пищу или питьё через рот. Применить назначенный глюкагон по инструкции и вызвать экстренную помощь.':
       severe?'Нарушено сознание или глотание. Не давать ничего через рот; срочно вызвать экстренную помощь, проверить глюкозу и следовать плану на случай тяжёлой гипогликемии при её наличии.':
       (dkaSigns||dangerKetones)?'Срочная медицинская оценка на предмет кетоацидоза. При тяжёлых симптомах вызвать экстренную помощь.':
       low?'Не задерживать помощь. Если ребёнок в сознании и безопасно глотает, применить индивидуальный план быстрых углеводов; проверить глюкозу примерно через 15 минут.':
       high?'Проверить длительность повышения, кетоны, симптомы и введённый инсулин по индивидуальному плану; не повторять болюс без проверки.':
       measured===null?'Нет свежих данных: проверить CGM и состояние, при необходимости измерить глюкометром.':'Показатель в основном диапазоне CGM; оценить динамику и самочувствие.';
   if(urgentKetones&&!dangerKetones&&!severe&&!dkaSigns)action+=' Кетоны повышены: незамедлительно связаться с диабетологической командой по плану болезни.';
   const allowPlan=low&&!severe&&exam.conscious==='yes'&&exam.swallow==='yes'&&source!=='none';
   return {status,actual:measured,source,stale:!q.dataFresh,low,high,severe,ketones,urgentKetones,dangerKetones,allowPlan,action,
      needsMeter:q.latest===null||!q.dataFresh||(v!==null&&q.latest&&Math.abs(Number(q.latest.mmol)-v)>1.5),
      patientContext:{age:context.age??null,weight:context.weight??null}};
  }
  // Research-only demo of a triangular action curve, opt-in for synthetic tests only.
  // Not calibrated to insulin type/person, not usable for medication decisions.
  function researchCurve(input,now=Date.now(),research=false){
   if(!research)return {status:'disabled',value:null};
   const shots=(input.events||[]).filter(e=>e.type==='insulin'&&e.insulinType==='short'&&valid(e.ts)&&valid(e.units)&&Number(e.units)>0&&Number(e.ts)<=now);
   if(!shots.length)return {status:'missing',value:null};
   const onset=15,peak=90,end=300;
   let v=0;
   for(const e of shots){const m=(now-Number(e.ts))/MINUTE;let f;
    if(m<=onset)f=1;else if(m>=end)f=0;
    else if(m<=peak)f=1-(m-onset)**2/((peak-onset)*(end-onset));
    else f=(end-m)**2/((end-peak)*(end-onset));
    v+=Number(e.units)*f;
   }
   return {status:'research-only',value:+v.toFixed(3),formula:'triangular residual integral; onset 15, peak 90, end 300 min',warning:'НЕ медицинский IOB; НЕ использовать для дозирования'};
  }

  global.GFMedical={checkData,insulinOverlap,mealEpisodes,similarMeals,basalWindow,summary,cgmTrend,shortInsulinWindow,triage,researchCurve};
})(typeof window!=='undefined'?window:globalThis);


/* v0.14: deterministic, non-prescriptive pharmacology timeline + exercise context.
   Reference windows are population descriptions and must NOT be treated as measured IOB,
   a glucose forecast, or bolus recommendations. */
(function(global){'use strict';
 const MIN=60000,HOUR=60*MIN;
 const fin=(x)=>typeof x==='number'?Number.isFinite(x):(x!==null&&x!==''&&Number.isFinite(Number(x)));
 function detect(name,type){
  const n=String(name||'').toLowerCase().replace(/ё/g,'е');
  if(/ново.?рапид|novorapid|novolog|insulin aspart|инсулин аспарт/.test(n))return {key:'novorapid',name:'НовоРапид',kind:'short',onset:[10,20],peak:[60,180],duration:[180,300],source:'официальная инструкция NovoRapid'};
  if(/левемир|levemir|insulin detemir|детемир/.test(n))return {key:'levemir',name:'Левемир',kind:'long',onset:null,peak:null,duration:[0,1440],source:'официальная инструкция Levemir; до 24 часов, зависит от дозы'};
  return {key:'unknown',name:String(name||'Препарат не указан'),kind:type||'unknown',onset:null,peak:null,duration:null,source:'препарат не распознан: использовать индивидуальную инструкцию'};
 }
 function labelPhase(profile,minutes){
  if(profile.key==='unknown')return 'профиль неизвестен';
  if(profile.kind==='long')return minutes<=1440?'возможное базальное действие; индивидуальная длительность неизвестна':'за пределами справочного окна; нельзя утверждать, что действие закончилось';
  if(minutes<profile.onset[0])return 'ранее типичного начала действия';
  if(minutes<profile.onset[1])return 'период начала действия';
  if(minutes<profile.peak[0])return 'нарастание действия';
  if(minutes<=profile.peak[1])return 'период типичного максимума';
  if(minutes<=profile.duration[0])return 'после типичного максимума; действие возможно';
  if(minutes<=profile.duration[1])return 'вариабельное остаточное действие возможно';
  return 'за пределами типичной длительности; нулевой IOB не доказан';
 }
 function insulinTimeline(input,now=Date.now()){
  const events=Array.isArray(input?.events)?input.events:[];
  const items=events.filter(e=>e.type==='insulin'&&['short','long'].includes(e.insulinType)&&fin(e.ts)&&fin(e.units)&&Number(e.units)>0&&Number(e.ts)<=now&&Number(e.ts)>=now-36*HOUR)
   .map(e=>{
     const p=detect(e.insulinName,e.insulinType),ageMin=(now-Number(e.ts))/MIN;
     // Wrong metadata is not silently corrected: flag inconsistent insulin class.
     const mismatch=p.key!=='unknown'&&p.kind!==e.insulinType;
     return {name:p.name,originalName:String(e.insulinName||''),type:e.insulinType,units:Number(e.units),ageMinutes:+ageMin.toFixed(1),ageHours:+(ageMin/60).toFixed(2),phase:mismatch?'Несовпадение типа инсулина в журнале':labelPhase(p,ageMin),mismatch,profile:p.key,typicalDurationMinutes:p.duration,source:p.source,possible:!mismatch&&p.duration!==null&&ageMin<=p.duration[1]};
   }).sort((a,b)=>a.ageMinutes-b.ageMinutes);
  const long=items.filter(x=>x.type==='long'),short=items.filter(x=>x.type==='short');
  return {status:items.length?'observed':'missing',items,short,long,possibleShort:short.filter(x=>x.possible).length,possibleLong:long.filter(x=>x.possible).length,
   overlaps:short.filter(x=>x.possible).length>1,unknown:items.filter(x=>x.profile==='unknown').length,mismatches:items.filter(x=>x.mismatch).length,
   iobUnits:null,basalActiveUnits:null,warning:'Время и характер действия — справочная информация. Ни «активные ЕД», ни эффективную дозу базального инсулина из этого получить нельзя. Неполный журнал не подтверждает отсутствие инсулина.'};
 }
 const levels={rest:'Спокойный отдых',walk:'Прогулка или легкая аэробная нагрузка',aerobic:'Умеренная аэробная нагрузка',intense:'Интенсивный / силовой спорт',mixed:'Смешанная нагрузка',unknown:'Не указано'};
 function classifyActivity(a){
  const raw=String(a||'').toLowerCase();
  if(/^(rest)$|низк|спокой|отдых|пассив/.test(raw))return 'rest';
  if(/^(walk)$|прогул|гуля|ходьб|самокат/.test(raw))return 'walk';
  if(/^(aerobic)$|средн|умерен|бег|плаван/.test(raw))return 'aerobic';
  if(/^(intense)$|высок|спорт|силов|спринт|батут/.test(raw))return 'intense';
  if(/^(mixed)$|смешан/.test(raw))return 'mixed';
  return 'unknown';
 }
 function mealActivityContext(input,exam={},now=Date.now()){
  const events=Array.isArray(input?.events)?input.events:[];
  const meals=events.filter(e=>e.type==='meal'&&e.status!=='planned'&&e.status!=='started'&&fin(e.ts)&&Number(e.ts)<=now).sort((a,b)=>b.ts-a.ts);
  const lastMeal=meals[0]||null;
  const mealActivity=classifyActivity(lastMeal?.activityLevel);
  const current=classifyActivity(exam.activityNow);
  const planned=String(exam.activityPlan||'unknown');
  const recent=events.filter(e=>e.type==='activity'&&fin(e.ts)&&Number(e.ts)<=now&&now-Number(e.ts)<=12*HOUR).sort((a,b)=>b.ts-a.ts).slice(0,5);
  const label=levels[current];
  const flags=[];
  if(['walk','aerobic'].includes(current))flags.push('Аэробная активность может способствовать снижению глюкозы, особенно при продолжающемся действии инсулина.');
  if(current==='intense'||current==='mixed')flags.push('Интенсивная и смешанная нагрузка иногда временно повышает глюкозу, а позднее может увеличивать риск снижения.');
  if(planned==='soon')flags.push('Планируется нагрузка в ближайшие 2 часа после еды: требуется индивидуальный план для спорта и наблюдение за CGM.');
  if(recent.length)flags.push('В журнале отмечена физическая активность за последние 12 часов: риск отсроченного снижения может сохраняться.');
  if(!flags.length)flags.push('Данных недостаточно, чтобы оценивать влияние нагрузки на глюкозу; отсутствие активности в журнале не доказывает ее отсутствия.');
  return {current,activityText:label,planned,meal: lastMeal?{ageMinutes:+((now-Number(lastMeal.ts))/MIN).toFixed(0),carbs:fin(lastMeal.carbs)?Number(lastMeal.carbs):null,activity:mealActivity,activityText:levels[mealActivity],status:lastMeal.status||''}:null,
   activityEvents:recent.length,flags,correctionFactor:null,insulinAdjustment:null,warning:'Множитель дозы по «активен/пассивен» без индивидуально проверенного протокола не вычисляется.'};
 }
 // Only a theory benchmark using user-specified, explicitly synthetic TDD. No therapy output.
 function educationalCoefficients(tdd,xeGrams=12){
  if(!fin(tdd)||!(Number(tdd)>0)||Number(tdd)>200||!fin(xeGrams)||!(Number(xeGrams)>0)||Number(xeGrams)>20)return {status:'invalid'};
  const v=Number(tdd),xe=Number(xeGrams),isf=100/v,icr=500/v;
  return {status:'educational-only',tdd:v,xe,referenceISF:+isf.toFixed(3),referenceICR:+icr.toFixed(3),unitsPerXE:+(xe/icr).toFixed(3),
   warning:'Это грубые учебные оценки по правилу 100 и 500; не являются персональным ФЧИ, УК, назначенной дозой или указанием для введения.'};
 }
 // Five fully observed calendar days: never count days with no records as zero insulin.
 function observedTdd(input,now=Date.now()){
   const events=Array.isArray(input?.events)?input.events:[];
   const daily=[];
   for(let day=1;day<=5;day++){
     const d=new Date(now);d.setHours(0,0,0,0);d.setDate(d.getDate()-day);
     const start=d.getTime(),end=start+24*HOUR;
     const entries=events.filter(e=>e.type==='insulin'&&fin(e.ts)&&Number(e.ts)>=start&&Number(e.ts)<end&&fin(e.units)&&Number(e.units)>0);
     if(!entries.length)return {status:'insufficient',reason:'Отсутствуют записи инсулина для всех пяти завершенных суток',daysRecorded:daily.length,mean:null};
     daily.push({day:d.toISOString().slice(0,10),total:+entries.reduce((a,e)=>a+Number(e.units),0).toFixed(2),count:entries.length});
   }
   const mean=+(daily.reduce((a,x)=>a+x.total,0)/5).toFixed(2);
   return {status:'observed-not-verified',daysRecorded:5,mean,daily,warning:'Это среднее по записям, а не подтвержденная СДИ; неполный дневник исказит результат.'};
 }
 Object.assign(global.GFMedical,{insulinTimeline,mealActivityContext,educationalCoefficients,observedTdd});
})(typeof window!=='undefined'?window:globalThis);

/* v0.15: validated arithmetic for nutrition descriptions and theoretical reference factors.
 Clinical applicability is NOT established by these simple equations. */
(function(global){'use strict';
const finite=(x)=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const round=(x,p=2)=>Number(x.toFixed(p));
function macroUnits(data){
 const carbs=data?.carbs,protein=data?.protein,fat=data?.fat,kcal=data?.kcal;
 for(const [k,x] of Object.entries({carbs,protein,fat,kcal}))if(finite(x)&&(Number(x)<0||Number(x)>3000))return {status:'invalid',reason:'Недопустимое значение '+k};
 if(!finite(carbs))return {status:'insufficient',reason:'Не указаны углеводы'};
 const c=Number(carbs),xe=finite(data?.xeGrams)?Number(data.xeGrams):12;
 if(!(xe>0&&xe<=20))return {status:'invalid',reason:'Размер ХЕ должен быть в пределах 0–20 г'};
 const hasP=finite(protein),hasF=finite(fat),hasEnergy=finite(kcal);
 const result={status:'observed',carbs:c,xeGrams:xe,xe:round(c/xe,3),protein:hasP?Number(protein):null,fat:hasF?Number(fat):null,kcalLabel:hasEnergy?Number(kcal):null,method:'missing',fpu:null,nonCarbKcal:null,macroKcal:null,energyDifference:null,flags:[],possibleLateImpact:false};
 if(hasP&&hasF){
  const non=4*Number(protein)+9*Number(fat);result.nonCarbKcal=round(non,2);result.fpu=round(non/100,3);result.method='4P+9F';result.macroKcal=round(4*c+non,2);
  if(hasEnergy){result.energyDifference=round(Number(kcal)-result.macroKcal,2);if(Math.abs(result.energyDifference)>Math.max(25,result.macroKcal*.12))result.flags.push('Калории этикетки заметно отличаются от расчёта 4/4/9: проверьте клетчатку, округления и состав');}
 }else if(hasEnergy){
  const est=Number(kcal)-4*c;
  if(est>=0){result.nonCarbKcal=round(est,2);result.fpu=round(est/100,3);result.method='kcalMinusCarbs';result.flags.push('БЖЕ получена косвенно из калорийности: это менее надёжно, чем белки и жиры отдельно');}
  else{result.flags.push('Калорийность меньше 4×углеводы: исходные данные противоречивы');result.status='conflict';}
 }else{result.status='partial';result.flags.push('Нужны граммы белков и жиров или достоверная общая калорийность для БЖЕ');}
 if(result.fpu!==null&&result.fpu>=2){result.possibleLateImpact=true;result.flags.push('Состав еды может давать отсроченную динамику глюкозы — проверять по CGM примерно через 2–6 часов');}
 return result;
}
function estimatedReferenceFactors(input){
 const tdd=input?.tdd,xe=input?.xeGrams??12;
 if(!finite(tdd)||Number(tdd)<=0||Number(tdd)>200||!finite(xe)||Number(xe)<=0||Number(xe)>20)return {status:'invalid',reason:'Неверная суточная доза или размер ХЕ'};
 const d=Number(tdd),g=Number(xe),fast=100/d,regular=83/d,ratio=500/d;
 return {status:'theoretical-only',tdd:d,xeGrams:g,isfRapidMmolPerUnit:round(fast,4),isfRegularMmolPerUnit:round(regular,4),icrGramsPerUnit:round(ratio,4),unitsPerXE:round(g/ratio,4),limits:'Грубые популяционные формулы. Не применяются как персональные дозы, время введения и коррекции.'};
}
function observedCarbRatio(input){
 const dose=input?.dailyMealBolusUnits,units=input?.dailyCarbXE,grams=input?.dailyCarbGrams,xe=input?.xeGrams??12;
 if(!finite(dose)||Number(dose)<=0||!finite(xe)||Number(xe)<=0)return {status:'invalid'};
 const g=finite(grams)?Number(grams):finite(units)?Number(units)*Number(xe):NaN;
 if(!Number.isFinite(g)||g<=0)return {status:'invalid'};
 return {status:'descriptive-only',bolusUnits:Number(dose),carbGrams:round(g,2),carbXE:round(g/Number(xe),2),gramsPerUnit:round(g/Number(dose),3),unitsPerXE:round(Number(dose)*Number(xe)/g,3),warning:'Это наблюдаемое отношение суммарных записей, не индивидуальный лечебный УК: могли учитываться коррекции, перекусы, IOB и другие факторы.'};
}
function mealCompositionContext(input,now=Date.now()){
 const events=Array.isArray(input?.events)?input.events:[];
 const meals=events.filter(x=>x.type==='meal'&&x.status!=='planned'&&x.status!=='started'&&finite(x.ts)&&Number(x.ts)<=now).sort((a,b)=>Number(b.ts)-Number(a.ts));
 const x=meals[0];if(!x)return {status:'missing',message:'Приём пищи не зарегистрирован'};
 let nutrients={carbs:x.carbs,protein:x.protein,fat:x.fat,kcal:x.kcal};
 // A null/absent meal aggregate must never be interpreted as zero nutrient content.
 let detail=macroUnits(nutrients);
 const ageMinutes=Math.round((now-Number(x.ts))/60000);
 let stage=ageMinutes<90?'0–90 минут: ранняя динамика, важны время инсулина и тип углеводов':ageMinutes<120?'90–120 минут: часто заметен вклад углеводов':ageMinutes<=360?'120–360 минут: возможно влияние белков, жиров и состава еды':'Позднее 6 часов: нельзя приписывать изменения только этому приёму пищи';
 return {status:'observed',name:String(x.name||'Приём пищи'),ageMinutes,stage,macros:detail,notes:detail.possibleLateImpact?['Есть предпосылки проверить отсроченный подъём глюкозы, но это не его доказательство']:[],noExtraBolus:true};
}
Object.assign(global.GFMedical,{macroUnits,estimatedReferenceFactors,observedCarbRatio,mealCompositionContext});
})(typeof window!=='undefined'?window:globalThis);

/* GlucoPapa v0.16: retrospective 3-day log audit and descriptive insulin coefficients.
   All values derived from recorded doses and food. They are NOT clinical dosing advice. */
(function(global){'use strict';
const MS_DAY=86400000,MS_MIN=60000,ROUND=(v,n=2)=>Number(v.toFixed(n));
const ok=(x)=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
function period(e){const s=String(e.mealSlot||'').toLowerCase();if(['breakfast','lunch','dinner'].includes(s))return s;
 const h=new Date(Number(e.ts)).getHours();return h>=5&&h<11?'breakfast':h>=11&&h<16?'lunch':h>=16&&h<=23?'dinner':null;}
function replayThreeDays(input,now=Date.now()){
 const events=Array.isArray(input?.events)?input.events:[];
 const readings=Array.isArray(input?.readings)?input.readings:[];
 const tz=String(input?.profile?.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
 let dayFormatter;try{dayFormatter=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});}catch(e){return {status:'invalid-timezone',reason:'Неверная часовая зона профиля: '+tz};}
 function dayKey(ts){const parts=dayFormatter.formatToParts(new Date(Number(ts)));const get=(k)=>parts.find(x=>x.type===k)?.value;return get('year')+'-'+get('month')+'-'+get('day');}
 const todayKey=dayKey(now);const last3=[3,2,1].map(d=>{const date=new Date(todayKey+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-d);return date.toISOString().slice(0,10);});
 const daily=[],flags=[],slots={breakfast:{grams:0,units:0,n:0,deltas:[]},lunch:{grams:0,units:0,n:0,deltas:[]},dinner:{grams:0,units:0,n:0,deltas:[]}};
 let severeDataError=false;
 const doseEntries=events.filter(e=>e.type==='insulin'&&ok(e.ts)&&ok(e.units)&&Number(e.units)>0);
 const seen=[];
 for(const e of doseEntries){
  // Suspicious double-entry is not silently removed: two actual injections can be recorded close together.
  const similar=seen.find(z=>Math.abs(Number(z.ts)-Number(e.ts))<MS_MIN&&z.insulinType===e.insulinType&&String(z.insulinName||'')===String(e.insulinName||'')&&Number(z.units)===Number(e.units));
  if(similar){flags.push('Подозрение на повторную запись инъекции '+new Date(Number(e.ts)).toISOString()); severeDataError=true;}
  seen.push(e);
 }
 const expectedBasal=Number(input?.profile?.expectedBasalInjectionsPerDay||0);
 for(let d=3;d>=1;d--){
  const key=last3[3-d];
  const meds=doseEntries.filter(e=>dayKey(e.ts)===key);
  const meals=events.filter(e=>e.type==='meal'&&e.status==='eaten'&&ok(e.ts)&&dayKey(e.ts)===key);
  const basal=meds.filter(e=>e.insulinType==='long');const short=meds.filter(e=>e.insulinType==='short');
  const mealBolus=short.filter(e=>e.doseReason==='meal');
  const dayFlags=[];if(basal.length===0)dayFlags.push('Нет базальных инъекций');
  if(expectedBasal>0&&basal.length!==expectedBasal)dayFlags.push('Количество базальных инъекций не соответствует настроенному графику ('+expectedBasal+')');
  for(const p of ['breakfast','lunch','dinner']){
   const ms=meals.filter(e=>period(e)===p);
   const ins=mealBolus.filter(e=>period(e)===p);
   if(ms.length!==1||ins.length!==1){dayFlags.push('Неоднозначный или отсутствующий '+p+' (еда='+ms.length+', пищевой инсулин='+ins.length+')');continue;}
   const m=ms[0],dose=ins[0];
   if(!ok(m.carbs)||Number(m.carbs)<0){dayFlags.push('Нет достоверных граммов углеводов: '+p);continue;}
   // Avoid guessing which dose was intended for which meal.
   if(Math.abs(Number(m.ts)-Number(dose.ts))>90*MS_MIN){dayFlags.push('Инъекция не связана по времени с приёмом пищи: '+p);continue;}
   slots[p].grams+=Number(m.carbs);slots[p].units+=Number(dose.units);slots[p].n++;
  }
  const cgm=readings.filter(r=>ok(r.ts)&&ok(r.mmol)&&dayKey(r.ts)===key&&Number(r.mmol)>1.5&&Number(r.mmol)<35);
  const coverage=ROUND(cgm.length/288*100,1);
  if(coverage<80)dayFlags.push('Покрытие CGM менее 80%: '+coverage+'%');
  if(meds.length===0||meals.length<3||mealBolus.length<3)dayFlags.push('Не полностью заполнен дневник инсулина и еды');
  const day={date:key,totalUnits:ROUND(meds.reduce((s,e)=>s+Number(e.units),0),2),basalUnits:ROUND(basal.reduce((s,e)=>s+Number(e.units),0),2),mealBolusUnits:ROUND(mealBolus.reduce((s,e)=>s+Number(e.units),0),2),otherShortUnits:ROUND(short.reduce((s,e)=>s+Number(e.units),0)-mealBolus.reduce((s,e)=>s+Number(e.units),0),2),carbGrams:ROUND(meals.reduce((s,e)=>s+(ok(e.carbs)?Number(e.carbs):0),0),2),mealCount:meals.length,basalCount:basal.length,shortCount:short.length,cgmPoints:cgm.length,cgmCoveragePercent:coverage,flags:dayFlags};
  if(dayFlags.length){flags.push(key+': '+dayFlags.join('; '));severeDataError=true;}
  daily.push(day);
 }
 const daysWithSufficientData=daily.filter(d=>!d.flags.length).length;
 const mean=daily.every(d=>d.totalUnits>0)&&!severeDataError?ROUND(daily.reduce((s,d)=>s+d.totalUnits,0)/3,4):null;
 const theo=mean!==null?global.GFMedical.estimatedReferenceFactors({tdd:mean}):null;
 const slotOut={};let anyMismatch=false;
 for(const [k,x] of Object.entries(slots)){
  const ratio=x.n===3&&x.units>0?ROUND(x.grams/x.units,3):null;
  const deviation=ratio!==null&&theo?ROUND((ratio/theo.icrGramsPerUnit-1)*100,1):null;
  if(deviation!==null&&Math.abs(deviation)>30){flags.push('Наблюдаемое отношение для '+k+' отличается от формулы 500/СДИ на '+deviation+'%; требуется проверка контекста и журнала');anyMismatch=true;}
  slotOut[k]={meals:x.n,carbGrams:ROUND(x.grams,2),recordedMealInsulinUnits:ROUND(x.units,2),observedGramsPerUnit:ratio,deviationFromReferencePercent:deviation,status:ratio===null?'insufficient':'descriptive-only'};
 }
 const validCgm=readings.filter(r=>ok(r.ts)&&last3.includes(dayKey(r.ts))&&ok(r.mmol)&&Number(r.mmol)>1.5&&Number(r.mmol)<35);
 const counts={below:0,inRange:0,above:0};for(const r of validCgm){if(r.mmol<3.9)counts.below++;else if(r.mmol<=10)counts.inRange++;else counts.above++;}
 const n=validCgm.length;
 const mealData=events.filter(e=>e.type==='meal'&&e.status==='eaten'&&ok(e.ts)&&last3.includes(dayKey(e.ts)));
 const nonCarbKcal=mealData.reduce((s,e)=>s+((ok(e.protein)?4*Number(e.protein):0)+(ok(e.fat)?9*Number(e.fat):0)),0);
 const activity=events.filter(e=>e.type==='activity'&&ok(e.ts)&&last3.includes(dayKey(e.ts)));
 const illness=events.filter(e=>e.type==='illness'&&ok(e.ts)&&last3.includes(dayKey(e.ts))&&e.isActive===true);
 if(illness.length)flags.push('В журнале болезнь: коэффициенты по трём дням могут быть нерепрезентативны для здорового состояния');
 if(activity.length)flags.push('Есть физическая активность: простое отношение пищевых доз к граммам углеводов не устраняет её влияние');
 return {timeZone:tz,status:severeDataError?'needs-review':anyMismatch?'provisional-disagreement':'provisional',dayCount:3,daysWithSufficientData:daysWithSufficientData,daily,tddMean:mean,reference:theo?{isfRapidMmolPerUnit:theo.isfRapidMmolPerUnit,isfRegularMmolPerUnit:theo.isfRegularMmolPerUnit,icrGramsPerUnit:theo.icrGramsPerUnit}:null,observedByMeal:slotOut,cgm:{points:n,belowPercent:n?ROUND(100*counts.below/n,2):null,inRangePercent:n?ROUND(100*counts.inRange/n,2):null,abovePercent:n?ROUND(100*counts.above/n,2):null},food:{mealCount:mealData.length,nonCarbKcal:ROUND(nonCarbKcal,1)},activityEpisodes:activity.length,illnessEpisodes:illness.length,flags,explanation:'Предварительный расчёт по зарегистрированным событиям за 3 завершённых дня. Не учитывает точно IOB, коррекции, стресс, болезнь, нагрузку и задержку усвоения. Не является проверенной моделью для назначения доз.'};
}
Object.assign(global.GFMedical,{replayThreeDays});
})(typeof window!=='undefined'?window:globalThis);


/* GlucoPapa v0.17: strict historical 5-calendar-day coefficient audit.
 * No dose advice. Can be run in Node.js (with medical_engine.js) or browser.
 * The 500/100/83 rules are descriptive initial hypotheses only. */
(function(global){'use strict';
const round=(x,n=3)=>Number(x.toFixed(n));
const valid=(x)=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
function replayFiveDays(input,now=Date.now()){
 const events=Array.isArray(input?.events)?input.events:[],readings=Array.isArray(input?.readings)?input.readings:[];
 const tz=String(input?.profile?.timeZone||'UTC');let fmt;
 try{fmt=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});}catch(e){return {status:'invalid-timezone',flags:['В профиле неверный часовой пояс']};}
 const key=(ts)=>{const p=fmt.formatToParts(new Date(Number(ts)));const get=k=>p.find(x=>x.type===k)?.value;return `${get('year')}-${get('month')}-${get('day')}`};
 const today=key(now),base=new Date(today+'T12:00:00Z'),keys=[5,4,3,2,1].map(n=>{const d=new Date(base);d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10)});
 const flags=[],daily=[],mealTotals={breakfast:{carbs:0,dose:0,n:0},lunch:{carbs:0,dose:0,n:0},dinner:{carbs:0,dose:0,n:0}};
 const doses=events.filter(e=>e.type==='insulin');const seen=[];
 for(const e of doses){
  if(!valid(e.ts)||!valid(e.units)||!(Number(e.units)>0)) {flags.push('Некорректная запись инсулина');continue;}
  if(seen.some(a=>Math.abs(Number(e.ts)-Number(a.ts))<60000&&e.insulinType===a.insulinType&&String(e.insulinName||'')===String(a.insulinName||'')&&Number(e.units)===Number(a.units)))flags.push('Подозрение на дублирующую инъекцию '+new Date(Number(e.ts)).toISOString());
  seen.push(e);
 }
 const expected=Number(input?.profile?.expectedBasalInjectionsPerDay||0);
 const slot=(e)=>{if(['breakfast','lunch','dinner'].includes(e.mealSlot))return e.mealSlot;const hour=new Date(Number(e.ts)).getUTCHours();return hour<11?'breakfast':hour<17?'lunch':'dinner'};
 for(const k of keys){
  const meds=doses.filter(e=>valid(e.ts)&&key(e.ts)===k),
        basal=meds.filter(e=>e.insulinType==='long'),rapid=meds.filter(e=>e.insulinType==='short'),
        food=events.filter(e=>e.type==='meal'&&e.status==='eaten'&&valid(e.ts)&&key(e.ts)===k),
        pBolus=rapid.filter(e=>e.doseReason==='meal');
  const issues=[];
  if(expected&&basal.length!==expected)issues.push('Базальных инъекций '+basal.length+' (ожидается '+expected+')');
  if(!expected&&basal.length===0)issues.push('Не зарегистрирована базальная инъекция');
  const cgm=readings.filter(r=>valid(r.ts)&&key(r.ts)===k&&valid(r.mmol)&&Number(r.mmol)>1.5&&Number(r.mmol)<35).sort((a,b)=>Number(a.ts)-Number(b.ts));
  const unique=new Set(cgm.map(r=>Number(r.ts))).size;
  if(cgm.length!==unique)issues.push('Повторные показания CGM');
  const coverage=round(100*unique/288,1);
  if(coverage<80)issues.push('Покрытие CGM ниже 80%');
  if(cgm.some((r,i)=>i&&Number(r.ts)-Number(cgm[i-1].ts)>20*60*1000))issues.push('Разрыв CGM больше 20 мин');
  for(const s of ['breakfast','lunch','dinner']){
   const mf=food.filter(e=>slot(e)===s),mb=pBolus.filter(e=>slot(e)===s);
   if(mf.length!==1||mb.length!==1){issues.push('Пропущена/дублирована еда или пищевой инсулин: '+s);continue;}
   if(!valid(mf[0].carbs)||Number(mf[0].carbs)<0||!valid(mb[0].units)) {issues.push('Некорректны граммы или доза для '+s);continue;}
   if(Math.abs(Number(mf[0].ts)-Number(mb[0].ts))>90*60000) {issues.push('Инсулин не связан по времени с едой '+s);continue;}
   mealTotals[s].carbs+=Number(mf[0].carbs);mealTotals[s].dose+=Number(mb[0].units);mealTotals[s].n++;
  }
  if(issues.length)flags.push(`${k}: ${issues.join('; ')}`);
  daily.push({date:k,levemirUnits:round(basal.reduce((s,e)=>s+Number(e.units||0),0),2),novorapidUnits:round(rapid.reduce((s,e)=>s+Number(e.units||0),0),2),totalUnits:round(meds.reduce((s,e)=>s+Number(e.units||0),0),2),carbGrams:round(food.reduce((s,e)=>s+Number(e.carbs||0),0),1),meals:food.length,basalCount:basal.length,shortCount:rapid.length,cgmPoints:unique,cgmCoveragePercent:coverage,issues});
 }
 const validDays=daily.filter(x=>x.issues.length===0).length;const invalid=flags.length>0;
 const tdd=invalid?null:round(daily.reduce((s,d)=>s+d.totalUnits,0)/5,4);
 const formula=tdd===null?null:global.GFMedical.estimatedReferenceFactors({tdd});
 const reference=formula?{isfNovorapidMmolPerUnit:formula.isfRapidMmolPerUnit,isfRegularMmolPerUnit:formula.isfRegularMmolPerUnit,carbGramsPerUnit:formula.icrGramsPerUnit}:null;
 const byMeal={};let disagreement=false;
 for(const [s,tot] of Object.entries(mealTotals)){
  const x=tot.n===5&&tot.dose>0?round(tot.carbs/tot.dose,3):null;
  const dev=x!==null&&reference?round(100*(x/reference.carbGramsPerUnit-1),1):null;
  if(dev!==null&&Math.abs(dev)>30)disagreement=true;
  byMeal[s]={count:tot.n,carbGrams:tot.carbs,recordedInsulinUnits:tot.dose,observedGramsPerUnit:x,deviationFrom500RulePct:dev};
 }
 const active=events.filter(e=>valid(e.ts)&&keys.includes(key(e.ts)));
 const mealList=active.filter(e=>e.type==='meal'&&e.status==='eaten');
 const illness=active.filter(e=>e.type==='illness'&&e.isActive===true).length;
 const activity=active.filter(e=>e.type==='activity').length;
 if(illness)flags.push('Отмечена болезнь: коэффициенты могут измениться');
 if(activity)flags.push('Отмечена физическая активность: влияет на сравнение с формулой');
 if(disagreement)flags.push('Наблюдаемое г/ЕД отличается от 500/СДИ >30% хотя бы для одного приёма пищи');
 const cgm=readings.filter(r=>valid(r.ts)&&keys.includes(key(r.ts))&&valid(r.mmol)&&Number(r.mmol)>1.5&&Number(r.mmol)<35),counts={low:0,target:0,high:0};
 for(const r of cgm){if(Number(r.mmol)<3.9)counts.low++;else if(Number(r.mmol)<=10)counts.target++;else counts.high++}
 return {version:'0.17-test',source:'v0.16 GFMedical + strict five-day audit',synthetic:true,status:invalid?'needs-review':disagreement?'provisional-disagreement':'provisional',timeZone:tz,dayCount:5,validDays,daily,tddMean:tdd,reference,byMeal,cgm:{total:cgm.length,lowPercent:cgm.length?round(counts.low*100/cgm.length,2):null,targetPercent:cgm.length?round(counts.target*100/cgm.length,2):null,highPercent:cgm.length?round(counts.high*100/cgm.length,2):null},nutrition:{meals:mealList.length,proteinGrams:round(mealList.reduce((s,e)=>s+Number(e.protein||0),0),1),fatGrams:round(mealList.reduce((s,e)=>s+Number(e.fat||0),0),1),nonCarbKcal:round(mealList.reduce((s,e)=>s+4*Number(e.protein||0)+9*Number(e.fat||0),0),1)},activityEpisodes:activity,illnessEpisodes:illness,flags,warning:'Числа 100/83/500 — справочные популяционные оценки. Отношение г/ЕД из журнала описывает назначенные/введённые дозы и не является подтверждённой физиологической потребностью.'};
}
Object.assign(global.GFMedical,{replayFiveDays});
})(typeof window!=='undefined'?window:globalThis);
