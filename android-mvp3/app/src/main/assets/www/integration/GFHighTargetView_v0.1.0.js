/* Binds the original, script-free HIGH view to the same host as the shell. */
(() => {
  'use strict';
  const frame=document.getElementById('iframeHighTarget');
  const bridge=globalThis.GFHighTargetBridge, svgNS='http://www.w3.org/2000/svg';
  const fmt=(value,digits=1)=>Number.isFinite(value)?value.toFixed(digits).replace('.',','):'—';
  const num=field=>field.value.trim()===''?null:Number(field.value);
  const levels=['normal','high','sport'];
  const coeffIds={normal:'coeffNormal',high:'coeffHigh',sport:'coeffSport'};
  let doc=null, observer=null, lastHost=null, requested=false, pending=null, busy=false;

  function size(){
    if(doc&&frame.clientWidth)frame.style.height=Math.ceil(doc.body.getBoundingClientRect().height)+'px';
  }

  function axis(chart, curves, target){
    chart.replaceChildren();
    function add(name,attrs,text){
      const node=doc.createElementNS(svgNS,name);
      for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
      if(text)node.textContent=text;
      chart.append(node);
    }
    const points=curves.flatMap(x=>x.points);
    if(!points.length){
      add('text',{x:20,y:112,fill:'#a55f4b','font-size':18},'Нет надёжных данных для графика');
      return;
    }
    const maxTime=curves[0].points.at(-1).t;
    const min=Math.min(3,target-2,...points.map(p=>p.g))-.5;
    const max=Math.max(target+2,...points.map(p=>p.g))+.5;
    const y=g=>203-(g-min)/(max-min)*163, x=t=>50+t/maxTime*601;
    add('rect',{x:50,y:y(target+.5),width:601,height:163/(max-min),fill:'#a1d3be','fill-opacity':.34});
    for(let i=0;i<=4;i++){
      const glucose=min+(max-min)*i/4, time=maxTime*i/4;
      add('line',{x1:50,x2:651,y1:y(glucose),y2:y(glucose),stroke:'#e0ecec'});
      add('text',{x:6,y:y(glucose)+4,fill:'#7e9597','font-size':11},fmt(glucose));
      add('text',{x:x(time),y:231,fill:'#7e9597','font-size':11,
        'text-anchor':i===0?'start':i===4?'end':'middle'},Math.round(time)+' мин');
    }
    add('line',{x1:50,x2:651,y1:y(target),y2:y(target),stroke:'#68ad90','stroke-dasharray':'5 5'});
    for(const curve of curves){
      add('path',{d:curve.points.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(2)+' '+y(p.g).toFixed(2)).join(' '),
        fill:'none',stroke:curve.color,'stroke-width':curve.width,'data-curve':curve.id});
    }
  }

  const el=id=>doc.getElementById(id);
  function updateField(id,value){
    const field=el(id);
    if(doc.activeElement!==field)field.value=value??'';
  }

  function render(){
    if(!doc||!globalThis.GPApp)return;
    const host=GPApp.getStorage(), mode=GPApp.mode();
    if(!host)return;
    if(lastHost!==host){
      el('preview').value='';
      el('site').selectedIndex=-1;
      pending=null;
      requested=false;
      lastHost=host;
      doc.querySelector('.fact .notice:last-child').textContent='Ожидается подтверждение.';
    }
    let result;
    try{
      result=bridge.inspect({host,mode,nowMs:Date.now(),
        foodOptions:globalThis.GFCOBStudyPanel?.optionsForRevision?.(host)??{},previewDose:num(el('preview'))});
    }catch{
      result={status:'BLOCKED',code:'SNAPSHOT_UNAVAILABLE',reasons:['Снимок GFStorage недоступен.'],baseline:[]};
    }
    const v=result.view;
    const prefs=v??bridge.preferences(host.connect('settings').read('profile'));
    const a=prefs.activity;
    const synthetic=mode==='demo';
    doc.querySelector('.headBadge').textContent=synthetic?'Синтетический журнал':'Локальный журнал';
    doc.querySelector('.src').textContent=v?.cgm.measuredAt
      ? new Date(v.cgm.measuredAt).toLocaleString('ru-RU')+' · '+(v.cgm.source==='SYNTHETIC'?'Вымышленные данные':v.cgm.code)
      : 'История CGM отсутствует.';
    el('gNow').textContent=fmt(v?.cgm.mmol);
    el('trend').textContent=v?.cgm.trend||'Тренд неизвестен';
    updateField('target',prefs.target?.valueMmol);
    el('target').setAttribute('aria-label','Цель, ммоль/л');
    updateField('act',a.selectedLevel);
    el('activityEnabled').checked=a.enabled;
    for(const level of levels)updateField(coeffIds[level],a.coefficients[level]);
    el('activeCoeff').textContent=a.enabled?
      (a.sportActive?'Идёт спорт · ':'')+'Коэффициент: '+fmt(a.effectiveCoefficient??a.coefficients[a.selectedLevel],2):
      'Активность не учитывается';
    el('preview').max=synthetic?'6':'200';
    el('previewTip').textContent=synthetic?'Ручная доза обновляет кривую синтетического сценария.':
      'Введите фактически введённое количество. Запись создаётся после подтверждения.';
    const reasons=result.reasons?.join(' ')||'';
    el('dose').textContent=!requested?'— ЕД':result.candidate?
      fmt(result.candidate.dose)+' ЕД':result.status==='SIMULATION_NO_SOLUTION'?'Нет решения':'Недоступно';
    el('arrive').textContent=requested?(result.candidate?'Синтетическая траектория достигла заданной полосы.':reasons):
      'Нажмите «Рассчитать» для проверки текущего снимка.';
    el('status').textContent=result.candidate?'Синтетический сценарий · '+result.code:
      (reasons||'Нет расчётного результата.')+' ('+result.code+')';
    el('status').dataset.code=result.code;
    el('iob').textContent=fmt(result.observations?.iobModelU,2)+' ЕД';
    el('cob').textContent=v?.food?.status==='RESEARCH_INTERVAL'?
      fmt(v.food.lowerG)+'–'+fmt(v.food.upperG)+' г':fmt(result.observations?.cobModelG)+' г';
    el('previewStatus').textContent=result.manualPreview?'Синтетическая кривая обновлена.':
      Number.isFinite(num(el('preview')))?'Количество введено вручную.':'—';
    el('manualEstimate').textContent=result.manualPreview?
      'Модельный итог '+fmt(result.manualPreview.finalMmol)+' ммоль/л.':synthetic?'Прогноз для введённой дозы недоступен.':'';
    const curves=[];
    if(result.baseline.length){
      curves.push({id:'baseline',points:result.baseline,color:'#2b78ac',width:2.5});
      if(result.manualPreview)curves.push({id:'preview',points:result.points,color:'#168c78',width:3.3});
    }
    axis(el('chart'),curves,prefs.target?.valueMmol);
    const researchTrajectory=globalThis.GFConsensusEvidence?.current(host);
    el('details').textContent=JSON.stringify({researchTrajectory,status:result.status,code:result.code,version:result.version??bridge.VERSION,
      revision:result.sourceRevision,observations:result.observations,source:v,model:result.meta,trace:result.trace},null,2);
    el('record').disabled=busy||!bridge.boundedHalf(num(el('preview')),synthetic?6:200)||!el('site').value;
    size();
  }

  function save(patch){
    const host=GPApp.getStorage(), settingsPort=host.connect('settings');
    const service=GFSettings.createSettingsService({settingsPort});
    const note=doc.querySelector('#scenarioSettings .help');
    try{
      service.setHighSettings(patch,settingsPort.getRevision());
      note.textContent='Настройки сохранены в GFStorage.';
    }catch(error){
      note.textContent=String(error.message||error);
      el('target').blur();
    }
    requested=false;
    render();
  }

  function saveActivity(){
    save({activity:{enabled:el('activityEnabled').checked,selectedLevel:el('act').value,
      coefficients:Object.fromEntries(levels.map(level=>[level,num(el(coeffIds[level]))]))}});
  }

  function record(){
    if(busy)return;
    const host=GPApp.getStorage(), units=num(el('preview')), region=el('site').value;
    const note=doc.querySelector('.fact .notice:last-child');
    if(!bridge.boundedHalf(units,GPApp.mode()==='demo'?6:200)||!Object.values(bridge.SITE).includes(region))return;
    if(pending?.host!==host||pending.record.units!==units||pending.record.injectionSite.region!==region){
      const identifier=Array.from(crypto.getRandomValues(new Uint32Array(4)),x=>x.toString(16).padStart(8,'0')).join('');
      pending={host,record:{id:'high-'+identifier,units,administeredAt:new Date().toISOString(),
        injectionSite:{region}}};
    }
    const expectedRevision=host.connect('actionWriter').getRevision();
    const site=el('site').selectedOptions[0].textContent;
    busy=true;
    el('record').disabled=true;
    try{
      const time=new Date(pending.record.administeredAt).toLocaleString('ru-RU');
      if(!window.confirm('РинФаст уже введён? '+fmt(units)+' ЕД, '+site.toLowerCase()+' · '+time)){
        pending=null;
        note.textContent='Подтверждение отменено.';
        return;
      }
      if(GPApp.getStorage()!==host){
        note.textContent='Журнал переключился. Введите факт в нужном журнале.';
        return;
      }
      const receipt=bridge.recordActualInjection({host,record:pending.record,confirmation:true,expectedRevision});
      if(receipt.status==='RECORDED'){
        pending=null;
        el('preview').value='';
        note.textContent='Подтверждённая инъекция сохранена в дневнике.';
      }else note.textContent=receipt.reasons.join(' ')+' ('+receipt.code+')';
    }finally{
      busy=false;
      render();
    }
  }

  function mount(){
    const candidate=frame.contentDocument;
    if(!candidate||candidate.location.href!==frame.src||!candidate.getElementById('record')||candidate===doc)return;
    observer?.disconnect();
    doc=candidate;
    lastHost=null;
    for(const option of el('site').options)option.value=bridge.SITE[option.textContent];
    el('target').addEventListener('change',()=>save({targetMmol:num(el('target'))}));
    for(const id of ['act','activityEnabled',...Object.values(coeffIds)])el(id).addEventListener('change',saveActivity);
    el('preview').addEventListener('input',()=>{pending=null;render();});
    el('site').addEventListener('change',()=>{pending=null;render();});
    el('compute').addEventListener('click',()=>{requested=true;render();});
    el('record').addEventListener('click',record);
    if(typeof ResizeObserver==='function'){
      observer=new ResizeObserver(size);
      observer.observe(doc.body);
    }
    render();
  }
  frame.addEventListener('load',mount);
  window.addEventListener('resize',size);
  globalThis.GFHighTargetView=Object.freeze({render});
  mount();
})();
