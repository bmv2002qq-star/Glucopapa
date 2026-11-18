/* ГлюкоПапа V2 · оболочка v0.3.12-stage10 (directory order / CGM freshness). UI orchestration only.
 * Shared host: exactly one GFStorage instance per active mode.
 * No dose recommendation, no remote calls, no duplicate storage schema.
 */
(() => {
'use strict';
const VER='0.3.12-stage10', MODE_KEY='GFV2SHELL_MODE_v1', DATA_PREFIX='GFV2SHELL_DATA_v1_';
const $=id=>document.getElementById(id), escape=s=>String(s===null||s===undefined?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('ru-RU',{maximumFractionDigits:d}):'—';
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const nowISO=()=>new Date().toISOString();
const localInputTime=(d=new Date())=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
let mode=localStorage.getItem(MODE_KEY)==='local'?'local':'demo',host=null,unsub=null,controller=null,bridge=null,settingsService=null,activeMeal=null,lastSafety=null,noticeTimer=null,sportMenuOpen=false;
const MODULES=[
 ['GFStorage v0.5.10','Android SQLite CAS, спорт и журнал','on'],['GFActionWriter','Единая запись фактических действий','on'],
 ['GFMealController / GFMealCalc','Факты еды и поиск; численный расчёт дозы не подключён','limited'],['GFCoefficients v0.1.2','Исторический анализ','on'],['GFCoefficientReview v0.1.1','Единые 4×6 ч интервалы и проверка старых записей','on'],
 ['GFSettings v0.1.7','Профиль, аллергии, рост/вес, часовой пояс','on'],['GFJournal v0.1.4','Дневник, включая интервалы спорта','on'],
 ['GFAuditExport adapter v0.1.4','JSON/TXT и печать PDF на основе одной базы','on'],['GFSafety v0.1.0','Диагностика входов','on'],
 ['GFSafetyStorageBridge v0.1.1','Одна ревизия данных','on'],['GFHighLow ReadOnly v0.1.4','Пометки спортивного контекста, без назначений','on'],['GFPhysioExerciseContext v0.1.3','Учёт начала/конца спорта без изменения доз','limited'],
 ['RinfastEngine v0.3.0','Один движок: график кривых и анализ истории','on'],['GFForecast v0.1.2','Ядро подключено; прогноз блокируется без достоверного CGM','limited'],
 ['GFSync v0.2.0','Логика загружена; реальная сеть не подключена','limited'],['GFNutrition v0.4.6','Утверждённая «Моя тарелка» восстановлена и подключена через GFPlate.v1','on'],
 ['Levemir v0.1.2','Реальное ядро подключено: анализ при проверенной истории','on'],['CGM Chart v0.2, вариант А','Реальный рендер графика подключён к общей базе','on'],
 ['GFInjectionAnalytics v0.1.1','Реальный модуль подключён только для чтения','on'],['xDrip+ Follower Android','Живой источник CGM ещё не подключён','pending'],
 ['GFCOB','Модель углеводов в организме не подключена; неизвестное не считается нулём','pending'],['Высокий/низкий','Статус исходных данных и запись выполненных действий','limited']
];
function notify(message,isError=false){const el=$('notice');el.textContent=message;el.className='notice visible'+(isError?' error':'');if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.classList.remove('visible'),8500);}
function dbKey(selectedMode=mode){return DATA_PREFIX+selectedMode;}
function getDriver(selectedMode){
  const key=dbKey(selectedMode); // Bound to exactly one mode at creation.
  const native=globalThis.GFNativeStorage;
  if(native) {
    if(typeof native.readSnapshot!=='function'||typeof native.writeIfRevision!=='function'||typeof native.importIfAbsent!=='function')throw Error('GF_NATIVE_BRIDGE_INCOMPLETE');
    let checkedLegacy=false;
    const parseReply=(raw,operation)=>{
      let p;
      try{p=JSON.parse(raw);}catch{throw Error('GF_NATIVE_'+operation+'_BAD_RESPONSE');}
      if(!p||p.ok!==true)throw Error('GF_NATIVE_'+operation+'_'+(p?.code||'FAILED'));
      return p;
    };
    const readNative=()=>{
      const p=parseReply(native.readSnapshot(key),'READ');
      if(p.code==='ABSENT')return null;
      if(p.code!=='FOUND'||typeof p.data!=='string')throw Error('GF_NATIVE_READ_INVALID');
      const data=JSON.parse(p.data);
      if(data.revision!==p.revision)throw Error('GF_NATIVE_READ_REVISION_MISMATCH');
      return data;
    };
    return {
      load(){
        let data=readNative();
        if(data!==null)return data;
        if(!checkedLegacy){
          checkedLegacy=true;
          const legacy=localStorage.getItem(key);
          if(legacy){
            const parsed=JSON.parse(legacy);
            // GFStorage validates schema before any import. Existing WebView copy remains untouched.
            const normalized=GFStorage.createHost({driver:{load:()=>parsed,save:()=>{throw Error('READ_ONLY_MIGRATION');}}}).exportState();
            // Import the schema-v5 normalized snapshot; retain the original WebView copy for rollback.
            const migrated=parseReply(native.importIfAbsent(key,JSON.stringify(normalized)),'IMPORT');
            if(!['IMPORTED','EXISTS'].includes(migrated.code))throw Error('GF_NATIVE_IMPORT_FAILED');
            data=readNative();
            if(data===null)throw Error('GF_NATIVE_IMPORT_MISSING');
          }
        }
        return data;
      },
      save(snapshot,expectedRevision){
        if(!Number.isSafeInteger(expectedRevision))throw Error('GF_NATIVE_EXPECTED_REVISION_REQUIRED');
        const reply=parseReply(native.writeIfRevision(key,JSON.stringify(snapshot),expectedRevision),'WRITE');
        if(reply.code!=='SAVED'||reply.revision!==snapshot.revision)throw Error('GF_NATIVE_WRITE_CONFIRMATION_MISMATCH');
      }
    };
  }
  // Native Android must never silently downgrade to WebView localStorage.
  if(typeof navigator!=='undefined' && /Android/i.test(navigator.userAgent||''))
    throw Error('GF_NATIVE_BRIDGE_REQUIRED_ANDROID');
  // Desktop/browser preview only.
  return {load(){const v=localStorage.getItem(key);return v?JSON.parse(v):null;},save(s){localStorage.setItem(key,JSON.stringify(s));}};
}
function ensureDependencies(){const required=['GFTimeGrid','GFStorage','GFMealController','GFSettings','GFJournal','GFJournalStorageAdapter','GFCgmEvidencePolicy','GFSafetyStorageBridge','GFSafety','GFAuditExportStorageAdapter','GFCoefficients','GFCoefficientReview','GFHighLowReadOnly','GFHighLowInputGate','GFCOBResearch','GFForecastStorageAdapter','GFFoodMealEntry','GPModuleHub','LevemirEngine','GPCgmWhiteChart','GFInjectionAnalytics','GFPhysioExerciseContext'];return required.filter(name=>!globalThis[name]);}
function boot(selectedMode=mode){
 const missing=ensureDependencies();
 if(missing.length)throw new Error('Отсутствуют модули: '+missing.join(', '));
 // A failed load must leave the active journal, mode preference and subscribers intact.
 const nextHost=GFStorage.createHost({driver:getDriver(selectedMode)});
 const nextController=GFMealController.createController(nextHost);
 const nextBridge=GFSafetyStorageBridge.connect(nextHost,GFSafety);
 const nextSettings=GFSettings.createSettingsService({settingsPort:nextHost.connect('settings')});
 const nextJournal=nextHost.connect('journal');
 const nextMeal=nextJournal.read('mealSessions').at(-1)?.id||null;
 const switched=selectedMode!==mode;
 if(switched)localStorage.setItem(MODE_KEY,selectedMode);
 if(unsub)unsub();
 mode=selectedMode;
 host=nextHost;
 controller=nextController;
 bridge=nextBridge;
 settingsService=nextSettings;
 activeMeal=nextMeal;
 lastSafety=null;
 if(switched){
   sportMenuOpen=false;
   $('injectionForm').reset();
   $('injectionTime').value=localInputTime();
   $('basalEntryContext').hidden=true;
   $('gfMealActualConfirm').checked=false;
   $('gfMealActualCorrectionReason').value='';
 }
 unsub=nextJournal.subscribe(()=>{
   lastSafety=null;
   render();
   setTimeout(broadcastApproved,0);
 });
 $('modeBadge').textContent=mode==='demo'?'Тестовые данные':'Локальный журнал';$('modeBadge').className='chip '+(mode==='demo'?'demo':'local');$('banner').innerHTML=mode==='demo'?'<strong>Тестовый режим.</strong> Вымышленные данные отделены от локального журнала. Нет расчёта доз, экстренных оповещений и подключения к xDrip+.':'<strong>Локальный экспериментальный журнал.</strong> Android: SQLite сохранение ещё не испытано на устройстве и не имеет проверенного восстановления из резервной копии. Браузер: временное localStorage. Не используйте как единственный медицинский дневник.';
 render();
 globalThis.GFCOBStudyPanel?.render?.();
 setTimeout(broadcastApproved,0);
}
function port(role){return host.connect(role);}
function state(){return host.exportState();}
function screen(id){if(id==='journal')id='approved-journal';document.querySelectorAll('.screen').forEach(e=>e.classList.toggle('active',e.id==='screen-'+id));const group={cgm:'home',injections:'journal',settings:'system','insulin-models':'analytics','injection-sites':'analytics',reports:'system',sync:'system',highlow:'home','approved-journal':'journal','approved-nutrition':'meals','approved-settings':'system','approved-low':'home','approved-high':'home','module-detail':'modules',research:'system'}[id]||id;document.querySelectorAll('#nav button').forEach(e=>e.classList.toggle('selected',e.dataset.screen===group));const names={home:'Главная',cgm:'Глюкоза',injections:'Инъекции',meals:'Продукты',journal:'Дневник',analytics:'Анализ',settings:'Настройки',system:'Ещё','insulin-models':'Инсулиновые модели','injection-sites':'Места инъекций',reports:'Отчёты',sync:'Синхронизация',highlow:'Высокий / низкий сахар','approved-nutrition':'Моя тарелка','approved-journal':'Дневник','approved-settings':'Настройки','approved-low':'Низкий сахар','approved-high':'Высокий сахар',modules:'Модули','module-detail':'Модуль',research:'Исследовательские модули'};$('pageTitle').textContent=names[id]||'Главная';document.body.dataset.activeScreen=id;window.scrollTo(0,0);render();setTimeout(broadcastApproved,0);}
function rowsMarkup(rows,mapper,max=50){if(!rows.length)return '<div class="empty">Записей пока нет</div>';return '<div class="events">'+rows.slice(-max).reverse().map(mapper).join('')+'</div>';}
function eventMarkup(title,details,time){return '<div class="event"><div class="event-text"><b>'+escape(title)+'</b><small>'+escape(details)+'</small></div><time>'+escape(time)+'</time></div>';}
function formatAt(v){try{return new Date(v).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}catch{return '—';}}
function activeSport(snapshot){return (snapshot.conditionPeriods||[]).find(p=>p.kind==='sport'&&p.end===null)||null;}
function showSportClock(snapshot=state()){
 const p=activeSport(snapshot);if(!p){$('sportClock').textContent='Нажмите «Начало спорта», когда тренировка действительно начнётся.';return;}
 const mins=Math.max(0,Math.floor((Date.now()-Date.parse(p.start))/60000));
 $('sportClock').textContent='Спорт идёт с '+new Date(p.start).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+' · '+mins+' мин';
}
function renderSport(s,all){
 const p=activeSport(s),level=s.profile?.activityBaseLevel||'low',show=!!p||sportMenuOpen;
 $('activityChoice').value=show?'sport':level;
 $('sportBadge').textContent=p?'Идёт спорт':show?'Готов к началу':'Нет тренировки';
 $('sportControls').hidden=!show;$('sportStart').hidden=!!p;$('sportFinish').hidden=!p;
 if(show)showSportClock(s);
 const rows=all.rows.filter(r=>r.kind==='sport');
 $('approvedSportRows').innerHTML=rowsMarkup(rows,r=>eventMarkup(r.description,r.status==='active'?'Занятие продолжается':'Завершено · '+fmt(r.durationMinutes)+' мин',r.time),30);
}
function chooseActivity(value){
 const s=state();if(activeSport(s))throw Error('Сначала завершите текущую тренировку');
 if(value==='sport'){sportMenuOpen=true;render();return;}
 if(!['low','usual','high'].includes(value))throw Error('Неизвестная активность');
 sportMenuOpen=false;port('activityUi').setBaseLevel(value,host.connect('activityUi').getRevision());render();
 notify('Уровень активности сохранён. Непроверенные лечебные коэффициенты не применяются.');
}
function startSport(){
 if(activeSport(state()))throw Error('Спорт уже идёт');
 const p=port('sport');p.startSport({id:uid('sport'),start:nowISO()},p.getRevision());
 sportMenuOpen=true;notify('Начало занятия записано в GFStorage');render();
}
function finishSport(){
 const open=activeSport(state());if(!open)throw Error('Нет открытой тренировки');
 if(!confirm('Подтвердить, что тренировка действительно закончилась?'))return;
 const p=port('sport');p.finishSport({id:open.id,end:nowISO()},p.getRevision());
 sportMenuOpen=false;notify('Занятие завершено и появилось в дневнике');render();
}
// Display only: CGM age is not a glucose forecast and does not influence any dose formula.
function cgmDisplayStatus(nowMs){
 const x=GFCgmEvidencePolicy.inspect(host,{nowMs});
 if(x.status==='OK'){
   const trend=GFCgmEvidencePolicy.forEvent(x,Date.parse(x.latestAt),{journal:GFJournal});
   const arrow=trend.direction&&trend.direction!=='—'?' '+trend.direction:'';
   return {state:'fresh',text:(x.sourceStatus==='SYNTHETIC'?'ВЫМЫШЛЕННЫЕ ДАННЫЕ':'Источник '+x.sourceDeviceId+' · не проверен xDrip')+' · измерено '+Math.floor(x.ageMinutes)+' мин назад',value:fmt(x.currentMmol)+' ммоль/л'+arrow};
 }
 if(x.status==='STALE')return {state:'stale',text:'CGM устарел · '+Math.floor(x.ageMinutes)+' мин назад · не текущий сахар',value:'—'};
 return {state:'invalid',text:'CGM недоступен: '+x.code+' · текущее значение не подтверждено',value:'—'};
}
function renderW06Evidence(role,nowMs=Date.now()){
 const out=$('w06Evidence'+(role==='low'?'Low':'High'));
 if(!out||!host)return;
 try{const result=GFHighLowInputGate.evaluate({host,nowMs,cgmPolicy:GFCgmEvidencePolicy,insulinGate:GFInsulinEvidenceGate,rinfastEngine:RinfastEngine,cobResearch:GFCOBResearch,...(globalThis.GFCOBStudyPanel?.optionsForRevision?.(host,nowMs)||{})});GFHighLowInputGate.renderPanel(out,result);}catch(e){out.textContent='Проверка данных недоступна: '+String(e.message||e);}
}
function renderCgm(cgm,active,nowMs){
 const screenId=document.body.dataset.activeScreen||'home';
 const statusCgm=cgmDisplayStatus(nowMs);
 $('homeGlucose').textContent=statusCgm.value;
 $('homeCgmInfo').textContent=statusCgm.text;
 $('cgmSource').textContent=active?(active.sourceType==='synthetic'?'Тестовый сенсор':'Источник '+active.sourceDeviceId)+(statusCgm.state==='stale'?' · устарел':statusCgm.state==='invalid'?' · ошибка качества':''):'Нет источника';
 $('cgmMeta').textContent=active?'Источник: '+active.sourceDeviceId+' · '+(active.sourceType==='synthetic'?'вымышленный':'с устройства')+' · '+cgm.length+' измерений':'Источник не подключён; xDrip+ пока не соединён с оболочкой.';
 if(screenId==='cgm')renderChart($('cgmDetailChart'),cgm,nowMs,24);
 if(screenId==='home')renderChart($('cgmChart'),cgm,nowMs,12);
 if(screenId==='approved-low'||screenId==='approved-high')renderW06Evidence(screenId==='approved-low'?'low':'high',nowMs);
}
function refreshClockDisplays(){
 if(!host||document.hidden)return;
 const snapshot=state();
 renderCgm(snapshot.cgm||[],snapshot.cgmMetadata,Date.now());
 if(activeSport(snapshot))showSportClock(snapshot);
}
function render(){if(!host)return;try{
 const renderNow=Date.now();
 const s=state(),all=GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter,{nowMs:renderNow}),cgm=s.cgm||[],active=s.cgmMetadata,inj=s.events.filter(e=>e.type==='insulin_injection'&&e.status==='confirmed');
 $('revBadge').textContent='База #'+s.revision;
 renderCgm(cgm,active,renderNow);
 $('homeCgmCount').textContent=String(cgm.length);$('homeInjectionCount').textContent=String(inj.length);$('homeMealCount').textContent=String(s.mealSessions.filter(m=>m.status==='completed').length);
 renderSport(s,all);
 $('homeEvents').innerHTML=rowsMarkup(all.rows,r=>eventMarkup(r.kind==='injection'?(r.insulinName||'Инсулин')+' · '+r.description:r.description,(r.kind==='injection'?fmt(r.dose)+' ЕД'+(r.siteLabel?' · '+r.siteLabel:''):r.meal?'Углеводы '+fmt(r.meal.carbs)+' г':'')+' · '+(r.recordSource||''),r.time),5);
 $('seedDemo').disabled=mode!=='demo'||!!active;
 $('injectionList').innerHTML=rowsMarkup(inj,e=>eventMarkup(e.insulinId==='rinfast'?'РинФаст':'Левемир',fmt(e.units)+' ЕД'+(e.injectionSite?' · '+e.injectionSite.region:''),formatAt(e.administeredAt)),15);
 let m=activeMeal?s.mealSessions.find(x=>x.id===activeMeal):null;if(!m){m=s.mealSessions.at(-1)||null;activeMeal=m?.id||null;}
 $('mealCurrent').innerHTML=m?'<div class="soft"><strong>ID:</strong> '+escape(m.id)+'<div><strong>Статус:</strong> '+escape(m.status)+'</div><div><strong>Углеводы по плану:</strong> '+fmt(m.plannedPlate?.totals?.carbs)+' г</div><div><strong>Углеводы фактически:</strong> '+(m.actualPlate?fmt(m.actualPlate.totals.carbs)+' г':'не подтверждено')+'</div></div>':'<div class="empty">Сначала создайте план</div>';
 $('mealReady').disabled=!m||m.status!=='draft';$('mealStart').disabled=!m||m.status!=='planned';$('mealFinish').disabled=!m||m.status!=='started'||!m.actualPlate;
 $('settingsTZ').value=s.profile.timeZone||'Europe/Minsk';const cr=GFCoefficientReview.evaluate({settingsPort:port('settings'),atIso:nowISO()});
 $('settingsInfo').textContent='Ревизия #'+s.revision+' · GFSettings v'+GFSettings.VERSION+' · хранилище schema '+host.getSchemaVersion()+(cr.conflicts.length?' · ВНИМАНИЕ: конфликтующих типов коэффициентов: '+cr.conflicts.length+'; выбор заблокирован':cr.legacyIntervals.length?' · Старые интервалы: '+cr.legacyIntervals.length+' требуют сверки с сеткой 4×6 ч':' · Единая сетка: 00–06 / 06–12 / 12–18 / 18–00; без назначения');
 $('storageInfo').textContent='GFStorage '+GFStorage.VERSION+' · схема '+s.schemaVersion+' · ревизий '+s.revision+' · записей CGM '+cgm.length+' · один общий экземпляр.';
 $('moduleTable').innerHTML='<div class="module-grid">'+MODULES.map(([name,detail,status])=>'<div class="module-row '+(status!=='on'?'pending':'')+'"><strong>'+escape(name)+'</strong><small>'+escape(detail)+'</small><span class="status">'+(status==='on'?'Подключён':status==='limited'?'Частично подключён':'Ожидает интеграции')+'</span></div>').join('')+'</div>';
 $('homeSafety').textContent=lastSafety?'GFSafety: '+lastSafety.status+'; вход для прогноза: '+(lastSafety.forecastInputEligible?'технически допустим':'заблокирован'):'GFSafety не запускался для текущей ревизии.';
 $('resetDemo').disabled=mode!=='demo'||!!globalThis.GFNativeStorage;
 }catch(e){notify('Ошибка отображения: '+String(e.message||e),true);console.error(e);}}
function renderChart(out,readings,nowMs,hours){
 if(readings.length<2){out.innerHTML='<div class="empty">Нет сохранённых показаний CGM</div>';out.classList.remove('full-chart');return;}
 try{
   const view=GPModuleHub.chart(host,{now:nowMs,hours,showInsulin:$('showRinfast').checked});
   if(['OK','STALE','QUALITY_BLOCKED','FUTURE_BLOCKED'].includes(view.status)&&view.svg){
     out.classList.add('full-chart');out.innerHTML=view.svg;
     const note=document.createElement('div');note.className='hint';note.textContent='График А v0.2 · '+view.count+' точек CGM · '+view.shotCount+' схематических кривых. '+view.reason;
     out.appendChild(note);return;
   }
   out.classList.remove('full-chart');out.textContent='График недоступен: '+(view.reason||view.code||'нет достоверных данных');return;
 }catch(error){console.warn('CGM Chart v0.2 отказал:',error);}
 out.classList.remove('full-chart');out.textContent='График временно недоступен. Сохранённые данные остались в GFStorage.';
}
function runSafety(){lastSafety=GFCgmEvidencePolicy.checkSafety(host,bridge);const summary=lastSafety.status+' · '+(lastSafety.code?'Причина: '+lastSafety.code:'источник '+(lastSafety.forecastInputEligible?'прошёл технический контроль':'не допущен к прогнозу'))+' · назначения запрещены';$('analysisSafety').textContent=summary;notify('Техническая проверка завершена: '+lastSafety.status);render();}
function numericField(id){const n=Number($(id).value);if(!Number.isFinite(n))throw Error('Проверьте числовые поля');return n;}
function doMeal(method){
 if(!activeMeal)throw Error('Сначала создайте план');
 if(method==='ready')controller.ready(activeMeal);
 if(method==='start'){
   if(!confirm('Подтвердить, что еда действительно началась?'))return;
   controller.startMeal(activeMeal,nowISO(),{actuallyStarted:true});
 }
 if(method==='finish'){
   if(!confirm('Подтвердить завершение приёма пищи?'))return;
   controller.finishMeal(activeMeal,nowISO(),{confirmed:true});
 }
 notify('Событие еды сохранено: '+method);
 render();
}
function seedDemo(){if(mode!=='demo')throw Error('Вымышленные данные только в тестовом режиме');const c=port('cgmAdapter');if(c.read('cgmMetadata'))throw Error('Тестовый датчик уже задан');c.setSourceMetadata({sourceDeviceId:'gs1-demo',sourceType:'synthetic',samplingMinutes:5,qualityScore:1},c.getRevision());const base=Math.floor(Date.now()/300000)*300000-300000;const rows=Array.from({length:24},(_,i)=>{const ts=base-(23-i)*300000;return {ts,mmol:Math.round((7.3+1.7*Math.sin(i/3.8)+.4*Math.cos(i/2))*10)/10,sourceDeviceId:'gs1-demo',receivedAt:new Date(ts+60000).toISOString()};});c.ingestReadings(rows,c.getRevision());notify('Добавлены 24 вымышленных измерения в отдельный тестовый журнал');}
function changeMode(next){if(next===mode)return;if(next==='local'&&!confirm('Локальный журнал — экспериментальный. Нет защищённой базы Room, резервирования и xDrip+. Переключиться?'))return;boot(next);notify(mode==='demo'?'Открыт отдельный тестовый журнал':'Открыт отдельный локальный журнал (экспериментальный)');}
function wrap(fn){return e=>{try{fn(e);}catch(ex){console.error(ex);notify(String(ex.message||ex),true);}};}
function setupEvents(){ $('activityChoice').addEventListener('change',wrap(e=>chooseActivity(e.target.value)));$('sportStart').addEventListener('click',wrap(startSport));$('sportFinish').addEventListener('click',wrap(finishSport));document.querySelectorAll('[data-screen]').forEach(b=>b.addEventListener('click',()=>screen(({journal:'approved-journal',meals:'approved-nutrition',settings:'approved-settings','meal-workflow':'meals'})[b.dataset.screen]||b.dataset.screen)));$('openLow').addEventListener('click',()=>{screen('approved-low');});$('openHigh').addEventListener('click',()=>{screen('approved-high');});$('openBasalQuick').addEventListener('click',()=>{ $('injectionForm').reset(); $('injectionDrug').value='levemir'; $('injectionTime').value=localInputTime(); $('basalEntryContext').hidden=false; screen('injections'); setTimeout(()=>{ $('injectionUnits').focus(); },0); });$('injectionDrug').addEventListener('change',()=>{if($('injectionDrug').value!=='levemir')$('basalEntryContext').hidden=true;});$('seedDemo').addEventListener('click',wrap(seedDemo));$('homeSafetyRun').addEventListener('click',wrap(()=>{runSafety();screen('analytics');}));$('runSafety').addEventListener('click',wrap(runSafety));$('runHighLow').addEventListener('click',wrap(()=>{const a=GFHighLowReadOnly.connect(host).analyze();$('analysisHighLow').textContent='Статус: '+a.status+'; эпизодов: '+(a.episodes?.length||0)+'; только наблюдения, без записей и рекомендаций.';}));$('runCoefficients').addEventListener('click',wrap(()=>{const x=GFCoefficients.createService({researchPort:port('research')}).run({asOfIso:nowISO(),windowDays:7});$('analysisCoefficients').textContent='Уколов: '+x.statistics.confirmedInjections+'; подтверждённых приёмов еды: '+x.statistics.meals+'; совпавших пар: '+x.statistics.mealPairs+'. '+(x.flags[0]||'Аналитика носит исследовательский характер.');}));$('runForecastGate').addEventListener('click',wrap(()=>{const v=GFCgmEvidencePolicy.checkSafety(host,bridge);const gate=GFForecastStorageAdapter.trustedReadings(host,{safetyVerdict:v});$('analysisForecast').textContent='Доступность: '+(gate.available?'технически допустимый вход; прогноз ещё не запущен':'ЗАБЛОКИРОВАНО')+'. Код: '+gate.code+'. Решения о дозах запрещены.';}));$('settingsForm').addEventListener('submit',wrap(e=>{e.preventDefault();settingsService.saveProfile({timeZone:$('settingsTZ').value},port('settings').getRevision());notify('Часовой пояс сохранён через GFSettings');}));$('injectionForm').addEventListener('submit',wrap(e=>{e.preventDefault();if(!$('injectionConfirm').checked)throw Error('Нужно подтвердить выполненную инъекцию');const n=numericField('injectionUnits');if(n<=0||Math.abs(n*2-Math.round(n*2))>1e-8)throw Error('Доза должна быть положительной и кратной 0,5 ЕД');const t=new Date($('injectionTime').value);if(!Number.isFinite(t.getTime()))throw Error('Неверное время');if(t.getTime()>Date.now()+60000)throw Error('Факт инъекции не может быть в будущем');const item={id:uid('inj'),insulinId:$('injectionDrug').value,units:n,administeredAt:t.toISOString()};if($('injectionRegion').value){item.injectionSite={region:$('injectionRegion').value};if($('injectionSide').value)item.injectionSite.side=$('injectionSide').value;}port('actionWriter').recordInjection(item,port('actionWriter').getRevision());$('injectionConfirm').checked=false;notify('Фактическая инъекция записана один раз');}));for(const [id,method]of [['mealReady','ready'],['mealStart','start'],['mealFinish','finish']])$(id).addEventListener('click',wrap(()=>doMeal(method)));$('modeDemo').addEventListener('click',wrap(()=>changeMode('demo')));$('modeLocal').addEventListener('click',wrap(()=>changeMode('local')));$('resetDemo').addEventListener('click',wrap(()=>{if(mode!=='demo')throw Error('Можно очистить только тестовые данные');if(globalThis.GFNativeStorage)throw Error('Сброс нативной SQLite-базы ещё не реализован. Данные не удалены.');if(!confirm('Удалить тестовый журнал?'))return;localStorage.removeItem(dbKey());boot();notify('Тестовая база очищена');}));$('exportState').addEventListener('click',wrap(()=>{const data=GFAuditExportStorageAdapter.exportJson(host);if(globalThis.AndroidExporter&&typeof globalThis.AndroidExporter.saveJson==='function'){globalThis.AndroidExporter.saveJson(data);notify('Открыт системный выбор файла для экспорта JSON');return;}const blob=new Blob([data],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ГлюкоПапа_V2_'+mode+'_rev'+host.diagnostics().revision+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500);notify('Сформирован аналитический JSON (не полноценная резервная копия)');}));}

// Approved UI adapters: child screens never obtain their own persistent GFStorage instance.
const approvedFrames=Object.freeze({
 nutrition:{id:'iframeApprovedNutrition',src:'approved/GFNutrition_v0.4.6_LIVE.html'},
 journal:{id:'iframeApprovedJournal',src:'approved/GFJournal_v0.1.2_3COL_CANDIDATE.html'},
 settings:{id:'iframeApprovedSettings',src:'approved/GFSettings_v0.1.4_LIVE.html'}
});

function approvedPeer(role){
 if(!Object.prototype.hasOwnProperty.call(approvedFrames,role))return null;
 const route=approvedFrames[role],frame=$(route.id),peer=frame?.contentWindow;
 if(!peer)return null;
 try {
  if(frame.hasAttribute('srcdoc')){
   // The historical standalone preview embeds these three local documents.
   if(globalThis.__SINGLEFILE_SYNTHETIC_PREVIEW!==true||frame.hasAttribute('src')||frame.hasAttribute('sandbox')||peer.location.href!=='about:srcdoc')return null;
   return {peer,origin:window.origin};
  }
  const expected=new URL(route.src,document.baseURI);
  if(window.origin==='null'||expected.origin!==window.origin||frame.src!==expected.href)return null;
  if(frame.hasAttribute('sandbox')||peer.location.href!==expected.href)return null;
  return {peer,origin:expected.origin};
 }catch{return null;}
}
function isApprovedMessage(role,event){
 const channel=approvedPeer(role);
 return !!channel&&event.source===channel.peer&&event.origin===channel.origin;
}
function sendApproved(role,message){
 const channel=approvedPeer(role);
 if(!channel)return false;
 // The generated synthetic preview has no URL origin. Multi-file uses the exact asset origin.
 channel.peer.postMessage(message,channel.origin==='null'?'*':channel.origin);
 return true;
}

let plateDialogObserver;
function watchPlateDialog(){
 plateDialogObserver?.disconnect();
 document.body.classList.remove('plate-modal-open');
 const peer=approvedPeer('nutrition')?.peer;
 const dialog=peer?.document.getElementById('foodModal');
 if(!dialog)return;
 const update=()=>document.body.classList.toggle('plate-modal-open',dialog.classList.contains('on'));
 plateDialogObserver=new MutationObserver(update);
 plateDialogObserver.observe(dialog,{attributes:true,attributeFilter:['class']});
 update();
}

function approvedSnapshot(role){if(!host)return null;const s=state();
 if(role==='nutrition')return {type:'gp:snapshot',role};
 if(role==='journal'){const all=GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter);return {type:'gp:snapshot',role,all,revision:s.revision,timezone:all.zone,today:GFJournal.ymd(Date.now(),all.zone)};}
 if(role==='settings')return {type:'gp:snapshot',role,profile:s.profile,revision:s.revision};
 return null;
}
function broadcastApproved(role=null){
 for(const r of ['nutrition','journal','settings']){
  if(role&&r!==role)continue;
  try{sendApproved(r,approvedSnapshot(r));}catch(e){console.warn('Frame awaiting initialization',r,e);}
 }
}
function registerApprovedPlate(payload){const converted=GFFoodMealEntry.normalizePlate(payload);const p=converted.plate;if(!p.items.length)throw Error('Тарелка пуста');
 const current=activeMeal?controller.lookup(activeMeal):null;
 if(current&&current.status==='draft'&&JSON.stringify(current.plannedPlate?.items)===JSON.stringify(p.items)){
   $('approvedPlateStatus').textContent='Такая тарелка уже сохранена · ID '+activeMeal;notify('Повторная запись еды не создана');return;
 }
 const id=uid('meal');controller.createFromFood(p,id);activeMeal=id;$('approvedPlateStatus').textContent='План зарегистрирован: '+id+' · '+p.items.length+' позиций. Для отметки фактически съеденного откройте «План / факт еды». Подтверждённый план не считается съеденным.';notify('Моя тарелка v0.4.6 передана в GFStorage: '+id);}
window.addEventListener('message',wrap(e=>{const d=e.data||{};if(!d.type?.startsWith?.('gp:'))return;
 const role=d.role;if(typeof role!=='string'||!isApprovedMessage(role,e))return;
 if(d.type==='gp:ready'){broadcastApproved(role);return;}
 if(d.type==='gp:plate'&&role==='nutrition'){registerApprovedPlate(d.plate);return;}
 if(d.type==='gp:error'){notify(String(d.error||'Ошибка исходного модуля'),true);return;}
 if(d.type==='gp:workflow'&&role==='nutrition'){notify('Чтобы зарегистрировать фактическое действие, используйте общий раздел «План / факт еды»; фиктивная запись в модуле питания отключена.');return;}
 if(d.type==='gp:measurement'&&role==='settings'){
 const record=d.record||{};settingsService.addMeasurement(record,port('settings').getRevision());notify('Рост/вес сохранён в едином GFStorage');broadcastApproved('settings');return;
 }
 if(d.type==='gp:profile'&&role==='settings'){
 const patch=Object.fromEntries(Object.entries(d.patch||{}).filter(([,v])=>v!==''));
 settingsService.saveProfile(patch,port('settings').getRevision());notify('Профиль сохранён через единый GFStorage');broadcastApproved('settings');return;
 }}));
for(const [role,route] of Object.entries(approvedFrames))$(route.id).addEventListener('load',()=>broadcastApproved(role));
$('iframeApprovedNutrition').addEventListener('load',watchPlateDialog);
$('approvedSavePlate').addEventListener('click',wrap(()=>{if(!sendApproved('nutrition',{type:'gp:capture:plate'}))throw Error('Модуль питания ещё не загружен');}));

try{setupEvents();watchPlateDialog();$('showRinfast').addEventListener('change',wrap(refreshClockDisplays));setInterval(wrap(refreshClockDisplays),15000);$('injectionTime').value=localInputTime();boot();}catch(e){console.error(e);document.body.insertAdjacentHTML('afterbegin','<div class="shell-boot-error" role="alert"><h2>Не удалось открыть оболочку</h2><pre>'+escape(String(e.message||e))+'</pre><p>Данные не очищены. Сохраните исходный журнал и обратитесь к техническому отчёту.</p></div>');}
globalThis.GPApp=Object.freeze({version:VER,getStorage:()=>host,mode:()=>mode,getModuleStatuses:()=>MODULES.map(x=>x.slice()),open:screen});
})();
