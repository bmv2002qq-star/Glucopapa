/* GlucoPapa 0.21: experimental calibration of time-resolved prediction.
 * No clinical claims; learning on invented histories with hidden test subjects.
 * NOT a device for choosing an insulin dose or amount of rescue carbohydrates.
 * This model is frozen and REJECTED for non-synthetic application.
 */
(function(root){ 'use strict';
 const MODEL={"version":"0.21-research","params":{"15":[0.046106,0.075743,0.003427,1.438059,0.019341,0.028333,1.003098,-0.00421,0.00112,0.011356],"30":[0.0,0.076166,0.00427,1.467508,0.020036,0.034027,1.006785,-0.017932,0.021893,0.0195],"60":[0.0,0.069917,0.004129,1.433652,0.021265,0.035315,1.022283,-0.02416,0.06809,0.014249],"120":[0.0,0.060392,0.003183,1.3724,0.024322,0.022844,1.046944,-0.072959,0.09421,0.007283]},"baseline":[0.5,0.08,0.0018,1.3,0.019,0.025,1.0,0.0,0.0,0.0],"reference":{"carb":[2.35,32,0],"rapid":[3.3,45,10],"fat":[3.2,75,60],"basal":[2,380,60],"activity":[2,60,0]},"features":["trend","carbs","protein_fat","rapid","basal","activity","illness","circadian_sin","circadian_cos","intercept"],"populationOnly":true,"outOfSampleGuard":{"pass":false,"reason":"60-minute low-glucose false-negative count worsened on held-out synthetic histories."}};
 const finite=n=>Number.isFinite(Number(n));
 const n=v=>Number(v);
 const H=[15,30,60,120],MINUTE=60000;
 function wave(age,shape,scale,onset){
   if(!finite(age)||age<=onset)return 0;
   const x=(age-onset)/scale,k=shape-1;
   return Math.exp(k*Math.log(x)-x+k-k*Math.log(k));
 }
 function response(name,age){const p=MODEL.reference[name];return wave(age,p[0],p[1],p[2]);}
 function recentRate(readings,now){
   const a=(readings||[]).filter(r=>finite(r.ts)&&finite(r.mmol)&&r.ts<=now&&r.ts>=now-20*MINUTE).sort((a,b)=>a.ts-b.ts);
   if(a.length<5)return null;
   const b=a.slice(-5),xs=b.map(x=>(x.ts-b[4].ts)/MINUTE),ys=b.map(x=>n(x.mmol));
   const xm=xs.reduce((a,b)=>a+b,0)/5,ym=ys.reduce((a,b)=>a+b,0)/5;
   if(b.some((x,i)=>i>0&&(x.ts-b[i-1].ts)>5.01*MINUTE))return null;
   const denom=xs.reduce((s,x)=>s+(x-xm)**2,0);
   return denom?xs.reduce((s,x,i)=>s+(x-xm)*(ys[i]-ym),0)/denom:null;
 }
 function eventFeatures(events,now,h){
   const f=[0,0,0,0,0,0];
   for(const e of events||[]){
     if(!finite(e.ts)||n(e.ts)>now)continue;
     const age=(now-n(e.ts))/MINUTE;
     if(age>2400)continue;
     const delta=k=>response(k,age+h)-response(k,age);
     if(e.type==='meal'){
       f[0]+=n(e.carbs||0)*delta('carb');
       f[1]+=(4*n(e.protein||0)+9*n(e.fat||0))*delta('fat');
     } else if(e.type==='insulin'){
       if(e.insulinType==='short')f[2]-=n(e.units||0)*delta('rapid');
       else if(e.insulinType==='long')f[3]-=n(e.units||0)*delta('basal');
     } else if(e.type==='activity'){
       if(['walk','aerobic','cycling','run'].includes(String(e.typeOfActivity||'').toLowerCase()))
         f[4]-=n(e.durationMin||0)*delta('activity');
     } else if(e.type==='illness'){
       const s=e.isActive===true?1:-1;
       f[5]+=s*(Math.max(0,Math.min(1,(age+h)/120))-Math.max(0,Math.min(1,age/120)));
     }
   }
   return f;
 }
 function vector(readings,events,now,h){
   const rate=recentRate(readings,now);if(rate===null)return null;
   const phase=((now/MINUTE)%(24*60))/(24*60)*2*Math.PI;
   return [rate*40*(1-Math.exp(-h/40)),...eventFeatures(events,now,h),Math.sin(phase)*h/120,Math.cos(phase)*h/120,1];
 }
 function forecast(readings,events,now,h,opts={}){
   if(!H.includes(h))return {status:'invalid-horizon'};
   const a=(readings||[]).filter(r=>finite(r.ts)&&finite(r.mmol)&&r.ts<=now).sort((x,y)=>x.ts-y.ts);
   const last=a.at(-1);
   if(!last||now-last.ts>10*MINUTE||n(last.mmol)<1.5||n(last.mmol)>35)return {status:'missing-fresh-CGM'};
   const X=vector(a,events,now,h);if(!X)return {status:'incomplete-CGM-context'};
   if(!opts.syntheticFixture)return {status:'research-only-not-authorized-for-patient',referenceMmol:null};
   const choice=opts.useCalibrated===true?'params':'baseline';
   const w=MODEL[choice][String(h)];
   const coefficients=Array.isArray(w)?w:MODEL.baseline;
   const y=n(last.mmol)+X.reduce((s,v,i)=>s+v*coefficients[i],0);
   return {status:'research-only',horizonMin:h,glucoseMmol:Math.round(y*1e4)/1e4,
     currentMmol:n(last.mmol),model:choice==='params'?'calibrated-out-of-sample':'baseline-reference',
     passedClinicalValidation:false,extraCarbsForTreatment:null,insulinDoseForTreatment:null,
     caution:'Синтетическая калибровка; обнаружен рост пропущенных гипогликемий. НЕ использовать для лечебных доз.'};
 }
 function hypothetical(readings,events,now,h,action,opts={}){
   if(!opts.syntheticFixture)return {status:'research-only-not-authorized-for-patient'};
   const base=forecast(readings,events,now,h,{syntheticFixture:true,useCalibrated:opts.useCalibrated});
   if(base.status!=='research-only')return base;
   if(!action||!['meal','insulin'].includes(action.type))return {status:'invalid-action'};
   const actionTime=n(action.ts),horizonEnd=now+h*MINUTE;
   if(!finite(actionTime)||actionTime<now||actionTime>horizonEnd)return {status:'outside-horizon'};
   const ag=(horizonEnd-actionTime)/MINUTE;
   const c=MODEL[opts.useCalibrated===true?'params':'baseline'];
   const w=Array.isArray(c)?c:c[String(h)];
   let effect=0;
   if(action.type==='meal'){
     const grams=n(action.carbs);if(!finite(grams)||grams<0||grams>200)return {status:'invalid-carbs'};
     effect=w[1]*grams*response('carb',ag);
   }else{
     const u=n(action.units);if(action.insulinType!=='short'||!finite(u)||u<0||u>30)return {status:'invalid-insulin'};
     effect=-w[3]*u*response('rapid',ag);
   }
   return {...base,modelActionEffectMmol:Math.round(effect*1e4)/1e4,glucoseMmol:Math.round((base.glucoseMmol+effect)*1e4)/1e4,
     treatmentRecommendation:null};
 }

 // Candidate selection uses ONLY validation observations, never test observations.
 // A gate can REJECT an unsafe transfer but cannot clinically validate a prediction.
 function validateAgainstPrior(readings,events,t0,t1,h,opts={}){
   if(!opts.syntheticFixture)return {status:'disabled-outside-synthetic-fixture'};
   if(!H.includes(h)||!finite(t0)||!finite(t1)||t1<=t0)return {status:'invalid-window'};
   const old=typeof require==='function' ? require('./temporal_engine_v018.js') : root.GFTemporal18;
   if(!old)return {status:'reference-model-unavailable'};
   const data=(readings||[]).filter(x=>finite(x.ts)&&finite(x.mmol)).sort((a,b)=>a.ts-b.ts);
   const ev=(events||[]).filter(e=>finite(e.ts)).sort((a,b)=>a.ts-b.ts);
   let n=0, sumOld=0,sumNew=0,low=0,missOld=0,missNew=0;
   const step=(opts.stepMin||15)*MINUTE;
   for(let t=t0;t+h*MINUTE<=t1;t+=step){
     const actual=data.find(r=>Math.abs(r.ts-(t+h*MINUTE))<=60*1000);
     if(!actual||ev.some(e=>e.ts>t&&e.ts<=t+h*MINUTE))continue;
     const past=data.filter(r=>r.ts<=t&&r.ts>=t-30*MINUTE);
     const o=old.forecast(past,ev.filter(e=>e.ts<=t),t,h);
     const x=forecast(past,ev.filter(e=>e.ts<=t),t,h,{syntheticFixture:true,useCalibrated:true});
     if(o.status!=='experimental'||x.status!=='research-only')continue;
     n++;sumOld+=Math.abs(o.forecastMmol-actual.mmol);
     sumNew+=Math.abs(x.glucoseMmol-actual.mmol);
     if(actual.mmol<3.9){low++;if(o.forecastMmol>=3.9)missOld++;if(x.glucoseMmol>=3.9)missNew++;}
   }
   const oldMae=n?sumOld/n:null,newMae=n?sumNew/n:null;
   const enough=n>=(opts.minSamples||24)&&low>=(opts.minLowCases||3);
   const better=enough&&newMae<oldMae*.95&&missNew<=missOld;
   return {status:'research-validation',horizonMin:h,n,lowCases:low,
     referenceMAE:oldMae===null?null:+oldMae.toFixed(4),candidateMAE:newMae===null?null:+newMae.toFixed(4),
     missedLowReference:missOld,missedLowCandidate:missNew,
     decision:better?'research-candidate-on-synthetic-only':'retain-v018-reference',
     reason:!enough?'insufficient-samples-or-hypoglycemia':(missNew>missOld?'worse-hypoglycemia-detection':(newMae>=oldMae*.95?'insufficient-MAE-improvement':'passed-synthetic-gate')),
     warning:'Не разрешает клиническое применение. Тестовая оценка без врачебной валидации.'};
 }
 root.GFTemporal21={version:MODEL.version,model:MODEL,wave,response,recentRate,eventFeatures,vector,forecast,hypothetical,validateAgainstPrior};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.GFTemporal21;
})(typeof window==='undefined'?globalThis:window);
