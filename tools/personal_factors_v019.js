/* GlucoPapa 0.19: research-only retrospective estimates, not insulin prescribing.
   Requires independently audited time-stamped records. Estimates are observational
   and may be biased by CGM lag, remaining insulin, basal variations and missing events. */
(function(root){'use strict';
const finite=v=>v!==null&&v!==''&&Number.isFinite(Number(v));
const med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2};
const rd=(v,n=3)=>v===null?null:+v.toFixed(n);
function factorFromValues(vals,minCount=3){
 const n=vals.length,values=vals.map(z=>z.estimate),center=med(values),mad=center===null?null:med(values.map(x=>Math.abs(x-center))),scatter=center?mad/center:null;
 const maxDeviation=center?Math.max(0,...values.map(v=>Math.abs(v-center)/center)):null;
 const outlierCount=center?values.filter(v=>Math.abs(v-center)/center>.25).length:0;
 return {status:n<minCount?'insufficient':(scatter>.25||maxDeviation>.30)?'unstable':'provisional',n,median:rd(center),mad:rd(mad),relativeMADPercent:rd(scatter===null?null:scatter*100,1),maxDeviationPercent:rd(maxDeviation===null?null:maxDeviation*100,1),outlierCount,samples:vals.map(x=>({time:new Date(x.ts).toISOString(),estimate:rd(x.estimate)}))};
}
function statsCGM(readings,t0,t1){const a=readings.filter(r=>finite(r.ts)&&finite(r.mmol)&&r.ts>=t0&&r.ts<=t1).sort((a,b)=>a.ts-b.ts);const unique=new Set(a.map(x=>x.ts)).size;let maxGap=0;for(let i=1;i<a.length;i++)maxGap=Math.max(maxGap,(a[i].ts-a[i-1].ts)/60000);return {coverage:unique/(1+Math.floor((t1-t0)/300000)),maxGap};}
function nearest(readings,t,dist=8){let best=null;for(const r of readings){const d=Math.abs(r.ts-t);if(d<=(dist*60000)&&(!best||d<best.dist))best={value:Number(r.mmol),dist:d};}return best?.value??null;}
function reasonExcluded(evt,events,t0,t1){let reason=null;
 const illness=events.filter(x=>x.type==='illness'&&finite(x.ts)).sort((a,b)=>a.ts-b.ts);
 let onset=null;for(const x of illness){
   if(x.isActive===true){if(onset===null)onset=Number(x.ts);}
   else if(x.isActive===false&&onset!==null){const end=Number(x.ts);if(onset<=t1&&end>=t0-240*60000)return 'болезнь';onset=null;}
 }
 if(onset!==null&&onset<=t1)return 'болезнь';
 for(const x of events){if(x===evt||!finite(x.ts))continue;const ts=Number(x.ts);
  if(x.type==='meal'&&ts>=t0-240*60000&&ts<=t1+10*60000)return 'другая еда или углеводы';
  if(x.type==='insulin'&&x.insulinType==='short'&&ts>=t0-300*60000&&ts<=t1+10*60000)return 'перекрытие короткого инсулина';
  if(x.type==='activity'&&ts>=t0-150*60000&&ts<=t1)return 'физическая активность';

 }
 return reason;
}
function starterFactors(tdd){
 const n=Number(tdd);if(!Number.isFinite(n)||n<=0)return {status:'missing-tdd'};
 return {status:'population-rule',tdd:n,isfRapidMmolPerUnit:rd(100/n,4),isfRegularMmolPerUnit:rd(83/n,4),carbGramsPerUnit:rd(500/n,4),warning:'Стартовые приближения, не индивидуальные назначения.'};
}
// Distinct auditing of a full 5-day set is delegated to existing GFMedical.replayFiveDays.
function estimate(input,now,medical){
 const audit=medical.replayFiveDays(input,now),out={version:'0.19-research',audit,reference:audit.reference||null,corrections:null,meals:{},excluded:[],status:'not-validated-for-treatment'};
 if(audit.tddMean===null||audit.tddMean===undefined)return {...out,corrections:{status:'journal-invalid',n:0},warning:'Журнал не прошёл аудит пяти суток. Персональные коэффициенты не рассчитываются.'};
 const events=input.events||[],R=input.readings||[];
 const excluded=(e,reason,kind)=>out.excluded.push({event:kind,time:new Date(e.ts).toISOString(),reason});
 const corrections=[];
 for(const e of events){if(e.type!=='insulin'||e.insulinType!=='short'||e.doseReason!=='correction')continue;
  const t=e.ts,t1=t+240*60000;if(t1>now){excluded(e,'ещё нет 4 ч наблюдения','correction');continue;}
  const reason=reasonExcluded(e,events,t,t1);if(reason){excluded(e,reason,'correction');continue;}
  const s=statsCGM(R,t,t1),pre=nearest(R,t),post=nearest(R,t1);if(s.coverage<.8||s.maxGap>20||pre===null||post===null){excluded(e,'недостоверные CGM','correction');continue;}
  const prior=nearest(R,t-30*60000);if(prior===null||Math.abs(prior-pre)>.75){excluded(e,'быстрое изменение глюкозы до события','correction');continue;}
  const est=(pre-post)/Number(e.units);if(!(est>0.1&&est<20)){excluded(e,'нет интерпретируемого снижения','correction');continue;}
  corrections.push({ts:t,estimate:est});
 }
 out.corrections=factorFromValues(corrections);
 // Meal endpoint method deliberately has strict clean-window requirements.
 const mealResults={breakfast:[],lunch:[],dinner:[]};
 const isf=out.corrections.status==='provisional'?out.corrections.median:audit.reference?.isfNovorapidMmolPerUnit;
 for(const m of events){if(m.type!=='meal'||m.status!=='eaten')continue;
  const t=m.ts,t1=t+240*60000,slot=m.mealSlot;if(!mealResults[slot])continue;
  if(t1>now){excluded(m,'ещё нет 4 ч наблюдения','meal');continue;}
  const matching=events.filter(b=>b.type==='insulin'&&b.insulinType==='short'&&b.doseReason==='meal'&&b.mealSlot===slot&&Math.abs(b.ts-t)<=45*60000);
  if(matching.length!==1){excluded(m,'нет однозначной пищевой инъекции','meal');continue;}
  const b=matching[0];
  const conflicts=events.filter(x=>x!==m&&x!==b);
  const conf=reasonExcluded(m,conflicts,t,t1);if(conf){excluded(m,conf,'meal');continue;}
  if(4*Number(m.protein||0)+9*Number(m.fat||0)>320){excluded(m,'высокие белки/жиры — поздняя абсорбция','meal');continue;}
  const s=statsCGM(R,t,t1),pre=nearest(R,t),post=nearest(R,t1);if(s.coverage<.8||s.maxGap>20||pre===null||post===null){excluded(m,'недостоверные CGM','meal');continue;}
  if(!isf||isf<=0){excluded(m,'нет даже стартовой ФЧИ','meal');continue;}
  const denominator=Number(b.units)+(post-pre)/isf;
  const est=Number(m.carbs)/denominator;
  if(!(est>3&&est<80)){excluded(m,'отклик непригоден для оценки','meal');continue;}
  mealResults[slot].push({ts:t,estimate:est});
 }
 for(const slot of Object.keys(mealResults)){
  const base=factorFromValues(mealResults[slot]);
  if(base.status==='provisional'&&out.corrections.status!=='provisional')base.status='reference-dependent';
  out.meals[slot]={...base,isfSource:out.corrections.status==='provisional'?'наблюдаемая ФЧИ':'популяционная стартовая ФЧИ'};
 }
 out.warning='Исследовательская ретроспективная оценка, не назначение доз. Простой 4-часовой отклик не отделяет все физиологические влияния и не валидирован у ребёнка.';
 return out;
}
root.GFPersonal19={estimate,starterFactors,factorFromValues,nearest,statsCGM};if(typeof module!=='undefined'&&module.exports)module.exports=root.GFPersonal19;
})(typeof window==='undefined'?globalThis:window);
