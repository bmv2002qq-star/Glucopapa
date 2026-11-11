/* GlucoPapa v0.20: experimental research-only integration of retrospective
 * personal factors and temporal kernels. NOT a medical device and does not
 * prescribe insulin or hypoglycemia treatment. All action amounts are supplied
 * by a tester and may only be used on synthetic data in compareHypothetical.
 */
(function(root){'use strict';
 const temporal = typeof require==='function' ? require('./temporal_engine_v018.js') : root.GFTemporal18;
 const personal = typeof require==='function' ? require('./personal_factors_v019.js') : root.GFPersonal19;
 const medical = root.GFMedical;
 const horizons=[15,30,60,120];
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 const round=(n,p=4)=>finite(n)?Number(n.toFixed(p)):null;
 function calibrate(journal,now){
  if(!medical||!personal) throw Error('GFMedical/GFPersonal19 unavailable');
  const raw=personal.estimate(journal,now,medical);
  const ref=raw.reference||{};
  const validTdd=finite(raw.audit?.tddMean)&&raw.audit?.tddMean>0;
  const isfObserved=raw.corrections?.status==='provisional'&&finite(raw.corrections.median);
  const isf=isfObserved?raw.corrections.median:ref.isfNovorapidMmolPerUnit;
  const slots={};const evidence={};
  for(const s of ['breakfast','lunch','dinner']){
   const v=raw.meals?.[s];const observed=v?.status==='provisional'&&isfObserved&&finite(v.median);
   slots[s]=observed?v.median:ref.carbGramsPerUnit;
   evidence[s]={source:observed?'retrospective-observational':'population-500-rule',n:v?.n||0,status:v?.status||'missing'};
  }
  const valid=validTdd&&finite(isf)&&isf>0&&Object.values(slots).every(v=>finite(v)&&v>0);
  return {status:valid?'research-calibrated':'invalid-journal',tdd:valid?raw.audit.tddMean:null,
    isfRapid:valid?isf:null,isfSource:isfObserved?'retrospective-observational':'population-100-rule',
    icrGramsPerUnit:valid?slots:null,icrEvidence:evidence,
    iobModel:'v0.18 synthetic rapid kernel, 300 min; basal separate',
    cutoffTs:now,rawStatus:raw.audit?.status||'unknown',nCorrectionEpisodes:raw.corrections?.n||0,
    excludedEpisodes:raw.excluded?.length||0,reference:raw.reference||null,
    warning:'Коэффициенты ориентировочные; наблюдательные оценки могут быть смещены из-за еды, инсулина, физической активности, болезни и ошибок датчиков. Не назначать по ним лечение.'};
 }
 function slotForAt(ts,timeZone){ // UTC by default, local time from profile allowed
  let hour;
  try{hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:timeZone||'UTC',hour:'2-digit',hourCycle:'h23'}).format(new Date(ts)));}
  catch(e){return 'lunch'}
  return hour<11?'breakfast':hour<17?'lunch':'dinner';
 }
 function edge(kernel,now,h,ts){
  const start=(now-ts)/60000, end=start+h;
  return Math.max(0,temporal.f(kernel,end)-temporal.f(kernel,Math.max(0,start)));
 }
 function actionChange(action,now,h,calibration,options){
  if(!action||!['meal','insulin'].includes(action.type)) return {status:'unsupported'};
  const ts=Number(action.ts);if(!finite(ts)||ts<now-1000||ts>now+h*60000)return {status:'outside-horizon'};
  const slot=action.mealSlot||slotForAt(ts,options?.timeZone);
  const isf=calibration.isfRapid,icr=calibration.icrGramsPerUnit[slot];
  if(action.type==='meal'){
   const carbs=Number(action.carbs),fat=Number(action.fat||0),protein=Number(action.protein||0);
   if(!finite(carbs)||carbs<0||carbs>200||!finite(fat)||fat<0||!finite(protein)||protein<0)return {status:'invalid-input'};
   const fast=carbs*(isf/icr)*edge('carb',now,h,ts);
   // Fat/protein delayed component is intentionally not assigned a quantitative
   // insulin-equivalent effect: no validated personal gain has been fitted.
   return {status:'research-only',deltaMmol:fast,lateFatProtein:'not-quantified'};
  }
  const units=Number(action.units);
  if(action.insulinType!=='short'||!finite(units)||units<0||units>30)return {status:'unsupported-or-invalid-insulin'};
  return {status:'research-only',deltaMmol:-units*isf*edge('rapid',now,h,ts)};
 }
 function forecast(readings,history,now,h,calibration,options={}){
  if(!calibration||calibration.status!=='research-calibrated')return {status:'invalid-calibration'};
  const old=temporal.forecast(readings,history,now,h);
  if(old.status!=='experimental')return {...old,source:'v0.18 temporal baseline'};
  const all=temporal.eventEffects(now,h,history),c=temporal.coefficients[String(h)];
  const slot=options.slot||slotForAt(now,options.timeZone);
  const isf=calibration.isfRapid,icr=calibration.icrGramsPerUnit[slot];
  // Replace population synthetic rapid & carbohydrate impact with individualized
  // observational coefficients, keeping other temporal terms unchanged.
  const carbEffect=all[0],rapidEffect=all[2];
  // Each historical meal uses its own meal-time slot, not the current hour.
  let patientCarb=0;
  for(const e of history||[]){
   if(e.type!=='meal'||!finite(Number(e.ts))||Number(e.ts)>now)continue;
   const grams=Number(e.carbs||0),k=e.mealSlot||slotForAt(Number(e.ts),options.timeZone);
   const ratio=calibration.icrGramsPerUnit[k];
   if(finite(grams)&&grams>=0&&finite(ratio)&&ratio>0)
    patientCarb+=grams*(isf/ratio)*edge('carb',now,h,Number(e.ts));
  }
  let value=old.forecastMmol-c[4]*carbEffect-c[6]*rapidEffect+patientCarb+isf*rapidEffect;
  // A separate held-out check can downweight personalized contributions when
  // they worsen predictions. Default 1 is permitted ONLY in research sandbox.
  const authorizedResearch=options.syntheticFixture===true;
  // Never silently apply observational coefficients to real-world forecast.
  const weight=authorizedResearch ? (options.personalizationWeight===undefined?1:Number(options.personalizationWeight)) : 0;
  if(!finite(weight)||weight<0||weight>1)return {status:'invalid-personalization-weight'};
  const currentPersonalDelta=(value-old.forecastMmol)*weight;
  value=old.forecastMmol+currentPersonalDelta;
  const planned=options.plannedEvents||[];
  let added=0;const effects=[];
  for(const action of planned){const d=actionChange(action,now,h,calibration,options);if(d.status!=='research-only')return {status:'invalid-planned-action',reason:d.status};added+=d.deltaMmol;effects.push({type:action.type,deltaMmol:round(d.deltaMmol)});}
  value+=added;
  return {status:'research-only',horizonMin:h,baselineV018Mmol:round(old.forecastMmol),
    forecastMmol:round(value),differenceFromV018Mmol:round(currentPersonalDelta),
    plannedEffectMmol:round(added),plannedEffects:effects,
    estimatedIobUnits:round(temporal.iob(now,history).estimatedRemainingActionUnits),
    isfSource:calibration.isfSource,icrSource:calibration.icrEvidence[slot]?.source,
    usedPersonalFactors:weight>0,personalizationWeight:weight,quality:(value<1.5||value>35)?'out-of-model-range':'experimental-unvalidated',source:'synthetic v0.18 baseline with v0.19 observational gains',
    warning:'Исследовательский сценарий. Числа не прогнозируют безопасную конечную глюкозу с клинической достоверностью и не означают рекомендованные дозы.'};
 }
 function compareHypothetical(readings,history,now,calibration,actions,options={}){
  if(!options.syntheticFixture)return {status:'disabled-outside-synthetic-fixture',actions:[]};
  if(!Array.isArray(actions)||actions.length<1||actions.length>6)return {status:'invalid-actions'};
  const triage=medical?.triage({readings,events:history,profile:{}},options.exam||{},now)||null;
  if(triage?.status?.startsWith('emergency'))return {status:'emergency-triage-only',triage:triage.action};
  const results=actions.map(a=>({label:String(a.label||'Сценарий').slice(0,80),
    horizons:Object.fromEntries(horizons.map(h=>[h,forecast(readings,history,now,h,calibration,{...options,plannedEvents:a.events||[]})]))}));
  return {status:'research-only',triage:triage?.action||null,actions:results,
    warning:'Только синтетические данные. Не подбирать инсулин и быстрые углеводы для ребёнка по этому сравнению.'};
 }

 // Chronological backtest on observations strictly AFTER the five-day calibration
 // cutoff. It is not a clinical validation; it can REJECT a bad transfer only.
 function validateTransfer(readings,events,now,calibration,opts={}){
   const h=opts.horizonMin||60,step=opts.stepMinutes||30,window=opts.windowDays||2;
   if(!horizons.includes(h)||!(step>0&&step<=240))return {status:'invalid-settings'};
   if(!finite(calibration?.cutoffTs)||now-calibration.cutoffTs<(window*86400000+h*60000))
     return {status:'no-independent-post-calibration-window',count:0,decision:'use-reference-only'};
   const ts0=Math.max(calibration.cutoffTs+60000,now-window*86400000),end=now-h*60000;
   const observed=(readings||[]).filter(r=>finite(Number(r.ts))&&finite(Number(r.mmol))).sort((a,b)=>a.ts-b.ts);
   const history=(events||[]).filter(e=>finite(Number(e.ts)));
   let n=0,oldErr=0,newErr=0,oldMiss=0,newMiss=0,actualLow=0;
   for(let t=ts0;t<=end;t+=step*60000){
     const actual=observed.find(r=>Math.abs(r.ts-(t+h*60000))<=150000);
     if(!actual)continue;
     const past=observed.filter(r=>r.ts<=t&&r.ts>=t-40*60000);
     const old=temporal.forecast(past,history.filter(e=>e.ts<=t),t,h);
     const fit=forecast(past,history.filter(e=>e.ts<=t),t,h,calibration,{timeZone:opts.timeZone||'UTC',syntheticFixture:true});
     if(old.status!=='experimental'||fit.status!=='research-only')continue;
     oldErr+=Math.abs(old.forecastMmol-actual.mmol);newErr+=Math.abs(fit.forecastMmol-actual.mmol);n++;
     if(actual.mmol<3.9){actualLow++;if(old.forecastMmol>=3.9)oldMiss++;if(fit.forecastMmol>=3.9)newMiss++;}
   }
   if(n<(opts.minSamples||24))return {status:'too-few-clean-holdout-samples',count:n,decision:'use-reference-only'};
   const maeOld=oldErr/n,maeNew=newErr/n;
   const pass=maeNew<0.95*maeOld&&newMiss<=oldMiss;
   return {status:'research-backtest',count:n,horizonMin:h,maeOld:round(maeOld),maePersonal:round(maeNew),
     improvementPct:round(100*(maeOld-maeNew)/maeOld,2),actualLow,missedLowOld:oldMiss,missedLowPersonal:newMiss,
     decision:pass?'eligible-for-further-research':'use-reference-only',personalizationWeight:pass?1:0,
     warning:'Это контроль переноса на другую синтетическую историю, НЕ клиническая валидация.'};
 }
 root.GFJoint20={version:'0.20-research',calibrate,forecast,compareHypothetical,actionChange,edge,validateTransfer};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.GFJoint20;
})(typeof window==='undefined'?globalThis:window);
