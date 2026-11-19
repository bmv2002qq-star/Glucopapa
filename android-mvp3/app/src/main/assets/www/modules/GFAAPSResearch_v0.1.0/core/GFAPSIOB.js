/* Independent mathematical transcription of exponential IOB idea in AAPS ICfg.kt.
   Computation is descriptive; not an estimate of dose to administer. */
(function(root,f){let U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;let api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSIOB=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function single(units,elapsedMinutes,diaMinutes,peakMinutes){
  U.requireFinite(units,'units',0,100);U.requireFinite(elapsedMinutes,'elapsed',-2000,100000);
  U.requireFinite(diaMinutes,'DIA',300,600);U.requireFinite(peakMinutes,'peak',1,240);
  U.assert(peakMinutes<diaMinutes/2,'Пик должен быть раньше половины DIA');
  if(elapsedMinutes<0||elapsedMinutes>=diaMinutes||units===0)return {iobU:elapsedMinutes<0?0:0,activityUPerMin:0};
  const t=elapsedMinutes,D=diaMinutes,p=peakMinutes;
  const tau=p*(1-p/D)/(1-2*p/D),a=2*tau/D;
  const s=1/(1-a+(1+a)*Math.exp(-D/tau));
  const activity=units*(s/tau**2)*t*(1-t/D)*Math.exp(-t/tau);
  const iob=units*(1-s*(1-a)*((t*t/(tau*D*(1-a))-t/tau-1)*Math.exp(-t/tau)+1));
  U.assert(U.finite(iob)&&U.finite(activity),'IOB не конечен');
  return {iobU:U.clamp(iob,0,units),activityUPerMin:Math.max(0,activity)};
}
function at(injections,time,params){U.assert(Array.isArray(injections),'Нет истории инъекций');const n=U.ts(time);U.assert(Number.isFinite(n),'Нет времени');
  let iobU=0,activityUPerMin=0,ignoredBasal=0;
  for(const e of injections){U.assert(e.status==='actual','Нельзя учитывать плановый укол');
    if(e.type==='basal'){ignoredBasal++;continue;}
    U.assert(e.type==='rapid','Неизвестный тип инсулина');
    const age=(n-U.ts(e.ts))/U.MIN;
    if(params.rapidCurve){
      U.requireFinite(e.units,'units',0,100);
      if(age<0||e.units===0)continue;
      const curve=params.rapidCurve(age);
      iobU+=e.units*curve.remainingFraction;
      activityUPerMin+=e.units*curve.activityFractionPerMinute;
    }else{
      const k=single(e.units,age,params.diaMinutes,params.peakMinutes);
      iobU+=k.iobU;
      activityUPerMin+=k.activityUPerMin;
    }
  }return {iobU:U.round(iobU,5),activityUPerMin:U.round(activityUPerMin,8),ignoredBasal};
}
return {single,at};
});
