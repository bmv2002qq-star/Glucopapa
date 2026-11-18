/* GFSync v0.2.2 host-side adapter. No direct cross-module storage writes.
 * Only GFSyncCore-normalized authenticated CGM uses GFStorage.syncWriter.
 */
(function(root,factory){const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;if(root)root.GFSyncStorageAdapter=a;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function applyRemoteLedger(host,rows,{syncCore,allowSender='child'}={}){
 if(!host||![4,5].includes(host.getSchemaVersion?.()))throw Error('Требуется GFStorage schema 4/5');
 if(!syncCore||typeof syncCore.normalizeEvent!=='function')throw Error('Нужен GFSyncCore v0.2.0');
 if(!Array.isArray(rows)||rows.length>10000)throw Error('Неподходящий набор синхронизации');
 const port=host.connect('syncWriter'),rejected=[],applied=[],duplicates=[];
 for(const row of rows){
  try{
   if(!row||!row.entry||typeof row.by!=='string'||row.by!==allowSender)throw Error('Не подтверждён авторизованный отправитель');
   const e=syncCore.normalizeEvent(row.entry);
   if(e.origin!==allowSender)throw Error('Несоответствие источника');
   if(e.kind!=='cgm')throw Error('Требуется отдельное ручное действие, автоматическая запись запрещена');
   const ans=port.applyInboundCgm(e,port.getRevision());
   (ans.idempotent?duplicates:applied).push(e.id);
  }catch(err){rejected.push({id:String(row?.entry?.id||'unknown'),reason:String(err.message||err)});}
 }
 return Object.freeze({applied,duplicates,rejected,storageRevision:port.getRevision()});
}
return Object.freeze({VERSION:'0.2.2',applyRemoteLedger});
});
