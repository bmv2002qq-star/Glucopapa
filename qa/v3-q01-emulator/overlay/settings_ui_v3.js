/* Q01 browser presentation adapter. Shares original GFSettings v0.1.4 visual markup.
 * Reads only GFStorage V3's shell settings port, stages approved V3 intents, then
 * asks native Android owner queue for a second explicit confirmation.
 * No localStorage, browser DB, credentials, network, or direct writes.
 */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFSettingsV3UI=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const KEYS=['00-06','06-12','12-18','18-00'];
 const TYPES=[['carb_g_per_u','УК, г/ЕД'],['isf_mmol_per_u','ФЧИ, ммоль/л/ЕД']];
 const ALLERGEN_CHOICES=['Молоко','Яйца','Рыба','Ракообразные','Моллюски','Арахис','Древесные орехи','Соя','Глютен','Пшеница','Кунжут','Сельдерей','Горчица','Люпин','Сульфиты'];
 const clone=x=>JSON.parse(JSON.stringify(x));
 /** Convert the profile's *local* wall clock to UTC, never the phone's timezone.
  * DST gap => no options. Fall-back overlap => two explicit options; never pick silently.
  * This is presentation-only; recorded timestamps remain real ISO UTC instants.
  */
 function localTimeOptions(local,zone){
  if(typeof local!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(local))throw Error('MEASUREMENT_LOCAL_TIME_INVALID');
  if(typeof zone!=='string'||!zone.trim())throw Error('PROFILE_TIMEZONE_MISSING');
  const [yr,mo,day,hour,minute]=[+local.slice(0,4),+local.slice(5,7),+local.slice(8,10),+local.slice(11,13),+local.slice(14,16)];
  const base=Date.UTC(yr,mo-1,day,hour,minute);
  const round=new Date(base);
  if(round.getUTCFullYear()!==yr||round.getUTCMonth()+1!==mo||round.getUTCDate()!==day||round.getUTCHours()!==hour||round.getUTCMinutes()!==minute)throw Error('MEASUREMENT_LOCAL_DATE_INVALID');
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const fields=ms=>Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p=>['year','month','day','hour','minute'].includes(p.type)).map(p=>[p.type,+p.value]));
  const asLocal=ms=>{const p=fields(ms);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)};
  const offsets=new Set();
  for(const diff of [-172800000,-86400000,0,86400000,172800000]){
   const sample=base+diff;offsets.add(asLocal(sample)-sample);
  }
  const candidates=[];
  for(const offset of offsets){
   const utc=base-offset;
   if(asLocal(utc)===base && !candidates.some(x=>x.iso===new Date(utc).toISOString())){
    const sign=offset>=0?'+':'-';const a=Math.abs(offset)/60000;
    candidates.push({iso:new Date(utc).toISOString(),offsetLabel:'UTC'+sign+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0')});
   }
  }
  return Object.freeze(candidates.sort((a,b)=>Date.parse(a.iso)-Date.parse(b.iso)).map(Object.freeze));
 }
 function profileLocalNow(zone){
  const f=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const p=Object.fromEntries(f.formatToParts(new Date()).filter(x=>['year','month','day','hour','minute'].includes(x.type)).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
 }
 function measurementIntent(snapshot,values,newId,nowIso){
  if(!snapshot||snapshot.schemaVersion!==3||!snapshot.profileConfigured||!snapshot.profileId)throw Error('PROFILE_UNCONFIGURED');
  if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)throw Error('REVISION_INVALID');
  if(!values||Object.keys(values).sort().join(',')!=='heightCm,measuredAtUtc,weightKg')throw Error('MEASUREMENT_FIELDS_INVALID');
  const {weightKg,heightCm,measuredAtUtc}=values;
  if(typeof weightKg!=='number'||!Number.isFinite(weightKg)||weightKg<1||weightKg>300||typeof heightCm!=='number'||!Number.isFinite(heightCm)||heightCm<20||heightCm>250)throw Error('MEASUREMENT_OUT_OF_RANGE');
  if(typeof measuredAtUtc!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(measuredAtUtc)||!Number.isFinite(Date.parse(measuredAtUtc)))throw Error('MEASUREMENT_TIME_INVALID');
  if(!Number.isFinite(Date.parse(nowIso)))throw Error('INSTANT_INVALID');
  if(new Date(measuredAtUtc).toISOString().slice(0,10)!==measuredAtUtc.slice(0,10)||Date.parse(measuredAtUtc)>Date.parse(nowIso)+60000)throw Error('MEASUREMENT_FUTURE_OR_DATE_INVALID');
  const settingChangeId=newId(),idempotencyKey=newId();
  return {type:'GFSETTINGS_V3_OWNER_INTENT',command:'setting',role:'settingsWriter',profileId:snapshot.profileId,
   expectedRevision:snapshot.revision,idempotencyKey,ownerConfirmed:true,
   payload:{settingChangeId,settingKey:'measurement',value:clone(values),effectiveAtUtc:nowIso}};
 }
 function mount(doc=globalThis.document,windowObject=globalThis){
  const $=id=>doc.getElementById(id);
  if(!doc||!windowObject||!windowObject.parent)throw Error('Q01_BROWSER_HOST_REQUIRED');
  const host=windowObject.parent.GPV3V3Host;
  const bridge=windowObject.parent.GPV3V3Bridge;
  function text(id,value){const e=$(id);if(e)e.textContent=value===undefined||value===null?'—':String(value);}
  function status(message,bad=false){const e=$('status');if(e){e.textContent=message;e.className='status '+(bad?'error':'success');}}
  function td(row,value){const x=doc.createElement('td');x.textContent=String(value??'—');row.append(x)}
  function signalHeight(){if(windowObject.parent!==windowObject){windowObject.parent.postMessage({type:'Q01_SETTINGS_HEIGHT_V1',height:Math.min(Math.ceil(doc.documentElement.scrollHeight),18000)},windowObject.location.origin)}}
  if(!host||!bridge||!windowObject.GFSettingsV3||!windowObject.GFTimeGridV3){
   text('storageWarning','Нативный GFStorage V3 недоступен. Действия сохранения заблокированы.');
   for(const f of doc.querySelectorAll('form'))for(const control of f.querySelectorAll('input,button,select'))control.disabled=true;
   return Object.freeze({connected:false});
  }
  const newId=()=>{
   const buf=new Uint32Array(4);windowObject.crypto.getRandomValues(buf);
   return 'Q01_'+Array.from(buf,n=>n.toString(16).padStart(8,'0')).join('');
  };
  // Copy a native GFStorage snapshot into this iframe's JS realm: parent
  // Object.prototype cannot be accepted by the independent strict object guard.
  const read=()=>clone(host.connect('settings').getSnapshot());
  const svc=windowObject.GFSettingsV3.createService({readPort:()=>read(),idFactory:newId,clock:()=>new Date().toISOString()});
  let last=null,selected=new Set(),draft=false,busy=false;
  const normIds={protein:'normProtein',fat:'normFat',carbs:'normCarbs',kcal:'normKcal'};
  function snapshotView(){last=svc.readView();return last}
  function markDirty(){draft=true;text('dirtyHint','Есть несохранённые изменения')}
  function renderAllergies(){const e=$('allergyChoices');e.replaceChildren();
   for(const name of new Set([...ALLERGEN_CHOICES,...selected])){
    const b=doc.createElement('button');b.type='button';b.className='choice';b.textContent=name;b.setAttribute('aria-pressed',selected.has(name)?'true':'false');
    b.addEventListener('click',()=>{if(selected.has(name))selected.delete(name);else if(selected.size<30)selected.add(name);else return status('Максимум 30 ограничений',true);markDirty();renderAllergies()});e.append(b)
   }
  }
  function preview(){const date=$('pBirth').value,zone=$('pZone').value.trim()||'UTC';let age=null,ref=null;
   try {if(date){age=windowObject.GFNutritionReference.ageOn(date,new Date().toISOString(),zone);ref=windowObject.GFNutritionReference.recommend({birthDate:date,timeZone:zone,sex:$('pSex').value||null},new Date().toISOString())}}
   catch(_){ /* Invalid drafts must not alter stored data. */ }
   text('agePreview',age===null?'—':age+' лет');
   text('nutritionGroup',ref?ref.groupLabel+' · исторические диапазоны 2012 года':'Нет проверенных возрастных справочных диапазонов');
   $('nutritionValues').replaceChildren();
   if(ref){for(const [title,key,unit] of [['Углеводы','carbsG','г'],['Белки','proteinG','г'],['Жиры','fatG','г'],['Калории','kcal','ккал']]){
     const box=doc.createElement('div');box.className='stat';const small=doc.createElement('small');small.textContent=title;const big=doc.createElement('b');big.textContent=ref[key].join('–')+' '+unit;box.append(small,big);$('nutritionValues').append(box);
   }}else text('nutritionSavedStatus','Справочные данные не определены; заполнение личных норм только вручную.');
  }
  function fillDraft(v){const p=v.profile||{};
   if(p.timeZone){try{const nowLocal=profileLocalNow(p.timeZone);$('mDate').max=nowLocal;if(!$('mDate').value)$('mDate').value=nowLocal}catch(_){}}
   $('pName').value=p.displayName||'';$('pBirth').value=p.birthDate||'';$('pSex').value=p.sex||'';$('pZone').value=p.timeZone||'';
   selected=new Set(Array.isArray(p.allergies)?p.allergies:[]);renderAllergies();
   const stored=v.nutritionReference?.daily||{};
   for(const [key,id] of Object.entries(normIds))$(id).value=stored[key]??'';
   $('targetMmol').value=v.target?.mmolL??'';
   $('q01FoodModel').value=v.foodModel;
   $('q01ShowGFForecast').checked=v.graphPreferences.showGFForecast;
   $('q01ShowGFxDrip').checked=v.graphPreferences.showGFxDrip;
   text('q01SettingFlags','Цель: '+(v.target?'записана':'не задана')+' · Модель: '+(v.foodModelPersisted?'сохранена':'по умолчанию')+' · Линии: '+(v.graphPreferencesPersisted?'сохранены':'по умолчанию'));
   draft=false;text('dirtyHint','Данные загружены из GFStorage V3');preview();
  }
  function renderCoeff(v){const tbody=$('q01CoefficientRows');tbody.replaceChildren();
   const zone=v.profile?.timeZone||'UTC';
   try {const slot=windowObject.GFTimeGridV3.slotForInstant(new Date().toISOString(),zone);text('q01TimeGridInfo','Текущее окно: '+slot.from+'–'+slot.to+' · '+zone)}
   catch(_){text('q01TimeGridInfo','Часовой пояс пока не определён')}
   for(const [kind,label] of TYPES)for(const slotId of KEYS){
    const found=v.coefficients.find(c=>c.kind===kind&&c.slotId===slotId);
    const row=doc.createElement('tr');td(row,label);td(row,slotId);
    const modeCell=doc.createElement('td'),sel=doc.createElement('select');sel.className='q01-mode';
    for(const [key,name] of [['manual','Вручную'],['auto','Авто']]){const opt=doc.createElement('option');opt.value=key;opt.textContent=name;sel.append(opt)}
    sel.value=found?.selectedMode||'manual';modeCell.append(sel);row.append(modeCell);
    const valueCell=doc.createElement('td'),input=doc.createElement('input');input.type='number';input.step='0.1';input.min='0.001';input.max='500';input.className='q01-value';input.setAttribute('aria-label',label+' '+slotId);
    input.value=found?.value===null?'':String(found?.value??'');input.placeholder=found?.status==='AUTO_PENDING_Q16'?'Q16':'—';valueCell.append(input);row.append(valueCell);
    const actions=doc.createElement('td');
    const saveMode=doc.createElement('button');saveMode.className='action secondary q01-save';saveMode.type='button';saveMode.textContent='Режим';
    saveMode.addEventListener('click',()=>send(()=>svc.stageMode(kind,slotId,sel.value,true),'Сохранение режима '+label+' '+slotId));
    const saveValue=doc.createElement('button');saveValue.className='action secondary q01-save';saveValue.type='button';saveValue.textContent='Значение';
    saveValue.addEventListener('click',()=>{
      if(sel.value!=='manual'||found?.selectedMode!=='manual')return status('Сначала сохраните ручной режим',true);
      send(()=>svc.stageManualCoefficient(kind,slotId,Number(input.value),true),'Сохранение коэффициента '+label+' '+slotId);
    });
    actions.append(saveMode,saveValue);row.append(actions);tbody.append(row);
   }
  }
  function render(){const v=snapshotView();const profile=v.profile||{};
   text('revisionBadge','База · ревизия '+v.revision);
   let age=null;try{age=profile.birthDate?windowObject.GFNutritionReference.ageOn(profile.birthDate,new Date().toISOString(),profile.timeZone):null}catch(_){ }
   text('ageValue',age===null?'—':age+' лет');text('summaryAge',age===null?'—':age+' лет');
   const measurements=[...(v.measurements||[])].sort((a,b)=>Date.parse(b.measuredAtUtc)-Date.parse(a.measuredAtUtc));
   const recent=measurements[0];text('weightValue',recent?recent.weightKg+' кг':'—');text('heightValue',recent?recent.heightCm+' см':'—');
   const m=$('measurementsList');m.replaceChildren();
   if(!measurements.length){const r=doc.createElement('tr');td(r,'Нет измерений');m.append(r)}
   for(const rec of measurements.slice(0,200)){
    const r=doc.createElement('tr');td(r,new Date(rec.measuredAtUtc).toLocaleString('ru-RU'));td(r,rec.weightKg+' кг');td(r,rec.heightCm+' см');td(r,rec.measurementId);m.append(r)
   }
   const h=$('historyList');h.replaceChildren();const history=[...(v.settingsHistory||[])].sort((a,b)=>b.createdRevision-a.createdRevision);
   if(!history.length){const r=doc.createElement('tr');td(r,'Нет изменений');h.append(r)}
   for(const rec of history.slice(0,200)){
    const r=doc.createElement('tr');td(r,rec.createdRevision);td(r,rec.changedAtUtc||'—');td(r,'GFSettings / '+rec.settingKey);td(r,'Сохранено');td(r,'Изменение '+rec.settingKey);h.append(r)
   }
   const g=windowObject.GFGrowthReference?.evaluate(profile,measurements.map(x=>({id:x.measurementId,measuredAt:x.measuredAtUtc,weightKg:x.weightKg,heightCm:x.heightCm})),new Date().toISOString());
   text('growthStatus',g?.statusLabel||'Данные для справочной оценки пока отсутствуют');$('growthValues').replaceChildren();
   if(g?.weightReferenceKg){for(const [name,value] of [['Справочный диапазон, кг',g.weightReferenceKg.join('–')],['Измеренный вес, кг',g.weightDisplayKg],['Рост, см',g.heightCm]]){
     const x=doc.createElement('div');x.className='growth-cell';const small=doc.createElement('small');small.textContent=name;const bold=doc.createElement('b');bold.textContent=value;x.append(small,bold);$('growthValues').append(x)
   }}
   text('growthDate',g?.measuredAt?'Дата измерения: '+new Date(g.measuredAt).toLocaleString('ru-RU'):'');
   text('nutritionSavedStatus',v.nutritionReference?.source==='OWNER_MANUAL'?'Суточные нормы сохранены вручную, источник GFStorage V3':'Личная норма не подтверждена — справочные диапазоны не сохранены автоматически');
   renderCoeff(v);if(!draft)fillDraft(v);signalHeight();
  }
  function send(build,action){
   if(busy)return status('Дождитесь завершения предыдущего действия',true);
   if(!windowObject.confirm(action+'?'))return;
   try {
    const intent=build(),request=JSON.parse(bridge.requestSettingsOwnerIntent(JSON.stringify(intent)));
    if(request.error)throw Error(request.error.message||request.error.code);
    if(request.state!=='PENDING'||typeof request.ticket!=='string')throw Error('OWNER_QUEUE_INVALID');
    busy=true;status('Ожидается подтверждение в Android: '+action);
    const ticket=request.ticket;
    const poll=()=>{
     const out=JSON.parse(bridge.pollSettingsOwnerIntent(ticket));if(out.error){busy=false;return status(out.error.message||out.error.code,true)}
     if(out.state==='PENDING'||out.state==='APPLYING'){windowObject.setTimeout(poll,400);return}
     busy=false;
     if(out.state!=='FINISHED'||!out.result?.accepted)return status('Не сохранено: '+(out.result?.code||out.state),true);
     host.refresh(true);draft=false;fillDraft(svc.readView());render();
     status('Сохранено в нативном GFStorage V3 · ревизия '+(out.result?.revision??'?'));
     // host.refresh(true) already emits the single sourceRevision change feed.
    };
    windowObject.setTimeout(poll,400);
   }catch(e){busy=false;status('Не сохранено: '+(e.message||e.code),true)}
  }
  function init(){
   text('storageWarning','Единственный источник — нативный GFStorage V3. Браузерное хранилище не используется.');
   $('seed').hidden=true;$('reset').hidden=true;
   doc.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{
    doc.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',x===b?'true':'false'));
    doc.querySelectorAll('[data-pane]').forEach(p=>p.classList.toggle('hidden',p.id!=='tab-'+b.dataset.tab));signalHeight();
   }));
   $('profileForm').addEventListener('submit',e=>{e.preventDefault();
    const values={displayName:$('pName').value.trim(),birthDate:$('pBirth').value,timeZone:$('pZone').value.trim(),allergies:[...selected]};
    if($('pSex').value)values.sex=$('pSex').value;
    send(()=>svc.stageSetting('childProfile',values,true),'Сохранение профиля')
   });
   $('nutritionForm').addEventListener('submit',e=>{e.preventDefault();
    const values={daily:Object.fromEntries(Object.entries(normIds).map(([k,id])=>[k,Number($(id).value)])),source:'OWNER_MANUAL'};
    send(()=>svc.stageSetting('nutritionReference',values,true),'Сохранение суточных норм')
   });
   $('targetForm').addEventListener('submit',e=>{e.preventDefault();
    send(()=>svc.stageSetting('target',{mmolL:Number($('targetMmol').value),source:'OWNER_MANUAL'},true),'Сохранение цели');
   });
   $('foodModelForm').addEventListener('submit',e=>{e.preventDefault();
    send(()=>svc.stageSetting('foodModel',{selectedModel:$('q01FoodModel').value,source:'OWNER_MANUAL'},true),'Сохранение модели еды');
   });
   $('graphPrefsForm').addEventListener('submit',e=>{e.preventDefault();
    send(()=>svc.stageSetting('graphPreferences',{showGFForecast:$('q01ShowGFForecast').checked,showGFxDrip:$('q01ShowGFxDrip').checked},true),'Сохранение отображаемых линий');
   });
   $('measurementForm').addEventListener('submit',e=>{e.preventDefault();
    try{
     const local=$('mDate').value,zone=read().data?.profile?.timeZone;
     const options=localTimeOptions(local,zone);
     if(!options.length)return status('В этом часовом поясе указанное местное время не существовало (переход часов). Выберите другое время.',true);
     let iso=options[0].iso;
     if(options.length>1){
      const select=$('mOffsetChoice');
      if($('mOffsetBox').hidden||!select.value||!options.some(x=>x.iso===select.value)){
       select.replaceChildren();const blank=doc.createElement('option');blank.value='';blank.textContent='Выберите, какой из двух моментов';select.append(blank);
       options.forEach((o,i)=>{const opt=doc.createElement('option');opt.value=o.iso;opt.textContent=(i===0?'Первый':'Второй')+' · '+o.offsetLabel;select.append(opt)});
       $('mOffsetBox').hidden=false;signalHeight();return status('В этот час время повторялось из-за перевода часов. Выберите вариант UTC, затем сохраните ещё раз.',true);
      }
      iso=select.value;
     }
     const values={weightKg:Number($('mWeight').value),heightCm:Number($('mHeight').value),measuredAtUtc:iso};
     send(()=>measurementIntent(read(),values,newId,new Date().toISOString()),'Сохранение роста и веса')
    }catch(err){status('Не сохранено: '+err.message,true)}
   });
   $('mDate').addEventListener('input',()=>{$('mOffsetChoice').replaceChildren();$('mOffsetBox').hidden=true});
   const initialZone=read().data?.profile?.timeZone||'UTC';
   const localDate=profileLocalNow(initialZone);
   $('mDate').value=localDate;$('mDate').max=localDate;
   for(const id of ['pName','pBirth','pSex','pZone'])$(id).addEventListener('input',()=>{markDirty();if(id!=='pName')preview()});
   $('addAllergy').addEventListener('click',()=>{const s=$('customAllergy').value.trim();if(!s)return;if(selected.size>=30)return status('Максимум 30 пунктов',true);selected.add(s);$('customAllergy').value='';renderAllergies();markDirty()});
   $('refresh').addEventListener('click',()=>{if(draft&&!windowObject.confirm('Отменить несохранённые изменения?'))return;host.refresh(true);draft=false;render();status('Данные обновлены из GFStorage V3')});
   windowObject.addEventListener('resize',signalHeight);
   windowObject.parent.document.addEventListener('gpv3:storage-changed',()=>{if(!draft&&!busy)try{render()}catch(e){status('Обновление: '+e.message,true)}});
   render();
  }
  try{init()}catch(e){status('Q01: '+e.message,true);text('storageWarning','Нативный GFStorage V3 пока не готов к отображению настроек.');}
  return Object.freeze({connected:true,readView:()=>last});
 }
 return Object.freeze({measurementIntent,localTimeOptions,profileLocalNow,mount});
});
if(typeof document!=='undefined'&&document.getElementById('profileForm'))globalThis.GFSettingsV3UI.mount(document,globalThis);
