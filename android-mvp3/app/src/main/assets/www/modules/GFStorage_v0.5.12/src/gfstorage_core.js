
/* ГлюкоПапа GFStorage v0.5.12 — canonical forecast visibility, same schema and snapshot driver.
 * UMD: CommonJS require(...) or browser global GFStorage.
 * No dosing calculations, no treatment advice, no automatic parameter application.
 * This standalone JS capability separation is NOT an OS security boundary.
 */
(function(root, make){
  'use strict';
  const grid = (typeof module === 'object' && module.exports) ? require('../../../shared/GFTimeGrid_v0.1.0.js') : root.GFTimeGrid;
  const api = make(grid);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GFStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(TimeGrid){
  'use strict';
  const VERSION = '0.5.12-unified-CANDIDATE', SCHEMA_VERSION = 5;
  if(!TimeGrid)throw Error('GFTimeGrid dependency required');
  const XDRIP_ID='xdrip-local-provider', XDRIP_TYPE='xdrip_local';
  const XDRIP_HISTORY='xdrip_loopback_history', XDRIP_HISTORY_WINDOW=24*60*60*1000;
  const isXDripHistory=row=>row.transport===XDRIP_HISTORY;
  // xDrip+ Constants.MMOLL_TO_MGDL. Store both the upstream value and the converted observation.
  const XDRIP_MGDL_PER_MMOL=18.01559;
  const DIRECTIONS=['DoubleUp','SingleUp','FortyFiveUp','Flat','FortyFiveDown','SingleDown','DoubleDown','NOT_COMPUTABLE'];
  const DRUGS = Object.freeze({
    rinfast: Object.freeze({id:'rinfast',name:'РинФаст',substance:'инсулин аспарт',type:'rapid'}),
    levemir: Object.freeze({id:'levemir',name:'Левемир',substance:'инсулин детемир',type:'basal'})
  });
  // Distinguish APPROVED HTML build version and internal model engine version.
  const MODELS = Object.freeze({
    rinfast:Object.freeze({drugId:'rinfast',approvedModuleVersion:'0.3.1',engineVersion:'0.3.0',
      model:'openaps_exponential_rapid',clinicalValidation:false,
      profile:Object.freeze({drugId:'rinfast',drugName:'РинФаст',substance:'инсулин аспарт',model:'openaps_exponential_rapid',modelVersion:'0.3.0',
        diaMinutes:300,peakMinutes:75,clinicalValidation:false})}),
    levemir:Object.freeze({drugId:'levemir',approvedModuleVersion:'0.1.2',engineVersion:'0.1.0',
      model:'detemir_population_time_trapezoid',clinicalValidation:false,
      profile:Object.freeze({drugId:'levemir',name:'Левемир',substance:'инсулин детемир',model:'detemir_population_time_trapezoid',
        modelVersion:'0.1.0',clinicalValidation:false,doseResponseInChildrenValidated:false,minimumJournalHours:48})})
  });
  const MEAL_MODELS = Object.freeze({
    GFForecast: Object.freeze({id:'GFForecast',version:'0.1.2'}),
    GFCOB: Object.freeze({id:'GFCOB',version:'0.1.1'})
  });
  const HIGH_ACTIVITY_DEFAULTS=Object.freeze({normal:1,high:1.05,sport:1.10});
  const FORECAST_INPUT_DOMAINS=new Set([
    'profile','measurements','coefficients','mealSessions','events','coverage','cgm','cgmMetadata','conditionPeriods','syncInbox'
  ]);
  const READ={
    settings:['profile','measurements','drugs','models','orders','coefficients','graphPreferences','history','conditionPeriods'],
    journal:['profile','measurements','drugs','orders','events','coverage','mealSessions','workflowLog','conditionPeriods','forecasts','forecastAssessments'],
    actionWriter:['events','mealSessions','coverage','workflowLog'],
    food:['profile','mealSessions'],
    mealFlow:['mealSessions','events','cgm'],
    calculator:['profile','measurements','drugs','models','coefficients','events','coverage','cgm','results','proposals','mealSessions'],
    lowReview:['profile','measurements','models','coefficients','events','coverage','cgm','cgmMetadata','mealSessions','conditionPeriods'],
    cgm:['cgm'],
    rinfast:['drugs','models','events','coverage','results'],
    levemir:['drugs','models','measurements','events','coverage','results'],
    graph:['models','coefficients','events','cgm','results','graphPreferences','mealSessions','forecasts'],
    research:['profile','measurements','drugs','models','orders','coefficients','events','coverage','cgm','results','proposals','mealSessions','forecasts','forecastAssessments','conditionPeriods'],
    injectionAnalytics:['events','cgm','cgmMetadata','conditionPeriods'],
    context:['conditionPeriods'],
    sport:['conditionPeriods','profile'],
    activityUi:['conditionPeriods','profile'],
    cgmAdapter:['cgm','cgmMetadata'],
    forecastWriter:['forecasts','forecastAssessments'],
    syncWriter:['syncInbox','cgm','cgmMetadata'],
  };
  const KINDS=new Set(['isf_mmol_per_u','carb_g_per_u','tdd_u','target_range_mmol']);
  const forbidden = new Set(['__proto__','prototype','constructor']);
  // ISPAD 2022 exercise carbohydrate ranges are an activity-planning reference, NOT hypo treatment.
  // Only user modifications are persisted. Null means use the published guideline defaults.
  function validateExerciseGuidance(x){
    requireFields(x,['version','source','basalOnly','activeBolus','editedAt'],['version','source','basalOnly','activeBolus','editedAt']);
    if(x.version!==1||x.source!=='user_override')fail('Некорректный источник настройки активности');
    iso(x.editedAt);
    for(const k of ['basalOnly','activeBolus']){
      requireFields(x[k],['low','high'],['low','high']);
      range(x[k].low,0,3);range(x[k].high,0,3);
      if(x[k].low>x[k].high)fail('Нижний коэффициент активности не может превышать верхний');
    }
    return clone(x);
  }
  // Optional, versioned experimental scenario coefficient store. These are NOT published medical parameters.
  function validateHypoActivityOverrides(x){
    requireFields(x,['version','source','low','normal','high','sport','editedAt'],['version','source','low','normal','high','sport','editedAt']);
    if(x.version!==1||x.source!=='user_override')fail('Некорректный источник множителей низкого сахара');
    iso(x.editedAt);
    for(const k of ['low','normal','high','sport'])range(x[k],0.5,2);
    return clone(x);
  }
  // Candidate-only bookkeeping; these flags never select a therapeutic dose.
  function validateCoefficientModes(x){
    requireFields(x,['carb_g_per_u','isf_mmol_per_u'],['carb_g_per_u','isf_mmol_per_u']);
    for(const kind of ['carb_g_per_u','isf_mmol_per_u'])if(!['manual','auto'].includes(x[kind]))fail('Неподдерживаемый режим коэффициента');
    return clone(x);
  }
  function validateHighActivity(x){
    requireFields(x,['version','enabled','selectedLevel','coefficients','source','editedAt'],
      ['version','enabled','selectedLevel','coefficients','source','editedAt']);
    if(x.version!==1||typeof x.enabled!=='boolean'||!Object.hasOwn(HIGH_ACTIVITY_DEFAULTS,x.selectedLevel)||
      x.source!=='user_configured')fail('Неподдерживаемая настройка активности HIGH');
    requireFields(x.coefficients,Object.keys(HIGH_ACTIVITY_DEFAULTS),Object.keys(HIGH_ACTIVITY_DEFAULTS));
    for(const value of Object.values(x.coefficients))range(value,0.5,2);
    iso(x.editedAt);
  }
  function validateHighTarget(x){
    requireFields(x,['version','valueMmol','source','editedAt'],['version','valueMmol','source','editedAt']);
    if(x.version!==1||x.source!=='user_input')fail('Неизвестный источник цели HIGH');
    range(x.valueMmol,4,13);iso(x.editedAt);
  }
  function validateIllnessFactor(x){
    requireFields(x,['value','source','editedAt'],['value','source','editedAt']);
    range(x.value,0.1,10); // data-integrity bound only, NOT a medical range
    if(x.source!=='user_input')fail('Коэффициент болезни должен быть явно введён пользователем');
    iso(x.editedAt);return clone(x);
  }
  function fail(message){throw new Error(message);}
  function object(x){return x!==null && typeof x==='object' && !Array.isArray(x) && (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);}
  function validData(x, depth=0){
    if(depth>16) fail('Слишком большая вложенность объекта');
    if(x===null||typeof x==='string'||typeof x==='boolean')return;
    if(typeof x==='number'&&Number.isFinite(x))return;
    if(Array.isArray(x)){if(x.length>100000)fail('Слишком большой массив'); x.forEach(v=>validData(v,depth+1));return;}
    if(object(x)) { for(const [k,v] of Object.entries(x)){if(forbidden.has(k))fail('Недопустимый ключ');validData(v,depth+1);}return; }
    fail('Недопустимый тип данных (функции/NaN/undefined запрещены)');
  }
  function clone(x){validData(x);const json=JSON.stringify(x);if(json.length>50000000)fail('Запись превышает допустимый размер');return JSON.parse(json);}
  function frozen(x){const a=clone(x); const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};return freeze(a);}
  function requireFields(o,allowed,required=[]){
    if(!object(o))fail('Ожидался объект');
    for(const k of Object.keys(o))if(!allowed.includes(k))fail('Поле не разрешено: '+k);
    for(const k of required)if(!(k in o))fail('Отсутствует поле: '+k);
    clone(o);
  }
  const iso=(s)=>{if(typeof s!=='string'||!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))fail('Нужно время ISO 8601 с часовым поясом');return s;};
  const date=(s)=>{if(typeof s!=='string'||!/^\d{4}-\d\d-\d\d$/.test(s)||Number.isNaN(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('Некорректная дата');return s;};
  const id=(s)=>{if(typeof s!=='string'||!/^[-\w:.]{1,100}$/.test(s))fail('ID: 1–100 букв латиницы, цифр, _ - . :');return s;};
  const text=(s,max=400)=>{if(typeof s!=='string'||s.length>max||!s.trim())fail('Пустой или слишком длинный текст');return s;};
  const range=(n,low,high)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<low||n>high)fail('Числовое значение вне допустимых границ');return n;};
  const drug=(s)=>{if(!Object.hasOwn(DRUGS,s))fail('Неизвестный препарат: '+s);return s;};
  const hhmm=(s)=>{if(typeof s!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))fail('Неверное время HH:mm');return s;};
  function ensureTimeOrder(a,b){if(b && Date.parse(iso(a))>=Date.parse(iso(b)))fail('Начало интервала должно предшествовать концу');}
  function validateSite(x){
    requireFields(x,['region','side'],['region']);
    if(!['abdomen','arm','thigh','buttock'].includes(x.region))fail('Неизвестная область инъекции');
    if(x.side!==undefined&&x.side!==null&&!['left','right'].includes(x.side))fail('Неверная сторона инъекции');
    return clone(x);
  }
  function validatePeriod(x){
    requireFields(x,['id','kind','start','end','note','source'],['id','kind','start','end','source']);
    id(x.id);if(!['illness','activity','sport'].includes(x.kind))fail('Тип периода не поддерживается');
    iso(x.start);if(x.end!==null){iso(x.end);if(Date.parse(x.end)<=Date.parse(x.start))fail('Период должен иметь положительную длительность');}
    if(x.source!=='user')fail('Источник периода должен быть задан пользователем');
    if(x.note!==undefined&&typeof x.note!=='string')fail('Неверное примечание периода');
    if(x.note!==undefined&&x.note.length>300)fail('Слишком длинное примечание');
    return clone(x);
  }
  function validateCgmMetadata(x){
    requireFields(x,['sourceDeviceId','sourceType','samplingMinutes','qualityScore'],['sourceDeviceId','sourceType','samplingMinutes','qualityScore']);
    id(x.sourceDeviceId);
    if(x.sourceType===XDRIP_TYPE){
      if(x.sourceDeviceId!==XDRIP_ID||x.samplingMinutes!==null||x.qualityScore!==null)
        fail('CGM_XDRIP_PROVENANCE: локальный интерфейс не сообщает качество или штатный интервал');
      return clone(x);
    }
    if(x.sourceDeviceId===XDRIP_ID||!['device_recorded','synthetic'].includes(x.sourceType))fail('Источник CGM: только устройство или тест');
    if(![5,10].includes(x.samplingMinutes))fail('Интервал CGM должен быть 5 или 10 минут');
    range(x.qualityScore,0,1);
    return clone(x);
  }
  function validateContext(x,ts,periods){
    const fields=['illness','activity','carbsG','iobU','mealLagMinutes','mealGroup','settingRevision','localHour','utcOffsetMinutes','illnessPeriodId','activityPeriodId'];
    requireFields(x,fields,fields.slice(0,9));iso(ts);
    if(!['no','yes'].includes(x.illness)||!['low','usual','high'].includes(x.activity))fail('Некорректные состояния');
    range(x.carbsG,0,400);range(x.iobU,0,100);range(x.mealLagMinutes,-60,180);
    if(!['with_meal','without_meal'].includes(x.mealGroup)||x.mealGroup==='without_meal'&&x.carbsG>5)fail('Несогласованная информация о еде');
    if((typeof x.settingRevision!=='string'||!x.settingRevision.trim())&&!Number.isSafeInteger(x.settingRevision))fail('Нет версии настроек');
    if(!Number.isInteger(x.localHour)||x.localHour<0||x.localHour>23)fail('Не указан локальный час');
    if(!Number.isInteger(x.utcOffsetMinutes)||x.utcOffsetMinutes < -720||x.utcOffsetMinutes>840||x.utcOffsetMinutes%15!==0)fail('Неверное UTC-смещение');
    if(new Date(Date.parse(ts)+x.utcOffsetMinutes*60000).getUTCHours()!==x.localHour)fail('Час и UTC-смещение противоречат времени укола');
    const checkPeriod=(key,kind,needed)=>{
      const v=x[key];if(!needed){if(v!==undefined&&v!==null)fail('Неожиданный период для обычного состояния');return;}
      id(v);const p=periods.find(y=>y.id===v&&y.kind===kind);
      if(!p)fail('Не найден подтверждённый период '+kind);
      if(Date.parse(p.start)>Date.parse(ts)||(p.end!==null&&Date.parse(p.end)<Date.parse(ts)))fail('Инъекция вне периода '+kind);
    };
    const active=(kind)=>periods.some(p=>p.kind===kind&&Date.parse(p.start)<=Date.parse(ts)&&(p.end===null||Date.parse(p.end)>=Date.parse(ts)));
    if(active('illness')!==(x.illness==='yes'))fail('Состояние болезни противоречит хронологии');
    if(active('activity')!==(x.activity!=='usual'))fail('Активность противоречит хронологии');
    checkPeriod('illnessPeriodId','illness',x.illness==='yes');
    checkPeriod('activityPeriodId','activity',x.activity!=='usual');
    return clone(x);
  }

  function validatePreinjectionIob(evidence,shot,events,revision){
    const fields=['contract','atIso','sourceRevision','modelVersion','modelUnits','priorInjectionIds',
      'coverageStart','coverageEnd','activity','settingKey','clinicalUse'];
    requireFields(evidence,fields,fields);
    const at=Date.parse(shot.administeredAt);
    iso(evidence.coverageStart);iso(evidence.coverageEnd);
    if(evidence.contract!=='glucopapa.preinjection-iob/1'||evidence.atIso!==shot.administeredAt||
      shot.insulinId!=='rinfast'||evidence.clinicalUse!==false||
      !Number.isSafeInteger(evidence.sourceRevision)||evidence.sourceRevision<0||evidence.sourceRevision>revision||
      evidence.modelVersion!=='0.3.0'||Date.parse(evidence.coverageStart)>at-48*3600000||
      Date.parse(evidence.coverageEnd)<at||
      ![null,'low','usual','high'].includes(evidence.activity)||
      (evidence.settingKey!==null&&(typeof evidence.settingKey!=='string'||evidence.settingKey.length>512))||
      !Array.isArray(evidence.priorInjectionIds)||new Set(evidence.priorInjectionIds).size!==evidence.priorInjectionIds.length||
      evidence.priorInjectionIds.some(id=>id===shot.id||!events.some(e=>e.id===id&&e.type==='insulin_injection'&&
        e.status==='confirmed'&&e.insulinId==='rinfast'&&Date.parse(e.administeredAt)<=at)))
      fail('Некорректное происхождение исторического IOB');
    range(evidence.modelUnits,0,100);
    return clone(evidence);
  }

  function validateForecastVisibility(value){
    requireFields(value,['GFForecast','GFxDrip','GFAPSEnhancer','GFConsensus']);
    if(Object.values(value).some(flag=>typeof flag!=='boolean'))fail('Неверная видимость прогноза');
  }

  function validateMealModel(value){
    requireFields(value,['id','version'],['id','version']);
    if(!Object.hasOwn(MEAL_MODELS,value.id)||value.version!==MEAL_MODELS[value.id].version)
      fail('Неизвестная версия модели усвоения еды');
  }

  function validateForecastRow(row){
    requireFields(row,['id','kind','payload'],['id','kind','payload']);
    if(row.kind!=='research_forecast'||!object(row.payload))fail('Ожидался исследовательский прогноз');
    const f=row.payload;
    iso(f.forecastAt);iso(f.sourceTime);
    if(f.status!=='EXPERIMENTAL'||f.mode!=='RESEARCH_FORECAST'||typeof f.version!=='string'||!f.version||!Array.isArray(f.points)||f.points.length!==25)fail('Недействительный прогноз');
    if(row.id!==f.forecastAt+'|'+f.sourceTime+'|'+f.version)fail('Несовпадение ID прогноза');
    if(f.contract!==undefined){
      if(f.contract!=='glucopapa.research-forecast/2'||
        !['GFForecast','GFAPSEnhancer','GFxDrip','GFConsensus'].includes(f.modelId)||
        typeof f.modelVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(f.modelVersion)||
        f.version!==f.modelId+'@'+f.modelVersion||typeof f.inputDigest!=='string'||!/^[0-9a-f]{64}$/.test(f.inputDigest)||
        !Number.isSafeInteger(f.sourceRevision)||f.sourceRevision<0||
        f.clinicalUse!==false||f.modelValidated!==false)fail('Недопустимое происхождение прогноза');
      if(f.mealModel!==undefined)validateMealModel(f.mealModel);
      if(f.timeAlignment!==undefined){
        const alignment=f.timeAlignment;
        requireFields(alignment,['originalOrigin','method'],['originalOrigin','method']);
        iso(alignment.originalOrigin);
        if(f.modelId!=='GFAPSEnhancer'||Date.parse(alignment.originalOrigin)!==Date.parse(f.sourceTime)||
          !['direct','linear-on-measured-grid-v1'].includes(alignment.method)||
          (alignment.method==='direct')!==(Date.parse(f.sourceTime)===Date.parse(f.forecastAt)))fail('Несогласованное выравнивание прогноза');
      }
      if(f.selection!==undefined)validateConsensusSelection(f);
      iso(f.sourceReceivedAt);
      if(Date.parse(f.sourceTime)>Date.parse(f.sourceReceivedAt)||Date.parse(f.sourceReceivedAt)>Date.parse(f.forecastAt))
        fail('Времена CGM после выдачи или до измерения');
    }
    for(let i=0;i<25;i++){const p=f.points[i];if(!object(p)||p.horizonMin!==i*5||typeof p.glucoseMmol!=='number'||!Number.isFinite(p.glucoseMmol)||p.glucoseMmol<0||p.glucoseMmol>40)fail('Повреждена точка прогноза');iso(p.at);if(Date.parse(p.at)!==Date.parse(f.forecastAt)+i*300000)fail('Неверное время прогноза');}
    if(!object(f.snapshot)||typeof f.snapshot.sensorSourceId!=='string'||!f.snapshot.sensorSourceId)fail('Нет доверенного источника CGM в прогнозе');
    return clone(row);
  }
  function validateConsensusSelection(f){
    const selection=f.selection;
    const fields=['contract','version','status','reason','leader','modelIds','trainedVersions','sourceId','evaluatedAt','results','clinicalUse'];
    requireFields(selection,fields,fields);
    const models=['GFForecast','GFxDrip','GFAPSEnhancer'];
    if(f.modelId!=='GFConsensus'||selection.contract!=='glucopapa.consensus-selection/1'||
      selection.version!==f.modelVersion||!['LEADER','COMPOSITE'].includes(selection.status)||
      selection.clinicalUse!==false||selection.sourceId!==f.snapshot?.sensorSourceId||selection.evaluatedAt!==f.forecastAt||
      !Array.isArray(selection.modelIds)||selection.modelIds.length<2||
      new Set(selection.modelIds).size!==selection.modelIds.length||selection.modelIds.some(id=>!models.includes(id))||
      (selection.status==='LEADER'?!selection.modelIds.includes(selection.leader):selection.leader!==null)||
      !Array.isArray(selection.results)||selection.results.length!==3)
      fail('Некорректный выбор исследовательского прогноза');
    requireFields(selection.trainedVersions,selection.modelIds,selection.modelIds);
    for(const id of selection.modelIds)if(!/^\d+\.\d+\.\d+$/.test(selection.trainedVersions[id]))fail('Неверная версия движка');
    for(const [i,horizon] of [30,60,120].entries()){
      const row=selection.results[i];
      if(!object(row)||row.horizon!==horizon||row.status!=='LEADER'||!selection.modelIds.includes(row.leader)||
        !Number.isSafeInteger(row.n)||row.n<288||!Number.isSafeInteger(row.pairedMinutes)||row.pairedMinutes<1440)
        fail('Недостаточные доказательства выбора прогноза');
    }
  }
  function validateAssessmentRow(row){
    requireFields(row,['id','kind','payload'],['id','kind','payload']);
    if(row.kind!=='research_forecast_assessment'||!object(row.payload))fail('Ожидалась сверка прогноза');
    const a=row.payload;iso(a.forecastAt);iso(a.assessedAt);
    if(typeof a.forecastId!=='string'||row.id!==a.forecastId+'|'+a.assessedAt)fail('Несовпадение ID сверки');
    if(!Array.isArray(a.checks)||!Array.isArray(a.peaks))fail('Некорректная сверка');
    return clone(row);
  }
  function validReceipt(x,ts){
    iso(x);const t=Date.parse(x);if(t<ts)fail('CGM получен раньше измерения');return x;
  }
  function xdripObservation(x){
    requireFields(x,['ts','mgdl','receivedAt','direction','staleAtReceipt'],['ts','mgdl','receivedAt','direction','staleAtReceipt']);
    if(!Number.isSafeInteger(x.ts)||x.ts<946684800000||x.ts>4102444800000)fail('CGM_XDRIP_TIMESTAMP');
    validReceipt(x.receivedAt,x.ts);
    const mmol=range(x.mgdl,1.5*XDRIP_MGDL_PER_MMOL,30*XDRIP_MGDL_PER_MMOL)/XDRIP_MGDL_PER_MMOL;
    if(x.direction!==null&&!DIRECTIONS.includes(x.direction))fail('CGM_XDRIP_TREND');
    if(x.staleAtReceipt!==null&&typeof x.staleAtReceipt!=='boolean')fail('CGM_XDRIP_FRESHNESS');
    return {ts:x.ts,mmol,source:XDRIP_TYPE,kind:'observed',sourceDeviceId:XDRIP_ID,
      mgdl:x.mgdl,receivedAt:x.receivedAt,direction:x.direction,staleAtReceipt:x.staleAtReceipt};
  }
  function xdripHistoricalObservation({ts,mgdl,receivedAt,direction}){
    if(!Number.isInteger(mgdl))fail('CGM_XDRIP_HISTORY_FORMAT');
    return {...xdripObservation({ts,mgdl,receivedAt,direction,staleAtReceipt:null}),transport:XDRIP_HISTORY};
  }
  function emptyState(){return {schemaVersion:SCHEMA_VERSION,revision:0,profile:{birthDate:null,timeZone:null,displayName:null,sex:null,allergies:[],dailyNutritionReference:null,exerciseGuidance:null,exerciseGuidanceEnabled:true,hypoActivityMultipliers:null,hypoActivityEnabled:true,activityBaseLevel:'low',coefficientModes:{carb_g_per_u:'manual',isf_mmol_per_u:'manual'},illnessFactor:null},measurements:[],drugs:clone(DRUGS),models:clone(MODELS),orders:[],coefficients:[],events:[],mealSessions:[],workflowLog:[],coverage:null,cgm:[],cgmMetadata:null,conditionPeriods:[],forecasts:[],forecastAssessments:[],syncInbox:[],results:[],proposals:[],graphPreferences:{layout:'guided',theme:'light',rangeHours:12,showRinfast:true,showTotal:false},history:[]};}
  function validateStored(s){
    if(!object(s)||s.schemaVersion!==SCHEMA_VERSION||!Number.isSafeInteger(s.revision)||s.revision<0)fail('Несовместимая версия базы');
    const expected=Object.keys(emptyState());
    requireFields(s,expected,expected);
    for(const key of ['measurements','orders','coefficients','events','mealSessions','workflowLog','cgm','conditionPeriods','forecasts','forecastAssessments','syncInbox','results','proposals','history'])if(!Array.isArray(s[key]))fail('Повреждена таблица '+key);
    if(s.history.length!==s.revision)fail('Повреждён журнал ревизий');
    if(!object(s.graphPreferences))fail('Повреждены настройки графика');
    if('autoConsensus'in s.graphPreferences&&typeof s.graphPreferences.autoConsensus!=='boolean')fail('Неверный флаг объединения');
    if('forecastVisibility'in s.graphPreferences)validateForecastVisibility(s.graphPreferences.forecastVisibility);
    if('showForecastMean' in s.graphPreferences){
      if(typeof s.graphPreferences.showForecastMean!=='boolean')fail('Неверный флаг средней линии');
      const {showForecastMean, ...graphPreferences}=s.graphPreferences;
      const stored=graphPreferences.forecastVisibility??{};
      graphPreferences.forecastVisibility={...stored,GFConsensus:stored.GFConsensus??showForecastMean};
      s={...s,graphPreferences};
    }
    if(!object(s.profile))fail('Повреждён профиль ребёнка');
    if(s.profile.sex===undefined||s.profile.exerciseGuidance===undefined||s.profile.exerciseGuidanceEnabled===undefined||s.profile.hypoActivityMultipliers===undefined||s.profile.hypoActivityEnabled===undefined||s.profile.activityBaseLevel===undefined||s.profile.coefficientModes===undefined||s.profile.illnessFactor===undefined)s=Object.assign({},s,{profile:Object.assign({},s.profile,{...(s.profile.sex===undefined?{sex:null}:{}),...(s.profile.exerciseGuidance===undefined?{exerciseGuidance:null}:{}),...(s.profile.exerciseGuidanceEnabled===undefined?{exerciseGuidanceEnabled:true}:{}),...(s.profile.hypoActivityMultipliers===undefined?{hypoActivityMultipliers:null}:{}),...(s.profile.hypoActivityEnabled===undefined?{hypoActivityEnabled:true}:{}),...(s.profile.activityBaseLevel===undefined?{activityBaseLevel:'low'}:{}),...(s.profile.coefficientModes===undefined?{coefficientModes:{carb_g_per_u:'manual',isf_mmol_per_u:'manual'}}:{}),...(s.profile.illnessFactor===undefined?{illnessFactor:null}:{})})});
    if(s.profile.sex!==null&&!['male','female'].includes(s.profile.sex))fail('Недопустимое значение поля');
    if(s.profile.exerciseGuidance!==null)validateExerciseGuidance(s.profile.exerciseGuidance);
    if(typeof s.profile.exerciseGuidanceEnabled!=='boolean')fail('Учёт активности: только true/false');
    if(s.profile.hypoActivityMultipliers!==null)validateHypoActivityOverrides(s.profile.hypoActivityMultipliers);
    if(typeof s.profile.hypoActivityEnabled!=='boolean')fail('Учёт множителя низкого сахара: true/false');
    if(!['low','usual','high'].includes(s.profile.activityBaseLevel))fail('Неверный базовый уровень активности');
    validateCoefficientModes(s.profile.coefficientModes);
    if(s.profile.mealAbsorptionModel!==undefined)validateMealModel(s.profile.mealAbsorptionModel);
    if(s.profile.highActivity!==undefined)validateHighActivity(s.profile.highActivity);
    if(s.profile.highTarget!=null)validateHighTarget(s.profile.highTarget);
    if(s.profile.illnessFactor!==null)validateIllnessFactor(s.profile.illnessFactor);
    if(s.cgmMetadata!==null){validateCgmMetadata(s.cgmMetadata);
      if(s.cgm.some(x=>x.sourceDeviceId!==undefined&&x.sourceDeviceId!==s.cgmMetadata.sourceDeviceId))fail('CGM содержит записи другого источника');
      if(s.cgm.some(x=>x.sourceDeviceId===undefined&&!(x.source==='xdrip_follower'&&x.kind==='observed'&&!isXDripHistory(x))))fail('Неизвестное происхождение старых CGM');
      if(s.cgmMetadata.sourceType===XDRIP_TYPE){
        const times=new Set();
        let latestProvider=-Infinity, latestHistory=-Infinity;
        for(const x of s.cgm.filter(r=>r.sourceDeviceId!==undefined)){
          const {ts,mgdl,receivedAt,direction,staleAtReceipt}=x;
          const historical=isXDripHistory(x);
          const reading=historical?xdripHistoricalObservation({ts,mgdl,receivedAt,direction}):
            xdripObservation({ts,mgdl,receivedAt,direction,staleAtReceipt});
          if(historical)latestHistory=Math.max(latestHistory,ts);
          else latestProvider=Math.max(latestProvider,ts);
          if(times.has(ts)||Object.keys(x).length!==Object.keys(reading).length||
             Object.keys(reading).some(key=>reading[key]!==x[key]))fail('CGM_XDRIP_CORRUPT');
          times.add(ts);
        }
        if(latestHistory!==-Infinity&&latestHistory>=latestProvider)fail('CGM_XDRIP_HISTORY_WITHOUT_PROVIDER');
      }
    }
    if(s.cgmMetadata?.sourceType!==XDRIP_TYPE&&s.cgm.some(x=>x.source===XDRIP_TYPE||x.sourceDeviceId===XDRIP_ID||isXDripHistory(x)))
      fail('CGM_XDRIP_PROVENANCE');
    for(const p of s.conditionPeriods)validatePeriod(p);
    if(new Set(s.conditionPeriods.map(x=>x.id)).size!==s.conditionPeriods.length)fail('Повтор ID периода');
    // Fail closed on duplicate identities before Journal/Report can count a physical event twice.
    // Never silently discard records: the original persisted snapshot remains untouched.
    const allEventIds=new Set(), confirmedInjectionIds=new Map();
    for(const e of s.events){
      if(!object(e)||typeof e.id!=='string'||!e.id.trim())fail('Повреждён идентификатор события');
      if(allEventIds.has(e.id))fail('DUPLICATE_EVENT_ID: повтор события '+e.id);
      allEventIds.add(e.id);
      if(e.type==='insulin_injection'&&e.status==='confirmed'){
        if(e.injectionSite!==undefined)validateSite(e.injectionSite);
        if(e.injectionContext!==undefined)validateContext(e.injectionContext,e.administeredAt,s.conditionPeriods);
        if(e.iobEvidence!==undefined){
          if(!e.linkedMealSessionId)fail('Исторический IOB должен относиться к связанной инъекции');
          validatePreinjectionIob(e.iobEvidence,e,s.events,s.revision);
        }
        confirmedInjectionIds.set(e.id,e);
      }
    }
    // The meal links are references, NOT additional injections. Each actual injection
    // belongs to at most one meal session; a broken link blocks the projection.
    const linkedInjectionIds=new Set();
    for(const session of s.mealSessions){
      if(!object(session)||!Array.isArray(session.injectionIds))fail('Повреждена связь еды с инъекциями');
      for(const injectionId of session.injectionIds){
        if(typeof injectionId!=='string'||!confirmedInjectionIds.has(injectionId))fail('MISSING_INJECTION_REFERENCE: связь еды без фактической инъекции');
        if(linkedInjectionIds.has(injectionId))fail('DUPLICATE_INJECTION_LINK: одна инъекция привязана к нескольким приёмам еды');
        linkedInjectionIds.add(injectionId);
        const injection=confirmedInjectionIds.get(injectionId);
        if(injection.linkedMealSessionId&&injection.linkedMealSessionId!==session.id)
          fail('INJECTION_LINK_CONFLICT: несогласованная принадлежность инъекции');
      }
    }
    for(const injection of confirmedInjectionIds.values()){
      if(injection.linkedMealSessionId&&!linkedInjectionIds.has(injection.id))
        fail('ORPHAN_LINKED_INJECTION: инъекция указывает на еду без обратной связи');
    }
    // Reject synthetic or foreign forecast records masquerading as confirmed actuals.
    const forecastIds=new Set();
    for(const row of s.forecasts){validateForecastRow(row);if(forecastIds.has(row.id))fail('Повтор ID прогноза');forecastIds.add(row.id);}
    const assessmentIds=new Set();
    for(const row of s.forecastAssessments){validateAssessmentRow(row);if(assessmentIds.has(row.id))fail('Повтор ID сверки');assessmentIds.add(row.id);if(!forecastIds.has(row.payload.forecastId))fail('Сверка без прогноза');}
    const syncIds=new Set();
    for(const row of s.syncInbox){requireFields(row,['id','kind','recordId','receivedAt','origin','body'],['id','kind','recordId','receivedAt','origin','body']);id(row.id);iso(row.receivedAt);if(row.kind!=='cgm')fail('Запрещён тип удалённого события');if(syncIds.has(row.id))fail('Повтор сетевого ID');syncIds.add(row.id);}
    // Approved model reference profiles are immutable; reject tampered persisted state.
    if(JSON.stringify(s.models)!==JSON.stringify(MODELS)||JSON.stringify(s.drugs)!==JSON.stringify(DRUGS))fail('Реестр препаратов или моделей был изменён');
    for(let i=0;i<s.history.length;i++)if(s.history[i].revision!==i+1)fail('Нарушен журнал ревизий');
    // Meal state must match the latest audited snapshot. This catches inconsistent writes.
    const latest=new Map(),seenOperations=new Set();
    for(const op of s.workflowLog){
      if(!object(op)||typeof op.id!=='string'||typeof op.sessionId!=='string'||!Number.isSafeInteger(op.revision)||op.revision<=0||op.revision>s.revision)fail('Повреждён журнал операций еды');
      if(seenOperations.has(op.id))fail('Дублируется операция в журнале еды');seenOperations.add(op.id);
      if(!s.history.some(h=>h.revision===op.revision&&h.domain==='mealSessions'&&h.actor===op.actor&&h.recordId===op.sessionId&&h.action===op.action))fail('Операция еды не связана с журналом ревизий');
      if(!object(op.after)||op.after.id!==op.sessionId||!Number.isSafeInteger(op.after.version))fail('Повреждён снимок операции');
      const prev=latest.get(op.sessionId)||null;
      if(JSON.stringify(op.before)!==JSON.stringify(prev)||op.after.version!==(prev?prev.version+1:1))fail('Нарушена последовательность версий тарелки');
      latest.set(op.sessionId,op.after);
    }
    if(s.mealSessions.length!==latest.size)fail('Несогласованность списка приёмов пищи');
    for(const m of s.mealSessions){if(JSON.stringify(m)!==JSON.stringify(latest.get(m.id)))fail('История еды не соответствует текущему состоянию');}
    return clone(s);
  }
  function migrateStored(saved){
    if(saved && [1,2,3,4].includes(saved.schemaVersion)){
      const next=clone(saved);
      if(next.schemaVersion===1){next.mealSessions=[];next.workflowLog=[];
        if(next.profile.sex===undefined)next.profile.sex=null;}
      if(next.schemaVersion<=2){next.cgmMetadata=null;next.conditionPeriods=[];}
      if(next.profile.dailyNutritionReference===undefined)next.profile.dailyNutritionReference=null;
      if(next.schemaVersion<=3){next.forecasts=[];next.forecastAssessments=[];next.syncInbox=[];}
      next.schemaVersion=SCHEMA_VERSION;
      return next;
    }
    return saved;
  }
  function createHost({driver=null,clock=()=>new Date().toISOString()}={}){
    if(driver && (typeof driver.load!=='function'||typeof driver.save!=='function'))fail('Драйвер должен иметь load/save');
    const loaded=driver?driver.load():null;
    let state=loaded===null||loaded===undefined?emptyState():validateStored(migrateStored(loaded));
    const listeners=new Set();
    function commit(role,domain,action,mutate,expectedRevision){
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('Для записи нужен expectedRevision');
      if(expectedRevision!==state.revision)fail('Конфликт ревизии: повторно прочтите настройки перед записью');
      const draft=clone(state), now=iso(clock());
      const target=mutate(draft,now);
      if(target===null)return frozen({revision:state.revision,idempotent:true});
      const rev=state.revision+1;
      draft.revision=rev;
      const audit={revision:rev,at:now,actor:role,domain,action,recordId:String(target)};
      // Keep old and new values for replaceable records; append-only tables keep full records themselves.
      if(['profile','coverage','graphPreferences','cgmMetadata','conditionPeriods'].includes(domain)){
        const oldRecord=state[domain],newRecord=draft[domain],changeSet={};
        const oldFields=oldRecord===null?{}:oldRecord,newFields=newRecord===null?{}:newRecord;
        for(const key of new Set([...Object.keys(oldFields),...Object.keys(newFields)])){
          if(JSON.stringify(oldFields[key])!==JSON.stringify(newFields[key])){
            changeSet[key]={before:oldFields[key]===undefined?null:oldFields[key],after:newFields[key]===undefined?null:newFields[key]};
          }
        }
        audit.changes=changeSet;
      }
      draft.history.push(audit);
      validateStored(draft);

      // Stage 2: optimistic conflict check against the persisted snapshot.
      // Prevents a stale GFStorage host from silently overwriting a newer revision.
      // Not a multi-process atomic database transaction; Android Room remains required.
      if(driver){
        const persisted=driver.load();
        if(persisted===null||persisted===undefined){
          if(state.revision!==0)fail('CONCURRENT_STORAGE_CHANGE: база была удалена или заменена; повторно откройте журнал');
        } else {
          const latest=validateStored(migrateStored(persisted));
          if(latest.revision!==state.revision||JSON.stringify(latest)!==JSON.stringify(state))
            fail('CONCURRENT_STORAGE_CHANGE: данные обновлены другим экземпляром; повторно откройте журнал');
        }
      }
      if(driver){driver.save(clone(draft),state.revision);} // Failure leaves in-memory state unchanged.
      state=draft;
      const notification=frozen({revision:rev,domain,action});
      for(const callback of listeners){try{callback(notification);}catch(e){/* listener errors cannot roll back committed writes */}}
      return frozen({revision:rev,recordId:String(target)});
    }
    function projectedEventForAnalytics(e){
      const o=clone(e);if(o.type!=='insulin_injection'||!o.injectionContext)return o;
      const c=o.injectionContext;
      for(const [key,out] of [['illnessPeriodId','illnessPeriod'],['activityPeriodId','activityPeriod']]){
        if(c[key]){
          const p=state.conditionPeriods.find(x=>x.id===c[key]);
          // Ongoing periods have no confirmed end. Keep the observation ineligible until closed.
          c[out]=p&&p.end!==null?{id:p.id,start:p.start,end:p.end}:null;
        }
      }
      return o;
    }
    function projection(role){
      const out={schemaVersion:state.schemaVersion,revision:state.revision};
      for(const field of READ[role]){
        if(role==='injectionAnalytics'&&field==='events')out[field]=state.events.map(projectedEventForAnalytics);
        else if(field==='cgm')out[field]=readCgm(role);
        else out[field]=role==='food'&&field==='mealSessions'?state.mealSessions.map(foodView):state[field];
      }
      return frozen(out);
    }
    function foodView(s){return {id:s.id,version:s.version,status:s.status,plannedPlate:s.plannedPlate,actualPlate:s.actualPlate,startedAt:s.startedAt,completedAt:s.completedAt};}
    function readCgm(role){
      if(role==='graph'||role==='cgmAdapter')return state.cgm;
      return state.cgm.filter(row=>!isXDripHistory(row)&&
        (role!=='injectionAnalytics'||!state.cgmMetadata||row.sourceDeviceId===state.cgmMetadata.sourceDeviceId));
    }
    function select(role,field){
      if(!READ[role].includes(field))fail('Нет доступа к разделу '+field);
      if(field==='cgm')return frozen(readCgm(role));
      return frozen(role==='food'&&field==='mealSessions'?state.mealSessions.map(foodView):state[field]);
    }
    function validatePlate(p){
      requireFields(p,['schema','source','createdAt','items','totals','containsEstimatedValues'],['schema','source','createdAt','items','totals','containsEstimatedValues']);
      if(p.schema!=='GFPlate.v1'||p.source!=='GFFoodOnly')fail('Ожидался GFPlate.v1 из GFFoodOnly');
      iso(p.createdAt);if(typeof p.containsEstimatedValues!=='boolean')fail('Некорректная оценка достоверности тарелки');
      if(!Array.isArray(p.items)||p.items.length>100)fail('Слишком много позиций');
      const totals={carbs:0,protein:0,fat:0,kcal:0},allowedUnits=['г','мл',null];
      for(const x of p.items){
        requireFields(x,['kind','foodId','name','amount','unit','carbs','protein','fat','kcal','note','nutritionStatus','glycemicIndex','glycemicIndexStatus'],['kind','foodId','name','amount','unit','carbs','protein','fat','kcal']);
        if(!['catalog','restaurant','manual','user'].includes(x.kind))fail('Неверный вид продукта');
        if(x.foodId!==null&&x.foodId!==undefined)text(x.foodId,160);text(x.name,250);
        if(x.amount!==null&&x.amount!==undefined)range(x.amount,0,5000);
        if(!allowedUnits.includes(x.unit??null))fail('Недопустимая единица массы/объёма');
        if((x.amount===null||x.amount===undefined)!==(x.unit===null||x.unit===undefined))fail('Масса и единица должны быть заданы вместе');
        for(const key of Object.keys(totals)){range(x[key],0,100000);totals[key]+=x[key];}
        if(x.note!==undefined&&(typeof x.note!=='string'||x.note.length>500))fail('Неверное примечание');if(x.nutritionStatus!==undefined)text(x.nutritionStatus,100);
        if(x.glycemicIndex!==undefined&&x.glycemicIndex!==null)range(x.glycemicIndex,0,100);
        if(x.glycemicIndexStatus!==undefined){text(x.glycemicIndexStatus,100);if(!/^[a-z0-9_]+$/.test(x.glycemicIndexStatus))fail('Неверный статус ГИ');}
      }
      requireFields(p.totals,['protein','fat','carbs','kcal','amount','count'],['protein','fat','carbs','kcal','amount','count']);
      if(!Number.isSafeInteger(p.totals.count)||p.totals.count!==p.items.length)fail('Количество позиций тарелки не совпадает');
      for(const key of Object.keys(totals)){range(p.totals[key],0,1000000);if(Math.abs(p.totals[key]-totals[key])>0.08+0.01*p.items.length)fail('Итоги БЖУ не совпадают с позициями: '+key);}
      range(p.totals.amount,0,100000);
      // Legacy totals.amount can mix 'г' and 'мл'; never infer an overall food mass.
      return clone(p);
    }
    // Never infer that two separate real injections are one; flag a suspicious replay.
    // An explicit acknowledgement is required to register a genuinely distinct close event.
    function assertNoPhysicalInjectionDuplicate(d, i){
      const similar=d.events.filter(x=>x.type==='insulin_injection'&&x.status==='confirmed'&&
        x.insulinId===i.insulinId&&x.units===i.units&&
        Math.abs(Date.parse(x.administeredAt)-Date.parse(i.administeredAt))<=120000);
      if(!similar.length){
        if(i.distinctActionAcknowledged!==undefined)fail('Не требуется подтверждение отдельной инъекции');
        return;
      }
      if(i.distinctActionAcknowledged!==true||typeof i.distinctActionReason!=='string'||i.distinctActionReason.trim().length<8)
        fail('POSSIBLE_DUPLICATE_INJECTION: проверьте факт и подтвердите отдельное действие');
    }
    function changeSession(role,action,sessionId,expectedVersion,opId,expectedRevision,mutator,isSameOperation=null){
      id(sessionId);id(opId);
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)fail('Нужна версия приёма пищи');
      return commit(role,'mealSessions',action,(d,now)=>{
        const prior=d.workflowLog.find(x=>x.id===opId);
        if(prior){
          if(isSameOperation?.(prior))return null;
          fail('Повтор идентификатора операции');
        }
        const index=d.mealSessions.findIndex(x=>x.id===sessionId),old=index<0?null:d.mealSessions[index];
        if((old?old.version:0)!==expectedVersion)fail('Конфликт версии приёма пищи');
        const updated=mutator(old?clone(old):null,d,now);
        if(!object(updated)||updated.id!==sessionId||updated.version!==expectedVersion+1)fail('Нарушена версия операции');
        if(index<0)d.mealSessions.push(updated);else d.mealSessions[index]=updated;
        d.workflowLog.push({id:opId,sessionId,action,actor:role,at:now,revision:state.revision+1,before:old?clone(old):null,after:clone(updated)});
        return sessionId;
      },expectedRevision);
    }
    function requireMeal(old,...allowed){if(!old)fail('Не найден приём пищи');if(!allowed.includes(old.status))fail('Недопустимый этап приёма пищи: '+old.status);}
    function mark(old,now){const next=clone(old);next.version++;next.lastChangedAt=now;return next;}
    function connect(role){
      if(!Object.hasOwn(READ,role))fail('Неизвестный модуль');
      const port={
        getSnapshot:()=>projection(role),
        read:(field)=>select(role,field),
        getRevision:()=>state.revision,
        subscribe:(cb)=>{if(typeof cb!=='function')fail('Требуется callback');listeners.add(cb);return ()=>listeners.delete(cb);},
      };
      if(role==='food'){
        port.createDraft=(item,rev)=>{
          requireFields(item,['id','plate'],['id','plate']);id(item.id);const plate=validatePlate(item.plate);
          return changeSession(role,'create_draft',item.id,0,'new:'+item.id,rev,(old,d,now)=>{
            if(old)fail('Приём пищи существует');
            return {id:item.id,version:1,status:'draft',createdAt:now,lastChangedAt:now,plannedPlate:plate,actualPlate:null,doseIntent:null,injectionIds:[],startedAt:null,completedAt:null};
          });
        };
        port.updatePlannedPlate=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','plate'],['sessionId','expectedVersion','opId','plate']);const plate=validatePlate(item.plate);
          return changeSession(role,'update_planned_plate',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'draft','planned');const next=mark(old,now);next.plannedPlate=plate;return next;
          });
        };
      }
      if(role==='mealFlow'){
        port.markReady=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId'],['sessionId','expectedVersion','opId']);
          return changeSession(role,'mark_ready',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'draft');const next=mark(old,now);next.status='planned';return next;
          });
        };
        // User-entered intent is NOT a performed injection or calculated recommendation.
        port.setUserDoseIntent=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','insulinId','units'],['sessionId','expectedVersion','opId','insulinId','units']);
          drug(item.insulinId);range(item.units,0,200);
          return changeSession(role,'set_user_dose_intent',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'draft','planned');const next=mark(old,now);next.doseIntent={insulinId:item.insulinId,units:item.units,enteredAt:now,source:'parent_manual',notAdministered:true};return next;
          });
        };
      }
      if(role==='settings'){
        port.setHighSettings=(patch,rev)=>commit(role,'profile','set_high_settings',(d,now)=>{
          requireFields(patch,['targetMmol','activity']);
          if(!Object.keys(patch).length)fail('Нет настроек HIGH для сохранения');
          let changed=false;
          if('targetMmol'in patch){
            const value=patch.targetMmol;
            if(value!==null)range(value,4,13);
            if(value!==(d.profile.highTarget?.valueMmol??null)){
              d.profile.highTarget=value===null?null:{version:1,valueMmol:value,source:'user_input',editedAt:now};
              changed=true;
            }
          }
          if('activity'in patch){
            requireFields(patch.activity,['enabled','selectedLevel','coefficients'],['enabled','selectedLevel','coefficients']);
            const next={...clone(patch.activity),version:1,source:'user_configured',editedAt:now};
            validateHighActivity(next);
            const prev=d.profile.highActivity;
            if(!prev||prev.enabled!==next.enabled||prev.selectedLevel!==next.selectedLevel||
              Object.keys(HIGH_ACTIVITY_DEFAULTS).some(level=>prev.coefficients[level]!==next.coefficients[level])){
              d.profile.highActivity=next;
              changed=true;
            }
          }
          return changed?'profile':null;
        },rev);
        port.setMealAbsorptionModel=(modelId,rev)=>commit(role,'profile','set_meal_absorption_model',d=>{
          if(typeof modelId!=='string'||!Object.hasOwn(MEAL_MODELS,modelId))fail('Неизвестная модель усвоения еды');
          const selected=d.profile.mealAbsorptionModel??MEAL_MODELS.GFForecast;
          if(selected.id===modelId)return null;
          d.profile.mealAbsorptionModel=clone(MEAL_MODELS[modelId]);return 'profile';
        },rev);
        port.updateProfile=(patch,rev)=>commit(role,'profile','update',d=>{
          requireFields(patch,['birthDate','timeZone','displayName','sex','allergies','dailyNutritionReference','exerciseGuidance','exerciseGuidanceEnabled','hypoActivityMultipliers','hypoActivityEnabled','coefficientModes','illnessFactor']);
          if(!Object.keys(patch).length)fail('Нет изменений');
          if('birthDate'in patch&&patch.birthDate!==null)date(patch.birthDate);
          if('sex'in patch&&patch.sex!==null&&!['male','female'].includes(patch.sex))fail('Допустимо male, female или null');
          if('displayName'in patch&&patch.displayName!==null)text(patch.displayName,120);
          if('timeZone'in patch&&patch.timeZone!==null){text(patch.timeZone,100);try{new Intl.DateTimeFormat('ru',{timeZone:patch.timeZone});}catch(e){fail('Неизвестный часовой пояс');}}
          if('exerciseGuidance'in patch&&patch.exerciseGuidance!==null)validateExerciseGuidance(patch.exerciseGuidance);
          if('exerciseGuidanceEnabled'in patch&&typeof patch.exerciseGuidanceEnabled!=='boolean')fail('Учёт активности: только true/false');
          if('hypoActivityMultipliers'in patch&&patch.hypoActivityMultipliers!==null)validateHypoActivityOverrides(patch.hypoActivityMultipliers);
          if('hypoActivityEnabled'in patch&&typeof patch.hypoActivityEnabled!=='boolean')fail('Переключатель низкого сахара: true/false');
          if('activityBaseLevel'in patch&&!['low','usual','high'].includes(patch.activityBaseLevel))fail('Неверный уровень активности');
          if('coefficientModes'in patch)validateCoefficientModes(patch.coefficientModes);
          if('illnessFactor'in patch&&patch.illnessFactor!==null)validateIllnessFactor(patch.illnessFactor);
          if('dailyNutritionReference'in patch&&patch.dailyNutritionReference!==null){const n=patch.dailyNutritionReference;
            if(!object(n)||n.kind!=='population_range_not_individual_target')fail('Только справочный ориентир питания');}
          if('allergies'in patch){if(!Array.isArray(patch.allergies)||patch.allergies.length>30)fail('Некорректный перечень аллергий');patch.allergies.forEach(a=>text(a,120));}
          d.profile=Object.assign({},d.profile,clone(patch));return 'profile';
        },rev);
        port.addMeasurement=(item,rev)=>commit(role,'measurements','append',d=>{
          requireFields(item,['id','measuredAt','weightKg','heightCm'],['id','measuredAt']);id(item.id);iso(item.measuredAt);
          if(!('weightKg'in item)&&!('heightCm'in item))fail('Нужен вес или рост');
          if('weightKg'in item)range(item.weightKg,0.1,400);
          if('heightCm'in item)range(item.heightCm,20,250);
          if(d.measurements.some(x=>x.id===item.id))fail('Повтор ID');d.measurements.push(clone(item));return item.id;
        },rev);
        port.addOrder=(item,rev)=>commit(role,'orders','append',d=>{
          requireFields(item,['id','drugId','units','scheduleLocal','effectiveFrom','effectiveUntil','source','sourceNote'],['id','drugId','units','effectiveFrom','source']);
          id(item.id);drug(item.drugId);range(item.units,0,200);iso(item.effectiveFrom);
          if(item.effectiveUntil){iso(item.effectiveUntil);ensureTimeOrder(item.effectiveFrom,item.effectiveUntil);}
          if(item.scheduleLocal)hhmm(item.scheduleLocal);
          if(!['manual','parent_transcribed_prescription'].includes(item.source))fail('Недопустимый источник назначения');
          if(item.sourceNote!==undefined)text(item.sourceNote,300);
          if(d.orders.some(x=>x.id===item.id))fail('Повтор ID');
          d.orders.push({...clone(item),verificationStatus:'unverified'});return item.id;
        },rev);
        port.addCoefficient=(item,rev)=>commit(role,'coefficients','append',d=>{
          requireFields(item,['id','kind','value','source','effectiveFrom','effectiveUntil','windowLocal','supersedesId','sourceNote'],['id','kind','value','source','effectiveFrom']);
          id(item.id);if(!KINDS.has(item.kind))fail('Неизвестный показатель');
          if(item.kind==='target_range_mmol'){
            requireFields(item.value,['low','high'],['low','high']);range(item.value.low,1,30);range(item.value.high,1,30);if(item.value.low>=item.value.high)fail('Целевой диапазон: low < high');
          } else range(item.value,0.0001,500);
          if(!['manual','parent_transcribed_prescription'].includes(item.source))fail('Исследовательские коэффициенты — только в proposals');
          iso(item.effectiveFrom);
          if(item.effectiveUntil){iso(item.effectiveUntil);ensureTimeOrder(item.effectiveFrom,item.effectiveUntil);}
          if(item.windowLocal){requireFields(item.windowLocal,['from','to'],['from','to']);hhmm(item.windowLocal.from);hhmm(item.windowLocal.to);if(item.windowLocal.from===item.windowLocal.to)fail('Пустое окно времени');}
          // Single authoritative time grid for NEW records; legacy history remains unchanged.
          TimeGrid.validate(item.kind,item.windowLocal);
          if(item.sourceNote!==undefined)text(item.sourceNote,300);
          if(d.coefficients.some(x=>x.id===item.id))fail('Повтор ID');
          const same=(x)=>x.kind===item.kind&&x.source===item.source&&JSON.stringify(x.windowLocal||null)===JSON.stringify(item.windowLocal||null);
          const lineage=d.coefficients.filter(same);
          if(lineage.length){
            if(!item.supersedesId)fail('Нужен supersedesId для новой версии коэффициента');
            const prior=lineage.find(x=>x.id===item.supersedesId);
            if(!prior||lineage.some(x=>x.supersedesId===prior.id))fail('Можно заменить только последнюю версию того же показателя');
            if(Date.parse(item.effectiveFrom)<=Date.parse(prior.effectiveFrom))fail('Новая версия должна начинаться позднее прежней');
            if(prior.effectiveUntil&&Date.parse(item.effectiveFrom)<Date.parse(prior.effectiveUntil))fail('Новая версия пересекается с конечной датой прежней');
          } else if(item.supersedesId)fail('Неизвестная предыдущая версия');
          // Reject effective-date overlap plus local-clock overlap for different slots.
          // A genuine supersedesId is allowed only for the identical time slot,
          // and the old revision ends logically at the new effectiveFrom.
          const newFrom=Date.parse(item.effectiveFrom),newUntil=item.effectiveUntil?Date.parse(item.effectiveUntil):Infinity;
          for(const old of d.coefficients){
            if(old.kind!==item.kind)continue;
            if(item.supersedesId===old.id)continue;
            const oldFrom=Date.parse(old.effectiveFrom);
            let oldUntil=old.effectiveUntil?Date.parse(old.effectiveUntil):Infinity;
            for(const later of d.coefficients){if(later.supersedesId===old.id)oldUntil=Math.min(oldUntil,Date.parse(later.effectiveFrom));}
            if(newFrom<oldUntil&&oldFrom<newUntil&&TimeGrid.overlaps(old.windowLocal||null,item.windowLocal||null))
              fail('COEFFICIENT_WINDOW_CONFLICT: пересечение времени с действующей записью '+old.id);
          }
          d.coefficients.push({...clone(item),verificationStatus:'unverified'});return item.id;
        },rev);
      }
      if(role==='context'){
        port.openPeriod=(item,rev)=>commit(role,'conditionPeriods','open',d=>{
          requireFields(item,['id','kind','start','note'],['id','kind','start']);
          if(item.kind==='sport')fail('Используйте отдельный sport-порт');
          const p=validatePeriod({...clone(item),end:null,source:'user'});
          if(Date.parse(p.start)>Date.parse(clock())+60000)fail('Начало периода находится в будущем');
          if(d.conditionPeriods.some(x=>x.id===p.id))fail('Повтор ID периода');
          if(d.conditionPeriods.some(x=>x.kind===p.kind&&(x.end===null||Date.parse(x.end)>=Date.parse(p.start))))fail('Новый период пересекается с существующим');
          d.conditionPeriods.push(p);return p.id;
        },rev);
        port.closePeriod=(item,rev)=>commit(role,'conditionPeriods','close',d=>{
          requireFields(item,['id','end'],['id','end']);id(item.id);iso(item.end);
          const p=d.conditionPeriods.find(x=>x.id===item.id);
          if(!p||p.end!==null||p.kind==='sport')fail('Не найден открытый период');
          if(Date.parse(item.end)<=Date.parse(p.start)||Date.parse(item.end)>Date.parse(clock())+60000)fail('Некорректный конец периода');
          p.end=item.end;return p.id;
        },rev);
      }
      // The dedicated sport port can never write an illness, injection or meal.
      if(role==='activityUi'){
        port.setBaseLevel=(level,rev)=>commit(role,'profile','set_base_activity',d=>{
          if(!['low','usual','high'].includes(level))fail('Выберите низкую, обычную или высокую активность');
          if(d.conditionPeriods.some(p=>p.kind==='sport'&&p.end===null))fail('Сначала завершите занятие спортом');
          if(d.profile.activityBaseLevel===level)return null;
          d.profile.activityBaseLevel=level;return 'profile';
        },rev);
      }
      if(role==='sport'){
        port.startSport=(item,rev)=>commit(role,'conditionPeriods','start_sport',d=>{
          requireFields(item,['id','start','note'],['id','start']);id(item.id);iso(item.start);
          const nowMs=Date.parse(clock()),startMs=Date.parse(item.start);
          if(startMs>nowMs+60000||nowMs-startMs>300000)fail('Начало спорта должно соответствовать текущему времени');
          if(d.conditionPeriods.some(p=>p.id===item.id))fail('Повторный идентификатор события');
          if(d.conditionPeriods.some(p=>p.kind==='sport'&&p.end===null))fail('Занятие уже началось');
          // Do not allow historical overlap with any completed sport session.
          if(d.conditionPeriods.some(p=>p.kind==='sport'&&(p.end===null||Date.parse(p.end)>startMs)))fail('Перекрытие спортивных занятий');
          const p=validatePeriod({id:item.id,kind:'sport',start:item.start,end:null,source:'user',...(item.note?{note:item.note}:{})});
          d.conditionPeriods.push(p);return p.id;
        },rev);
        port.finishSport=(item,rev)=>commit(role,'conditionPeriods','finish_sport',d=>{
          requireFields(item,['id','end'],['id','end']);id(item.id);iso(item.end);
          const p=d.conditionPeriods.find(x=>x.id===item.id&&x.kind==='sport');
          if(!p||p.end!==null)fail('Нет открытого занятия с этим ID');
          if(Date.parse(item.end)<=Date.parse(p.start)||Date.parse(item.end)>Date.parse(clock())+60000)fail('Некорректное время завершения');
          p.end=item.end;return p.id;
        },rev);
      }
      if(role==='cgmAdapter'){
        port.ingestXDripObservation=(observation,rev)=>commit(role,'cgm','ingest_xdrip_provider', (d,now)=>{
          const row=xdripObservation(observation);
          if(Date.parse(row.receivedAt)>Date.parse(now))fail('CGM_XDRIP_FUTURE_RECEIPT');
          if(d.cgmMetadata&&d.cgmMetadata.sourceType!==XDRIP_TYPE)fail('CGM_SOURCE_CONFLICT');
          d.cgmMetadata={sourceDeviceId:XDRIP_ID,sourceType:XDRIP_TYPE,samplingMinutes:null,qualityScore:null};
          const index=d.cgm.findIndex(x=>x.sourceDeviceId===XDRIP_ID&&x.ts===row.ts);
          if(index!==-1){
            const old=d.cgm[index];
            if(isXDripHistory(old)){
              d.cgm[index]=row; // Direct observations take precedence over retrospective data.
              return XDRIP_ID+':'+row.ts;
            }
            if(old.mgdl!==row.mgdl)fail('CGM_XDRIP_CONFLICT');
            return null; // Preserve the first direct receipt.
          }
          d.cgm.push(row);
          d.cgm.sort((a,b)=>a.ts-b.ts);
          return XDRIP_ID+':'+row.ts;
        },rev);
        port.ingestXDripHistory=(batch,rev)=>commit(role,'cgm','import_xdrip_history',(d,now)=>{
          const fields=['anchorTs','anchorSgv','receivedAt','items'];
          requireFields(batch,fields,fields);
          const {anchorTs,anchorSgv,receivedAt,items}=batch;
          if(!Number.isSafeInteger(anchorTs)||!Number.isInteger(anchorSgv)||!Array.isArray(items)||items.length>287)
            fail('CGM_XDRIP_HISTORY_FORMAT');
          const receipt=Date.parse(validReceipt(receivedAt,anchorTs));
          if(receipt>Date.parse(now)||anchorTs<receipt-XDRIP_HISTORY_WINDOW)fail('CGM_XDRIP_HISTORY_TIME');
          if(d.cgmMetadata?.sourceType!==XDRIP_TYPE)fail('CGM_XDRIP_HISTORY_ANCHOR');
          const known=new Map(d.cgm.filter(row=>row.sourceDeviceId===XDRIP_ID).map(row=>[row.ts,row]));
          const legacy=new Set(d.cgm.filter(row=>row.sourceDeviceId===undefined).map(row=>row.ts));
          const anchor=known.get(anchorTs);
          if(!anchor||isXDripHistory(anchor)||Math.trunc(anchor.mgdl)!==anchorSgv||
              Date.parse(anchor.receivedAt)>receipt)fail('CGM_XDRIP_HISTORY_ANCHOR');
          const incoming=new Map();
          for(const item of items){
            requireFields(item,['ts','mgdl','direction'],['ts','mgdl','direction']);
            const row=xdripHistoricalObservation({...item,receivedAt});
            if(row.ts>=anchorTs||row.ts<receipt-XDRIP_HISTORY_WINDOW)fail('CGM_XDRIP_HISTORY_TIME');
            const prior=incoming.get(row.ts);
            if(prior&&(prior.mgdl!==row.mgdl||prior.direction!==row.direction))fail('CGM_XDRIP_HISTORY_CONFLICT');
            const existing=known.get(row.ts);
            if(existing&&(Math.trunc(existing.mgdl)!==row.mgdl||
                (isXDripHistory(existing)&&existing.direction&&row.direction&&existing.direction!==row.direction)))
              fail('CGM_XDRIP_HISTORY_CONFLICT');
            if(!existing&&!legacy.has(row.ts))incoming.set(row.ts,row);
          }
          if(!incoming.size)return null;
          d.cgm.push(...incoming.values());
          d.cgm.sort((a,b)=>a.ts-b.ts);
          return 'history:'+incoming.size;
        },rev);
        port.setSourceMetadata=(meta,rev)=>commit(role,'cgmMetadata','set_provenance',d=>{
          const m=validateCgmMetadata(meta);
          if(m.sourceType===XDRIP_TYPE)fail('CGM_XDRIP_USE_PROVIDER_PORT');
          if(d.cgmMetadata)fail('Источник CGM уже установлен; смена требует отдельного управления сенсорами');
          if(d.cgm.some(x=>x.sourceDeviceId!==undefined))fail('Для смены датчика требуется расширение multi-source; нельзя переименовывать прежний источник');
          // Старые строки без sourceDeviceId остаются в истории, но скрыты от injectionAnalytics после установки метаданных.
          d.cgmMetadata=m;return m.sourceDeviceId;
        },rev);
        port.ingestReadings=(items,rev)=>commit(role,'cgm','ingest_trusted',d=>{
          if(!d.cgmMetadata)fail('Сначала задайте сведения об источнике CGM');
          if(d.cgmMetadata.sourceType===XDRIP_TYPE)fail('CGM_XDRIP_USE_PROVIDER_PORT');
          if(!Array.isArray(items)||!items.length||items.length>10000)fail('Некорректная пачка CGM');
          const m=d.cgmMetadata,seen=new Map(d.cgm.map(x=>[x.ts,x])),incoming=new Map();
          for(const r of items){
            requireFields(r,['ts','mmol','sourceDeviceId','valid','qualityFlag','receivedAt'],['ts','mmol','sourceDeviceId']);
            if(!Number.isSafeInteger(r.ts)||r.ts<946684800000||r.ts>4102444800000)fail('Некорректный timestamp CGM');
            range(r.mmol,1.5,30);if(r.sourceDeviceId!==m.sourceDeviceId)fail('Несоответствие сенсора');
            if(r.valid!==undefined&&typeof r.valid!=='boolean')fail('Некорректный valid');
            if(r.qualityFlag!==undefined&&!['ok','invalid'].includes(r.qualityFlag))fail('Неверный qualityFlag');
            if(r.receivedAt!==undefined&&r.receivedAt!==null)validReceipt(r.receivedAt,r.ts);
            const row={ts:r.ts,mmol:r.mmol,source:m.sourceType,kind:'observed',sourceDeviceId:m.sourceDeviceId};
            if(r.receivedAt!==undefined&&r.receivedAt!==null)row.receivedAt=r.receivedAt;
            if(r.valid!==undefined)row.valid=r.valid;
            if(r.qualityFlag!==undefined)row.qualityFlag=r.qualityFlag;
            const old=incoming.get(r.ts)||seen.get(r.ts);
            if(old&&JSON.stringify(old)!==JSON.stringify(row))fail('Противоречивые CGM (значение или качество)');
            incoming.set(r.ts,row);
          }
          let added=0;for(const [ts,row] of incoming)if(!seen.has(ts)){d.cgm.push(row);added++;}
          if(!added)return null;d.cgm.sort((a,b)=>a.ts-b.ts);return 'batch:'+added;
        },rev);
      }
      if(role==='forecastWriter'){
        // Only approved research records; no treatment results and no direct GFForecast write.
        port.appendResearchEvents=(batch,rev)=>commit(role,'forecasts','append_research',d=>{
          requireFields(batch,['schema','writerRequired','forecasts','assessments'],['schema','writerRequired','forecasts','assessments']);
          if(batch.schema!=='gfforecast.research-events/1'||batch.writerRequired!==true||!Array.isArray(batch.forecasts)||!Array.isArray(batch.assessments)||batch.forecasts.length+batch.assessments.length>1000)fail('Некорректный пакет прогнозов');
          let changes=0;
          for(const row of batch.forecasts){validateForecastRow(row);const old=d.forecasts.find(x=>x.id===row.id);
            if(old){if(JSON.stringify(old)!==JSON.stringify(row))fail('Конфликт прогноза с таким ID');continue;}
            const f=row.payload;
            if(f.modelId==='GFConsensus'&&f.contract==='glucopapa.research-forecast/2'){
              validateConsensusSelection(f);
              for(const model of f.selection.modelIds){
                const version=f.selection.trainedVersions[model];
                const donor=d.forecasts.find(x=>x.id===f.forecastAt+'|'+f.sourceTime+'|'+model+'@'+version)?.payload;
                if(!donor||donor.inputDigest!==f.inputDigest||donor.sourceRevision!==f.sourceRevision||
                    donor.sourceReceivedAt!==f.sourceReceivedAt||donor.snapshot.sensorSourceId!==f.snapshot.sensorSourceId||
                    donor.mealModel?.id!==f.mealModel?.id||donor.mealModel?.version!==f.mealModel?.version)
                  fail('Не найдено основание выбранного прогноза');
              }
            }
            if(row.payload.contract==='glucopapa.research-forecast/2' && row.payload.sourceRevision!==rev)
              fail('Прогноз подготовлен по другой ревизии');
            d.forecasts.push(clone(row));changes++;
          }
          for(const row of batch.assessments){validateAssessmentRow(row);
            if(!d.forecasts.some(x=>x.id===row.payload.forecastId))fail('Сверка с неизвестным прогнозом');
            const old=d.forecastAssessments.find(x=>x.id===row.id);
            if(old){if(JSON.stringify(old)!==JSON.stringify(row))fail('Конфликт сверки с таким ID');continue;}
            d.forecastAssessments.push(clone(row));changes++;
          }
          return changes?'batch:'+changes:null;
        },rev);
      }
      if(role==='syncWriter'){
        // Only CGM is auto-importable. All action events require separate authorized
        // user workflows and must not be silently inserted as injections/food facts.
        port.applyInboundCgm=(event,rev)=>commit(role,'syncInbox','apply_cgm', (d,now)=>{
          requireFields(event,['id','kind','recordId','baseVersion','origin','at','body','sourceEpoch'],['id','kind','recordId','baseVersion','origin','at','body','sourceEpoch']);
          id(event.id);id(event.recordId);
          if(event.kind!=='cgm'||event.origin!=='child'||event.baseVersion!==0||!Number.isInteger(event.sourceEpoch)||event.sourceEpoch<1)fail('Удалённый тип/источник требует ручной обработки');
          if(!d.cgmMetadata)fail('Не зарегистрирован источник CGM');
          if(d.cgmMetadata.sourceType===XDRIP_TYPE)fail('CGM_XDRIP_USE_PROVIDER_PORT');
          const b=event.body;
          requireFields(b,['mmol','measuredAt','sensorId','trend'],['mmol','measuredAt','sensorId']);
          id(b.sensorId);if(b.sensorId!==d.cgmMetadata.sourceDeviceId)fail('Чужой датчик');
          if(!Number.isSafeInteger(b.measuredAt)||b.measuredAt<946684800000||b.measuredAt>4102444800000)fail('Недопустимое время CGM');
          range(b.mmol,1.5,30);
          if(event.recordId!=='cgm:'+b.sensorId+':'+b.measuredAt)fail('Неверный recordId');
          if(b.measuredAt>Date.parse(now)+60000)fail('CGM с будущим временем');
          const existingPacket=d.syncInbox.find(x=>x.id===event.id);
          if(existingPacket){if(existingPacket.recordId!==event.recordId||JSON.stringify(existingPacket.body)!==JSON.stringify(b))fail('Конфликт повторного пакета');return null;}
          const old=d.cgm.find(x=>x.ts===b.measuredAt&&x.sourceDeviceId===b.sensorId);
          if(old&&old.mmol!==b.mmol)fail('Противоречащие CGM из сети');
          if(!old)d.cgm.push({ts:b.measuredAt,mmol:b.mmol,source:d.cgmMetadata.sourceType,kind:'observed',sourceDeviceId:b.sensorId,receivedAt:now});
          d.cgm.sort((a,b)=>a.ts-b.ts);
          d.syncInbox.push({id:event.id,kind:'cgm',recordId:event.recordId,origin:event.origin,receivedAt:now,body:clone(b)});
          return event.id;
        },rev);
      }
      if(role==='actionWriter'){
        port.confirmCompletedMeal=(item,rev)=>{
          requireFields(item,['sessionId','opId','eatenAt','actualPlate','parentConfirmed'],
            ['sessionId','opId','eatenAt','actualPlate','parentConfirmed']);
          if(item.parentConfirmed!==true)fail('Сначала подтвердите, что еда уже съедена');
          const eatenAt=iso(item.eatenAt),plate=validatePlate(item.actualPlate);
          if(plate.items.length!==1||!(plate.items[0].amount>0)||plate.totals.amount!==plate.items[0].amount)
            fail('Для быстрой записи требуется один продукт с фактическим количеством');
          const matches=op=>op.actor===role&&op.action==='confirm_completed_meal'&&op.sessionId===item.sessionId&&
            op.after.startedAt===eatenAt&&JSON.stringify(op.after.actualPlate)===JSON.stringify(plate);
          return changeSession(role,'confirm_completed_meal',item.sessionId,0,item.opId,rev,(old,d,now)=>{
            if(Date.parse(eatenAt)>Date.parse(now))fail('Фактически съеденная порция находится в будущем');
            return {id:item.sessionId,version:1,status:'completed',createdAt:now,lastChangedAt:now,
              startedAt:eatenAt,completedAt:eatenAt,plannedPlate:plate,actualPlate:plate,actualReason:'first_confirmation',
              doseIntent:null,injectionIds:[]};
          },matches);
        };
        // Confirm factual administration + link to meal atomically; never infer from dose intent.
        port.recordSessionInjection=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','injectionId','insulinId','units','administeredAt','injectionSite','injectionContext','iobEvidence','distinctActionAcknowledged','distinctActionReason'],['sessionId','expectedVersion','opId','injectionId','insulinId','units','administeredAt']);
          id(item.injectionId);drug(item.insulinId);range(item.units,0.001,200);iso(item.administeredAt);
          if(Date.parse(item.administeredAt)>Date.parse(clock())+60000)fail('Нельзя подтверждать будущую инъекцию');
          return changeSession(role,'confirm_injection',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'planned','started','completed');
            if(d.events.some(x=>x.id===item.injectionId))fail('Повтор идентификатора фактической инъекции');
            assertNoPhysicalInjectionDuplicate(d,item);
            const next=mark(old,now);next.injectionIds.push(item.injectionId);
            const extra={};if(item.injectionSite!==undefined)extra.injectionSite=validateSite(item.injectionSite);
            if(item.injectionContext!==undefined)extra.injectionContext=validateContext(item.injectionContext,item.administeredAt,d.conditionPeriods);
            if(item.iobEvidence!==undefined){
              if(item.iobEvidence.sourceRevision!==rev||item.iobEvidence.coverageStart!==d.coverage?.startIso||
                  item.iobEvidence.coverageEnd!==d.coverage?.endIso||d.coverage?.confirmedComplete!==true)
                fail('Снимок исторического IOB устарел');
              extra.iobEvidence=validatePreinjectionIob(item.iobEvidence,
                {id:item.injectionId,insulinId:item.insulinId,administeredAt:item.administeredAt},d.events,rev);
            }
            d.events.push({type:'insulin_injection',status:'confirmed',id:item.injectionId,insulinId:item.insulinId,units:item.units,administeredAt:item.administeredAt,linkedMealSessionId:item.sessionId,...extra,
              ...(item.distinctActionAcknowledged?{distinctActionAcknowledged:true,distinctActionReason:item.distinctActionReason}: {})});
            return next;
          });
        };
        port.linkExistingInjection=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','injectionId'],['sessionId','expectedVersion','opId','injectionId']);id(item.injectionId);
          return changeSession(role,'link_existing_injection',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'planned','started','completed');
            const hit=d.events.find(e=>e.type==='insulin_injection'&&e.status==='confirmed'&&e.id===item.injectionId);
            if(!hit)fail('Нужна существующая подтверждённая фактическая инъекция');
            if(d.mealSessions.some(s=>s.injectionIds.includes(item.injectionId)))fail('Инъекция уже связана с приёмом пищи');
            const next=mark(old,now);next.injectionIds.push(item.injectionId);return next;
          });
        };
        port.confirmMealStart=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','startedAt'],['sessionId','expectedVersion','opId','startedAt']);iso(item.startedAt);
          if(Date.parse(item.startedAt)>Date.parse(clock())+60000)fail('Начало еды находится в будущем');
          return changeSession(role,'confirm_meal_start',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'planned');const next=mark(old,now);next.startedAt=item.startedAt;next.status='started';return next;
          });
        };
        port.recordActualPlate=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','plate','reason'],['sessionId','expectedVersion','opId','plate']);
          const plate=validatePlate(item.plate);
          return changeSession(role,'record_actual_plate',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'started','completed');
            if(old.actualPlate&&!item.reason)fail('Причина исправления фактически съеденного обязательна');
            if(item.reason!==undefined)text(item.reason,300);
            const next=mark(old,now);next.actualPlate=plate;next.actualReason=item.reason||'first_confirmation';return next;
          });
        };
        port.confirmMealFinished=(item,rev)=>{
          requireFields(item,['sessionId','expectedVersion','opId','finishedAt'],['sessionId','expectedVersion','opId','finishedAt']);iso(item.finishedAt);
          return changeSession(role,'confirm_meal_finished',item.sessionId,item.expectedVersion,item.opId,rev,(old,d,now)=>{
            requireMeal(old,'started');if(!old.actualPlate)fail('Сначала подтвердите, что фактически съедено');
            if(Date.parse(item.finishedAt)<Date.parse(old.startedAt)||Date.parse(item.finishedAt)>Date.parse(clock())+60000)fail('Неверное время завершения еды');
            const next=mark(old,now);next.status='completed';next.completedAt=item.finishedAt;return next;
          });
        };
        port.recordInjection=(item,rev)=>commit(role,'events','injection',d=>{
          requireFields(item,['id','insulinId','units','administeredAt','doseErrorSuspected','note','injectionSite','injectionContext','distinctActionAcknowledged','distinctActionReason'],['id','insulinId','units','administeredAt']);
          id(item.id);drug(item.insulinId);range(item.units,0.001,200);iso(item.administeredAt);
          if(Date.parse(item.administeredAt)>Date.parse(clock())+60000)fail('Фактическая инъекция находится в будущем');
          if(item.doseErrorSuspected!==undefined&&typeof item.doseErrorSuspected!=='boolean')fail('Некорректный флаг');
          if(item.note!==undefined)text(item.note,300);
          if(item.injectionSite!==undefined)validateSite(item.injectionSite);
          if(item.injectionContext!==undefined)validateContext(item.injectionContext,item.administeredAt,d.conditionPeriods);
          const duplicateId=d.events.find(x=>x.id===item.id);
          if(duplicateId){
            if(duplicateId.type==='insulin_injection'&&Object.keys(item).every(k=>JSON.stringify(duplicateId[k])===JSON.stringify(item[k]))&&Object.keys(duplicateId).filter(k=>!['type','status'].includes(k)).every(k=>Object.hasOwn(item,k)))return null;
            fail('Конфликт идентификатора инъекции');
          }
          assertNoPhysicalInjectionDuplicate(d,item);
          d.events.push({type:'insulin_injection',status:'confirmed',...clone(item)});return item.id;
        },rev);
        // Legacy type=meal is read-only after migration. New meals use mealSessions.
        port.setCoverage=(info,rev)=>commit(role,'coverage','declaration',d=>{
          requireFields(info,['startIso','endIso','confirmedComplete','declaredBy'],['startIso','endIso','confirmedComplete','declaredBy']);
          iso(info.startIso);iso(info.endIso);ensureTimeOrder(info.startIso,info.endIso);
          if(typeof info.confirmedComplete!=='boolean')fail('Подтверждение должно быть явным');
          if(info.declaredBy!=='parent')fail('Только явное подтверждение родителя');
          d.coverage=clone(info);return 'coverage';
        },rev);
      }
      if(role==='cgm'){
        port.ingest=(items,rev)=>commit(role,'cgm','ingest',d=>{
          if(d.cgmMetadata)fail('После настройки источника CGM используйте порт cgmAdapter');
          if(!Array.isArray(items)||items.length===0||items.length>10000)fail('Неверная пачка CGM');
          const seen=new Map(d.cgm.map(x=>[x.ts,x])),incoming=new Map();
          for(const r of items){
            requireFields(r,['ts','mmol'],['ts','mmol']);
            if(!Number.isSafeInteger(r.ts)||r.ts<946684800000||r.ts>4102444800000)fail('Неверный timestamp CGM в миллисекундах');
            range(r.mmol,1.5,30);
            if(incoming.has(r.ts)&&incoming.get(r.ts)!==r.mmol)fail('Противоречие в одном пакете CGM');
            incoming.set(r.ts,r.mmol);
            if(seen.has(r.ts)&&seen.get(r.ts).mmol!==r.mmol)fail('Противоречивые CGM: нельзя тихо перезаписать');
          }
          let added=0;
          for(const [ts,mmol] of incoming){if(!seen.has(ts)){d.cgm.push({ts,mmol,source:'xdrip_follower',kind:'observed'});added++;}}
          if(!added)return null;
          d.cgm.sort((a,b)=>a.ts-b.ts);return 'batch:'+added;
        },rev);
      }
      if(role==='rinfast'||role==='levemir'){
        port.saveModelResult=(result,rev)=>commit(role,'results','model_estimate',d=>{
          requireFields(result,['id','computedAt','basedOnRevision','output','inputEventIds'],['id','computedAt','basedOnRevision','output']);
          id(result.id);iso(result.computedAt);
          if(!Number.isSafeInteger(result.basedOnRevision)||result.basedOnRevision<0||result.basedOnRevision>state.revision)fail('Неверная исходная ревизия');
          if(state.revision!==result.basedOnRevision)fail('Старый снимок настроек: пересчитайте модель');
          if(result.inputEventIds!==undefined){if(!Array.isArray(result.inputEventIds))fail('Некорректные ID');result.inputEventIds.forEach(id);}
          if(!object(result.output)||!['INCOMPLETE','MODEL_ESTIMATE'].includes(result.output.status)||result.output.clinicalValidation!==false)fail('Разрешены только исследовательские результаты');
          if(result.output.engineVersion!==MODELS[role].engineVersion)fail('Версия движка не совпадает с принятым модулем');
          if(Object.keys(result.output).some(k=>/recommend|suggest|bolus|prescri|doseadjust/i.test(k)))fail('Нельзя записывать назначения и рекомендации доз');
          if(d.results.some(x=>x.id===result.id))fail('Повтор ID результата');
          d.results.push({...clone(result),modelId:role,clinicalValidation:false});return result.id;
        },rev);
      }
      if(role==='research'){
        port.submitProposal=(proposal,rev)=>commit(role,'proposals','research_only',d=>{
          requireFields(proposal,['id','kind','candidate','computedAt','evidence','sourceModule'],['id','kind','candidate','computedAt','sourceModule']);
          id(proposal.id);if(!KINDS.has(proposal.kind))fail('Неизвестный показатель');iso(proposal.computedAt);
          if(proposal.kind==='target_range_mmol')fail('ИИ не предлагает новый лечебный диапазон');
          range(proposal.candidate,0.0001,500);text(proposal.sourceModule,80);
          if(proposal.evidence!==undefined)text(proposal.evidence,1000);
          if(d.proposals.some(x=>x.id===proposal.id))fail('Повтор ID гипотезы');
          d.proposals.push({...clone(proposal),status:'research_only',applied:false,clinicalValidation:false});return proposal.id;
        },rev);
      }
      if(role==='graph'){
        port.getForecastInputRevision=()=>{
          for(let index=state.history.length-1;index>=0;index--){
            const entry=state.history[index];
            if(FORECAST_INPUT_DOMAINS.has(entry.domain))return entry.revision;
          }
          return 0;
        };
        port.setPreferences=(patch,rev)=>commit(role,'graphPreferences','display_only',d=>{
          requireFields(patch,['rangeHours','showRinfast','showTotal','forecastVisibility','autoConsensus']);
          if('rangeHours'in patch&&!([6,12,24].includes(patch.rangeHours)))fail('Разрешённые интервалы 6,12,24 часов');
          if('showRinfast'in patch&&typeof patch.showRinfast!=='boolean')fail('Неверный флаг');
          if('showTotal'in patch&&typeof patch.showTotal!=='boolean')fail('Неверный флаг');
          if('autoConsensus'in patch&&typeof patch.autoConsensus!=='boolean')fail('Неверный флаг объединения');
          if('forecastVisibility'in patch)validateForecastVisibility(patch.forecastVisibility);
          if(!Object.keys(patch).length)fail('Нет изменений');
          const before=JSON.stringify(d.graphPreferences);
          if(patch.forecastVisibility)patch={...patch,forecastVisibility:{...d.graphPreferences.forecastVisibility,...patch.forecastVisibility}};
          Object.assign(d.graphPreferences,clone(patch));
          return JSON.stringify(d.graphPreferences)===before?null:'graphPreferences';
        },rev);
      }
      return Object.freeze(port);
    }
    return Object.freeze({
      connect, getSchemaVersion:()=>SCHEMA_VERSION,
      exportState:()=>frozen(state),
      diagnostics:()=>frozen({version:VERSION,schemaVersion:SCHEMA_VERSION,revision:state.revision,persistent:!!driver,clinicalValidation:false}),
      // Host-only import is intentionally absent: restore must be verified by a future native adapter.
    });
  }
  return Object.freeze({VERSION,SCHEMA_VERSION,DRUGS,MODELS,MEAL_MODELS,HIGH_ACTIVITY_DEFAULTS,isXDripHistory,createHost});
});
