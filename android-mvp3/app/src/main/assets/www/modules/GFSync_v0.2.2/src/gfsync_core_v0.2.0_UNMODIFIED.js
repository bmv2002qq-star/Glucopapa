
/* GlucoPapa GFSync v0.2.0: offline-first, test-only transport model.
   All records in this model are synthetic. No clinical estimates or medical guidance.
   This is NOT a production Firestore authorization boundary or a GFStorage writer.
*/
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFSyncCore=api;})(typeof globalThis!=='undefined'?globalThis:null,function(){
'use strict';
const VERSION='0.2.0',SCHEMA=2;
const DEVICES=Object.freeze(['parent','child','other-parent']);
const TYPES=Object.freeze(['cgm','meal','injection','illness','activity','settings','revise','retract']);
const SITES=['abdomen','arm','thigh','buttock'];
const DEVICE_LABEL=Object.freeze({parent:'Мой телефон',child:'Телефон ребёнка','other-parent':'Телефон жены'});
function fail(s){throw Error(s)}
function ok(b,s){if(!b)fail(s)}
function plain(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype}
function checkObject(x,keys,required){ok(plain(x),'not an object');for(const k of Object.keys(x))ok(keys.includes(k),'unrecognized field '+k);for(const k of required)ok(Object.hasOwn(x,k),'missing field '+k);}
function id(v){ok(typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,96}$/.test(v),'invalid id');return v}
function ts(v){ok(Number.isSafeInteger(v)&&v>=946684800000&&v<=4102444800000,'invalid UTC timestamp');return v}
function num(v,min,max){ok(typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max,'invalid number');return v}
function text(v,max=100){ok(typeof v==='string'&&v.trim().length>0&&v.length<=max,'invalid text');return v}
function copy(x){return JSON.parse(JSON.stringify(x))}
function device(v){ok(DEVICES.includes(v),'unknown device');return v}
function bodyFor(kind,b){
 switch(kind){
 case 'cgm':checkObject(b,['mmol','measuredAt','sensorId','trend'],['mmol','measuredAt','sensorId']);num(b.mmol,1.5,30);ts(b.measuredAt);id(b.sensorId);if(b.trend!==undefined)ok(['up','flat','down','unknown'].includes(b.trend),'bad trend');break;
 case 'meal':checkObject(b,['label','grams'],['label','grams']);text(b.label,100);num(b.grams,0.1,5000);break;
 case 'injection':checkObject(b,['drug','units','site'],['drug','units','site']);ok(['rinfast','levemir'].includes(b.drug),'unknown drug');num(b.units,0.01,200);ok(SITES.includes(b.site),'bad injection site');break;
 case 'illness':checkObject(b,['active'],['active']);ok(typeof b.active==='boolean','invalid illness');break;
 case 'activity':checkObject(b,['level'],['level']);ok(['low','usual','high'].includes(b.level),'invalid activity');break;
 case 'settings':checkObject(b,['key','value'],['key','value']);ok(['display','reminder'].includes(b.key),'settings: prototype supports only display/reminder fields');text(b.value,80);break;
 case 'revise':checkObject(b,['reason','replacement'],['reason','replacement']);text(b.reason,160);ok(plain(b.replacement)&&Object.keys(b.replacement).length<=3,'bad correction replacement');for(const k of Object.keys(b.replacement))ok(['label','grams','site'].includes(k),'unauthorized correction field');if(b.replacement.label!==undefined)text(b.replacement.label,100);if(b.replacement.grams!==undefined)num(b.replacement.grams,0.1,5000);if(b.replacement.site!==undefined)ok(SITES.includes(b.replacement.site),'bad site');break;
 case 'retract':checkObject(b,['reason'],['reason']);text(b.reason,160);break;
 default: fail('unknown event type');
 }
 return copy(b)
}
function normalizeEvent(e){
 checkObject(e,['id','kind','recordId','baseVersion','origin','at','body','sourceEpoch'],['id','kind','recordId','baseVersion','origin','at','body']);
 id(e.id);id(e.recordId);ok(TYPES.includes(e.kind),'unknown event type');device(e.origin);ts(e.at);
 ok(Number.isSafeInteger(e.baseVersion)&&e.baseVersion>=0&&e.baseVersion<=1000000,'bad version');
 if(e.sourceEpoch!==undefined)ok(Number.isSafeInteger(e.sourceEpoch)&&e.sourceEpoch>=1,'bad epoch');
 if(e.kind==='cgm'){ok(e.sourceEpoch!==undefined,'CGM must carry source epoch');ok(e.baseVersion===0,'CGM cannot overwrite');ok(e.recordId===`cgm:${e.body.sensorId}:${e.body.measuredAt}`,'CGM key must be deterministic');}
 if(e.kind!=='cgm')ok(e.sourceEpoch===undefined,'sourceEpoch only for CGM');
 if(e.kind==='revise'||e.kind==='retract')ok(e.baseVersion>0,'correction requires base version');
 else ok(e.baseVersion===0,'new records start at zero');
 const b=bodyFor(e.kind,e.body);
 return Object.freeze({id:e.id,kind:e.kind,recordId:e.recordId,baseVersion:e.baseVersion,origin:e.origin,at:e.at,body:b,...(e.sourceEpoch!==undefined?{sourceEpoch:e.sourceEpoch}:{})});
}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function createHub({sender='child'}={}){
 device(sender);
 let activeSender=sender,epoch=1,version=0;
 const ledger=[],byId=new Map(),byRecord=new Map();
 const counters={accepted:0,duplicates:0,rejected:0,conflicts:0};
 function authorize(deviceId,actorId){return DEVICES.includes(deviceId)&&deviceId===actorId;}
 function setSender(newSender,actor){device(newSender);ok(DEVICES.includes(actor),'unrecognized actor');if(newSender!==activeSender){activeSender=newSender;epoch++;}return senderInfo()}
 function senderInfo(){return Object.freeze({device:activeSender,epoch})}
 function submit(entry,{asDevice,actor}){
  let e;
  try{e=normalizeEvent(entry)}catch(err){counters.rejected++;return {ok:false,reason:'invalid_payload',details:err.message}}
  if(!authorize(asDevice,actor)||asDevice!==e.origin){counters.rejected++;return {ok:false,reason:'not_authorized'}}
  if(byId.has(e.id)){
   const prior=byId.get(e.id).entry;
   if(equal(prior,e)){counters.duplicates++;return {ok:true,duplicate:true,seq:byId.get(e.id).seq,version:byRecord.get(e.recordId).version}}
   counters.rejected++;counters.conflicts++;return {ok:false,reason:'id_collision'};
  }
  if(e.kind==='cgm'&&(e.origin!==activeSender||e.sourceEpoch!==epoch)){counters.rejected++;return {ok:false,reason:'source_not_authorized'}}
  const prior=byRecord.get(e.recordId);
  if(e.baseVersion===0&&prior){counters.rejected++;counters.conflicts++;return {ok:false,reason:'record_conflict'}}
  if(e.baseVersion>0){
   if(!prior){counters.rejected++;return {ok:false,reason:'missing_record'}}
   if(prior.version!==e.baseVersion||prior.retracted){counters.rejected++;counters.conflicts++;return {ok:false,reason:'version_conflict'}}
   if(e.kind==='revise'&&(!['meal','injection'].includes(prior.kind)||e.body.replacement.site!==undefined&&prior.kind!=='injection'||(e.body.replacement.label!==undefined||e.body.replacement.grams!==undefined)&&prior.kind!=='meal')){counters.rejected++;return {ok:false,reason:'bad_correction'}}
  }
  const rec={seq:++version,entry:copy(e),by:actor};ledger.push(rec);byId.set(e.id,rec);
  byRecord.set(e.recordId,{version:(prior?prior.version:0)+1,kind:prior?prior.kind:e.kind,retracted:e.kind==='retract'});
  counters.accepted++;return {ok:true,duplicate:false,seq:rec.seq,version:byRecord.get(e.recordId).version};
 }
 function since(cursor,{asDevice,actor}){ok(authorize(asDevice,actor),'not authorized to read');ok(Number.isSafeInteger(cursor)&&cursor>=0&&cursor<=version,'invalid cursor');return copy(ledger.slice(cursor));}
 function snapshot(){return copy({sender:senderInfo(),version,ledger,counters});}
 return Object.freeze({setSender,senderInfo,submit,since,snapshot});
}
function createDevice(deviceId,hub,{clock=()=>Date.now(),state=null}={}){
 device(deviceId);ok(hub&&typeof hub.submit==='function'&&typeof hub.since==='function','hub required');
 let online=true,seq=0,cursor=0,queue=[],blocked=[],received=[],status='not_synced',lastCgm=null,cgmCount=0;
 const receivedId=new Map();
 if(state){
  checkObject(state,['device','online','seq','cursor','queue','blocked','received'],['device','online','seq','cursor','queue','blocked','received']);
  ok(state.device===deviceId,'wrong device snapshot');ok(typeof state.online==='boolean','bad online state');online=state.online;
  ok(Number.isSafeInteger(state.seq)&&state.seq>=0,'bad sequence');seq=state.seq;
  ok(Number.isSafeInteger(state.cursor)&&state.cursor>=0,'bad cursor');cursor=state.cursor;
  ok(Array.isArray(state.queue)&&Array.isArray(state.received)&&Array.isArray(state.blocked),'bad stored collections');
  queue=state.queue.map(normalizeEvent);blocked=copy(state.blocked);
  for(const v of state.received){ok(plain(v)&&Number.isSafeInteger(v.seq)&&v.seq>0,'bad received item');const e=normalizeEvent(v.entry);if(receivedId.has(e.id))ok(equal(receivedId.get(e.id),e),'conflicting restored id');else {receivedId.set(e.id,e);received.push({seq:v.seq,entry:e,by:v.by});if(e.kind==='cgm'){cgmCount++;if(!lastCgm||e.body.measuredAt>lastCgm.measuredAt)lastCgm=e.body}}}
 }
 function local(){return copy({device:deviceId,online,seq,cursor,queue,blocked,received})}
 function queueEvent({kind,recordId,body,baseVersion=0,at=clock(),sourceEpoch}={}){
  ok(queue.length<1000,'local queue is full');seq++;
  const e=normalizeEvent({id:`${deviceId}.${at}.${seq}`,kind,recordId,baseVersion,origin:deviceId,at,body,...(sourceEpoch===undefined?{}:{sourceEpoch})});
  queue.push(e);status='pending';if(online)sync();return copy(e);
 }
 function sync(){
  if(!online){status='offline';return {status,queued:queue.length,cursor}}
  // Submit is idempotent. Rejects are moved to a *visible* quarantine, not silently lost.
  while(queue.length){
   const e=queue[0];let ans;
   try{ans=hub.submit(e,{asDevice:deviceId,actor:deviceId})}catch(err){status='sync_error';break}
   if(ans.ok)queue.shift();else{blocked.push({event:e,reason:ans.reason});queue.shift();}
  }
  try{
   const delta=hub.since(cursor,{asDevice:deviceId,actor:deviceId});
   for(const row of delta){const e=normalizeEvent(row.entry);if(receivedId.has(e.id)){ok(equal(receivedId.get(e.id),e),'remote ID collision')}else {receivedId.set(e.id,e);received.push(copy(row));if(e.kind==='cgm'){cgmCount++;if(!lastCgm||e.body.measuredAt>lastCgm.measuredAt)lastCgm=e.body}};cursor=Math.max(cursor,row.seq)}
   status=blocked.length?'conflict':queue.length?'pending':'synced';
  }catch(err){status='sync_error'}
  return {status,queued:queue.length,cursor}
 }
 function setOnline(value){ok(typeof value==='boolean','bad online value');online=value;if(value)return sync();status='offline';return {status,queued:queue.length,cursor}}
 function summary({now=clock()}={}){
  ts(now);const recent=lastCgm;const futureReading=Boolean(recent&&recent.measuredAt>now+2*60000);const age=recent?Math.max(0,now-recent.measuredAt):null;
  return copy({device:deviceId,online,status,queued:queue.length,blocked:blocked.length,received:received.length,cgmCount,lastCgm:recent,cgmStale:!online||futureReading||age===null||age>15*60000,cgmClockInvalid:futureReading,cgmAgeMinutes:age===null?null:Math.round(age/60000),cursor});
 }
 return Object.freeze({device:deviceId,queueEvent,sync,setOnline,local,summary});
}
function createSimulator({clock=()=>Date.now(),sender='child'}={}){
 const hub=createHub({sender});let serial=0;
 const devices={};for(const d of DEVICES)devices[d]=createDevice(d,hub,{clock});
 function restartDevice(d){device(d);const stored=devices[d].local();devices[d]=createDevice(d,hub,{clock,state:stored});devices[d].sync();return snapshot()}
 function allSync(){for(const d of DEVICES)devices[d].sync();for(const d of DEVICES)devices[d].sync();return snapshot()}
 function sample(d,kind,body,opts={}){device(d);const at=opts.at||clock();const recordId=opts.recordId||`demo.${d}.${++serial}`;
  const sourceEpoch=kind==='cgm'?hub.senderInfo().epoch:undefined;
  const id=kind==='cgm'?`cgm:${body.sensorId}:${body.measuredAt}`:recordId;
  // event IDs are generated by createDevice; CGM recordId is deterministic.
  const e=devices[d].queueEvent({kind,body,recordId:kind==='cgm'?id:recordId,at,sourceEpoch,baseVersion:opts.baseVersion||0});
  allSync();return e;
 }
 function snapshot(){const s=hub.snapshot();return copy({hub:s,devices:Object.fromEntries(DEVICES.map(d=>[d,devices[d].summary({now:clock()})]))});}
 return Object.freeze({hub,devices,sample,allSync,snapshot,restartDevice});
}
return Object.freeze({VERSION,SCHEMA,DEVICES,DEVICE_LABEL,TYPES,normalizeEvent,createHub,createDevice,createSimulator});
});

