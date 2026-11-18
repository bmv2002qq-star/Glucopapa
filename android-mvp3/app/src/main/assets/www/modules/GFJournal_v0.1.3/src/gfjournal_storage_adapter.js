/* Adapter GFStorage schemaVersion 2–5 -> GFJournal read-only v0.1.4 (sport). */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;if(root)root.GFJournalStorageAdapter=a;})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
function connect(host,{illnessProvider=null,annotationProvider=null,extraProvider=null}={}){
 if(!host||typeof host.connect!=='function')throw Error('Нужен единый хост GFStorage');
 if(![2,3,4,5].includes(host.getSchemaVersion()))throw Error('Ожидается GFStorage schemaVersion 2–5');
 const journal=host.connect('journal'),graph=host.connect('graph');
 const read=()=>{let j,g;for(let i=0;i<3;i++){j=journal.getSnapshot();g=graph.getSnapshot();if(j.revision===g.revision)break;}if(j.revision!==g.revision)throw Error('Не удалось прочитать согласованный снимок GFStorage');return {journal:j,graph:g,timeZone:j.profile.timeZone||'Europe/Minsk',illnessEpisodes:illnessProvider?illnessProvider():
    (j.conditionPeriods||[]).filter(p=>p.kind==='illness').map(p=>({id:p.id,startedAt:p.start,endedAt:p.end,label:'Болезнь'})),injectionAnnotations:annotationProvider?annotationProvider():{},extraEvents:[...(j.conditionPeriods||[]).filter(p=>p.kind==='activity').map(p=>({id:p.id,kind:'activity',ts:p.start,text:'Изменение активности'})),...(extraProvider?extraProvider():[])]}};
 return Object.freeze({read,subscribe:journal.subscribe,source:'GFStorage',readOnly:true});
}
return Object.freeze({connect});
});
