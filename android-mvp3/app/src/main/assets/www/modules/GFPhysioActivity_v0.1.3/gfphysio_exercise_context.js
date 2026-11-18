/* GFPhysioExerciseContext v0.1.3: research-only context from GFStorage.
 * NO dosage, NO insulin/CHO adjustment; does not touch original GFPhysio differential equations.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFPhysioExerciseContext=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';const VERSION='0.1.3-sport-context';
function fromSnapshot(s,asOf=new Date().toISOString()){
 if(!s||![4,5].includes(s.schemaVersion)||!Array.isArray(s.conditionPeriods))throw Error('Нужен GFStorage schema 4/5 с периодами');
 const ts=Date.parse(asOf);if(!Number.isFinite(ts))throw Error('Неверное время');
 const rows=s.conditionPeriods.filter(p=>p.kind==='sport'&&Number.isFinite(Date.parse(p.start))&&Date.parse(p.start)<=ts)
  .map(p=>({id:p.id,start:p.start,end:p.end,minuteDuration:p.end===null?null:Math.round((Date.parse(p.end)-Date.parse(p.start))/60000*10)/10}));
 const active=rows.find(p=>p.end===null)||null;
 const completed=rows.filter(p=>p.end!==null&&Date.parse(p.end)<=ts).sort((a,b)=>Date.parse(b.end)-Date.parse(a.end));
 const last=completed[0]||null;
 return Object.freeze({version:VERSION,source:'GFStorage.conditionPeriods',clinicalValidation:false,researchOnly:true,revision:s.revision??null,
   baseLevel:s.profile?.activityBaseLevel||'low',sportActive:!!active,
   activeSession:active,latestCompleted:last,
   minutesSinceLastSport:last?Math.round((ts-Date.parse(last.end))/60000):null,
   needsIndividualAssessment:!!active||!!last,
   multiplier:null,insulinAdjustment:null,carbohydrateAdjustment:null,
   note:'Возможное отсроченное влияние нагрузки индивидуально; ни длительность эффекта, ни дозировки модель пока не определяет.'});
}
function connect(host,asOf=new Date().toISOString()){
 if(!host||typeof host.connect!=='function')throw Error('Нужен GFStorage host');
 const p=host.connect('research');return fromSnapshot(p.getSnapshot(),asOf);
}
return Object.freeze({VERSION,fromSnapshot,connect});
});
