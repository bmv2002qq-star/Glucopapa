/* ГлюкоПапа V2 · оболочка v0.3.12-stage10 (directory order / CGM freshness). UI orchestration only.
 * Shared host: exactly one GFStorage instance.
 * No dose recommendation, no remote calls, no duplicate storage schema.
 */
(() => {
'use strict';
const VER='0.3.14-prototype', MODE_KEY='GFV2SHELL_MODE_v1', DATA_PREFIX='GFV2SHELL_DATA_v1_';
const XDRIP_KEY='GFV2SHELL_XDRIP_LOCAL_v1';
const $=id=>document.getElementById(id), escape=s=>String(s===null||s===undefined?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('ru-RU',{maximumFractionDigits:d}):'—';
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const nowISO=()=>new Date().toISOString();
const localInputTime=(d=new Date())=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
const testJournal=globalThis.GFTestJournal;
let mode='local',host=null,unsub=null,controller=null,bridge=null,settingsService=null,activeMeal=null,lastSafety=null,noticeTimer=null,sportMenuOpen=false;
let fileOperation=null,xdripStatus='',xdripTimer;
const MODULES=[
 ['GFStorage v'+(globalThis.GFStorage?.VERSION||'—'),'Android SQLite CAS, спорт и журнал','on'],['GFActionWriter','Единая запись фактических действий','on'],
 ['GFMealController / GFMealCalc','Факты еды и поиск; численный расчёт дозы не подключён','limited'],['GFCoefficients v0.1.2','Исторический анализ','on'],['GFCoefficientReview v0.1.1','Единые 4×6 ч интервалы и проверка старых записей','on'],
 ['GFSettings v0.1.7','Профиль, аллергии, рост/вес, часовой пояс','on'],['GFJournal v0.1.4','Дневник, включая интервалы спорта','on'],
 ['GFAuditExport adapter v0.1.4','JSON/TXT и печать PDF на основе одной базы','on'],['GFSafety v0.1.0','Диагностика входов','on'],
 ['GFSafetyStorageBridge v0.1.1','Одна ревизия данных','on'],['GFHighLow ReadOnly v0.1.4','Пометки спортивного контекста, без назначений','on'],['GFPhysioExerciseContext v0.1.3','Учёт начала/конца спорта без изменения доз','limited'],
 ['RinfastEngine v0.3.0','Один движок: график кривых и анализ истории','on'],['GFForecast v0.1.2','Ядро подключено; прогноз блокируется без достоверного CGM','limited'],
 ['GFSync v0.2.0','Логика загружена; реальная сеть не подключена','limited'],['GFNutrition v0.4.6','Утверждённая «Моя тарелка» восстановлена и подключена через GFPlate.v1','on'],
 ['Levemir v0.1.2','Реальное ядро подключено: анализ при проверенной истории','on'],['CGM Chart v0.2, вариант А','Реальный рендер графика подключён к общей базе','on'],
 ['GFInjectionAnalytics v0.1.1','Реальный модуль подключён только для чтения','on'],['xDrip+ Follower Android','Чтение последнего показания через локальный ContentProvider; проверка с датчиком предстоит','limited'],
 ['GFCOB','Чтение подтверждённой еды и расчёт исследовательских профилей при полной истории','limited'],['Высокий/низкий','Статус исходных данных и запись выполненных действий','limited']
];
function readPreference(key){
 const native=globalThis.GFShellPreferences;
 return native?.read(key)??localStorage.getItem(key);
}
function savePreference(key,value){
 const native=globalThis.GFShellPreferences;
 if(native){
   if(!native.write(key,value))throw Error('Не удалось сохранить настройку приложения');
 }else localStorage.setItem(key,value);
}
function notify(message,isError=false){const el=$('notice');el.textContent=message;el.className='notice visible'+(isError?' error':'');if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.classList.remove('visible'),8500);}
function getDriver(selectedMode){
  if(selectedMode!=='local'&&!(testJournal&&selectedMode==='demo'))throw Error('GF_JOURNAL_MODE_DENIED');
  const key=DATA_PREFIX+selectedMode;
  const checkSource=snapshot=>{
    if(selectedMode==='local'&&(snapshot?.cgmMetadata?.sourceType==='synthetic'||
       snapshot?.cgm?.some(row=>row.source==='synthetic')))throw Error('GF_LOCAL_SYNTHETIC_DATA');
    return snapshot;
  };
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
      return checkSource(data);
    };
    return {
      load(){
        let data=readNative();
        if(data!==null)return data;
        if(!checkedLegacy){
          checkedLegacy=true;
          const legacy=localStorage.getItem(key);
          if(legacy){
            const parsed=checkSource(JSON.parse(legacy));
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
        const reply=parseReply(native.writeIfRevision(key,JSON.stringify(checkSource(snapshot)),expectedRevision),'WRITE');
        if(reply.code!=='SAVED'||reply.revision!==snapshot.revision)throw Error('GF_NATIVE_WRITE_CONFIRMATION_MISMATCH');
      }
    };
  }
  // Native Android must never silently downgrade to WebView localStorage.
  if(typeof navigator!=='undefined' && /Android/i.test(navigator.userAgent||''))
    throw Error('GF_NATIVE_BRIDGE_REQUIRED_ANDROID');
  // Desktop/browser preview only.
  return {load(){const v=localStorage.getItem(key);return v?checkSource(JSON.parse(v)):null;},save(s){localStorage.setItem(key,JSON.stringify(checkSource(s)));}};
}
function ensureDependencies(){const required=['GFTimeGrid','GFStorage','GFMealController','GFSettings','GFJournal','GFJournalStorageAdapter','GFCgmEvidencePolicy','GFSafetyStorageBridge','GFSafety','GFAuditExportStorageAdapter','GFCoefficients','GFCoefficientReview','GFHighLowReadOnly','GFHighLowInputGate','GFHighTargetBridge','GFInjectionTimingStorage','GFInjectionFact','GFCOBResearch','GFMealAbsorption','GFCalculationEvidence','GFForecastStorageAdapter','GFForecastReadout','GFResearchForecastRun','GFResearchForecastGraph','GFGraphFourLines','GFConsensusAutoSelection','GFConsensusEvidence','GFMainScreenCore','GFMainScreenUI','GFFoodMealEntry','GFProviderCgm','GFJournalBackup','GPModuleHub','LevemirEngine','GPCgmWhiteChart','GFInjectionAnalytics','GFPhysioExerciseContext'];return required.filter(name=>!globalThis[name]);}
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
 if(switched)savePreference(MODE_KEY,selectedMode);
 if(unsub)unsub();
 mode=selectedMode;
 host=nextHost;
 controller=nextController;
 bridge=nextBridge;
 settingsService=nextSettings;
 activeMeal=nextMeal;
 lastSafety=null;
 clearForecast();
 sportMenuOpen=Boolean(activeSport(nextHost.exportState()));
 if(switched){
   $('injectionForm').reset();
   $('injectionTime').value=localInputTime();
   $('basalEntryContext').hidden=true;
   $('gfMealActualConfirm').checked=false;
   $('gfMealActualCorrectionReason').value='';
 }
 unsub=nextJournal.subscribe(change=>{
   recordDiagnostic('storage_commit', change.revision, {status:'OK'});
   lastSafety=null;
   clearForecast();
   clearResearchReviews();
   render();
   setTimeout(broadcastApproved,0);
 });
 $('xdripControls').hidden=mode!=='local'||!globalThis.GFNativeXDrip;
 $('xdripEnabled').checked=xdripEnabled();
 $('backupControls').hidden=!globalThis.AndroidExporter?.saveBackup;
 $('aiExportControls').hidden=!globalThis.AndroidExporter?.saveAiExport;
 if(switched||!xdripEnabled())xdripStatus='';
 clearResearchReviews();
 render();
 globalThis.GFCOBStudyPanel?.render?.();
 globalThis.GFInjectionTimingPanel?.refresh();
 setTimeout(broadcastApproved,0);
 requestXDrip();
}
function port(role){return host.connect(role);}
function state(){return host.exportState();}
function screen(id){if(id==='journal')id='approved-journal';document.querySelectorAll('.screen').forEach(e=>e.classList.toggle('active',e.id==='screen-'+id));const group={cgm:'home',injections:'journal',settings:'system','insulin-models':'analytics','injection-sites':'analytics',reports:'system',sync:'system',highlow:'home','approved-journal':'journal','approved-nutrition':'meals','approved-settings':'system','approved-low':'home','approved-high':'home','module-detail':'modules',research:'system'}[id]||id;document.querySelectorAll('#nav button').forEach(e=>e.classList.toggle('selected',e.dataset.screen===group));const names={home:'Главная',cgm:'Глюкоза',injections:'Инъекции',meals:'Продукты',journal:'Дневник',analytics:'Анализ',settings:'Настройки',system:'Ещё','insulin-models':'Инсулиновые модели','injection-sites':'Места инъекций',reports:'Отчёты',sync:'Синхронизация',highlow:'Высокий / низкий сахар','approved-nutrition':'Моя тарелка','approved-journal':'Дневник','approved-settings':'Настройки','approved-low':'Низкий сахар','approved-high':'Высокий сахар',modules:'Модули','module-detail':'Модуль',research:'Исследовательские модули'};$('pageTitle').textContent=names[id]||'Главная';document.body.dataset.activeScreen=id;window.scrollTo(0,0);render();globalThis.GPModuleUI?.refresh?.();setTimeout(broadcastApproved,0);}
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
 const p=activeSport(s),level=s.profile?.activityBaseLevel||'low';
 const pending=sportMenuOpen&&$('activityChoice').value==='sport';
 $('activityChoice').value=(p||pending)?'sport':level;
 $('sportStatus').textContent=p?'Идёт спорт':'';
 $('sportStatus').classList.toggle('running',Boolean(p));
 $('sportMenu').hidden=!sportMenuOpen;
 $('sportToggle').setAttribute('aria-expanded',String(sportMenuOpen));
 $('sportChevron').textContent=sportMenuOpen?'⌃':'⌄';
 $('sportControls').hidden=!sportMenuOpen;$('sportStart').hidden=!!p;$('sportFinish').hidden=!p;
 if(sportMenuOpen)showSportClock(s);
 const rows=all.rows.filter(r=>r.kind==='sport');
 $('approvedSportRows').innerHTML=rowsMarkup(rows,r=>eventMarkup(r.description,r.status==='active'?'Занятие продолжается':'Завершено · '+fmt(r.durationMinutes)+' мин',r.time),30);
}
function chooseActivity(value){
 if(activeSport(state())){
   $('activityChoice').value='sport';
   throw Error('Сначала завершите текущую тренировку');
 }
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
function cgmDisplayStatus(x){
 if(x.status==='OK'||(x.status==='OBSERVED_ONLY'&&Number.isFinite(x.reportedMmol))){
   const trend=GFCgmEvidencePolicy.forEvent(x,Date.parse(x.latestAt),{journal:GFJournal});
   const arrow=trend.direction||'—';
   const source=x.sourceStatus==='SYNTHETIC'?'ВЫМЫШЛЕННЫЕ ДАННЫЕ':x.sourceStatus==='XDRIP_LOCAL'?'Последнее показание xDrip+':'Источник '+x.sourceDeviceId;
   const modelNote=x.sourceStatus==='XDRIP_LOCAL'?' · пригодность для прогноза неизвестна':'';
   return {state:'fresh',text:source+' · измерено '+Math.floor(x.ageMinutes)+' мин назад'+modelNote,
     value:fmt(x.currentMmol??x.reportedMmol),arrow};
 }
 if(x.status==='STALE')return {state:'stale',text:'Последнее показание устарело · '+Math.floor(x.ageMinutes)+' мин назад',value:'—'};
 if(x.status==='OBSERVED_ONLY')return {state:'invalid',text:'xDrip+ не сообщил о свежести показания · '+Math.floor(x.ageMinutes)+' мин назад',value:'—'};
 return {state:'invalid',text:'Нет актуального показания CGM ('+x.code+')',value:'—'};
}
function renderCalculationEvidence(route,nowMs){
 const out=$('calcEvidence'+{low:'Low',high:'High',meal:'Meal'}[route]);
 if(!out||!host)return;
 let evidence;
 try{
   const cobOptions=globalThis.GFCOBStudyPanel?.optionsForRevision?.(host,nowMs)||{};
   evidence=GFCalculationEvidence.inspect({host,route,nowMs,activeMeal,cobOptions});
 }catch(error){
   console.error(error);
   evidence={blockers:[{code:'INPUT_READ_FAILED',message:'Не удалось прочитать согласованный снимок GFStorage.'}],trace:null};
 }
 GFCalculationEvidence.render(out,evidence);
}
function selectForecasts(evidence,nowMs){
 const g=port('graph'),data=g.getSnapshot(),prefs=data.graphPreferences;
 $('forecastGraphOptions').hidden=mode!=='local';
 $('forecastAutoConsensus').checked=prefs.autoConsensus!==false;
 for(const control of document.querySelectorAll('[data-model-visibility]')){
   control.checked=prefs.forecastVisibility?.[control.dataset.modelVisibility]!==false;
 }
 const allowed=mode==='local'&&evidence.status==='OK'&&evidence.sourceStatus==='DEVICE_DECLARED'&&
   evidence.revision===data.revision&&g.getRevision()===data.revision;
 return GFGraphFourLines.select({
   forecasts:allowed?data.forecasts:[],sourceId:evidence.sourceDeviceId,sourceTime:Date.parse(evidence.latestAt),
   nowMs,preferences:prefs,minimumSourceRevision:g.getForecastInputRevision(),
 });
}
function renderCgm(cgm,active,nowMs,journal){
 const screenId=document.body.dataset.activeScreen||'home';
 const evidence=GFCgmEvidencePolicy.inspect(host,{nowMs});
 const statusCgm=cgmDisplayStatus(evidence);
 $('homeGlucose').textContent=statusCgm.value;
 $('homeTrend').textContent=statusCgm.arrow||'—';
 $('homeCgmInfo').textContent=statusCgm.text;
 const name=active?.sourceType==='xdrip_local'?'xDrip+':active?.sourceType==='synthetic'?'Тестовый сенсор':active?.sourceDeviceId;
 $('cgmSource').textContent=name||'Нет источника';
 $('cgmMeta').textContent=active?name+' · '+cgm.length+' измерений · '+statusCgm.text:statusCgm.text;
 renderXdripStatus();
 if(screenId==='home'||screenId==='cgm'){
   const result=selectForecasts(evidence,nowMs);
   const legend=GFGraphFourLines.statusText(result);
   $('homeForecastLegend').textContent=legend;
   $('forecastGraphLegend').textContent=legend;
   if(screenId==='home'){
     const all=journal??GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter,{nowMs});
     GFMainScreenUI.draw({evidence,now:nowMs,timezone:all.zone,forecastLines:result.lines,actions:all.rows.slice(-30)});
   }else renderChart($('cgmDetailChart'),cgm,nowMs,24,result.lines);
 }
 if(screenId==='approved-nutrition')renderCalculationEvidence('meal',nowMs);
 if(screenId==='approved-low')globalThis.GFLOWView?.render();
 if(screenId==='approved-high')globalThis.GFHighTargetView?.render();
}
function renderInjectionMeals(sessions){
 const selector=$('injectionMeal'),selected=selector.value;
 $('injectionMealField').hidden=$('injectionDrug').value!=='rinfast';
 const options=[new Option('Без связи','')];
 for(const meal of sessions.filter(row=>GFInjectionFact.allowedStates.includes(row.status)).slice(-20).reverse()){
   const names=meal.actualPlate?.items??meal.plannedPlate?.items??[];
   const description=names.map(item=>item.name).join(', ');
   const label=formatAt(meal.startedAt??meal.createdAt)+' · '+(description||meal.id);
   options.push(new Option((meal.actualPlate?'Факт · ':'План · ')+label,meal.id));
 }
 selector.replaceChildren(...options);
 selector.value=options.some(el=>el.value===selected)?selected:'';
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
 renderCgm(cgm,active,renderNow,all);
 renderSport(s,all);
 GFMainScreenUI.renderSummary(GFMainScreenCore.summarize({
   journal:all,profile:s.profile,journalApi:GFJournal,nutritionRef:globalThis.GFNutritionReference,nowMs:renderNow,
 }));
 testJournal?.render(mode,active);
 renderInjectionMeals(s.mealSessions);
 $('injectionList').innerHTML=rowsMarkup(inj,e=>eventMarkup(e.insulinId==='rinfast'?'РинФаст':'Левемир',fmt(e.units)+' ЕД'+(e.injectionSite?' · '+e.injectionSite.region:''),formatAt(e.administeredAt)),15);
 let m=activeMeal?s.mealSessions.find(x=>x.id===activeMeal):null;if(!m){m=s.mealSessions.at(-1)||null;activeMeal=m?.id||null;}
 $('mealCurrent').innerHTML=m?'<div class="soft"><strong>ID:</strong> '+escape(m.id)+'<div><strong>Статус:</strong> '+escape(m.status)+'</div><div><strong>Углеводы по плану:</strong> '+fmt(m.plannedPlate?.totals?.carbs)+' г</div><div><strong>Углеводы фактически:</strong> '+(m.actualPlate?fmt(m.actualPlate.totals.carbs)+' г':'не подтверждено')+'</div></div>':'<div class="empty">Сначала создайте план</div>';
 $('mealReady').disabled=!m||m.status!=='draft';$('mealStart').disabled=!m||m.status!=='planned';$('mealFinish').disabled=!m||m.status!=='started'||!m.actualPlate;
 $('settingsTZ').value=s.profile.timeZone||'Europe/Minsk';const cr=GFCoefficientReview.evaluate({settingsPort:port('settings'),atIso:nowISO()});
 $('settingsInfo').textContent='Ревизия #'+s.revision+' · GFSettings v'+GFSettings.VERSION+' · хранилище schema '+host.getSchemaVersion()+(cr.conflicts.length?' · ВНИМАНИЕ: конфликтующих типов коэффициентов: '+cr.conflicts.length+'; выбор заблокирован':cr.legacyIntervals.length?' · Старые интервалы: '+cr.legacyIntervals.length+' требуют сверки с сеткой 4×6 ч':' · Единая сетка: 00–06 / 06–12 / 12–18 / 18–00; без назначения');
 $('storageInfo').textContent='GFStorage '+GFStorage.VERSION+' · схема '+s.schemaVersion+' · ревизий '+s.revision+' · записей CGM '+cgm.length+' · один общий экземпляр.';
 $('moduleTable').innerHTML='<div class="module-grid">'+MODULES.map(([name,detail,status])=>'<div class="module-row '+(status!=='on'?'pending':'')+'"><strong>'+escape(name)+'</strong><small>'+escape(detail)+'</small><span class="status">'+(status==='on'?'Подключён':status==='limited'?'Частично подключён':'Ожидает интеграции')+'</span></div>').join('')+'</div>';
 }catch(e){notify('Ошибка отображения: '+String(e.message||e),true);console.error(e);}}
function renderChart(out,readings,nowMs,hours,forecastLines){
 if(readings.length<2){
   out.textContent=readings.length?'Сохранено одно показание. Для графика нужны два.':'Нет сохранённых показаний CGM';
   out.classList.remove('full-chart');return;
 }
 try{
   const view=GPModuleHub.chart(host,{now:nowMs,hours,showInsulin:$('showRinfast').checked});
   if(view.svg){
     out.classList.add('full-chart');out.innerHTML=view.svg;
     const svg=out.querySelector('svg');
     for(const title of svg.querySelectorAll('[data-cgm-point] title')){
       title.textContent=title.textContent.replace(/ · демо$/,
         view.sourceStatus==='SYNTHETIC'?' · тестовое измерение':' · измерение');
     }
     GFGraphFourLines.overlay(svg,GPCgmWhiteChart,view.window,forecastLines);
     const note=document.createElement('div');
     note.className='hint';
     note.textContent='График А v0.2 · '+view.count+' точек CGM · '+view.shotCount+' схематических кривых. '+view.reason;
     out.appendChild(note);return;
   }
   out.classList.remove('full-chart');out.textContent='График недоступен: '+(view.reason||view.code||'нет достоверных данных');return;
 }catch(error){console.warn('CGM Chart v0.2 отказал:',error);}
 out.classList.remove('full-chart');out.textContent='График временно недоступен. Сохранённые данные остались в GFStorage.';
}
function runSafety(){lastSafety=GFCgmEvidencePolicy.checkSafety(host,bridge);const summary=lastSafety.status+' · '+(lastSafety.code?'Причина: '+lastSafety.code:'источник '+(lastSafety.forecastInputEligible?'прошёл технический контроль':'не допущен к прогнозу'))+' · назначения запрещены';$('analysisSafety').textContent=summary;notify('Техническая проверка завершена: '+lastSafety.status);render();}
function clearForecast(){
 $('forecastTrace').hidden=true;
 $('forecastValues').textContent='';
 $('analysisForecast').textContent='Выполните проверку для текущей ревизии данных.';
}
function recordDiagnostic(operation,revision,fields={}){
 const bridge=globalThis.AndroidDiagnostics;
 if(bridge&&Number.isSafeInteger(revision)&&revision>=0){
   try{bridge.record(mode,JSON.stringify({operation,sourceRevision:revision,...fields}));}
   catch{/* Diagnostics never roll back a result or a journal commit. */}
 }
}
async function runForecast(){
 const button=$('runForecastGate');
 if(button.disabled)return;
 button.disabled=true;
 clearForecast();
 const sourceHost=host,requestedMode=mode;
 const isCurrent=()=>sourceHost===host&&requestedMode===mode;
 try{
   const nowMs=Date.now(),safetyVerdict=GFCgmEvidencePolicy.checkSafety(host,bridge,{nowMs});
   const options=globalThis.GFCOBStudyPanel?.optionsForRevision?.(host,nowMs)||{};
   const result=await GFResearchForecastRun.run({host:sourceHost,mode:requestedMode,nowMs,safetyVerdict,isCurrent,
     foodHistoryDeclaration:options.historyDeclaration,mealCoverageRevision:options.mealCoverageRevision,
     kineticsByMealId:options.kineticsByMealId});
   if(!isCurrent())return;
   const engineStatuses=(result.engines||[]).map(({modelId,status,code,details})=>({modelId,status,code,details}));
   const lead=result.engines?.find(x=>x.modelId==='GFForecast');
   recordDiagnostic('forecast_attempt',result.sourceRevision??host.diagnostics().revision,{
     status:lead?.status??result.status,code:lead?.code??result.code,
     modelId:'GFForecast',modelVersion:GFForecast.VERSION,
     measuredAt:lead?.row?.payload.sourceTime,receivedAt:lead?.row?.payload.sourceReceivedAt,
     formula:lead?.row?'GFFORECAST_V01':null,baselineMmol:lead?.summary?.baselineMmol,
     slopeMmolMin:lead?.summary?.observedSlopeMmolPerMin,points:lead?.row?.payload.points,
   });
   for(const alternate of result.engines?.filter(x=>x.modelId!=='GFForecast')??[]){
     recordDiagnostic('forecast_attempt',result.sourceRevision??host.diagnostics().revision,{
       status:alternate.status,code:alternate.code,modelId:alternate.modelId,
       modelVersion:alternate.row?.payload.modelVersion,measuredAt:alternate.row?.payload.sourceTime,
       receivedAt:alternate.row?.payload.sourceReceivedAt,points:alternate.row?.payload.points,
     });
   }
   $('analysisForecast').textContent=result.status==='ARCHIVED'?
     'Исследовательские прогнозы сохранены. Ревизия входа '+result.sourceRevision+'.':
     (result.reason||'Данных для сохранения прогноза недостаточно')+' ('+result.code+').';
   $('forecastTrace').hidden=false;
   $('forecastValues').textContent=JSON.stringify({движки:engineStatuses,выборПрогноза:result.consensus,модельПитания:result.mealModel,состояниеДанныхЕды:result.foodCode,коэффициенты:result.coefficients,
     прогнозы:result.engines?.filter(x=>x.row).map(x=>({источник:x.summary,ряд:x.row.payload}))},null,2);
 }catch(error){
   if(isCurrent())$('analysisForecast').textContent='Ошибка подготовки прогноза ('+String(error.message||error)+').';
 }finally{button.disabled=false;}
}
function clearResearchReviews(){
 $('basalReviewStatus').textContent='Обзор выполняется по нажатию.';
 $('basalReviewTrace').textContent='';
 $('basalReviewDetails').hidden=true;
 $('consensusReviewStatus').textContent='Проверка текущей ревизии ещё не запускалась.';
}
function runBasalReview(){
 const result=GFLevemirReview.inspect(host,Number($('basalReviewPeriod').value));
 const reason=result.code==='FORMULA_SPEC_GAP'?'Формула оценки дозы не утверждена.':
   result.code==='INSUFFICIENT_HISTORY'?'Недостаточно пригодных окон CGM.':'Снимок неполный ('+result.code+').';
 $('basalReviewStatus').textContent='Расчёт дозы недоступен. '+reason;
 const groups=result.sections;
 if(groups){
   const lines=['GFStorage · ревизия '+result.sourceRevision+' · '+result.days+' дн. · '+result.timezone];
   for(const [name,key] of [['Утро','morning'],['Вечер','evening']]){
     const group=groups[key];
     lines.push(name+' · последняя подтверждённая доза '+(group.lastConfirmedUnits==null?'неизвестна':group.lastConfirmedUnits+' ЕД'));
     lines.push('Пригодных окон '+group.eligibleWindows+' · медиана изменений CGM '+fmt(group.observedMedianDelta,2)+' ммоль/л');
     for(const window of group.windows)lines.push(window.startedAt+' – '+window.endedAt+
       (window.issues.length?' · '+window.issues.join(', '):' · ΔCGM '+fmt(window.observedDelta,2))+
       (window.possibleBasalOverlap?' · возможное перекрытие базального действия':''));
   }
   $('basalReviewTrace').textContent=lines.join('\n');
 }
 $('basalReviewDetails').hidden=!groups;
 recordDiagnostic('basal_review',result.sourceRevision,{modelId:'GFLevemirReview',modelVersion:result.version,
   status:result.status,code:result.code,formula:result.model,
   eligibleWindows:groups?groups.morning.eligibleWindows+groups.evening.eligibleWindows:null});
}
function runConsensusReview(){
 const previous=mode==='local'?GFConsensusReview.archiveAssessment(host):null;
 const result=GFConsensusEvidence.history(host);
 const counts=(result.results||[]).map(row=>row.horizon+' мин: '+row.n+' пар').join(' · ');
 const leader=result.leader?' · '+result.leader:'';
 $('consensusReviewStatus').textContent='GFConsensus · '+result.status+leader+
   (result.reason?' · '+result.reason:'')+(counts?' · '+counts:'')+
   (previous?.archived?' · сохранено сверок: '+previous.archived:'');
}
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
function xdripEnabled(){return mode==='local'&&readPreference(XDRIP_KEY)==='on';}
function renderXdripStatus(){
 $('refreshXdrip').disabled=!xdripEnabled();
 $('xdripStatus').textContent=xdripEnabled()?xdripStatus||'Поиск локального источника':'Чтение выключено';
}
const XDRIP_STATUS=Object.freeze({
 READING:'Запрос показания',NO_PROVIDER:'Локальный ContentProvider xDrip+ не найден',
 NO_MEASUREMENT:'Нет показания. Проверьте включение Content Provider в xDrip+ и наличие данных.',
 OBSERVED:'Показание передано в GFStorage',STALE:'Источник считает показание устаревшим',
 FRESHNESS_UNKNOWN:'Источник не указал свежесть показания',PROVIDER_TIMEOUT:'xDrip+ не ответил вовремя',
 INVALID_MEASUREMENT:'xDrip+ вернул некорректное показание или время',
 UNEXPECTED_PROVIDER:'Пакет источника отличается от xDrip+',PROVIDER_READ_FAILED:'Ошибка чтения xDrip+',
 UNAVAILABLE:'Нет доступа к локальному источнику'
});
function acceptXDrip(raw){
 if(!xdripEnabled()||document.hidden)return;
 try{
   const result=GFProviderCgm.ingest(host,mode,JSON.parse(raw));
   xdripStatus=XDRIP_STATUS[result.status]||'Неизвестный ответ xDrip+';
 }catch(error){
   xdripStatus='GFStorage отклонил наблюдение ('+String(error.message||error)+')';
 }
 renderXdripStatus();
}
function requestXDrip(){
 const source=globalThis.GFNativeXDrip;
 if(!host||!source||!xdripEnabled()||document.hidden)return;
 acceptXDrip(source.pollLatest());
 clearTimeout(xdripTimer);
 xdripTimer=setTimeout(()=>acceptXDrip(source.peekLatest()),1100);
}
function setFileOperation(next){
 fileOperation=next;
 $('saveBackup').disabled=!!next;
 $('openBackup').disabled=!!next;
 $('exportState').disabled=!!next;
 $('saveAiExport').disabled=!!next;
}
function saveAiExport(){
 if(fileOperation)return;
 setFileOperation({mode,kind:'ai'});
 $('aiExportStatus').textContent='Выберите локальный файл для выгрузки.';
 try{AndroidExporter.saveAiExport(mode,$('aiExportPeriod').value);}
 catch{
   $('aiExportStatus').textContent='Не удалось открыть системный выбор файла.';
   setFileOperation(null);
 }
}
async function saveBackup(){
 if(fileOperation)return;
 setFileOperation({mode,read:false});
 try{
   const data=await GFJournalBackup.create(mode,state(),GFStorage);
   $('backupStatus').textContent='Выберите файл для сохранения.';
   AndroidExporter.saveBackup(data);
 }catch(error){fileFailure(error);}
}
function openBackup(){
 if(fileOperation)return;
 setFileOperation({mode,read:true});
 $('backupStatus').textContent='Выберите файл резервной копии.';
 AndroidExporter.openBackup();
}
function fileFailure(error){
 const code=String(error.message||error);
 const messages={
  BACKUP_TARGET_EXISTS:'Журнал уже содержит сохранённые данные. Восстановление остановлено.',
  BACKUP_MODE_MISMATCH:'Копия принадлежит другому режиму.',
  BACKUP_CHECKSUM_MISMATCH:'Контрольная сумма отличается. Копия повреждена.',
  BACKUP_INVALID_JSON:'Файл не содержит корректный JSON.',
  BACKUP_FORMAT:'Файл не является поддерживаемой резервной копией.'
 };
 $('backupStatus').textContent=messages[code]||'Операция с файлом не завершена ('+code+').';
 setFileOperation(null);
}
async function consumeFileResult(){
 const raw=globalThis.AndroidExporter?.takeFileResult?.();
 if(!raw)return;
 try{
   const result=JSON.parse(raw),operation=fileOperation;
   if(result.aiExport){
     setFileOperation(null);
     $('aiExportStatus').textContent=result.status==='FILE_SAVED'?'Выгрузка сохранена':
       result.status==='FILE_CANCELLED'?'Выгрузка отменена':'Выгрузка не завершена ('+result.status+')';
     return;
   }
   if(result.report){
     setFileOperation(null);
     notify(result.status==='FILE_SAVED'?'Аналитический отчёт сохранён':
       result.status==='FILE_CANCELLED'?'Экспорт отменён':'Экспорт не завершён ('+result.status+')',
       !['FILE_SAVED','FILE_CANCELLED'].includes(result.status));
     return;
   }
   if(!operation)return;
   if(result.status==='FILE_CANCELLED')$('backupStatus').textContent='Операция отменена.';
   else if(result.status==='FILE_SAVED'&&!operation.read)$('backupStatus').textContent='Резервная копия сохранена.';
   else if(result.status==='FILE_READ'&&operation.read){
     const verified=await GFJournalBackup.verify(result.data,operation.mode,GFStorage);
     if(verified.mode!==mode)throw Error('BACKUP_MODE_MISMATCH');
     if(confirm('Восстановить резервную копию в пустой журнал? Ревизия '+verified.snapshot.revision+'.')){
       GFJournalBackup.importEmpty(GFNativeStorage,dbKey(),verified);
       boot();
       $('backupStatus').textContent='Журнал восстановлен. Ревизия '+verified.snapshot.revision+'.';
     }else $('backupStatus').textContent='Восстановление отменено.';
   }else throw Error(result.status);
   setFileOperation(null);
 }catch(error){fileFailure(error);}
}
function setupLocalFilesAndSource(){
 $('xdripEnabled').addEventListener('change',wrap(e=>{
   if(mode!=='local')return;
   savePreference(XDRIP_KEY,e.target.checked?'on':'off');
   xdripStatus='';
   renderXdripStatus();
   requestXDrip();
 }));
 $('refreshXdrip').addEventListener('click',wrap(requestXDrip));
 $('saveBackup').addEventListener('click',saveBackup);
 $('saveAiExport').addEventListener('click',saveAiExport);
 $('openBackup').addEventListener('click',wrap(openBackup));
 document.addEventListener('visibilitychange',wrap(requestXDrip));
}
function wrap(fn){return e=>{try{fn(e);}catch(ex){console.error(ex);notify(String(ex.message||ex),true);}};}
function submitInjection(event){
 event.preventDefault();
 if(!$('injectionConfirm').checked)throw Error('Нужно подтвердить выполненную инъекцию');
 const units=numericField('injectionUnits'), time=new Date($('injectionTime').value);
 if(units<=0||Math.abs(units*2-Math.round(units*2))>1e-8)throw Error('Доза должна быть положительной и кратной 0,5 ЕД');
 if(!Number.isFinite(time.getTime()))throw Error('Неверное время');
 if(time.getTime()>Date.now()+60000)throw Error('Факт инъекции не может быть в будущем');
 const item={id:uid('inj'),insulinId:$('injectionDrug').value,units,administeredAt:time.toISOString()};
 const region=$('injectionRegion').value,side=$('injectionSide').value;
 if(region)item.injectionSite={region,...(side?{side}:{})};
 const mealId=item.insulinId==='rinfast'?$('injectionMeal').value:null;
 GFInjectionFact.record({host,item,mealId,confirmed:true,revision:port('actionWriter').getRevision()});
 $('injectionForm').reset();$('injectionTime').value=localInputTime();$('basalEntryContext').hidden=true;
 notify('Фактическая инъекция записана один раз');
 render();
}
function setupEvents(){
 for(const control of document.querySelectorAll('[data-model-visibility]'))control.addEventListener('change',wrap(()=>{
   const g=port('graph'), snapshot=g.getSnapshot();
   g.setPreferences({forecastVisibility:{...snapshot.graphPreferences.forecastVisibility,
     [control.dataset.modelVisibility]:control.checked}},snapshot.revision);
 }));
 $('forecastAutoConsensus').addEventListener('change',wrap(e=>{
   const g=port('graph');g.setPreferences({autoConsensus:e.target.checked},g.getRevision());
 }));
 $('runBasalReview').addEventListener('click',wrap(runBasalReview));
 $('basalReviewPeriod').addEventListener('change',clearResearchReviews);
 $('runConsensusReview').addEventListener('click',wrap(runConsensusReview));
 $('sportToggle').addEventListener('click',wrap(()=>{sportMenuOpen=!sportMenuOpen;render();}));
 $('activityChoice').addEventListener('change',wrap(e=>chooseActivity(e.target.value)));$('sportStart').addEventListener('click',wrap(startSport));$('sportFinish').addEventListener('click',wrap(finishSport));document.querySelectorAll('[data-screen]').forEach(b=>b.addEventListener('click',()=>screen(({journal:'approved-journal',meals:'approved-nutrition',settings:'approved-settings','meal-workflow':'meals'})[b.dataset.screen]||b.dataset.screen)));$('openLow').addEventListener('click',()=>{screen('approved-low');});$('openHigh').addEventListener('click',()=>{screen('approved-high');});$('openBasalQuick').addEventListener('click',()=>{ $('injectionForm').reset(); $('injectionDrug').value='levemir'; $('injectionTime').value=localInputTime(); $('basalEntryContext').hidden=false; screen('injections'); setTimeout(()=>{ $('injectionUnits').focus(); },0); });$('injectionDrug').addEventListener('change',()=>{if($('injectionDrug').value!=='levemir')$('basalEntryContext').hidden=true;renderInjectionMeals(state().mealSessions);});$('runSafety').addEventListener('click',wrap(runSafety));$('runHighLow').addEventListener('click',wrap(()=>{const a=GFHighLowReadOnly.connect(host).analyze();$('analysisHighLow').textContent='Статус: '+a.status+'; эпизодов: '+(a.episodes?.length||0)+'; только наблюдения, без записей и рекомендаций.';}));$('runCoefficients').addEventListener('click',wrap(()=>{const x=GFCoefficients.createService({researchPort:port('research')}).run({asOfIso:nowISO(),windowDays:7});$('analysisCoefficients').textContent='Уколов: '+x.statistics.confirmedInjections+'; подтверждённых приёмов еды: '+x.statistics.meals+'; совпавших пар: '+x.statistics.mealPairs+'. '+(x.flags[0]||'Аналитика носит исследовательский характер.');}));$('runForecastGate').addEventListener('click',wrap(()=>{runForecast();}));$('settingsForm').addEventListener('submit',wrap(e=>{e.preventDefault();settingsService.saveProfile({timeZone:$('settingsTZ').value},port('settings').getRevision());notify('Часовой пояс сохранён через GFSettings');}));$('injectionForm').addEventListener('submit',wrap(submitInjection));for(const [id,method]of [['mealReady','ready'],['mealStart','start'],['mealFinish','finish']])$(id).addEventListener('click',wrap(()=>doMeal(method)));$('exportState').addEventListener('click',wrap(()=>{const data=GFAuditExportStorageAdapter.exportJson(host);if(globalThis.AndroidExporter&&typeof globalThis.AndroidExporter.saveJson==='function'){setFileOperation({mode,read:false});globalThis.AndroidExporter.saveJson(data);return;}const blob=new Blob([data],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ГлюкоПапа_V2_'+mode+'_rev'+host.diagnostics().revision+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500);notify('Сформирован аналитический JSON (не полноценная резервная копия)');}));}

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
 const id=uid('meal');controller.createFromFood(p,id);activeMeal=id;if(document.body.dataset.activeScreen==='approved-nutrition')renderCalculationEvidence('meal',Date.now());$('approvedPlateStatus').textContent='План зарегистрирован: '+id+' · '+p.items.length+' позиций. Для отметки фактически съеденного откройте «План / факт еды». Подтверждённый план не считается съеденным.';notify('Моя тарелка v0.4.6 передана в GFStorage: '+id);}
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

try{
testJournal?.setup({
  change(next){
    if(next===mode)return;
    if(fileOperation)throw Error('Дождитесь завершения операции с файлом');
    boot(next);
  },
  reload:()=>boot(), port, current:()=>mode, wrap, notify,
});
setupEvents();setupLocalFilesAndSource();watchPlateDialog();$('showRinfast').addEventListener('change',wrap(refreshClockDisplays));setInterval(wrap(()=>{refreshClockDisplays();requestXDrip();}),15000);$('injectionTime').value=localInputTime();boot(testJournal?.initialMode(readPreference(MODE_KEY))||'local');}catch(e){console.error(e);document.body.insertAdjacentHTML('afterbegin','<div class="shell-boot-error" role="alert"><h2>Не удалось открыть оболочку</h2><pre>'+escape(String(e.message||e))+'</pre><p>Данные не очищены. Сохраните исходный журнал и обратитесь к техническому отчёту.</p></div>');}
globalThis.GPApp=Object.freeze({version:VER,getStorage:()=>host,mode:()=>mode,getModuleStatuses:()=>MODULES.map(x=>x.slice()),open:screen,consumeFileResult});
})();
