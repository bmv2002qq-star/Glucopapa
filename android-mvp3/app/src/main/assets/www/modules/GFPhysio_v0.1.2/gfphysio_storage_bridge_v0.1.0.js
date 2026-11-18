/* GFPhysioStorageBridge: READ ONLY. Reads existing GFSettings/getView or GFStorage research/settings port.
   NO independent user database, NO writes to GFStorage. Virtual simulation ONLY.
*/
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GFPhysioStorageBridge=api})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
function fail(s){throw Error(s)}
function ageOn(birthDate,at,timeZone){
 if(typeof birthDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)||!Number.isFinite(Date.parse(birthDate+'T00:00:00Z')))fail('Укажите дату рождения в GFSettings');
 if(!timeZone)fail('Укажите часовой пояс ребёнка в GFSettings');
 let d;try{const f=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});const xs=Object.fromEntries(f.formatToParts(new Date(at)).filter(x=>['year','month','day'].includes(x.type)).map(x=>[x.type,Number(x.value)]));d=xs;}catch(e){fail('Недействительный часовой пояс GFSettings')}
 const [year,month,day]=birthDate.split('-').map(Number);let age=d.year-year-(d.month<month||d.month===month&&d.day<day?1:0);
 if(age<0||age>110)fail('Возраст из даты рождения вне диапазона');return age;
}
function extract(snapshot,asOf=new Date().toISOString()){
 if(!snapshot||!snapshot.profile||!Array.isArray(snapshot.measurements)||![4,5].includes(snapshot.schemaVersion))fail('Ожидался снимок GFStorage schema 4/5 из настроек');
 const when=Date.parse(asOf);if(!Number.isFinite(when))fail('Некорректное время оценки');
 const ageYears=ageOn(snapshot.profile.birthDate,asOf,snapshot.profile.timeZone);
 const byTime=snapshot.measurements.filter(m=>m&&Number.isFinite(Date.parse(m.measuredAt))&&Date.parse(m.measuredAt)<=when).sort((a,b)=>Date.parse(b.measuredAt)-Date.parse(a.measuredAt));
 const w=byTime.find(m=>typeof m.weightKg==='number'&&Number.isFinite(m.weightKg)&&m.weightKg>0),h=byTime.find(m=>typeof m.heightCm==='number'&&Number.isFinite(m.heightCm)&&m.heightCm>0);
 if(!w)fail('Нет измерения веса в GFSettings/GFStorage');
 const weightAgeDays=(when-Date.parse(w.measuredAt))/86400000;
 const rawSex=snapshot.profile.sex;const sex=['male','female'].includes(rawSex)?rawSex:null;
 return {ageYears,weightKg:w.weightKg,heightCm:h?.heightCm??null,sex,
 source:'GFStorage.profile + GFStorage.measurements (read only)',asOf,revision:snapshot.revision??null,
 details:{birthDate:snapshot.profile.birthDate,weightMeasuredAt:w.measuredAt,heightMeasuredAt:h?.measuredAt??null,weightAgeDays,staleWeight:weightAgeDays>180},
 warnings:[...(weightAgeDays>180?['Вес измерен более 180 дней назад']:[]),...(h?[]:['Рост отсутствует в GFSettings']),...(sex?[]:['Пол отсутствует в GFSettings'])]};
}
function fromSource(source,asOf=new Date().toISOString()){
 if(!source)fail('Нет подключённого GFStorage/GFSettings');
 if(typeof source.getSnapshot==='function')return extract(source.getSnapshot(),asOf);
 if(typeof source.getView==='function'){
   const v=source.getView(asOf);return extract({schemaVersion:v.schemaVersion,revision:v.revision,profile:v.profile,measurements:v.measurements},asOf);
 }
 fail('Источник должен предоставлять getSnapshot() или getView()');
}
return Object.freeze({extract,fromSource,ageOn});
});
