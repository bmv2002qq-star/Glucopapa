/* GlucoPapa GFSettings v0.1.6 — UI-facing facade over GFStorage schema 5. Only user settings are editable.
 * Stores user-entered plans; does not calculate insulin doses, glucose, or treatment decisions.
 * Only uses a settings role port; does NOT need access to privileged GFStorage host.
 * UMD: module.exports or globalThis.GFSettings.
 */
(function(root, factory){
  'use strict';
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.GFSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const VERSION = '0.1.7-uniform-windows';
  const GRID = typeof module==='object'&&module.exports ? require('../../../shared/GFTimeGrid_v0.1.0.js') : globalThis.GFTimeGrid;
  if(!GRID)throw Error('GFTimeGrid missing');
  const KINDS = Object.freeze({
    isf_mmol_per_u:'ФЧИ · ммоль/л на ЕД',
    carb_g_per_u:'Углеводный коэффициент · г/ЕД',
    tdd_u:'СДИ · ЕД за сутки',
    target_range_mmol:'Целевой диапазон · ммоль/л'
  });
  const NUTRITION = typeof module==='object'&&module.exports ? require('../shared/gfnutrition_reference.js') : globalThis.GFNutritionReference;
  const GROWTH = typeof module==='object'&&module.exports ? require('../shared/gfgrowth_reference.js') : globalThis.GFGrowthReference;
  const SOURCE_LABELS = Object.freeze({
    manual:'Введено пользователем'
  });
  function fail(message){throw new Error(message);}
  function plain(o){return o!==null&&typeof o==='object'&&!Array.isArray(o)&&[Object.prototype,null].includes(Object.getPrototypeOf(o));}
  function clone(o){return JSON.parse(JSON.stringify(o));}
  function frozen(o){
    const z=clone(o);
    function fr(v){if(v&&typeof v==='object'){for(const a of Object.values(v))fr(a);Object.freeze(v);}return v;}
    return fr(z);
  }
  function fieldRules(o, names, required=[]){
    if(!plain(o))fail('Нужен объект полей');
    for(const k of Object.keys(o)) if(!names.includes(k)) fail('Недопустимое поле: '+k);
    for(const k of required) if(!Object.hasOwn(o,k))fail('Нет обязательного поля: '+k);
  }
  function iso(s){
    if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)||!Number.isFinite(Date.parse(s)))fail('Нужна дата-время ISO 8601 с часовым поясом');
    return s;
  }
  function day(s){
    if(typeof s!=='string'||!/^\d{4}-\d\d-\d\d$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('Некорректная дата рождения');
    return s;
  }
  function positive(n,min,max){if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)fail('Значение вне допустимого технического диапазона');return n;}
  function str(v,max=150){if(typeof v!=='string'||!v.trim()||v.length>max)fail('Пустой или слишком длинный текст');return v.trim();}
  function revNumber(n){if(!Number.isSafeInteger(n)||n<0)fail('Отсутствует корректная ревизия');return n;}
  function labelSource(s){if(s!=='manual')fail('Разрешён только ручной ввод пользовательского плана');return s;}
  function tzDateParts(time,zone){
    const formatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
    const parts=Object.fromEntries(formatter.formatToParts(new Date(time)).filter(x=>['year','month','day'].includes(x.type)).map(x=>[x.type,+x.value]));
    return parts;
  }
  function calculateAge(birthDate,asOfIso,timeZone){
    if(!birthDate)return null;
    day(birthDate); iso(asOfIso);
    let parts;
    try{parts=tzDateParts(asOfIso,timeZone||'UTC');}catch(e){fail('Некорректный часовой пояс профиля');}
    const [year,month,dayOfMonth]=birthDate.split('-').map(Number);
    const age=parts.year-year-((parts.month<month||(parts.month===month&&parts.day<dayOfMonth))?1:0);
    // A data integrity/status helper, not a medical age-range check.
    return age<0||age>130?null:age;
  }
  function latestVitals(list){
    const sorted=list.map((x,index)=>({x,index})).sort((a,b)=>Date.parse(b.x.measuredAt)-Date.parse(a.x.measuredAt)||b.index-a.index).map(({x})=>x);
    const find=k=>sorted.find(x=>Number.isFinite(x[k]));
    return {weight:find('weightKg')?{value:find('weightKg').weightKg,measuredAt:find('weightKg').measuredAt}:null,
      height:find('heightCm')?{value:find('heightCm').heightCm,measuredAt:find('heightCm').measuredAt}:null};
  }
  function sameCoefficientLineage(a,b){
    return a.kind===b.kind&&a.source===b.source&&JSON.stringify(a.windowLocal||null)===JSON.stringify(b.windowLocal||null);
  }
  function localWindowMatch(windowLocal,asOfIso,timeZone){
    if(!windowLocal)return true;
    if(!timeZone)return false; // Never silently interpret a child's clock windows as UTC.
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(asOfIso));
    const nums=Object.fromEntries(parts.filter(x=>['hour','minute'].includes(x.type)).map(x=>[x.type,Number(x.value)]));
    const clockMinutes=nums.hour*60+nums.minute;
    const parseMinutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
    const from=parseMinutes(windowLocal.from),to=parseMinutes(windowLocal.to);
    return from<to?clockMinutes>=from&&clockMinutes<to:clockMinutes>=from||clockMinutes<to;
  }
  function coefficientTimeline(rows,asOfIso,timeZone=null){
    iso(asOfIso); const t=Date.parse(asOfIso);
    return [...rows].map(x=>{
      const future=rows.filter(y=>y.supersedesId===x.id);
      const next=future.sort((a,b)=>Date.parse(a.effectiveFrom)-Date.parse(b.effectiveFrom))[0]||null;
      const start=Date.parse(x.effectiveFrom),end=x.effectiveUntil?Date.parse(x.effectiveUntil):Infinity;
      const withinDate=start<=t&&t<end&&(!next||t<Date.parse(next.effectiveFrom));
      const isEffectiveAt=withinDate&&localWindowMatch(x.windowLocal,asOfIso,timeZone);
      return {...x,isEffectiveAt,timeZoneMissing:!!x.windowLocal&&!timeZone,isLatestRevision:!next,supersededAt:next?next.effectiveFrom:null,
        sourceLabel:SOURCE_LABELS[x.source]||'Архивная запись прежнего формата',
        verificationStatus:'unverified'};
    }).sort((a,b)=>Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom));
  }
  function orderTimeline(rows,asOfIso){
    iso(asOfIso);const t=Date.parse(asOfIso);
    return [...rows].map(x=>{
      const active=Date.parse(x.effectiveFrom)<=t&&(!x.effectiveUntil||t<Date.parse(x.effectiveUntil));
      const concurrent=active?rows.filter(y=>y.id!==x.id&&y.drugId===x.drugId&&(y.scheduleLocal||null)===(x.scheduleLocal||null)&&Date.parse(y.effectiveFrom)<=t&&(!y.effectiveUntil||t<Date.parse(y.effectiveUntil))).length:0;
      return {...x,isEffectiveAt:active,conflictingActive:concurrent>0,verificationStatus:'unverified',sourceLabel:SOURCE_LABELS[x.source]||'Архивная запись прежнего формата'};
    }).sort((a,b)=>Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom));
  }
  function createSettingsService({settingsPort,clock=()=>new Date().toISOString(),idFactory}={}){
    if(!settingsPort||typeof settingsPort.getSnapshot!=='function'||typeof settingsPort.getRevision!=='function'||typeof settingsPort.read!=='function'||typeof settingsPort.subscribe!=='function') fail('Нужен порт GFStorage role=settings');
    for(const method of ['updateProfile','addMeasurement','addOrder','addCoefficient']) if(typeof settingsPort[method]!=='function')fail('Несовместимая версия порта settings: '+method);
    const check=()=>{const s=settingsPort.getSnapshot();if(![1,2,3,4,5].includes(s.schemaVersion)||!Array.isArray(s.measurements)||!Array.isArray(s.coefficients)||!Array.isArray(s.orders)||!Array.isArray(s.history)||!s.models)fail('Нужен GFStorage schemaVersion 1–5');return s;};
    check();
    let seq=0;
    const newId=(prefix)=>{
      const candidate=idFactory?idFactory(prefix):prefix+'_'+Date.now().toString(36)+'_'+(++seq).toString(36)+'_'+Math.random().toString(36).slice(2,10);
      if(typeof candidate!=='string'||!/^[\w:.-]{1,100}$/.test(candidate))fail('Недопустимый идентификатор');return candidate;
    };
    function getView(at=clock()){
      iso(at);const s=check();
      const vitals=latestVitals(s.measurements);
      const growthReference=GROWTH.evaluate(s.profile,s.measurements,at);
      const warnings=[];
      if(s.orders.some(x=>!x.effectiveUntil))warnings.push('Планы без конечной даты могут пересекаться с более новыми записями. Автоматически выбирать действующую дозу запрещено.');
      const reference=NUTRITION.recommend(s.profile,at);
      const saved=s.profile.dailyNutritionReference||null;
      const nutritionIsCurrent=JSON.stringify(reference)===JSON.stringify(saved);
      return frozen({version:VERSION,schemaVersion:s.schemaVersion,revision:s.revision,asOf:at,
        nutritionReference:reference,growthReference,nutritionSaved:!!saved&&nutritionIsCurrent,nutritionStale:!nutritionIsCurrent,
        profile:s.profile,timeGrid:{version:GRID.VERSION,slots:GRID.SLOTS,legacy:GRID.audit(s.coefficients).invalid},ageYears:calculateAge(s.profile.birthDate,at,s.profile.timeZone),
        measurements:s.measurements.map((x,index)=>({x,index})).sort((a,b)=>Date.parse(b.x.measuredAt)-Date.parse(a.x.measuredAt)||b.index-a.index).map(({x})=>x),vitals,
        drugs:s.drugs,models:s.models,orders:orderTimeline(s.orders,at),coefficients:coefficientTimeline(s.coefficients,at,s.profile.timeZone),
        graphPreferences:s.graphPreferences,history:s.history.slice().reverse(),warnings,
        researchProposalAccess:'Не предусмотрен для роли settings; гипотезы живут отдельно в GFStorage research',
        researchOnly:true});
    }
    function saveProfile(patch,expectedRevision){
      revNumber(expectedRevision);fieldRules(patch,['birthDate','timeZone','displayName','allergies','sex']);
      if(!Object.keys(patch).length)fail('Нужно изменить хотя бы одно поле');
      if('birthDate'in patch&&patch.birthDate!==null){day(patch.birthDate);if(patch.birthDate>clock().slice(0,10))fail('Дата рождения в будущем');}
      if('displayName'in patch&&patch.displayName!==null)str(patch.displayName,120);
      if('timeZone'in patch&&patch.timeZone!==null){str(patch.timeZone,100);try{new Intl.DateTimeFormat('en',{timeZone:patch.timeZone});}catch(e){fail('Неизвестный часовой пояс');}}
      if('allergies'in patch){if(!Array.isArray(patch.allergies)||patch.allergies.length>30)fail('Нужен список аллергий (не более 30)');patch.allergies.forEach(a=>str(a,120));if(new Set(patch.allergies.map(x=>x.toLocaleLowerCase('ru'))).size!==patch.allergies.length)fail('Дубли в списке аллергий');}
      if('sex'in patch && patch.sex!==null && !['male','female'].includes(patch.sex))fail('Некорректно указан пол');
      const current=check().profile;
      const finalProfile={...current,...patch};
      const nutrition=NUTRITION.recommend(finalProfile,clock());
      return settingsPort.updateProfile({...patch,dailyNutritionReference:nutrition},expectedRevision);
    }
    function addMeasurement({measuredAt,weightKg,heightCm},expectedRevision){
      revNumber(expectedRevision);
      const currentTime=iso(clock());
      const measuredTime=iso(measuredAt||currentTime);
      if(Date.parse(measuredTime)>Date.parse(currentTime))fail('Дата измерения не может быть в будущем');
      const record={id:newId('measure'),measuredAt:measuredTime};
      if(weightKg!==undefined&&weightKg!==null)record.weightKg=positive(weightKg,0.1,400);
      if(heightCm!==undefined&&heightCm!==null)record.heightCm=positive(heightCm,20,250);
      if(!('weightKg'in record)&&!('heightCm'in record))fail('Укажите вес или рост');
      return settingsPort.addMeasurement(record,expectedRevision);
    }
    function addOrder({drugId,units,scheduleLocal,effectiveFrom,effectiveUntil,source,sourceNote},expectedRevision){
      revNumber(expectedRevision);const item={id:newId('order'),drugId,units:positive(units,0,200),effectiveFrom:iso(effectiveFrom||clock()),source:labelSource(source)};
      if(scheduleLocal!==undefined&&scheduleLocal!==null&&scheduleLocal!=='')item.scheduleLocal=scheduleLocal;
      if(effectiveUntil!==undefined&&effectiveUntil!==null&&effectiveUntil!=='')item.effectiveUntil=iso(effectiveUntil);
      if(sourceNote!==undefined&&sourceNote!==null&&sourceNote.trim())item.sourceNote=str(sourceNote,300);
      return settingsPort.addOrder(item,expectedRevision);
    }
    function addCoefficient({kind,value,source,windowLocal,effectiveFrom,effectiveUntil,sourceNote},expectedRevision){
      revNumber(expectedRevision);if(!Object.hasOwn(KINDS,kind))fail('Недопустимый тип коэффициента');
      labelSource(source);
      if(kind==='target_range_mmol'){
        fieldRules(value,['low','high'],['low','high']);positive(value.low,1,30);positive(value.high,1,30);if(value.low>=value.high)fail('Нижняя граница должна быть меньше верхней');
      }else positive(value,0.0001,500);
      const item={id:newId('coef'),kind,value:clone(value),source,effectiveFrom:iso(effectiveFrom||clock())};
      if(windowLocal!==undefined&&windowLocal!==null){fieldRules(windowLocal,['from','to'],['from','to']);item.windowLocal=clone(windowLocal);}
      GRID.validate(kind,item.windowLocal);
      if(effectiveUntil!==undefined&&effectiveUntil!==null&&effectiveUntil!=='')item.effectiveUntil=iso(effectiveUntil);
      if(sourceNote!==undefined&&sourceNote!==null&&sourceNote.trim())item.sourceNote=str(sourceNote,300);
      const existing=check().coefficients.filter(x=>sameCoefficientLineage(x,item));
      if(existing.length){
        const leaves=existing.filter(x=>!existing.some(y=>y.supersedesId===x.id));
        if(leaves.length!==1)fail('Неоднозначная история коэффициента. Требуется проверка записей');
        item.supersedesId=leaves[0].id;
        if(Date.parse(item.effectiveFrom)<=Date.parse(leaves[0].effectiveFrom))fail('Новая версия должна начинаться позже предыдущей');
      }
      return settingsPort.addCoefficient(item,expectedRevision);
    }
    function refreshNutritionReference(expectedRevision){
      revNumber(expectedRevision);
      const s=check();const nutrition=NUTRITION.recommend(s.profile,clock());
      if(JSON.stringify(s.profile.dailyNutritionReference||null)===JSON.stringify(nutrition))return frozen({revision:s.revision,idempotent:true});
      return settingsPort.updateProfile({dailyNutritionReference:nutrition},expectedRevision);
    }
    function subscribe(callback){if(typeof callback!=='function')fail('Требуется функция');return settingsPort.subscribe(e=>callback(frozen(e)));}
    return Object.freeze({VERSION,getView,getRevision:()=>settingsPort.getRevision(),saveProfile,refreshNutritionReference,addMeasurement,addOrder,addCoefficient,subscribe,
      getHistory:()=>frozen(check().history.slice().reverse()),
      getHomeGrowthSummary:(at=clock())=>{const s=check();return frozen(GROWTH.evaluate(s.profile,s.measurements,at));},
      getModelRegistry:()=>frozen(check().models),
      getCurrentDisplayCoefficients:(at=clock())=>{const s=check();return frozen(coefficientTimeline(s.coefficients,at,s.profile.timeZone).filter(x=>x.isEffectiveAt));},
      getCurrentDisplayOrders:(at=clock())=>frozen(orderTimeline(check().orders,at).filter(x=>x.isEffectiveAt))});
  }
  return Object.freeze({VERSION,KINDS,SOURCE_LABELS,TIME_SLOTS:GRID.SLOTS,createSettingsService,calculateAge,latestVitals,coefficientTimeline,orderTimeline});
});
