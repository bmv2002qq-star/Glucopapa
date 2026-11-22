/* GlukoPapa GFSettings V3 v0.2.0.
 * Independent presentation + owner-intent builder for a *single* GFStorage V3 settings snapshot.
 * No localStorage, direct SQLite, network, privileged JS write bridge, or medical computation.
 * A trusted installed native GFSettings owner adapter alone may commit an intent after both approvals.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFSettingsV3=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VERSION='0.2.0',SCHEMA=3;
 const KINDS=Object.freeze(['carb_g_per_u','isf_mmol_per_u']);
 const SLOT_IDS=Object.freeze(['00-06','06-12','12-18','18-00']);
 const WRITE_KEYS=Object.freeze(['childProfile','nutritionReference','target','foodModel','graphPreferences','activityPreferences','coefficientModeControls']);
 const MODE_VALUES=Object.freeze(['manual','auto']);
 function fail(code){throw Object.assign(new Error(code),{code});}
 function obj(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
 function copy(v){return JSON.parse(JSON.stringify(v));}
 function freeze(v){if(v&&typeof v==='object'){for(const a of Object.values(v))freeze(a);Object.freeze(v);}return v;}
 function fields(v,allowed,required=[]){if(!obj(v))fail('OBJECT_REQUIRED');for(const k of Object.keys(v))if(!allowed.includes(k))fail('UNKNOWN_FIELD_'+k);for(const k of required)if(!Object.hasOwn(v,k))fail('REQUIRED_FIELD_'+k);}
 function finite(v,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('NUMBER_OUT_OF_RANGE');return v;}
 function text(v,max=120){if(typeof v!=='string'||!v.trim()||v.length>max)fail('STRING_INVALID');return v.trim();}
 function instant(s){
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(s))fail('INSTANT_INVALID');
  const g=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s);
  const [y,mo,da,hh,mm,ss]=g.slice(1).map(Number);
  if(mo<1||mo>12||da<1||da>31||hh>23||mm>59||ss>59)fail('INSTANT_INVALID');
  const reconstructed=new Date(Date.UTC(y,mo-1,da));
  if(reconstructed.getUTCFullYear()!==y||reconstructed.getUTCMonth()+1!==mo||reconstructed.getUTCDate()!==da)fail('INSTANT_INVALID');
  const off=/([+-])(\d{2}):(\d{2})$/.exec(s);
  if(off&&(Number(off[2])>14||Number(off[3])>59||(Number(off[2])===14&&Number(off[3])!==0)))fail('INSTANT_INVALID');
  if(!Number.isFinite(Date.parse(s)))fail('INSTANT_INVALID');return s;
 }
 function timezone(s){text(s,100);try {new Intl.DateTimeFormat('en',{timeZone:s});} catch(_){fail('ZONE_INVALID');} return s;}
 function date(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('BIRTHDATE_INVALID');return s;}
 function ensureRevision(n){if(!Number.isSafeInteger(n)||n<0)fail('REVISION_INVALID');return n;}
 function snapshot(s){
  if(!obj(s)||s.schemaVersion!==SCHEMA||!obj(s.data)||!Number.isSafeInteger(s.revision)||s.revision<0||!Number.isSafeInteger(s.inputRevision)||s.inputRevision<0)fail('GFSTORAGE_V3_SNAPSHOT_REQUIRED');
  const d=s.data;for(const key of ['preferences','coefficients','coefficientHistory','settingHistory','measurements'])if(!Array.isArray(d[key]))fail('SETTINGS_SNAPSHOT_INCOMPLETE_'+key);
  if(s.profileConfigured!==true)return freeze({revision:s.revision,inputRevision:s.inputRevision,profileConfigured:false,profileId:null,data:copy(d)});
  if(typeof s.profileId!=='string'||!s.profileId.trim()||!obj(d.profile))fail('PROFILE_SNAPSHOT_INVALID');
  if(d.profile.profileId!==s.profileId)fail('PROFILE_ID_CONFLICT');
  timezone(d.profile.timeZone);
  return freeze({revision:s.revision,inputRevision:s.inputRevision,profileConfigured:true,profileId:s.profileId,data:copy(d)});
 }
 function preferences(s){const m=new Map();for(const item of s.data.preferences){if(!obj(item)||typeof item.key!=='string'||!obj(item.value)||m.has(item.key))fail('SETTING_PREFERENCE_INVALID');m.set(item.key,copy(item.value));}return m;}
 function defaultModes(){const a={};for(const k of KINDS){a[k]={};for(const slot of SLOT_IDS)a[k][slot]='manual';}return a;}
 function validateModes(v){
  fields(v,['schema','modes','autoEngineStatus'],['schema','modes','autoEngineStatus']);
  if(v.schema!==1||v.autoEngineStatus!=='NOT_CONNECTED_Q16')fail('AUTO_ENGINE_STATUS_INVALID');
  fields(v.modes,KINDS,KINDS);
  for(const kind of KINDS){fields(v.modes[kind],SLOT_IDS,SLOT_IDS);for(const id of SLOT_IDS)if(!MODE_VALUES.includes(v.modes[kind][id]))fail('COEFFICIENT_MODE_INVALID');}
  return v;
 }
 function nutrition(v){
  // Exact V3 M02 read-contract: value.daily.protein/fat/carbs/kcal.
  fields(v,['daily','source','sourceVersion'],['daily','source']);
  fields(v.daily,['protein','fat','carbs','kcal'],['protein','fat','carbs','kcal']);
  for(const k of ['protein','fat','carbs'])finite(v.daily[k],0.001,1000);
  finite(v.daily.kcal,1,10000);
  if(!['OWNER_MANUAL','HISTORICAL_UNVERIFIED'].includes(v.source))fail('NUTRITION_PROVENANCE_INVALID');
  if(v.sourceVersion!==undefined)text(v.sourceVersion,100);return v;
 }
 function validateSetting(key,value){
  if(!WRITE_KEYS.includes(key))fail('SETTING_KEY_NOT_ALLOWED');
  if(!obj(value))fail('SETTING_OBJECT_REQUIRED');
  switch(key){
   case 'childProfile':
    fields(value,['displayName','birthDate','sex','timeZone','allergies'],['displayName','birthDate','timeZone']);
    text(value.displayName);date(value.birthDate);timezone(value.timeZone);
    if(value.birthDate<'1900-01-02'||value.birthDate>new Date().toISOString().slice(0,10))fail('BIRTHDATE_OUT_OF_RANGE');
    if(value.sex!==undefined&&value.sex!==null&&!['male','female'].includes(value.sex))fail('SEX_INVALID');
    if(value.allergies!==undefined){if(!Array.isArray(value.allergies)||value.allergies.length>30)fail('ALLERGIES_INVALID');const x=value.allergies.map(y=>text(y));if(new Set(x.map(y=>y.toLocaleLowerCase('ru'))).size!==x.length)fail('ALLERGIES_DUPLICATED');}
    break;
   case 'nutritionReference': nutrition(value);break;
   case 'target':fields(value,['mmolL','source'],['mmolL','source']);finite(value.mmolL,2,30);if(value.source!=='OWNER_MANUAL')fail('TARGET_SOURCE_INVALID');break;
   case 'foodModel':fields(value,['selectedModel','source'],['selectedModel','source']);if(!['GFForecast','GFCOB'].includes(value.selectedModel)||value.source!=='OWNER_MANUAL')fail('FOOD_MODEL_INVALID');break;
   case 'graphPreferences':fields(value,['showGFForecast','showGFxDrip'],['showGFForecast','showGFxDrip']);if(typeof value.showGFForecast!=='boolean'||typeof value.showGFxDrip!=='boolean')fail('GRAPH_TOGGLE_INVALID');break;
   case 'coefficientModeControls':validateModes(value);break;
   case 'activityPreferences':fields(value,['activityLevel','source'],['activityLevel','source']);if(!['low','normal','high','sport'].includes(value.activityLevel)||value.source!=='OWNER_MANUAL')fail('ACTIVITY_PREFERENCES_INVALID');break;
  }
  if(JSON.stringify(value).length>16384)fail('SETTING_TOO_LARGE');return value;
 }
 function view(raw,asOfIso){
  const s=snapshot(raw),at=instant(asOfIso),m=preferences(s);
  const graph=m.get('graphPreferences')||{showGFForecast:true,showGFxDrip:true};validateSetting('graphPreferences',graph);
  const food=m.get('foodModel')||{selectedModel:'GFForecast',source:'OWNER_MANUAL'};validateSetting('foodModel',food);
  const modeSetting=m.get('coefficientModeControls');if(modeSetting)validateModes(modeSetting);
  const modes=modeSetting?modeSetting.modes:defaultModes();
  const result={version:VERSION,schemaVersion:SCHEMA,revision:s.revision,inputRevision:s.inputRevision,profileConfigured:s.profileConfigured,profile:s.profileConfigured?s.data.profile:null,
   nutritionReference:m.get('nutritionReference')||null,target:m.get('target')||null,foodModel:food.selectedModel,foodModelPersisted:m.has('foodModel'),graphPreferences:graph,graphPreferencesPersisted:m.has('graphPreferences'),coefficientModesPersisted:!!modeSetting,coefficientModes:modes,autoEngineStatus:'NOT_CONNECTED_Q16',
   coefficients:[],settingsHistory:s.data.settingHistory,coefficientHistory:s.data.coefficientHistory,measurements:s.data.measurements};
  for(const kind of KINDS)for(const slotId of SLOT_IDS){
   const eligible=s.data.coefficients.filter(x=>x&&x.kind===kind&&x.slotId===slotId&&typeof x.effectiveFromUtc==='string'&&Date.parse(x.effectiveFromUtc)<=Date.parse(at));
   eligible.sort((a,b)=>Date.parse(b.effectiveFromUtc)-Date.parse(a.effectiveFromUtc)||b.createdRevision-a.createdRevision);
   const latest=eligible[0]||null,mode=modes[kind][slotId];
   const manual=latest&&latest.mode==='manual'&&Number.isFinite(latest.value)&&latest.value>0?latest:null;
   result.coefficients.push({kind,slotId,selectedMode:mode,status:mode==='auto'?'AUTO_PENDING_Q16':manual?'MANUAL_RECORDED':'UNKNOWN',
    value:mode==='manual'&&manual?manual.value:null,recordId:mode==='manual'&&manual?manual.id:null,
    historicalDisplayValue:latest?.value??null,source:mode==='manual'&&manual?manual.source:null});
  }
  return freeze(result);
 }
 function createService({readPort,idFactory,clock=()=>new Date().toISOString()}={}){
  if(typeof readPort!=='function'||typeof idFactory!=='function'||typeof clock!=='function')fail('TRUSTED_SETTINGS_PORT_REQUIRED');
  const read=()=>snapshot(readPort('settings'));
  const nextId=()=>{const id=idFactory();if(typeof id!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9_.:-]{4,127}$/.test(id)))fail('RECORD_ID_INVALID');return id;};
  function intent(role,s,command,payload,ownerConfirmed,asOf=null){
   if(ownerConfirmed!==true)fail('OWNER_CONFIRMATION_REQUIRED');
   if(!s.profileConfigured)fail('PROFILE_UNCONFIGURED');
   const key=nextId();
   if(asOf!==null)instant(asOf);
   return freeze({type:'GFSETTINGS_V3_OWNER_INTENT',command,role,profileId:s.profileId,expectedRevision:ensureRevision(s.revision),idempotencyKey:key,payload:copy(payload),ownerConfirmed:true});
  }
  return Object.freeze({VERSION,readView:(at=clock())=>view(readPort('settings'),at),
   stageSetting:(settingKey,value,ownerConfirmed,at=clock())=>{
    const s=read();validateSetting(settingKey,value);const t=instant(at);
    return intent('settingsWriter',s,'setting',{
     settingChangeId:nextId(),settingKey,value,effectiveAtUtc:t},ownerConfirmed,t);
   },
   stageMode:(kind,slotId,mode,ownerConfirmed,at=clock())=>{
    if(!KINDS.includes(kind)||!SLOT_IDS.includes(slotId)||!MODE_VALUES.includes(mode))fail('COEFFICIENT_MODE_INVALID');
    const s=read(),existing=preferences(s).get('coefficientModeControls');
    if(existing)validateModes(existing);
    const modes=existing?copy(existing.modes):defaultModes();modes[kind][slotId]=mode;
    return intent('settingsWriter',s,'setting',{
     settingChangeId:nextId(),settingKey:'coefficientModeControls',value:{schema:1,modes,autoEngineStatus:'NOT_CONNECTED_Q16'},effectiveAtUtc:instant(at)},ownerConfirmed,at);
   },
   stageManualCoefficient:(kind,slotId,value,ownerConfirmed,at=clock())=>{
    if(!KINDS.includes(kind)||!SLOT_IDS.includes(slotId))fail('COEFFICIENT_SLOT_NOT_ON_GRID');
    finite(value,0.001,500);const s=read();
    return intent('coefficientWriter',s,'coefficient',{
     coefficientId:nextId(),kind,slotId,value,mode:'manual',source:'OWNER_MANUAL',effectiveFromUtc:instant(at),ownerApproved:true},ownerConfirmed,at);
   },
   stageDailyFactor:(kind,value,ownerConfirmed,at=clock())=>{
    if(!['illness_factor','activity_factor'].includes(kind))fail('DAILY_FACTOR_KIND_INVALID');finite(value,0.1,10);const s=read();
    return intent('coefficientWriter',s,'coefficient',{
     coefficientId:nextId(),kind,slotId:null,value,mode:'manual',source:'OWNER_MANUAL',effectiveFromUtc:instant(at),ownerApproved:true},ownerConfirmed,at);
   }
  });
 }
 return Object.freeze({VERSION,SCHEMA,KINDS,SLOT_IDS,WRITE_KEYS,snapshot,validateSetting,validateModes,view,createService});
});
