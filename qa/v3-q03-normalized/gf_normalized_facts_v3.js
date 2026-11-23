/* Q03 GFNormalizedFacts V3 v0.2.0 - independent read-only projection adapter.
 * No storage, writes, model math, synthetic placeholders or implicit links.
 * The approved historical v0.1.0 core stays byte-for-byte unchanged.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFNormalizedFactsV3=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const VERSION='0.2.0';
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const copy=x=>JSON.parse(JSON.stringify(x));
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const fail=(code)=>{const e=new Error(code);e.code=code;throw e;};
const ident=x=>typeof x==='string'&&x.length>0&&x.length<=160&&x.trim()===x&& !/[\u0000-\u001f]/.test(x);
function utc(raw){
 if(typeof raw!=='string')return null;
 const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/.exec(raw);
 if(!m)return null;
 const y=+m[1],month=+m[2],d=+m[3],h=+m[4],minute=+m[5],sec=+m[6],ms=+(m[7]||'0').padEnd(3,'0');
 const leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(y<1||month<1||month>12||d<1||d>days[month-1]||h>23||minute>59||sec>59)return null;
 let offset=0;
 if(m[8]!=='Z'){const oh=+m[10],om=+m[11];if(oh>14||om>59||(oh===14&&om!==0))return null;offset=(m[9]==='+'?1:-1)*(oh*60+om);}
 // Date.UTC translates years 0..99 to 1900..1999; reconstruct without that rule.
 const dt=new Date(0);dt.setUTCFullYear(y,month-1,d);dt.setUTCHours(h,minute,sec,ms);
 const absolute=dt.getTime()-offset*60000;
 if(!Number.isFinite(absolute))return null;
 const result=new Date(absolute).toISOString();
 return /^\d{4}-/.test(result)?result:null;
}
function stamp(src){return src?.occurredAtUtc??src?.startedAtUtc??src?.administeredAtUtc??src?.measuredAtUtc??src?.createdAtUtc??src?.startedAt??src?.occurredAt??src?.administeredAt??src?.measuredAt??src?.createdAt??null;}
function idOf(src){return src?.eventId??src?.sessionId??src?.measurementId??src?.observationId??src?.id??null;}
function validatePort(p){if(!isObj(p)||p.schemaVersion!==3||!Number.isSafeInteger(p.revision)||p.revision<0||!isObj(p.data))fail('Q03_PORT_INVALID');return p;}
function pair(journal,graph){
 const j=validatePort(journal),g=validatePort(graph);
 if(j.revision!==g.revision)fail('Q03_REVISION_MISMATCH');
 if(j.inputRevision!==g.inputRevision)fail('Q03_INPUT_REVISION_MISMATCH');
 if(!ident(j.profileId)||j.profileId!==g.profileId||j.profileConfigured===false||g.profileConfigured===false)fail('Q03_PROFILE_MISMATCH');
 if(!isObj(j.data.profile)||j.data.profile.profileId!==j.profileId||typeof j.data.profile.timeZone!=='string')fail('Q03_PROFILE_MISMATCH');
 try{new Intl.DateTimeFormat('en',{timeZone:j.data.profile.timeZone});}catch(_){fail('Q03_TIMEZONE_INVALID');}
 if(!Array.isArray(j.data.events)||!Array.isArray(j.data.mealSessions)||!Array.isArray(g.data.cgm))fail('Q03_DOMAIN_MISSING');
 return {j,g};
}
function plateCarbs(s){
 const plate=s?.actualPlate;
 if(s?.status!=='completed'||!isObj(plate)||plate.schema!=='GFPlate.v1'||!Array.isArray(plate.items)||!plate.items.length||plate.items.length>150||!isObj(plate.totals))return null;
 const ks=['carbs','fat','protein','kcal'];const sum=Object.fromEntries(ks.map(k=>[k,0]));
 for(const item of plate.items){
  if(!isObj(item)||!Number.isFinite(item.amount)||item.amount<=0||!['g','ml','г','мл'].includes(item.unit))return null;
  if(typeof item.name!=='string'||!item.name.trim()||/unknown|missing|not_provided/i.test(item.nutritionStatus||''))return null;
  for(const k of ks){if(!Number.isFinite(item[k])||item[k]<0)return null;sum[k]+=item[k];}
 }
 for(const k of ks)if(!Number.isFinite(plate.totals[k])||plate.totals[k]<0||Math.abs(plate.totals[k]-sum[k])>Math.max(0.11,plate.items.length*0.11))return null;
 return {carbs:plate.totals.carbs,estimated:plate.containsEstimatedValues===true};
}
function normalize(journal,graph){
 const {j,g}=pair(journal,graph),events=j.data.events,sessions=j.data.mealSessions,cgm=g.data.cgm;
 const issues=[],rows=[];const issue=(code,id,detail='')=>issues.push({code,id:id??null,detail:String(detail).slice(0,240)});
 // Refuse to choose a winner among duplicate IDs: every occurrence gets marked conflicting.
 const occurrences=new Map();
 for(const [domain,list] of [['event',events],['session',sessions],['cgm',cgm]])for(let i=0;i<list.length;i++){
  const x=list[i],id=idOf(x);if(!ident(id))continue;
  const a=occurrences.get(id)||[];a.push({domain,index:i});occurrences.set(id,a);
 }
 const collisions=new Set();for(const [id,a] of occurrences)if(a.length>1){collisions.add(id);issue('DUPLICATE_ID',id,`${a.length} records`);}
 const normalizedSessions=new Map();
 for(let i=0;i<sessions.length;i++){
  const src=sessions[i],id=idOf(src),when=utc(stamp(src));
  if(!ident(id)){issue('INVALID_ID',null,'mealSession '+i);continue;}
  if(collisions.has(id))continue;
  if(!when){issue('INVALID_UTC',id,'mealSession');continue;}
  const nutrition=plateCarbs(src);
  if(src.status==='completed'&&!nutrition)issue('MEAL_NUTRITION_UNKNOWN',id);
  if(src.status!=='completed'&&src.actualPlate)issue('UNCONFIRMED_MEAL_NOT_COUNTED',id);
  const row={id,kind:'mealSession',utc:when,rawDomain:'mealSessions',rawIndex:i,status:src.status||'unknown',carbsGrams:nutrition?nutrition.carbs:null,quality:nutrition?.estimated?'ESTIMATED':nutrition?'CONFIRMED':'UNKNOWN',counted:!!nutrition,link:null};
  normalizedSessions.set(id,row);rows.push(row);
 }
 // Identical confirmed sessions close in time are never silently merged or double-counted.
 const approvedMeals=[...normalizedSessions.values()].filter(x=>x.counted);
 for(let i=0;i<approvedMeals.length;i++)for(let k=i+1;k<approvedMeals.length;k++){
  const a=approvedMeals[i],b=approvedMeals[k];
  if(Math.abs(Date.parse(a.utc)-Date.parse(b.utc))>60000)continue;
  if(JSON.stringify(sessions[a.rawIndex].actualPlate)!==JSON.stringify(sessions[b.rawIndex].actualPlate))continue;
  issue('MEAL_SESSION_POSSIBLE_DUPLICATE',a.id,b.id);
  a.counted=false;b.counted=false;a.quality='AMBIGUOUS';b.quality='AMBIGUOUS';
 }
 for(let i=0;i<events.length;i++){
  const src=events[i],id=idOf(src);if(!ident(id)){issue('INVALID_ID',null,'event '+i);continue;}
  if(collisions.has(id))continue;
  const time=utc(stamp(src));if(!time){issue('INVALID_UTC',id,'event');continue;}
  const kind=src.eventType||src.type||'unknown';
  if(kind==='meal'&&src.status==='recorded'){
   const explicitA=src.sessionId,explicitB=src.linkedMealSessionId;
   if(ident(explicitA)&&ident(explicitB)&&explicitA!==explicitB){
    issue('MEAL_LINK_CONFLICT',id);
    rows.push({id,kind:'legacyMeal',utc:time,rawDomain:'events',rawIndex:i,status:'AMBIGUOUS',carbsGrams:null,quality:'UNKNOWN',counted:false,link:null});
    continue;
   }
   const linkedId=ident(explicitA)?explicitA:ident(explicitB)?explicitB:null;
   if(linkedId){
    if(normalizedSessions.has(linkedId)){
     rows.push({id,kind:'legacyMeal',utc:time,rawDomain:'events',rawIndex:i,status:'LINKED',carbsGrams:null,quality:'UNKNOWN',counted:false,link:linkedId});
    }else{issue('MEAL_LINK_UNRESOLVED',id,linkedId);rows.push({id,kind:'legacyMeal',utc:time,rawDomain:'events',rawIndex:i,status:'UNRESOLVED',carbsGrams:null,quality:'UNKNOWN',counted:false,link:linkedId});}
   }else{
    const matching=[...normalizedSessions.values()].filter(x=>Math.abs(Date.parse(x.utc)-Date.parse(time))<=60000);
    if(matching.length)issue('MEAL_POSSIBLE_DUPLICATE',id,matching.map(x=>x.id).join(','));
    rows.push({id,kind:'legacyMeal',utc:time,rawDomain:'events',rawIndex:i,status:matching.length?'AMBIGUOUS':'LEGACY_UNVERIFIED',carbsGrams:null,quality:'UNKNOWN',counted:false,link:null});
   }
   continue;
  }
  rows.push({id,kind,utc:time,rawDomain:'events',rawIndex:i,status:src.status||'unknown',carbsGrams:null,quality:'UNKNOWN',counted:false,link:null});
 }
 for(let i=0;i<cgm.length;i++){
  const src=cgm[i],id=idOf(src);if(!ident(id)){issue('CGM_ID_UNKNOWN',null,'graph '+i);continue;}
  if(collisions.has(id))continue;
  const time=utc(stamp(src));if(!time){issue('INVALID_UTC',id,'cgm');continue;}
  const observed=src.provenance==='observed'&&['good','verified'].includes(src.quality);
  if(!observed)issue('CGM_NOT_VERIFIED',id,src.provenance||'provenance_unknown');
  rows.push({id,kind:'cgm',utc:time,rawDomain:'cgm',rawIndex:i,status:observed?'OBSERVED':'NON_OBSERVED',carbsGrams:null,quality:observed?src.quality:'UNVERIFIED',counted:false,link:null});
 }
 if(events.length>=2000||sessions.length>=2000||cgm.length>=2000||j.data.coverage?.complete===false||g.data.coverage?.complete===false)issue('HISTORY_MAY_BE_TRUNCATED',null);
 rows.sort((a,b)=>b.utc.localeCompare(a.utc)||a.id.localeCompare(b.id));
 const totalCarbsGrams=rows.reduce((acc,r)=>acc+(r.counted?r.carbsGrams:0),0);
 return freeze({version:VERSION,revision:j.revision,inputRevision:j.inputRevision,profileId:j.profileId,rows,issues,summary:{sourceCount:events.length+sessions.length+cgm.length,normalizedCount:rows.length,issuesCount:issues.length,confirmedMealCount:rows.filter(x=>x.counted).length,totalCarbsGrams}});
}
function read(bridge){
 if(!bridge||typeof bridge.getRevision!=='function'||typeof bridge.readShellPort!=='function')fail('Q03_BRIDGE_UNAVAILABLE');
 for(let n=0;n<5;n++){
  const before=bridge.getRevision();const a=JSON.parse(bridge.readShellPort('journal')),b=JSON.parse(bridge.readShellPort('graph'));const after=bridge.getRevision();
  if(Number(before)!==Number(after)||a.revision!==before||b.revision!==before)continue;
  if(a.error||b.error)fail('Q03_PORT_DENIED');
  return normalize(a,b);
 }
 fail('Q03_REVISION_CHANGED');
}
return Object.freeze({VERSION,normalize,read,canonicalUtc:utc});
});
