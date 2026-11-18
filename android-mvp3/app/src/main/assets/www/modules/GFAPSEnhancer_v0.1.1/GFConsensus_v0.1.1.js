/* GFConsensus v0.1.1. Descriptive comparison only. No recommendations and no dosing decisions. */
(function(root,f){const api=f();if(typeof module==='object'&&module.exports)module.exports=api;root.GFConsensus=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const NAMES=['GFForecast','GFxDrip','GFAPSEnhancer'];
const isFiniteNumber=x=>typeof x==='number'&&Number.isFinite(x);
const M=60000;
function normalize(id,input,{asOf,sourceTime=null}={}){
 if(!NAMES.includes(id))throw Error('Неизвестная модель');
 if(!input||!Array.isArray(input.points))return {id,available:false,reason:'Модель не предоставила прогноз',points:[]};
 const rows=input.points.map(q=>({minute:q.minute??q.horizonMin,value:q.glucoseMmol??q.value??q.COB}));
 const seen=new Set(),points=[];
 for(const p of rows){
  if(!Number.isInteger(p.minute)||p.minute<0||p.minute>240||p.minute%5!==0||seen.has(p.minute)||!isFiniteNumber(p.value)||p.value<0||p.value>40)
   return {id,available:false,reason:'Неверные значения или шаг прогноза',points:[]};
  seen.add(p.minute);points.push(p);
 }
 points.sort((a,b)=>a.minute-b.minute);
 if(points.length<2||points[0].minute!==0||points.some((p,i)=>p.minute!==i*5))return {id,available:false,reason:'Неполная сетка прогноза',points:[]};
 if(!Number.isFinite(asOf))return {id,available:false,reason:'Отсутствует время расчёта',points:[]};
 const origin=input.forecastAt?Date.parse(input.forecastAt):input.originTs??asOf;
 if(!Number.isFinite(origin)||Math.abs(origin-asOf)>M*2)return {id,available:false,reason:'Прогноз рассчитан в другое время',points:[]};
 if(sourceTime!==null){
   const source=typeof input.sourceTime==='number'?input.sourceTime:(typeof input.sourceTime==='string'?Date.parse(input.sourceTime):NaN);
   if(!Number.isSafeInteger(source))return {id,available:false,reason:'Нет временной метки исходного CGM',points:[]};
   if(Math.abs(source-sourceTime)>M)return {id,available:false,reason:'Прогноз построен на другой точке CGM',points:[]};
 }
 return {id,available:true,source:'research',originTs:origin,points,reason:null};
}
function unavailable(id,reason){return {id,available:false,reason,points:[]};}
function compare(models,horizons=[30,60,120]){
 const byId=Object.fromEntries(NAMES.map(id=>[id,models[id]||unavailable(id,'Нет источника')]));
 const rows=horizons.map(minute=>{
  const values=Object.fromEntries(NAMES.map(id=>{
    const m=byId[id];const point=m.available?m.points.find(q=>q.minute===minute):null;
    return [id,point?.value??null];
  }));
  const present=Object.values(values).filter(isFiniteNumber);
  return {minute,values,spreadMmol:present.length>=2?+(Math.max(...present)-Math.min(...present)).toFixed(2):null,
    count:present.length};
 });
 return {models:byId,rows,labels:NAMES,interpretation:'Расхождение не доказывает, какая модель правильная. Возможные причины: разная модель еды, инсулина, тренда и неполные данные.',isDoseAdvice:false};
}
/* Compare only forecasts that were timestamped before the actual observation. No leakage. */
function assess({issued,actual,horizon=60,toleranceMinutes=5}={}){
 if(!Number.isInteger(horizon)||horizon<=0||horizon>240||horizon%5!==0)throw Error('Неверный горизонт');
 if(!Array.isArray(issued)||!Array.isArray(actual))throw Error('Ожидались истории прогнозов и CGM');
 const results=[];
 for(const item of issued){
  if(!isFiniteNumber(item.originTs)||!item.models)continue;
  const target=item.originTs+horizon*M;
  const fact=actual.filter(x=>x.valid!==false&&isFiniteNumber(x.mmol)&&Number.isFinite(x.ts)&&x.ts>=target-toleranceMinutes*M&&x.ts<=target+toleranceMinutes*M)
     .sort((a,b)=>Math.abs(a.ts-target)-Math.abs(b.ts-target))[0];
  if(!fact||fact.ts<=item.originTs)continue;
  for(const id of NAMES){const p=item.models[id];if(!p?.available)continue;
   const predicted=p.points.find(q=>q.minute===horizon);
   if(!predicted)continue;
   results.push({id,originTs:item.originTs,actualTs:fact.ts,horizon,forecast:predicted.value,actual:fact.mmol,absoluteError:+Math.abs(predicted.value-fact.mmol).toFixed(3),
    missedLow:fact.mmol<3.9 && predicted.value>=3.9});
  }
 }
 const stats=Object.fromEntries(NAMES.map(id=>{
   const list=results.filter(x=>x.id===id);const n=list.length;
   return [id,{n,mae:n?+(list.reduce((s,x)=>s+x.absoluteError,0)/n).toFixed(3):null,
     rmse:n?+Math.sqrt(list.reduce((s,x)=>s+(x.forecast-x.actual)**2,0)/n).toFixed(3):null,
     missedLow:list.filter(x=>x.missedLow).length,
     validated:false}];
 }));
 return {horizon,stats,rows:results,ranking:null,conclusion:'Только описательная статистика, без выбора модели для лечения'};
}
return Object.freeze({VERSION:'0.1.1',NAMES,normalize,unavailable,compare,assess});
});
