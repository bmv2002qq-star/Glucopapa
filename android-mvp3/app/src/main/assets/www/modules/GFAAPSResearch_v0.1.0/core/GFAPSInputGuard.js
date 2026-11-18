/* AAPS-inspired input checks (not a port): research only, fail closed for predictions. */
(function(root,f){let U=typeof module==='object'&&module.exports?require('./utils'):root.GFAPSUtils;let api=f(U);if(typeof module==='object'&&module.exports)module.exports=api;root.GFAPSInputGuard=api;})(typeof globalThis!=='undefined'?globalThis:this,function(U){
'use strict';
function inspect(s,{forecast=true}={}){
  const errors=[], warnings=[];const add=(condition,msg)=>{if(condition)errors.push(msg);};
  if(!s||typeof s!=='object')return {ok:false,errors:['Нет снимка входных данных'],warnings:[]};
  const now=U.ts(s.nowTs);add(!Number.isFinite(now),'Нет достоверного времени отсчёта');
  add(!Array.isArray(s.cgm),'Нет CGM-массива');
  const raw=Array.isArray(s.cgm)?s.cgm:[];
  add(raw.length<13,'Для оценки еды требуется не менее 13 CGM-точек (~60 минут)');add(raw.length>100000,'История CGM чрезмерно велика');
  const cgm=raw.slice().sort((a,b)=>U.ts(a.ts)-U.ts(b.ts));
  if(cgm.length){
    let last=-Infinity,source=null;
    for(const p of cgm){
      const t=U.ts(p.ts),val=p.mmol;
      if(!Number.isFinite(t)||t<=last)errors.push('Некорректное время или дубликат CGM');
      if(!U.finite(val)||val<2||val>30)errors.push('Недопустимый CGM');
      if(p.valid===false||p.qualityFlag==='invalid'||p.noise==='high')errors.push('CGM помечен как недостоверный');
      if(p.kind&&p.kind!=='observed')errors.push('CGM должен быть измеренным, не прогнозным');
      if(p.sourceDeviceId){if(source&&source!==p.sourceDeviceId)errors.push('Смешаны разные источники CGM');source=p.sourceDeviceId;}
      if(t>now+U.MIN)errors.push('CGM из будущего');
      last=t;
    }
    if(Number.isFinite(now)&&now-last>10*U.MIN)errors.push('Последний CGM устарел более чем на 10 минут');
    if(cgm.length>=4){
      if((U.ts(cgm.at(-1).ts)-U.ts(cgm[0].ts))/U.MIN<60)errors.push('История CGM короче 60 минут');
      const tail=cgm.slice(-4);
      for(let i=1;i<tail.length;i++){
        const gap=(U.ts(tail[i].ts)-U.ts(tail[i-1].ts))/U.MIN;
        if(gap<3||gap>8)errors.push('Последние CGM имеют пропуски/аномальную частоту');
      }
    }
    if(cgm.at(-1)?.mmol<3.9)errors.push('Низкий текущий CGM: прогноз заблокирован; используйте штатные оповещения CGM');
    if(cgm.at(-1)?.mmol>20)warnings.push('Высокий текущий CGM: прогноз сугубо исследовательский, не заменяет клиническую оценку');
    if(cgm.some(p=>p.valid===undefined||p.qualityFlag===undefined))warnings.push('Часть CGM без явных меток достоверности');
  }
  const c=s.completeness||{};
  if(forecast)for(const key of ['cgm','insulin','meals'])if(c[key]!=='confirmed_complete')errors.push(`Не подтверждена полнота истории: ${key}`);
  if(!Array.isArray(s.insulin))errors.push('Нет массива фактических инъекций');
  if(!Array.isArray(s.meals))errors.push('Нет массива фактически съеденной еды');
  const ins=Array.isArray(s.insulin)?s.insulin:[];const meals=Array.isArray(s.meals)?s.meals:[];
  for(const e of ins){const t=U.ts(e.ts);if(!Number.isFinite(t)||t>now+U.MIN||t<946684800000)errors.push('Неверное время инъекции');
    if(!U.finite(e.units)||e.units<0||e.units>100)errors.push('Неверное количество введённого инсулина');
    if(!['rapid','basal'].includes(e.type))errors.push('Неизвестный тип инсулина');
    if(e.status!=='actual')errors.push('Планируемая инъекция не является фактической');
  }
  for(const e of meals){const t=U.ts(e.ts);if(!Number.isFinite(t)||t>now+U.MIN||t<946684800000)errors.push('Неверное время еды');
    if(!U.finite(e.carbs)||e.carbs<0||e.carbs>500)errors.push('Неверная масса углеводов');
    if(e.status!=='actual')errors.push('Нельзя подменять фактическую еду запланированной');
  }
  if(forecast){
    if(ins.some(x=>x.type==='basal'))warnings.push('Длительный инсулин зарегистрирован, но его действие НЕ моделируется в этом прогнозе');
    const earliest=cgm.length?U.ts(cgm[0].ts):Infinity;
    if(meals.some(e=>U.ts(e.ts)<earliest))errors.push('Еда раньше доступной истории CGM: COB нельзя достоверно восстановить');
    const p=s.parameters||{};
    for(const [k,lo,hi] of [['isfMmolPerU',0.1,30],['crGPerU',1,200],['diaMinutes',300,600],['peakMinutes',1,240]])if(!U.finite(p[k])||p[k]<lo||p[k]>hi)errors.push(`Нет допустимого коэффициента ${k}`);
    if(U.finite(p.peakMinutes)&&U.finite(p.diaMinutes)&&p.peakMinutes>=p.diaMinutes/2)errors.push('Пик должен быть до половины длительности действия');
    if(s.context?.illness===true||['high','sport'].includes(s.context?.activity))warnings.push('Болезнь или высокая активность: исследовательский прогноз не моделирует этот фактор');
  }
  return {ok:errors.length===0,errors:[...new Set(errors)],warnings:[...new Set(warnings)],counts:{cgm:raw.length,insulin:ins.length,meals:meals.length}};
}
return {inspect};
});
