/* GFShell v0.2.0 · UI extensions only. NO second patient storage, NO dosing. */
(()=>{'use strict';
 const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const h=()=>GPApp.getStorage();let observer=null,lastHost=null;
 const errorMessage=e=>{console.error(e);const el=$('notice');if(el){el.textContent=String(e.message||e);el.className='notice visible error';}};
 const protect=f=>e=>{try{f(e);}catch(ex){errorMessage(ex);}};
 const fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('ru-RU',{maximumFractionDigits:d}):'—';
 const dateText=s=>{try{return new Date(s).toLocaleString('ru-RU');}catch{return '—';}};
 function connect(){const host=h();if(lastHost!==host){if(observer)observer();lastHost=host;observer=host.connect('journal').subscribe(()=>renderActive());}}
 function renderActive(){connect();const section=document.body.dataset.activeScreen;
  if(section==='insulin-models')renderInsulin();if(section==='injection-sites')renderSites();if(section==='reports')renderReports();if(section==='sync')renderSync();if(section==='highlow')renderHighLow();if(section==='settings')renderSettings();}
 function renderInsulin(){
  const r=GPModuleHub.rinfastModel(h()), b=GPModuleHub.levemirModel(h());
  $('rinfastModels').textContent=r.status==='MODEL_ESTIMATE'?
    r.source+' · '+r.method+' · '+r.parts.length+' подтверждённых записей. Модельный остаток '+fmt(r.totalModelUnits,3)+' ЕД.':
    'Данные неполные. '+(r.detail||r.code)+'.';
  $('levemirModels').textContent=b.status==='MODEL_ESTIMATE'?
    'Движок Левемир v'+LevemirEngine.VERSION+' · модельный остаток '+fmt(b.remainingModelActionUnits,3)+' ЕД.':
    'Данные неполные. '+(b.issues||[]).join(' ')+' ('+b.status+')';
  const inputs=$('insulinModelInputs');
  inputs.replaceChildren();
  for(const [label,rows,remaining] of [
    ['РинФаст',r.parts,'remainingModelUnits'],['Левемир',b.contributions,'remainingModelActionUnits']
  ]){
    for(const row of rows||[]){
      const line=document.createElement('li');
      line.textContent=label+' · подтверждённый факт '+(row.units??row.doseUnits)+' ЕД · '+
        fmt(row.ageMinutes??row.ageHours*60,1)+' мин назад · модельный вклад '+fmt(row[remaining],3)+' ЕД';
      inputs.append(line);
    }
  }
  $('insulinModelTrace').hidden=inputs.childElementCount===0;
 }
 function renderSites(){const r=GPModuleHub.sitesAnalysis(h());$('siteStats').textContent='Подтверждённых записей: '+r.totals.total+' · пригодных для исследования: '+r.totals.eligible+' · без места/контекста: '+r.totals.metadataMissing+' · CGM недостаточно: '+r.totals.cgmMissingOrUnclear+'. Проверка не назначает время инъекции.';
 $('siteDetails').innerHTML=(r.siteStats||[]).map(x=>'<div class="food-row"><b>'+esc(GFInjectionAnalytics.SITE_LABEL[x.region]||x.region)+'</b><span>'+fmt(x.count,0)+' записей · '+(x.sufficient?'описательная выборка':'мало данных')+'</span></div>').join('')||'Нет данных по местам инъекций';}
 function renderReports(){const r=GPModuleHub.report(h());const ins=(r.events||[]).filter(x=>x.type==='insulin_injection'&&x.status==='confirmed');const done=(r.mealSessions||[]).filter(x=>x.status==='completed');$('reportSummary').textContent='Одна база GFStorage · ревизия '+r.revision+' · CGM '+(r.cgm||[]).length+' точек · инъекции '+ins.length+' · завершено приёмов еды '+done.length+'. JSON содержит всю историю.';
 $('reportEvents').innerHTML='<div class="events">'+ins.slice(-20).reverse().map(x=>'<div class="event"><div class="event-text"><b>'+esc(x.insulinId)+'</b><small>'+fmt(x.units)+' ЕД · '+esc(x.injectionSite?.region||'зона не указана')+'</small></div><time>'+esc(dateText(x.administeredAt))+'</time></div>').join('')+'</div>';
 if(!ins.length)$('reportEvents').textContent='Нет инъекций в журнале.';}
 function renderSync(){const s=h().exportState();$('syncDiagnostics').textContent='GFSync загружен: '+(globalThis.GFSync?'да':'ядро отсутствует')+'. Сетевое соединение: НЕ НАСТРОЕНО. CGM источник: '+(s.cgmMetadata?.sourceDeviceId||'не подключён')+'. Полученных показаний: '+(s.cgm||[]).length+'. Версия схемы: '+s.schemaVersion+'. Нет передачи данных на сервер.';}
 function renderHighLow(){const a=GFHighLowReadOnly.connect(h()).analyze();$('highLowSummary').textContent='Проверка CGM: '+a.status+'. Найдено эпизодов: '+(a.episodes?.length||0)+'. Раздел только читает события и не регистрирует повторных инъекций/приёмов пищи.';}
 function renderSettings(){const s=h().exportState();const prof=s.profile||{};const m=s.measurements||[];$('childName').value=prof.displayName||'';$('childBirth').value=prof.birthDate||'';$('childAllergies').value=(prof.allergies||[]).join(', ');$('childMeasurementInfo').textContent=m.length?'Последнее измерение: '+dateText(m.at(-1).measuredAt)+' · вес '+(m.at(-1).weightKg??'—')+' кг · рост '+(m.at(-1).heightCm??'—')+' см':'Вес и рост пока не записаны';}
 function download(text,name,mime='text/plain;charset=utf-8'){if(typeof Blob!=='function')throw Error('Этот браузер не поддерживает загрузку файлов');const url=URL.createObjectURL(new Blob([text],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200);}
 const bindings=[['refreshInsulinModels','click',renderInsulin],['runSiteAnalytics','click',renderSites],['refreshSync','click',renderSync],['refreshHighLow','click',renderHighLow],['downloadReportTxt','click',()=>download(GPModuleHub.reportTxt(h()),'ГлюкоПапа_отчёт.txt')],['openPrintReport','click',()=>window.print()]];
 for(const [id,event,fn] of bindings)$(id).addEventListener(event,protect(fn));
 $('childProfileForm').addEventListener('submit',protect(e=>{e.preventDefault();const patch={};if($('childName').value.trim())patch.displayName=$('childName').value.trim();if($('childBirth').value)patch.birthDate=$('childBirth').value;patch.allergies=$('childAllergies').value.split(',').map(x=>x.trim()).filter(Boolean);h().connect('settings').updateProfile(patch,h().connect('settings').getRevision());renderSettings();}));
 $('childMeasurementForm').addEventListener('submit',protect(e=>{e.preventDefault();const a=$('childWeight').value.trim(),b=$('childHeight').value.trim();if(!a&&!b)throw Error('Введите вес или рост');const row={id:'measurement-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),measuredAt:new Date().toISOString()};if(a)row.weightKg=Number(a);if(b)row.heightCm=Number(b);h().connect('settings').addMeasurement(row,h().connect('settings').getRevision());renderSettings();}));
 // The shell refreshes the active section after every navigation.
 connect();
 globalThis.GPModuleUI=Object.freeze({VERSION:'0.2.1',refresh:renderActive});
})();
