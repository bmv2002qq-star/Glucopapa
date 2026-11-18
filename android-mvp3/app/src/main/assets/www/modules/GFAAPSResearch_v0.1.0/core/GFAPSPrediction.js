/* Multiscenario analytical forecast; informed by AAPS IOB/COB/UAM distinctions,
 * NOT a port of determine-basal; NO pump / dose commands. Synthetic-only validation. */
(function(root,f){const b=typeof module==='object'&&module.exports;const U=b?require('./utils'):root.GFAPSUtils,G=b?require('./GFAPSInputGuard'):root.GFAPSInputGuard,I=b?require('./GFAPSIOB'):root.GFAPSIOB,C=b?require('./GFAPSCOB'):root.GFAPSCOB;const api=f(U,G,I,C);if(b)module.exports=api;root.GFAPSPrediction=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U,G,I,C){
'use strict';
function predict(snapshot,{horizonMinutes=120,stepMinutes=5,absorptionTimeMinutes=150}={}){
 const guard=G.inspect(snapshot);
 if(!guard.ok)return {ok:false,status:'insufficient_data',errors:guard.errors,warnings:guard.warnings,points:[]};
 U.assert(Number.isInteger(horizonMinutes)&&horizonMinutes>0&&horizonMinutes<=240,'Горизонт 1–240 минут');
 U.assert(Number.isInteger(stepMinutes)&&stepMinutes>0&&horizonMinutes%stepMinutes===0&&stepMinutes<=10,'Некорректный шаг');
 U.requireFinite(absorptionTimeMinutes,'время сценария еды',30,480);
 const cg=snapshot.cgm.slice().sort((a,b)=>U.ts(a.ts)-U.ts(b.ts));
 const now=U.ts(snapshot.nowTs),last=cg.at(-1),lastTs=U.ts(last.ts),p=snapshot.parameters;
 const tail=cg.slice(-4),interval=(U.ts(tail.at(-1).ts)-U.ts(tail[0].ts))/U.MIN;
 const trend=U.clamp((tail.at(-1).mmol-tail[0].mmol)/interval,-0.06,0.06); // exploratory cap, not from AAPS
 const cob=C.estimate(snapshot),remaining=cob.remainingCarbsG;
 // UAM is *not* identified unlogged food; it is the observed positive unexplained component.
 const latest=cob.rows.at(-1),uam=U.clamp(Math.max(0,latest.deviationMmol||0),0,0.35);
 const branches={IOB:last.mmol,COB:last.mmol,UAM:last.mmol};let carbsLeft=remaining;
 let points=[{minute:0,ts:lastTs,IOB:U.round(last.mmol),COB:U.round(last.mmol),UAM:U.round(last.mmol),iobU:I.at(snapshot.insulin,lastTs,p).iobU,cobG:U.round(remaining)}];
 for(let m=stepMinutes;m<=horizonMinutes;m+=stepMinutes){
   const t=lastTs+m*U.MIN;
   const act=I.at(snapshot.insulin,t,p),insulinEffect=-act.activityUPerMin*p.isfMmolPerU*stepMinutes;
   const dampedTrend=trend*Math.exp(-m/35)*stepMinutes;
   const deltaCarbs=carbsLeft*(1-Math.exp(-stepMinutes/absorptionTimeMinutes));
   carbsLeft=Math.max(0,carbsLeft-deltaCarbs);
   const carbEffect=deltaCarbs*p.isfMmolPerU/p.crGPerU;
   const uamEffect=uam*Math.exp(-m/35)*stepMinutes/5;
   branches.IOB+=insulinEffect+dampedTrend;
   branches.COB+=insulinEffect+dampedTrend+carbEffect;
   branches.UAM+=insulinEffect+dampedTrend+carbEffect+uamEffect;
   if(Object.values(branches).some(x=>!U.finite(x)||x<0||x>35))return {ok:false,status:'out_of_model_range',errors:['Прогноз за пределами допустимой расчётной области'],warnings:guard.warnings,points:[]};
   points.push({minute:m,ts:t,IOB:U.round(branches.IOB),COB:U.round(branches.COB),UAM:U.round(branches.UAM),iobU:act.iobU,cobG:U.round(carbsLeft)});
 }
 return {ok:true,status:'research_only',warnings:guard.warnings,points,input:{lastMmol:last.mmol,trendMmolPerMin:U.round(trend,5),estimatedCobG:remaining},method:'AAPS-inspired multiscenario independent approximation; not AndroidAPS determine-basal output',isDoseAdvice:false};
}
return {predict};
});
