/* ГлюкоПапа GFXDripLowAlert v0.1.0 — original JavaScript implementation of a
 * CGM-only time-to-low research alert. Algorithmic study: xDrip+ Forecast.java,
 * BgGraphBuilder.java and Notifications.java (NightscoutFoundation/xDrip,
 * revision 10739aa79c257f4fe5bacea705b0904ded0c1a27, GPL-3.0).
 * This is NOT a translation/copy of xDrip Java source. Independent OLS solver,
 * uniform units, original-scale cross-validation, conservative guards. No meals,
 * IOB, medical action or doses. No data persistence. NOT clinically validated.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFXDripLowAlert=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.1.0',MINUTE=60000;
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const clamp=(a,lo,hi)=>Math.max(lo,Math.min(hi,a));
const r=(n,nDigits=2)=>Math.round(n*10**nDigits)/10**nDigits;
const fail=(code,detail='')=>({version:VERSION,status:'UNAVAILABLE',code,detail,clinicalUse:false,points:[],timeToLowMin:null});
function parseTime(x){const ms=typeof x==='number'?x:typeof x==='string'&&/T/.test(x)&&/(Z|[+-]\d\d:\d\d)$/.test(x)?Date.parse(x):NaN;return Number.isFinite(ms)&&ms>=946684800000&&ms<=4102444800000?ms:NaN;}
function line(x,y){
 const n=x.length;if(n<2)return null;let sx=0,sy=0,sxx=0,sxy=0;
 for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i];}
 const d=n*sxx-sx*sx;if(!finite(d)||Math.abs(d)<1e-10)return null;
 const b=(n*sxy-sx*sy)/d, a=(sy-b*sx)/n;
 return finite(a)&&finite(b)?{a,b}:null;
}
const models={
 linear:{xx:t=>t,yy:v=>v,out:v=>v},
 logarithmic:{xx:t=>Math.log1p(t),yy:v=>v,out:v=>v},
 exponential:{xx:t=>t,yy:v=>Math.log(v),out:v=>Math.exp(v)},
 power:{xx:t=>Math.log1p(t),yy:v=>Math.log(v),out:v=>Math.exp(v)}
};
function fit(name,rows,t0){
 const m=models[name];if(!m||rows.length<2)return null;
 const x=rows.map(p=>m.xx((p.t-t0)/MINUTE));
 const y=rows.map(p=>m.yy(p.g));
 if(x.some(v=>!finite(v))||y.some(v=>!finite(v)))return null;
 const co=line(x,y);if(!co)return null;
 return {name,coefficients:co,predictMs:t=>m.out(co.a+co.b*m.xx((t-t0)/MINUTE))};
}
function scoreModel(name,rows,t0){
 // Leave-one-out error always measured in mmol/L, including log-space models.
 let err=0,count=0;
 for(let i=0;i<rows.length;i++){
  const train=rows.filter((_,j)=>i!==j),mod=fit(name,train,t0);
  if(!mod)return Infinity;
  const pred=mod.predictMs(rows[i].t);
  if(!finite(pred)||pred<0||pred>40)return Infinity;
  err+=(pred-rows[i].g)**2;count++;
 }
 return Math.sqrt(err/count);
}
function prepare(input,now){
 const src=input?.readings??input?.cgm;if(!Array.isArray(src))return {error:'CGM_MISSING'};
 const unique=new Map();
 for(const p of src){
  const t=parseTime(p?.measuredAt??p?.ts),received=parseTime(p?.receivedAt);
  const g=p?.glucoseMmol??p?.mmol;
  if(!finite(t)||!finite(g)||g<2||g>33||t>now+MINUTE)return {error:'CGM_INVALID'};
  if(!finite(received)||received<t-MINUTE||received>now+MINUTE)return {error:'CGM_TIME_INVALID'};
  if(p?.kind&&p.kind!=='observed')return {error:'CGM_NOT_OBSERVED'};
  const source=p?.sourceId??p?.sourceDeviceId;
  if(!source)return {error:'CGM_SOURCE_MISSING'};
  const prior=unique.get(t);
  if(prior && (Math.abs(prior.g-g)>0.001||prior.source!==source))return {error:'CGM_CONFLICT'};
  unique.set(t,{t,g,source,received});
 }
 const all=[...unique.values()].sort((a,b)=>a.t-b.t);
 if(all.length<5)return {error:'CGM_TOO_FEW'};
 const source=all.at(-1).source;
 if(all.some(x=>x.source!==source))return {error:'CGM_MIXED_SOURCE'};
 const age=(now-all.at(-1).t)/MINUTE;
 if(age>12)return {error:'CGM_STALE',ageMin:r(age,1)};
 const rows=all.filter(x=>x.t>=all.at(-1).t-30*MINUTE);
 if(rows.length<5)return {error:'CGM_RECENT_TOO_FEW'};
 if(rows.some((p,i)=>i && (p.t-rows[i-1].t)/MINUTE>8.5))return {error:'CGM_GAP'};
 if(rows.at(-1).t-rows[0].t<10*MINUTE)return {error:'CGM_SPAN_TOO_SHORT'};
 return {all,rows,age,source};
}
function predict(input={}){
 const now=parseTime(input.nowIso);if(!finite(now))return fail('CLOCK_INVALID');
 const threshold=finite(input.thresholdMmol)?input.thresholdMmol:3.9;
 const windowMin=finite(input.warningWindowMin)?input.warningWindowMin:30;
 const horizon=finite(input.horizonMin)?input.horizonMin:Math.max(30,windowMin);
 if(threshold<2.8||threshold>6||windowMin<5||windowMin>90||horizon<windowMin||horizon>120)return fail('SETTINGS_INVALID');
 const prep=prepare(input,now);
 if(prep.error)return {...fail(prep.error),ageMin:prep.ageMin??null};
 const {rows,age}=prep,last=rows.at(-1),first=rows[0],t0=first.t;
 const slopeFit=line(rows.map(p=>(p.t-last.t)/MINUTE),rows.map(p=>p.g));
 const recentSlope=slopeFit?.b;
 const volatility=Math.sqrt(rows.reduce((sum,p)=>sum+(p.g-(slopeFit.a+recentSlope*(p.t-last.t)/MINUTE))**2,0)/rows.length);
 if(!finite(recentSlope))return fail('TREND_INVALID');
 // A measured CGM below threshold is a distinct state, regardless of forecast fit.
 const observedLow=last.g<threshold;
 // Physiologically extreme changes, sensor problems, high scatter: do not publish
 // exact crossing time. Suggest verifying CGM with a blood glucose meter.
 if(Math.abs(recentSlope)>0.30 || volatility>0.70){
  return {version:VERSION,status:observedLow?'LOW_READING_VERIFY':'VERIFY_READING',code:'UNRELIABLE_FAST_OR_NOISY',clinicalUse:false,
   currentMmol:last.g,observedAt:new Date(last.t).toISOString(),ageMin:r(age,1),slopeMmolPerMin:r(recentSlope,3),noiseRmseMmol:r(volatility,3),
   warningWindowMin:windowMin,thresholdMmol:threshold,timeToLowMin:null,points:[],models:[],note:'Резкое/шумное изменение CGM: проверка глюкометром, не численный прогноз.'};
 }
 const candidates=[];
 for(const name of Object.keys(models)){
  const obj=fit(name,rows,t0),cv=scoreModel(name,rows,t0);
  if(!obj||!finite(cv))continue;
  const atNow=obj.predictMs(now),atH=obj.predictMs(now+horizon*MINUTE);
  if(!finite(atNow)||!finite(atH)||atNow<0||atNow>34||atH<0||atH>34)continue;
  // Reject models extrapolating rapidly upward while observed recent slope falls.
  if(recentSlope<-.015&&atNow>last.g+1.2)continue;
  candidates.push({name,cvRmseMmol:cv,mod:obj});
 }
 if(!candidates.length)return { ...fail('MODEL_UNSTABLE'),currentMmol:last.g };
 candidates.sort((a,b)=>a.cvRmseMmol-b.cvRmseMmol);
 const chosen=candidates[0],f=chosen.mod.predictMs;
 const next=[];let crossing=observedLow?0:null;
 for(let t=0;t<=horizon+0.001;t+=0.5){
  const v=f(now+t*MINUTE);
  if(!finite(v)||v<0||v>34)return { ...fail('MODEL_DIVERGENT'),currentMmol:last.g};
  if(crossing===null&&v<=threshold)crossing=t;
  if(Math.abs(t/5-Math.round(t/5))<1e-8)next.push({horizonMin:r(t,1),glucoseMmol:r(v,2)});
 }
 let state=observedLow?'HYPO_READING':crossing!==null&&crossing<=windowMin?'RISK_WITHIN_WINDOW':'NO_RISK_WITHIN_WINDOW';
 // Recalculate and compare slope of the last three, to expose accelerating decline.
 const latest3=rows.slice(-3);const trend3=line(latest3.map(p=>(p.t-last.t)/MINUTE),latest3.map(p=>p.g));
 const accelerationHint=trend3?trend3.b-recentSlope:null;
 // Model disagreement signals uncertain trend rather than a reliable minute count.
 const comparable=candidates.filter(c=>c.cvRmseMmol<=chosen.cvRmseMmol+0.25);
 const rivals=comparable.map(c=>c.mod.predictMs(now+Math.min(windowMin,15)*MINUTE));
 const disagreement=Math.max(...rivals)-Math.min(...rivals);
 const uncertainty=(chosen.cvRmseMmol>0.55||disagreement>1.2);
 if(uncertainty&&!observedLow)state='UNCERTAIN_TREND';
 return {version:VERSION,status:state,clinicalUse:false,currentMmol:last.g,
  observedAt:new Date(last.t).toISOString(),receivedAt:new Date(last.received).toISOString(),ageMin:r(age,1),sourceId:last.source,
  slopeMmolPerMin:r(recentSlope,3),accelerationHintMmolPerMin:r(accelerationHint??0,3),
  noiseRmseMmol:r(volatility,3),modelRmseMmol:r(chosen.cvRmseMmol,3),modelDisagreementMmol:r(disagreement,3),
  selectedModel:chosen.name,thresholdMmol:threshold,warningWindowMin:windowMin,
  timeToLowMin:uncertainty&&!observedLow?null:crossing===null?null:r(crossing,1),
  points:next,models:candidates.map(c=>({name:c.name,cvRmseMmol:r(c.cvRmseMmol,3)})),
  flags:[...(uncertainty?['MODEL_DISAGREEMENT']:[]),...(age>5?['CGM_DELAYED']:[]),...(input.synthetic===true?['SYNTHETIC']:[])],
  note:'Оценка тренда только CGM. IOB, COB и активность в этой ветви не учитываются.'};
}
return Object.freeze({VERSION,predict});
});
