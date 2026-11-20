/* ГлюкоПапа V2 · оболочка v0.3.12-stage10 (directory order / CGM freshness). UI orchestration only.
 * Shared host: exactly one GFStorage instance.
 * No dose recommendation, no remote calls, no duplicate storage schema.
 */
(() => {
'use strict';
const VER='0.3.18-qa', MODE_KEY='GFV2SHELL_MODE_v1', DATA_PREFIX='GFV2SHELL_DATA_v1_';
const XDRIP_KEY='GFV2SHELL_XDRIP_LOCAL_v1', XDRIP_SOURCE_KEY='GFV2SHELL_XDRIP_SOURCE_v1';
const $=id=>document.getElementById(id), escape=s=>String(s===null||s===undefined?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('ru-RU',{maximumFractionDigits:d}):'—';
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
const nowISO=()=>new Date().toISOString();
const localInputTime=(d=new Date())=>new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
const testJournal=globalThis.GFTestJournal;
let mode='local',host=null,unsub=null,controller=null,bridge=null,settingsService=null,activeMeal=null,lastSafety=null,noticeTimer=null,sportMenuOpen=false;
let fileOperation=null,xdripStatus='',xdripRequest=null,xdripHistoryRequest=null,nextXDripWindow=0;
const routes=[],foodRoutes=[];
let returningInsideFood=false, captureForInjection=false;
let mealWorkflowDoc=null, mealWorkflowView=null;
let approvedQuickFoodSource;
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
 if(approvedQuickFoodSource)nextHost.bindApprovedQuickFoods(approvedQuickFoodSource);
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
 $('xdripHistoryControls').hidden=!globalThis.GFNativeXDripHistory;
 $('xdripEnabled').checked=xdripEnabled();
 $('xdripSourceMode').value=xdripSourceMode();
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
function screen(id,back=false){
 if(id==='journal')id='approved-journal';
 if(!$('screen-'+id))return;
 const from=document.body.dataset.activeScreen||'home';
 if(!back&&id!==from){
   if(routes.at(-1)?.id===id)routes.pop();
   else routes.push({id:from,scroll:window.scrollY});
 }document.querySelectorAll('.screen').forEach(e=>e.classList.toggle('active',e.id==='screen-'+id));const group={cgm:'home',injections:'journal',settings:'system','insulin-models':'analytics','injection-sites':'analytics',reports:'system',sync:'modules',highlow:'home','approved-journal':'journal','approved-nutrition':'meals','approved-meal':'meals','approved-settings':'system','approved-low':'home','approved-high':'home','module-detail':'modules',about:'modules',research:'modules'}[id]||id;document.querySelectorAll('#nav button').forEach(e=>e.classList.toggle('selected',e.dataset.screen===(group==='analytics'?'coefficients':group==='system'?'approved-settings':group)));const names={home:'Главная',cgm:'Глюкоза',injections:'Инъекции',meals:'Продукты',journal:'Дневник',analytics:'Техническая диагностика',coefficients:'Коэффициенты',settings:'Настройки',system:'Ещё','insulin-models':'Инсулиновые модели','injection-sites':'Места инъекций',reports:'Отчёты',sync:'Синхронизация телефонов',about:'О программе',highlow:'Высокий / низкий сахар','approved-nutrition':'Моя тарелка','approved-meal':'Инсулин и приём пищи','approved-journal':'Дневник','approved-settings':'Настройки','approved-low':'Низкий сахар','approved-high':'Высокий сахар',modules:'Модули','module-detail':'Модуль',research:'Исследовательские модули'};$('pageTitle').textContent=names[id]||'Главная';document.body.dataset.activeScreen=id;window.scrollTo(0,0);render();if(id==='coefficients')renderCoefficients();globalThis.GPModuleUI?.refresh?.();setTimeout(broadcastApproved,0);}
function back(){
 const active=document.body.dataset.activeScreen||'home';
 if(active==='approved-meal'&&mealWorkflowDoc?.getElementById('editPanel')?.hidden===false){
   mealWorkflowDoc.getElementById('cancelActual').click();return true;
 }
 if(active==='approved-nutrition'){
   const peer=approvedPeer('nutrition')?.peer, frame=peer?.document;
   if(frame?.getElementById('foodModal')?.classList.contains('on')){
     frame.getElementById('modalClose').click(); return true;
   }
   const pantry=frame?.getElementById('pantryModal');
   if(pantry?.open){pantry.close();return true;}
   const foodRoute=foodRoutes.pop();
   if(foodRoute&&peer?.GFFoodDemo){
     returningInsideFood=true;
     try{
       peer.GFFoodDemo.setTab(foodRoute.tab);
       if(foodRoute.tab==='restaurants'){
         const places=[...frame.querySelectorAll('[data-venue]')];
         if(foodRoute.venue==='*')frame.getElementById('showAllVenues').click();
         else places.find(node=>node.dataset.venue===foodRoute.venue)?.click();
         [...frame.querySelectorAll('[data-venuecat]')].find(node=>node.dataset.venuecat===foodRoute.category)?.click();
         const search=frame.getElementById('restaurantSearch');
         search.value=foodRoute.query;
         search.dispatchEvent(new Event('input',{bubbles:true}));
       }
       requestAnimationFrame(()=>{peer.scrollTo(0,foodRoute.frameScroll);window.scrollTo(0,foodRoute.shellScroll);});
     }finally{returningInsideFood=false;}
     return true;
   }
 }
 const previous=routes.pop();
 if(!previous)return false;
 screen(previous.id,true);
 requestAnimationFrame(()=>window.scrollTo(0,previous.scroll));
 return true;
}
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
 const summary=$('approvedSportRows');
 if(!summary)return;
 summary.innerHTML=rowsMarkup(rows,r=>eventMarkup(r.description,r.status==='active'?'Занятие продолжается':'Завершено · '+fmt(r.durationMinutes)+' мин',r.time),30);
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
 const restored=cgm.filter(GFStorage.isXDripHistory).length;
 $('cgmMeta').textContent=active?name+' · '+cgm.length+' измерений · '+statusCgm.text+
   (restored?' · Web Service: '+restored+' точек истории':''):statusCgm.text;
 renderXdripStatus();
 if(screenId==='home'||screenId==='cgm'){
   const result=selectForecasts(evidence,nowMs);
   const legend=GFGraphFourLines.statusText(result);
   $('homeForecastLegend').textContent=legend;
   $('forecastGraphLegend').textContent=legend;
   if(screenId==='home'){
     const all=journal??GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter,{nowMs});
     GFMainScreenUI.draw({evidence:{...evidence,readings:evidence.timelineReadings},
       now:nowMs,timezone:all.zone,forecastLines:result.lines,actions:all.rows.slice(-30)});
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
 renderMealWorkflow();
 const s=state(),all=GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter,{nowMs:renderNow}),cgm=s.cgm||[],active=s.cgmMetadata,inj=s.events.filter(e=>e.type==='insulin_injection'&&e.status==='confirmed');
 $('revBadge').textContent='База #'+s.revision;
 $('aboutVersion').textContent=VER;
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
function xdripSourceMode(){return readPreference(XDRIP_SOURCE_KEY)||'auto';}
function renderXdripStatus(){
 $('refreshXdrip').disabled=!xdripEnabled()||!!xdripRequest;
 $('xdripSourceMode').disabled=!xdripEnabled();
 $('restoreXdripHistory').disabled=!xdripEnabled()||!!xdripHistoryRequest||!!xdripRequest;
 $('xdripStatus').textContent=xdripEnabled()?xdripStatus||'Поиск локального источника':'Чтение выключено';
}
const XDRIP_STATUS=Object.freeze({
 READING:'Запрос показания',NO_PROVIDER:'Локальный ContentProvider xDrip+ не найден',
 NO_MEASUREMENT:'Нет показания. Проверьте включение Content Provider в xDrip+ и наличие данных.',
 OBSERVED:'Показание передано в GFStorage',STALE:'Источник считает показание устаревшим',
 FRESHNESS_UNKNOWN:'Источник не указал свежесть показания',PROVIDER_TIMEOUT:'xDrip+ не ответил вовремя',
 INVALID_MEASUREMENT:'xDrip+ вернул некорректное показание или время',
 UNEXPECTED_PROVIDER:'Пакет источника отличается от xDrip+',PROVIDER_READ_FAILED:'Ошибка чтения xDrip+',
 PROVIDER_ACCESS_DENIED:'Доступ к ContentProvider отклонён настройками или разрешениями xDrip+',
 UNAVAILABLE:'Нет доступа к локальному источнику'
});
function acceptXDrip(reply){
 return GFProviderCgm.ingest(host,mode,reply);
}
const WEB_STATUS=Object.freeze({
 HISTORY_UNAVAILABLE:'Web Service выключен или недоступен',
 HISTORY_EMPTY:'Web Service не вернул показаний',
 HISTORY_INVALID:'Некорректные время, единицы или формат Web Service',
 HISTORY_HTTP_ERROR:'Web Service отклонил запрос',
 HISTORY_TOO_LARGE:'Ответ Web Service превышает допустимый размер',
 HISTORY_TIMEOUT:'Web Service не ответил вовремя',
 HISTORY_BUSY:'Web Service занят другим запросом',
 WEB_FUTURE_MEASUREMENT:'Время показания Web Service находится в будущем',
});
function xdripClockError(reply){
 if(!Number.isSafeInteger(reply?.measuredAtMs)||!Number.isSafeInteger(reply?.receivedAtMs))return '';
 const ahead=Math.ceil((reply.measuredAtMs-reply.receivedAtMs)/1000);
 if(ahead<=0)return '';
 const measured=new Date(reply.measuredAtMs).toLocaleString('ru-RU');
 const received=new Date(reply.receivedAtMs).toLocaleString('ru-RU');
 return ' · измерено '+measured+' · получено '+received+' · опережение '+ahead+' с';
}
function requestXDrip(forceWindow=false){
 const provider=globalThis.GFNativeXDrip, web=globalThis.GFNativeXDripHistory;
 if(!host||!xdripEnabled()||document.hidden||xdripRequest||xdripHistoryRequest||(!provider&&!web))return;
 const sourceMode=xdripSourceMode(), request={host};
 xdripRequest=request;
 xdripStatus='Получаем показание xDrip+…';
 renderXdripStatus();
 function current(){return request===xdripRequest&&request.host===host&&xdripEnabled()&&!document.hidden;}
 function end(message){
   if(!current())return;
   xdripRequest=null;
   xdripStatus=message;
   renderXdripStatus();
 }
 function formatObservation(packet,outcome,channel){
   const value=fmt(packet.mgdl/18.01559), measured=new Date(packet.measuredAtMs).toLocaleString('ru-RU');
   const received=new Date(packet.receivedAtMs).toLocaleTimeString('ru-RU');
   const state={OBSERVED:'Показание',STALE:'Устаревшее показание',FRESHNESS_UNKNOWN:'Свежесть не подтверждена'}[outcome.status];
   return channel+' · '+state+' '+value+' ммоль/л · измерено '+measured+' · получено '+received;
 }
 function save(packet,channel,reason=''){
   try{end(formatObservation(packet,acceptXDrip(packet),channel)+(reason?' · '+reason:''));}
   catch(error){end(channel+' · '+(error.message==='CGM_XDRIP_CONFLICT'?
     'Значение расходится с сохранённым измерением. Новая запись отклонена.':'Не удалось сохранить показание в журнале.'));}
 }
 function fromProvider(reason=''){
   const prefix=reason?reason+' · ':'';
   if(!provider){end(prefix+'ContentProvider недоступен');return;}
   xdripStatus=prefix+'Запрос ContentProvider…';
   renderXdripStatus();
   const until=performance.now()+5400;
   provider.pollLatest();
   function poll(){
     if(!current())return;
     const reply=JSON.parse(provider.peekLatest());
     if(reply.status==='READING'&&performance.now()<until){setTimeout(poll,250);return;}
     if(reply.status==='MEASUREMENT'){save(reply,'ContentProvider',reason);return;}
     end(prefix+(XDRIP_STATUS[reply.status==='READING'?'PROVIDER_TIMEOUT':reply.status]||
       'ContentProvider не вернул показание.')+xdripClockError(reply));
   }
   setTimeout(poll,250);
 }
 function failedWeb(reply,window){
   const reason=(WEB_STATUS[reply.status]||HISTORY_STATUS[reply.status]||'Локальный Web Service недоступен')+xdripClockError(reply);
   if(window)$('xdripHistoryStatus').textContent=reason;
   if(sourceMode==='auto')fromProvider(reason);
   else end(reason);
 }
 function saveWindow(reply){
   try{
     const outcome=GFProviderCgm.ingestWindow(host,mode,reply);
     const skipped=reply.futureCount?' · пропущено будущих: '+reply.futureCount+
       xdripClockError({measuredAtMs:reply.futureMeasuredAtMs,receivedAtMs:reply.latest.receivedAtMs}):'';
     $('xdripHistoryStatus').textContent='Точек истории добавлено: '+outcome.historyAdded+skipped;
     if(reply.latest.stale&&sourceMode==='auto')fromProvider('Последнее допустимое показание Web Service устарело'+skipped);
     else end(formatObservation(reply.latest,outcome,'Локальный Web Service')+skipped);
   }catch(error){
     failedWeb({status:HISTORY_STATUS[error.message]?error.message:'HISTORY_WRITE_FAILED'},true);
   }
 }
 function fromWeb(window){
   if(!web?.requestLatest){failedWeb({status:'HISTORY_UNAVAILABLE'},window);return;}
   if(window)nextXDripWindow=performance.now()+60000;
   const start=JSON.parse(window?web.requestWindow():web.requestLatest());
   if(start.status!=='HISTORY_FETCHING'){failedWeb(start,window);return;}
   const until=performance.now()+5400;
   function pollWeb(){
     if(!current())return;
     const raw=window?web.take():web.takeLatest();
     if(!raw){
       if(performance.now()<until)setTimeout(pollWeb,250);
       else failedWeb({status:'HISTORY_TIMEOUT'},window);
       return;
     }
     const reply=JSON.parse(raw);
     if(reply.status==='WEB_WINDOW_READY'&&window){saveWindow(reply);return;}
     if(reply.status==='MEASUREMENT'){
       if(reply.stale&&sourceMode==='auto')fromProvider('Показание Web Service устарело');
       else save(reply,'Локальный Web Service');
       return;
     }
     if(reply.status==='WEB_FUTURE_MEASUREMENT'&&!window&&web.requestWindow&&performance.now()+45000>=nextXDripWindow){
       fromWeb(true);
       return;
     }
     failedWeb(reply,window);
   }
   setTimeout(pollWeb,250);
 }
 if(sourceMode==='provider')fromProvider();
 else fromWeb(!!web?.requestWindow&&(forceWindow===true||performance.now()>=nextXDripWindow));
}
const HISTORY_STATUS=Object.freeze({
 HISTORY_NEEDS_PROVIDER:'Сначала получите показание через ContentProvider xDrip+.',
 HISTORY_BUSY:'Предыдущий запрос истории ещё выполняется.',
 HISTORY_DISABLED:'Включите чтение показаний xDrip+.',
 HISTORY_EMPTY:'Web Service не вернул показаний.',
 HISTORY_UNAVAILABLE:'Локальный Web Service xDrip+ недоступен. Проверьте его настройку в xDrip+.',
 HISTORY_HTTP_ERROR:'Web Service отклонил запрос истории.',
 HISTORY_TIMEOUT:'Web Service не ответил вовремя.',
 HISTORY_INVALID:'Показания Web Service имеют неподдерживаемый формат.',
 HISTORY_TOO_LARGE:'Ответ Web Service превышает допустимый размер.',
 HISTORY_ANCHOR_MISMATCH:'Показание ContentProvider не совпало с Web Service. Обновите источник и повторите.',
 HISTORY_CONFLICT:'В истории Web Service есть противоречащие точки.',
 CGM_XDRIP_HISTORY_ANCHOR:'Контрольное показание изменилось. Обновите источник и повторите.',
 CGM_XDRIP_HISTORY_CONFLICT:'История расходится с сохранёнными показаниями.',
 HISTORY_WRITE_FAILED:'История CGM не сохранена. Проверьте доступность журнала.',
});
function finishXDripHistory(text) {
 xdripHistoryRequest=null;
 $('xdripHistoryStatus').textContent=text;
 renderXdripStatus();
}
function restoreXDripHistory(){
 const source=globalThis.GFNativeXDripHistory, provider=globalThis.GFNativeXDrip;
 if(!source||!host||!xdripEnabled()||document.hidden||xdripHistoryRequest||xdripRequest)return;
 if(xdripSourceMode()!=='provider'&&source.requestWindow){requestXDrip(true);return;}
 if(!provider)return;
 const request={host,deadline:performance.now()+5500};
 xdripHistoryRequest=request;
 $('xdripHistoryStatus').textContent='Получаем контрольное показание ContentProvider…';
 renderXdripStatus();
 function current(){
   if(xdripHistoryRequest!==request)return false;
   if(request.host===host&&xdripEnabled()&&!document.hidden)return true;
   finishXDripHistory('Импорт истории прерван.');
   return false;
 }
 function check(){
   if(!current())return;
   try{
     const raw=source.take();
     if(!raw){
       if(performance.now()<request.deadline){setTimeout(check,250);return;}
       finishXDripHistory(HISTORY_STATUS.HISTORY_TIMEOUT);
       return;
     }
     const outcome=GFProviderCgm.ingestHistory(host,mode,JSON.parse(raw));
     finishXDripHistory(outcome.status==='HISTORY_IMPORTED'?
       (outcome.added?'Добавлено точек истории: '+outcome.added+'.':'В журнале уже есть все полученные точки.') :
       HISTORY_STATUS[outcome.status]||'История CGM недоступна.');
   }catch(error){
     finishXDripHistory(HISTORY_STATUS[error.message]||'История не сохранена. Проверьте доступность журнала.');
   }
 }
 function findAnchor(){
   if(!current())return;
   const observation=JSON.parse(provider.peekLatest());
   if(observation.status==='READING'&&performance.now()<request.deadline){setTimeout(findAnchor,250);return;}
   if(observation.status!=='MEASUREMENT'){
     finishXDripHistory(HISTORY_STATUS.HISTORY_NEEDS_PROVIDER);
     return;
   }
   try{acceptXDrip(observation);}
   catch(error){finishXDripHistory('Контрольное показание ContentProvider отклонено: '+error.message);return;}
   const reply=JSON.parse(source.request());
   if(reply.status!=='HISTORY_FETCHING'){
     finishXDripHistory(HISTORY_STATUS[reply.status]||'История CGM недоступна.');
     return;
   }
   request.deadline=performance.now()+7000;
   $('xdripHistoryStatus').textContent='Получаем историю CGM…';
   setTimeout(check,250);
 }
 provider.pollLatest();
 setTimeout(findAnchor,250);
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
   nextXDripWindow=0;
   xdripRequest=null;
   if(!e.target.checked&&xdripHistoryRequest)finishXDripHistory('Импорт истории прерван.');
   xdripStatus='';
   renderXdripStatus();
   requestXDrip();
 }));
 $('xdripSourceMode').addEventListener('change',wrap(e=>{
   savePreference(XDRIP_SOURCE_KEY,e.target.value);
   nextXDripWindow=0;
   xdripRequest=null;
   requestXDrip();
 }));
 $('refreshXdrip').addEventListener('click',wrap(requestXDrip));
 $('restoreXdripHistory').addEventListener('click',wrap(restoreXDripHistory));
 $('saveBackup').addEventListener('click',saveBackup);
 $('saveAiExport').addEventListener('click',saveAiExport);
 $('openBackup').addEventListener('click',wrap(openBackup));
 document.addEventListener('visibilitychange',wrap(()=>{
   if(document.hidden){
     nextXDripWindow=0;
     xdripRequest=null;
     if(xdripHistoryRequest)finishXDripHistory('Импорт истории прерван.');
   }
   requestXDrip();
 }));
}
function wrap(fn){return e=>{try{fn(e);}catch(ex){console.error(ex);notify(String(ex.message||ex),true);}};}
function renderMealWorkflow(){
 if(document.body.dataset.activeScreen!=='approved-meal'||!host)return;
 const frame=$('iframeApprovedMeal'),doc=frame.contentDocument;
 if(!doc||doc.URL!==new URL(frame.getAttribute('src'),location.href).href||!doc.getElementById('plateCard'))return;
 if(mealWorkflowDoc!==doc){
   mealWorkflowDoc=doc;
   mealWorkflowView=GFMealWorkflowView.mount(doc,{
     getHost:()=>host,getController:()=>controller,getMode:()=>mode,getActive:()=>activeMeal,
     setActive:id=>{activeMeal=id;},openFood:()=>screen('approved-nutrition'),makeId:uid,
   });
 }
 mealWorkflowView.render();
}
function submitInjection(event){
 event.preventDefault();
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
function renderCoefficients(){
 const view=settingsService.getView(),kind=$('coefficientKind').value;
 const selected=GFTimeGrid.SLOTS[Number($('coefficientWindow').value)];
 const entries=view.coefficients.filter(row=>row.kind===kind&&row.windowLocal?.from===selected.from&&
   row.windowLocal?.to===selected.to);
 const current=view.coefficients.find(row=>row.kind===kind&&row.isEffectiveAt&&row.source==='manual');
 const mode=view.coefficientModes[kind];
 $('coefficientMode').value=mode;
 $('coefficientEffective').textContent=mode==='auto'?'Авто: статистика истории. Применение нового значения требует подтверждения.':
   current?'Сейчас '+fmt(current.value,4)+' · '+current.windowLocal.from+'–'+current.windowLocal.to+' · ручное значение':
   'Для текущего интервала ручное значение не задано.';
 $('coefficientValue').value=entries.find(row=>row.source==='manual'&&row.isLatestRevision)?.value??'';
 $('coefficientValue').disabled=mode==='auto';
 $('coefficientApply').disabled=mode==='auto';
 const history=$('coefficientHistory');
 history.replaceChildren(...entries.map(row=>{
   const line=document.createElement('div');line.className='actions';
   const label=document.createElement('span');
   label.textContent=formatAt(row.effectiveFrom)+' · '+fmt(row.value,4)+' · '+row.sourceLabel;
   line.append(label);
   if(row.source==='manual'){
     const reuse=document.createElement('button');reuse.type='button';reuse.className='btn secondary';
     reuse.textContent='Выбрать значение';reuse.disabled=mode==='auto';
     reuse.onclick=()=>{$('coefficientValue').value=String(row.value);};
     line.append(reuse);
   }
   return line;
 }));
 if(!entries.length)history.textContent='В выбранном интервале пока нет записей.';
 const activity={low:'Низкая',usual:'Обычная',high:'Высокая',sport:'Спорт'};
 const sport=activeSport(state());
 $('coefficientContext').textContent='Активность: '+(sport?'Спорт':activity[view.profile.activityBaseLevel]||'—')+
   ' · Болезнь: '+(view.illness.active?'активна':'выключена')+' · коэффициент '+
   (view.illness.effectiveFactor===null?'не задан':view.illness.effectiveFactor.toFixed(2).replace('.',','));
}
function setupCoefficients(){
 const periods=$('coefficientWindow');
 periods.replaceChildren(...GFTimeGrid.SLOTS.map((row,index)=>new Option(row.from+'–'+row.to,String(index))));
 for(const id of ['coefficientKind','coefficientWindow'])$(id).addEventListener('change',wrap(renderCoefficients));
 $('coefficientMode').addEventListener('change',wrap(e=>{
   settingsService.setCoefficientMode($('coefficientKind').value,e.target.value,port('settings').getRevision());
   renderCoefficients();
 }));
 $('coefficientForm').addEventListener('submit',wrap(e=>{
   e.preventDefault();
   const {from,to}=GFTimeGrid.SLOTS[Number(periods.value)];
   settingsService.addCoefficient({kind:$('coefficientKind').value,value:numericField('coefficientValue'),
     source:'manual',windowLocal:{from,to},sourceNote:'Ручной ввод'},port('settings').getRevision());
   $('coefficientMessage').textContent='Значение сохранено в истории выбранного интервала.';
   renderCoefficients();
 }));
 $('coefficientRecalculate').addEventListener('click',wrap(()=>{
   const result=GFCoefficients.createService({researchPort:port('research')}).run({asOfIso:nowISO(),windowDays:7});
   const stats=result.statistics;
   $('coefficientMessage').textContent='Период 7 дней · '+stats.confirmedInjections+' инъекций · '+
     stats.meals+' подтверждённых приёмов · '+stats.mealPairs+' сопоставленных пар. '+
     (result.flags[0]||'Готовность входов проверена; пригодное значение для применения отсутствует.');
 }));
}
function setupEvents(){
 setupCoefficients();
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

let plateDialogObserver, foodDocument;
function paintFoodReference(doc){
 if(!host||document.body.dataset.activeScreen!=='approved-nutrition')return;
 let panel=doc.getElementById('gpFoodReference');
 if(!panel){
   panel=doc.createElement('div');panel.id='gpFoodReference';
   doc.querySelector('.meals-panel')?.append(panel);
 }
 const nowMs=Date.now(),profile=port('settings').read('profile');
 const journal=GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter,{nowMs});
 const {nutrition}=GFMainScreenCore.summarize({journal,profile,journalApi:GFJournal,nutritionRef:GFNutritionReference,nowMs});
 const title=doc.createElement('h4');title.textContent='Сегодня';
 panel.replaceChildren(title,...nutrition.rows.map(row=>{
   const entry=doc.createElement('p');entry.className='sub';
   const range=row.range?row.range.map(n=>fmt(n)).join('–')+' '+row.unit:'—';
   const amount=value=>Number.isFinite(value)?fmt(value,2)+' '+row.unit:'—';
   entry.textContent=row.name+' · съедено '+amount(row.eaten)+' · норма '+range+' · осталось до нижней границы '+amount(row.remaining);
   return entry;
 }));
}
function mountFoodPresentation(doc,peer){
 const title=doc.querySelector('.brand h1');
 if(title)title.textContent='Продукты';
 for(const selector of ['.brand p','.demo-controls','.meals-panel>.muted','#tab-restaurants .titlebar .sub',
       '#tab-restaurants .venue-section .sub','#venueDescription']){
   for(const node of doc.querySelectorAll(selector))node.hidden=true;
 }
 const plateTitle=doc.querySelector('.plate-title');if(plateTitle)plateTitle.textContent='Моя тарелка';
 const choose=doc.getElementById('mealType');
 const placeholder=doc.createElement('option');placeholder.value='';placeholder.textContent='Выберите приём пищи';
 choose.prepend(placeholder);
 function refreshMealType(){
   if(choose.dataset.manual)return;
   const meal=activeMeal&&controller?.lookup(activeMeal);
   if(meal?.mealType&&['draft','planned'].includes(meal.status)){choose.value=meal.mealType;return;}
   const zone=host?.connect('settings').read('profile').timeZone;
   const hour=zone?Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(new Date())):new Date().getHours();
   choose.value=hour<8?'':hour<11?'breakfast':hour<17?'lunch':'dinner';
 }
 refreshMealType();
 choose.addEventListener('change',()=>{choose.dataset.manual='yes';});
 peer.GFStorageNutritionPort.readNutrition=()=>null; // The profile publishes a daily range, no per-meal split.
 const table=doc.getElementById('mealCompare'), target=doc.getElementById('mealTargetStatus');
 if(table)table.hidden=true;
 if(target){
   const translate=()=>{
     const value='Для отдельного приёма пищи доля нормы не задана.';
     if(target.textContent!==value)target.textContent=value;
   };
   new MutationObserver(translate).observe(target,{childList:true,subtree:true});
   translate();
 }
 const panorama=doc.querySelector('#tab-plate .panel>.info');
 if(panorama){
   const details=doc.createElement('details'), heading=doc.createElement('summary');
   heading.textContent='Ориентир разнообразной тарелки';
   const label=panorama.querySelector('b');if(label)label.remove();
   details.append(heading,panorama);
   doc.querySelector('#tab-plate .plate-actions')?.after(details);
 }
 for(const id of ['balanceFood','balanceInsulin']){
   doc.getElementById(id)?.addEventListener('click',()=>{
     if(peer.GFStorageNutritionPort.readNutrition())return;
     doc.getElementById('suggestionResults').textContent=id==='balanceFood'?
       'Для расчёта нужна норма этого приёма пищи. В профиле есть только суточный диапазон.':
       'Для расчёта под шаг инсулина нужны норма приёма пищи и проверенный расчёт дозы.';
   });
 }
 const plateCalc=doc.getElementById('plateCalculate');
 plateCalc.textContent='Рассчитать / ввести инсулин';
 doc.addEventListener('click',e=>{
   if(e.target.closest('#goPlate'))refreshMealType();
   if(e.target.closest('#plateCalculate')){
     e.preventDefault(); e.stopImmediatePropagation();
     wrap(()=>{
       if(!sendApproved('nutrition',{type:'gp:capture:plate'}))throw Error('Каталог ещё загружается.');
       captureForInjection=true;
     })();
   }
   if(e.target.closest('#addToPlate'))setTimeout(()=>{
     if(!doc.getElementById('foodModal').classList.contains('on'))peer.GFFoodDemo.setTab('plate');
   },0);
 },true);
 paintFoodReference(doc);
}
function watchPlateDialog(){
 plateDialogObserver?.disconnect();
 document.body.classList.remove('plate-modal-open');
 const peer=approvedPeer('nutrition')?.peer;
 const doc=peer?.document, dialog=doc?.getElementById('foodModal');
 if(!dialog||!peer.GFFoodDemo||!peer.GFStorageNutritionPort)return;
 if(foodDocument!==doc){
   foodDocument=doc;
   mountFoodPresentation(doc,peer);
   try{
     approvedQuickFoodSource=JSON.parse(doc.getElementById('foodsData').textContent);
     host?.bindApprovedQuickFoods(approvedQuickFoodSource);
     globalThis.GFLOWView?.render();
   }catch(error){console.warn('Не удалось прочитать утверждённый справочник LOW',error.message);}
   foodRoutes.length=0;
   doc.addEventListener('click',e=>{
     const move=e.target.closest('[data-tab],[data-venue],[data-venuecat],#goPlate,#backCatalog,#backRestaurants,#showAllVenues');
     if(!move||returningInsideFood||!peer.GFFoodDemo)return;
     foodRoutes.push({tab:peer.GFFoodDemo.getTab(),venue:peer.GFFoodDemo.getSelectedVenue(),
       category:doc.querySelector('[data-venuecat].active')?.dataset.venuecat,
       query:doc.getElementById('restaurantSearch').value,frameScroll:peer.scrollY,shellScroll:window.scrollY});
     if(foodRoutes.length>50)foodRoutes.shift();
   },true);
 }
 const update=()=>document.body.classList.toggle('plate-modal-open',dialog.classList.contains('on'));
 plateDialogObserver=new MutationObserver(update);
 plateDialogObserver.observe(dialog,{attributes:true,attributeFilter:['class']});
 update();
}

const approvedSettingsProfiles=new WeakMap();
function appendSettingsRows(doc,id,rows,empty){
 const target=doc.getElementById(id);
 if(!target)return;
 target.replaceChildren(...(rows.length?rows:[empty]).map(text=>{
   if(target.tagName==='TBODY'){
     const row=doc.createElement('tr'),cell=doc.createElement('td');
     cell.colSpan=target.closest('table')?.tHead?.rows[0].cells.length||1;
     cell.textContent=text;
     row.append(cell);
     return row;
   }
   const row=doc.createElement('p');
   row.textContent=text;
   return row;
 }));
}
function mountSettingsPresentation(doc){
 if(doc.body.dataset.gpUserSettings)return;
 doc.body.dataset.gpUserSettings='1';
 const style=doc.createElement('style');
 style.textContent='#gpApprovedSettingsNotice:empty{display:none}.app{display:block;min-height:0}.side,.warning,.foot,.top .small{display:none!important}.main{padding:12px}';
 doc.head.append(style);
 for(const pane of doc.querySelectorAll('section[data-pane]'))pane.classList.remove('hidden');
 for(const node of doc.querySelectorAll('#storageWarning,#status,#tab-history .panel>.small'))node.hidden=true;
 const notice=doc.getElementById('gpApprovedSettingsNotice');
 notice.textContent='';
 notice.setAttribute('role','status');
 const frame=$('iframeApprovedSettings');
 const size=()=>{
   const height=Math.ceil(doc.querySelector('.app').getBoundingClientRect().height+notice.getBoundingClientRect().height);
   if(height>0&&frame.style.height!==height+'px')frame.style.height=height+'px';
 };
 const observer=new ResizeObserver(size);
 observer.observe(doc.querySelector('.app'));observer.observe(notice);
 size();
}
function paintGrowth(doc,growth,measurements){
 const status=doc.getElementById('growthStatus');
 const labels={missing_profile:'Укажите дату рождения и пол.',needs_paired_measurement:'Сохраните рост и вес в одном измерении.',
   invalid_date:'Проверьте дату рождения и дату измерения.',unsupported_age:'Справочник доступен с 61 до 228 месяцев.'};
 status.textContent=growth.statusLabel||labels[growth.status]||'Справочная оценка пока недоступна.';
 const values=growth.bmiReference?[
   'ИМТ '+fmt(growth.bmi)+' кг/м² · справочный диапазон '+growth.bmiReference.map(n=>fmt(n)).join('–'),
   'Вес '+fmt(growth.weightDisplayKg,2)+' кг · справочный интервал при этом росте '+growth.weightReferenceKg.map(n=>fmt(n,2)).join('–')+' кг',
   growth.referenceMethod,
 ]:[];
 appendSettingsRows(doc,'growthValues',values,'—');
 doc.getElementById('growthDate').textContent=growth.measuredAt?new Date(growth.measuredAt).toLocaleString('ru-RU'):'';
 const box=doc.getElementById('growthPanel');
 let charts=doc.getElementById('measurementCurves');
 if(!charts){charts=doc.createElement('div');charts.id='measurementCurves';box.append(charts);}
 const series=[['heightCm','Рост, см'],['weightKg','Вес, кг']];
 charts.replaceChildren(...series.map(([key,title])=>{
   const section=doc.createElement('section'), heading=doc.createElement('h3');
   heading.textContent=title;section.append(heading);
   const points=measurements.filter(row=>Number.isFinite(row[key])).slice(0,30).reverse();
   if(points.length<2){
     const message=doc.createElement('p');message.textContent='Для графика нужны два измерения.';section.append(message);
     return section;
   }
   const values=points.map(row=>row[key]), low=Math.min(...values), high=Math.max(...values);
   const start=Date.parse(points[0].measuredAt), end=Date.parse(points.at(-1).measuredAt);
   const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');
   svg.setAttribute('viewBox','0 0 300 85');svg.setAttribute('role','img');svg.setAttribute('aria-label',title);
   const line=doc.createElementNS(svg.namespaceURI,'polyline');
   line.setAttribute('points',points.map(row=>
     (12+276*(Date.parse(row.measuredAt)-start)/Math.max(1,end-start))+','+
     (67-49*(row[key]-low)/(high-low||1))).join(' '));
   line.setAttribute('fill','none');line.setAttribute('stroke','#207caa');line.setAttribute('stroke-width','2');
   svg.append(line);section.append(svg);
   const range=doc.createElement('p');
   range.textContent=new Date(start).toLocaleDateString('ru-RU')+' — '+new Date(end).toLocaleDateString('ru-RU')+
     ' · '+fmt(low)+'–'+fmt(high);
   section.append(range);
   return section;
 }));
}
function renderApprovedSettings(doc,view){
 mountSettingsPresentation(doc);
 paintGrowth(doc,view.growthReference,view.measurements);
 const set=(id,text)=>{const field=doc.getElementById(id);if(field)field.textContent=text;};
 for(const id of ['seed','reset','refresh','revisionBadge','storageWarning'])doc.getElementById(id)?.setAttribute('hidden','');
 doc.querySelector('.foot')?.setAttribute('hidden','');
 const age=view.ageYears===null?'—':String(view.ageYears);
 set('ageValue',age);
 set('summaryAge',age);
 set('weightValue',view.vitals.weight?fmt(view.vitals.weight.value)+' кг':'—');
 set('heightValue',view.vitals.height?fmt(view.vitals.height.value)+' см':'—');
 const ref=view.nutritionReference;
 set('nutritionGroup',ref?.groupLabel??'Нужны данные профиля');
 set('nutritionSavedStatus',ref?'Справочные диапазоны, постановление Минздрава Беларуси № 180, 2012':
   !view.profile.birthDate?'Укажите дату рождения.':!view.profile.sex?'Укажите пол для соответствующей возрастной группы.':'Для этого возраста нет справочных данных.');
 appendSettingsRows(doc,'nutritionValues',ref?[
   'Углеводы '+ref.carbsG.join('–')+' г', 'Белки '+ref.proteinG.join('–')+' г',
   'Жиры '+ref.fatG.join('–')+' г', 'Энергия '+ref.kcal.join('–')+' ккал',
 ]:[],'—');
 appendSettingsRows(doc,'measurementsList',view.measurements.map(item=>[
   new Date(item.measuredAt).toLocaleString('ru-RU'),
   Number.isFinite(item.weightKg)?fmt(item.weightKg)+' кг':null,
   Number.isFinite(item.heightCm)?fmt(item.heightCm)+' см':null,
 ].filter(Boolean).join(' · ')), 'Измерений пока нет.');
 const height=doc.getElementById('mHeight');
 if(height){height.min='20';height.max='250';height.title='Рост в сантиметрах, от 20 до 250';}
 const weight=doc.getElementById('mWeight');
 if(weight){weight.min='0.1';weight.max='400';weight.step='0.1';}
 const listId='profileInsulins';
 let list=doc.getElementById(listId);
 if(!list){list=doc.createElement('div');list.id=listId;doc.querySelector('#tab-insulins .panel')?.append(list);}
 appendSettingsRows(doc,listId,[
   'РинФаст · быстрый инсулин. Шаг ввода факта 0,5 ЕД.',
   'Левемир · базальный инсулин. Плановые отметки 08:00 и 20:00; факт записывается отдельно.',
   ...view.orders.map(row=>[row.drugId==='rinfast'?'РинФаст':'Левемир',
     row.scheduleLocal||null, typeof row.units==='number'?fmt(row.units)+' ЕД':null,
     row.isEffectiveAt?'Действующая запись плана':'Архивная запись плана'].filter(Boolean).join(' · ')),
 ],'Настроек препаратов пока нет.');
 const labels={displayName:'Имя',birthDate:'Дата рождения',timeZone:'Часовой пояс',sex:'Пол',allergies:'Ограничения',
   illnessFactor:'Коэффициент болезни',coefficientModes:'Режимы коэффициентов'};
 const display=value=>value==null?'—':Array.isArray(value)?value.join(', '):
   typeof value==='object'?String(value.value??'настройки обновлены'):String(value);
 const history=view.history.filter(row=>row.role==='settings'||row.actor==='settings').slice(0,75).map(row=>{
   const change=Object.entries(row.changes||{}).filter(([key])=>labels[key]).map(([key,delta])=>
     labels[key]+' '+display(delta.before)+' → '+display(delta.after)).join(', ');
   const domain={profile:'Профиль',measurements:'Измерение',orders:'План инсулина',coefficients:'Коэффициенты'};
   return [new Date(row.at).toLocaleString('ru-RU'),domain[row.domain]||'Настройки',change].filter(Boolean).join(' · ');
 });
 appendSettingsRows(doc,'historyList',history,'Изменений пока нет.');
}
function approvedSnapshot(role){if(!host)return null;const s=state();
 if(role==='nutrition')return {type:'gp:snapshot',role};
 if(role==='journal'){
   const all=GFCgmEvidencePolicy.journalView(host,GFJournal,GFJournalStorageAdapter);
   const today=GFJournal.ymd(Date.now(),all.zone), doc=approvedPeer(role)?.peer.document;
   if(!doc?.getElementById('tbody')||!doc?.defaultView.render)return null;
   const presentation=GFJournalPresentation.prepare(doc,all,port('settings').getSnapshot(),today,()=>broadcastApproved('journal'));
   return {type:'gp:snapshot',role,all:presentation,revision:s.revision,timezone:all.zone,today};
 }
 if(role==='settings')return {type:'gp:snapshot',role,profile:s.profile,revision:s.revision};
 return null;
}
function broadcastApproved(role=null){
 for(const r of ['nutrition','journal','settings']){
  if(role&&r!==role)continue;
  try{
   if(r==='nutrition'&&foodDocument)paintFoodReference(foodDocument);
   if(r==='settings'&&host){
     const doc=approvedPeer(r)?.peer.document;
     if(!doc?.getElementById('profileForm'))continue;
     const view=settingsService.getView();
     const key=JSON.stringify(view.profile);
     renderApprovedSettings(doc,view);
     if(approvedSettingsProfiles.get(doc)===key)continue;
     approvedSettingsProfiles.set(doc,key);
   }
   sendApproved(r,approvedSnapshot(r));
  }catch(e){console.warn('Frame awaiting initialization',r,e);}
 }
}
function registerApprovedPlate(payload){const converted=GFFoodMealEntry.normalizePlate(payload);const p=converted.plate;if(!p.items.length)throw Error('Тарелка пуста');
 const mealType=foodDocument?.getElementById('mealType')?.value||null;
 const current=activeMeal?controller.lookup(activeMeal):null;
 if(current&&['draft','planned'].includes(current.status)&&!current.injectionIds.length&&JSON.stringify(current.plannedPlate?.items)===JSON.stringify(p.items)){
   if((current.mealType??null)!==mealType){
     controller.updatePlan(current.id,p,mealType);
     $('approvedPlateStatus').textContent='Тип приёма сохранён в существующем плане.';
     return;
   }
   $('approvedPlateStatus').textContent='Тарелка уже сохранена.';return;
 }
 const id=uid('meal');
 controller.createFromFood(p,id,mealType);
 activeMeal=id;
 $('approvedPlateStatus').textContent='План питания сохранён.';
}
window.addEventListener('message',wrap(e=>{const d=e.data||{};if(!d.type?.startsWith?.('gp:'))return;
 const role=d.role;if(typeof role!=='string'||!isApprovedMessage(role,e))return;
 if(d.type==='gp:ready'){broadcastApproved(role);return;}
 if(d.type==='gp:plate'&&role==='nutrition'){
   const showInjection=captureForInjection&&document.body.dataset.activeScreen==='approved-nutrition';
   captureForInjection=false;
   registerApprovedPlate(d.plate);
   if(showInjection)screen('approved-meal');
   return;
 }
 if(d.type==='gp:error'){if(role==='nutrition')captureForInjection=false;notify(String(d.error||'Ошибка исходного модуля'),true);return;}
 if(d.type==='gp:workflow'&&role==='nutrition'){notify('Чтобы зарегистрировать фактическое действие, используйте общий раздел «План / факт еды»; фиктивная запись в модуле питания отключена.');return;}
 if(d.type==='gp:measurement'&&role==='settings'){
 const record=d.record||{}, output=approvedPeer('settings')?.peer.document.getElementById('gpApprovedSettingsNotice');
 try{
   settingsService.addMeasurement(record,port('settings').getRevision());
   if(output)output.textContent='Измерение сохранено.';
   broadcastApproved('settings');
 }catch(error){if(output)output.textContent='Измерение не сохранено. Проверьте кг, см и дату.';throw error;}
 return;
 }
 if(d.type==='gp:profile'&&role==='settings'){
 const patch=Object.fromEntries(Object.entries(d.patch||{}).filter(([,v])=>v!==''));
 settingsService.saveProfile(patch,port('settings').getRevision());
 const output=approvedPeer('settings')?.peer.document.getElementById('gpApprovedSettingsNotice');
 if(output)output.textContent='Профиль сохранён.';
 broadcastApproved('settings');return;
 }}));
for(const [role,route] of Object.entries(approvedFrames))$(route.id).addEventListener('load',()=>broadcastApproved(role));
$('iframeApprovedNutrition').addEventListener('load',watchPlateDialog);
$('iframeApprovedMeal').addEventListener('load',wrap(renderMealWorkflow));
setInterval(()=>{if(document.body.dataset.activeScreen==='approved-meal'&&!document.hidden)mealWorkflowView?.paintTimer();},1000);
document.addEventListener('visibilitychange',wrap(renderMealWorkflow));
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
globalThis.GPApp=Object.freeze({version:VER,getStorage:()=>host,mode:()=>mode,getModuleStatuses:()=>MODULES.map(x=>x.slice()),open:screen,back,consumeFileResult});
})();
