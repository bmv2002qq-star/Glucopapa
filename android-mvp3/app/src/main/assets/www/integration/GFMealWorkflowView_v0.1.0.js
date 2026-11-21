/* Presentation for the five-card GFMealCalc workflow. Facts use the shared actionWriter. */
(function (root) {
  'use strict';

  const number = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:2});
  const fmt = value => Number.isFinite(value) ? number.format(value) : '—';
  const stages = {draft:'Черновик',planned:'Тарелка подтверждена',started:'Еда начата',completed:'Еда завершена'};
  const reasons = {
    DOSE_MISSING:'Введите дозу для поиска похожих случаев.',
    IOB_INCOMPLETE:'Нужна подтверждённая история инъекций.',
    CGM_UNAVAILABLE:'Для сравнения нужен свежий ряд CGM.',
    HISTORY_LESS_THAN_3_DAYS:'Нужно больше подтверждённой истории.',
    SIMILAR_CASES_INSUFFICIENT:'Подходящих случаев недостаточно.',
    CONTEXT_INCOMPLETE:'Не хватает данных об активности или IOB.',
    CURRENT_GLUCOSE_LOW:'CGM вне диапазона анализа интервалов.',
    INDEX_UNAVAILABLE:'История CGM или профиля непригодна для анализа.',
    NON_LOCAL_HISTORY:'Для анализа нужна подтверждённая локальная история.',
  };

  function drawCurve(svg, units) {
    svg.replaceChildren();
    if (units === null) return;
    const engine = root.RinfastEngine;
    const {diaMinutes,peakMinutes} = engine.DEFAULT_PROFILE;
    const max = engine.getCurve(peakMinutes).activityFractionPerMinute*50;
    const left=50, width=520, bottom=180;
    function draw(tag, attrs, label) {
      const node=svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg',tag);
      for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
      if (label) node.textContent=label;
      svg.append(node);
    }
    for(let tick=0;tick<=5;tick++){
      const x=left+width*tick/5;
      draw('line',{x1:x,y1:10,x2:x,y2:bottom,stroke:'#dce7eb'});
      draw('text',{x:x-6,y:205,fill:'#667f8c','font-size':13},String(diaMinutes*tick/5));
    }
    draw('text',{x:5,y:18,fill:'#667f8c','font-size':13},'ЕД/мин');
    draw('text',{x:5,y:205,fill:'#667f8c','font-size':13},'мин');
    const points=[];
    for (let minute=0;minute<=diaMinutes;minute+=5) {
      const activity=units*engine.getCurve(minute).activityFractionPerMinute;
      points.push((left+width*minute/diaMinutes).toFixed(2)+','+(bottom-160*activity/max).toFixed(2));
    }
    draw('polyline',{points:points.join(' '),stroke:'#107d84','stroke-width':3,fill:'none'});
  }

  function mount(doc, actions) {
    const field=id=>doc.getElementById(id);
    const set=(id,value)=>{if(field(id).textContent!==value)field(id).textContent=value;};
    const enable=(id,on)=>field(id).disabled=!on;
    const details=field('mealCalculationDetails');
    for(const [tag,key] of [['p','summary'],['ul','blockers'],['pre','trace']]){
      const node=doc.createElement(tag);
      node.setAttribute('data-calc-'+key,'');
      details.append(node);
    }
    function selectedTime(id) {
      const raw=field(id).value;
      const at=raw?Date.parse(raw):Date.now();
      if (!Number.isFinite(at)||at>Date.now()) throw Error('Укажите время, которое уже наступило.');
      return new Date(at).toISOString();
    }
    const selectedDose=()=>field('doseChosen').checkValidity()&&Number.isFinite(field('doseChosen').valueAsNumber)?
      field('doseChosen').valueAsNumber:null;
    const site=()=>field('shotSite').value||null;

    let selectedId=null, displayedShot=null, timingKey='', detailsKey='', optionsKey='';
    let editingVersion=null, saving=false;
    const read=()=>{
      const host=actions.getHost();
      const port=host.connect('mealTiming'), data=port.getSnapshot();
      const meal=data.mealSessions.find(row=>row.id===actions.getActive())||data.mealSessions.at(-1);
      return {host,port,data,meal};
    };

    field('timerNote').setAttribute('aria-live','polite');
    function paintTimer(){
      const seconds=root.GFMealTimingService.countdown(displayedShot);
      set('timerText',seconds===null?'--:--':
        String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0'));
      set('timerNote',seconds===null?(displayedShot?'Интервал для укола недоступен.':'Ожидание подтверждения укола.'):
        seconds===0?'Исторический интервал завершён.':'Отсчёт от фактического времени укола.');
    }

    function preview(host, port, meal, units, revision) {
      try {
        const atIso=selectedTime('shotTime');
        const input=[meal.id,revision,units,site(),field('shotTime').value||atIso.slice(0,16)].join('|');
        if(input!==timingKey){
          root.GFMealTimingService.refresh(host,{sessionId:meal.id,units,site:site(),atIso,mode:actions.getMode()});
          timingKey=input;
        }
        return port.readPreview(meal.id);
      } catch {
        return {code:'ANALYSIS_UNAVAILABLE'};
      }
    }

    function render(){
      const {host,port,data,meal}=read();
      if((meal?.id??null)!==selectedId){
        selectedId=meal?.id??null;
        for(const id of ['doseChosen','shotSite','shotTime','mealStartTime','editReason'])field(id).value='';
        field('editPanel').hidden=true;
        timingKey=detailsKey='';
      }
      const options=JSON.stringify(data.mealSessions.map(row=>[row.id,row.status]));
      if(options!==optionsKey){
        optionsKey=options;
        field('chooseMeal').replaceChildren(...data.mealSessions.slice().reverse().map(row=>{
          const option=doc.createElement('option');
          option.value=row.id;
          option.textContent=new Date(row.createdAt).toLocaleString('ru-RU')+' · '+stages[row.status];
          return option;
        }));
      }
      if(meal)field('chooseMeal').value=meal.id;
      const status=meal?.status, plate=meal?.plannedPlate, units=selectedDose();
      const shots=meal?data.events.filter(e=>meal.injectionIds.includes(e.id)&&
        e.type==='insulin_injection'&&e.status==='confirmed'&&e.insulinId==='rinfast'):[];
      displayedShot=shots.at(-1)??null;
      const current=meal&&!displayedShot&&['draft','planned'].includes(status)?
        preview(host,port,meal,units,data.revision):null;
      const estimate=displayedShot?.mealTiming?.estimate??current?.estimate;
      field('minutesChosen').value=estimate?.minutes??'';
      set('minutesSuggested',estimate?fmt(estimate.minutes)+' мин':'—');
      set('minutesExplain',estimate?estimate.rangeMinutes.map(fmt).join('–')+' мин · '+estimate.matchedCases+' случаев':
        reasons[current?.code]||'Подходящий исторический интервал недоступен.');
      set('sampleMatches',estimate?'По '+estimate.distinctDays+' дням наблюдений':'');
      // Show carbohydrate arithmetic as a separate research component.
      // Calculation is read-only; recording an actual injection remains a separate explicit action.
      let arithmetic=null, arithmeticError=null;
      if(meal)try{
        arithmetic=root.GFCalculationEvidence.mealCarbEquivalent(host,meal.id);
      }catch(error){arithmeticError=String(error.message||error);}
      const modelUnits=arithmetic?.unroundedEquivalentUnits;
      set('doseSuggested',Number.isFinite(modelUnits)?fmt(modelUnits)+' ЕД (C/УК)':'—');
      set('doseExplain',Number.isFinite(modelUnits)?
        'Расчётный вклад углеводов: '+fmt(arithmetic.carbsG)+' г / '+fmt(arithmetic.ratioGPerUnit)+
        ' г/ЕД. Остальные вклады полной модели здесь не вычислены.':
        meal?'Нет арифметического результата: '+(arithmetic?.reason||arithmeticError||'неполные входные данные')+'.':
        'Сначала соберите и сохраните тарелку.');
      set('injectionHint',displayedShot?'Подтверждённый укол записан.':'Подтвердите выполненный укол.');
      set('plateChip',stages[status]||'Нет тарелки');
      set('calcChip',displayedShot?'Укол записан':'РинФаст');
      set('timerChip',displayedShot?.mealTiming?'По истории':'—');
      set('mealChip',stages[status]||'Нет тарелки');
      set('endChip',status==='completed'?'Завершено':'—');
      field('plannedFoods').replaceChildren(...(plate?.items??[]).map(item=>{
        const row=doc.createElement('p');
        row.textContent=item.name+' · '+fmt(item.amount)+' '+(item.unit??'')+' · '+fmt(item.carbs)+' г У';
        return row;
      }));
      set('plateTotal',plate?fmt(plate.totals.carbs)+' г углеводов':'—');
      set('mealPlanned',plate?fmt(plate.totals.carbs)+' г углеводов':'—');
      set('finalPlanned',plate?fmt(plate.totals.carbs)+' г У':'—');
      set('finalActual',meal?.actualPlate?fmt(meal.actualPlate.totals.carbs)+' г У':'—');
      set('finalInjected',shots.length?fmt(shots.reduce((sum,e)=>sum+e.units,0))+' ЕД':'—');
      const interval=displayedShot&&meal?.startedAt?(Date.parse(meal.startedAt)-Date.parse(displayedShot.administeredAt))/60000:null;
      set('finalInterval',interval===null?'—':interval<0?'Еда до укола · '+fmt(-interval)+' мин':fmt(interval)+' мин');
      set('actualConfirmed',meal?.actualPlate?'Факт еды сохранён.':'Фактическая еда ещё не записана.');
      drawCurve(field('chartSvg'),displayedShot?.units??units);
      enable('confirmPlate',status==='draft'&&!saving);
      enable('confirmInjection',Boolean(meal)&&!displayedShot&&units!==null&&status!=='draft'&&!saving);
      for(const id of ['doseChosen','shotTime','shotSite'])enable(id,Boolean(meal)&&!displayedShot&&!saving);
      enable('startMeal',status==='planned'&&!saving);
      enable('ateAll',status==='started'&&!meal?.actualPlate&&!saving);
      enable('editActual',status==='started'&&!saving);
      enable('finishMeal',status==='started'&&Boolean(meal?.actualPlate)&&!saving);
      enable('showCorrection',status==='completed'&&!saving);
      field('afterStart').hidden=!['started','completed'].includes(status);
      const token=[meal?.id,data.revision,new Date().toISOString().slice(0,16)].join('|');
      if(token!==detailsKey){
        const evidence=root.GFCalculationEvidence.inspect({host,route:'meal',activeMeal:meal?.id??null});
        root.GFCalculationEvidence.render(details,evidence);
        detailsKey=token;
      }
      paintTimer();
    }

    function click(id,fn){
      field(id).addEventListener('click',()=>{
        if(saving)return;
        saving=true;
        try {set('mealOperationStatus','');fn(read());}
        catch(error){set('mealOperationStatus',String(error.message||error));}
        finally{saving=false;render();}
      });
    }

    field('chooseMeal').addEventListener('change',()=>{
      actions.setActive(field('chooseMeal').value);
      render();
    });
    for(const id of ['doseChosen','shotSite','shotTime'])field(id).addEventListener('input',render);
    click('savePlan',actions.openFood);
    click('newTest',actions.openFood);
    click('confirmPlate',({meal})=>actions.getController().ready(meal.id));
    click('confirmInjection',({host,port,meal})=>{
      const units=selectedDose(), atIso=selectedTime('shotTime'), region=site();
      if(units===null||!meal||meal.injectionIds.length)return;
      if(!root.confirm('Записать уже сделанный укол РинФаста?'))return;
      if(meal.status==='planned'){
        root.GFMealTimingService.refresh(host,{sessionId:meal.id,units,site:region,atIso,mode:actions.getMode()});
      }
      const item={id:actions.makeId('inj'),insulinId:'rinfast',units,administeredAt:atIso,
        ...(region?{injectionSite:{region}}:{})};
      root.GFInjectionFact.record({host,item,mealId:meal.id,confirmed:true,revision:port.getRevision(),mealWorkflow:true});
      set('mealOperationStatus','Укол записан.');
    });
    click('startMeal',({meal})=>actions.getController().startMeal(meal.id,selectedTime('mealStartTime'),{actuallyStarted:true}));
    click('ateAll',({meal})=>{
      if(root.confirm('Подтвердить, что вся порция съедена?'))
        actions.getController().actualFood(meal.id,meal.plannedPlate,{parentConfirmed:true});
    });
    click('finishMeal',({meal})=>actions.getController().finishMeal(meal.id,new Date().toISOString(),{confirmed:true}));

    function edit({meal}){
      field('editFoodRows').replaceChildren(...meal.plannedPlate.items.map(item=>{
        const label=doc.createElement('label'), input=doc.createElement('input');
        label.textContent=item.name+' · '+(item.unit??'количество неизвестно');
        input.type='number';input.min='0';input.max='5000';input.step='0.1';
        input.disabled=!Number.isFinite(item.amount);
        const previous=meal.actualPlate?.items.find(row=>(row.foodId||row.name)===(item.foodId||item.name)&&row.unit===item.unit);
        input.value=meal.actualPlate?(previous?.amount??0):(item.amount??'');
        label.append(input);
        return label;
      }));
      editingVersion=meal.version;
      field('editPanel').hidden=false;
      field('editPanel').scrollIntoView({block:'nearest'});
    }
    click('editActual',edit);
    click('showCorrection',edit);
    click('cancelActual',()=>{field('editPanel').hidden=true;});
    click('saveActual',({meal})=>{
      if(meal.version!==editingVersion)throw Error('Факт еды изменился. Откройте редактирование заново.');
      const amounts=[...field('editFoodRows').querySelectorAll('input')].map(input=>input.valueAsNumber);
      const plate=root.GFMealActualPanel.scalePlate(meal.plannedPlate,amounts);
      const reason=field('editReason').value.trim();
      if(meal.actualPlate&&!reason)throw Error('Укажите причину исправления.');
      actions.getController().actualFood(meal.id,plate,{parentConfirmed:true,reason});
      field('editPanel').hidden=true;
      field('editReason').value='';
    });
    return Object.freeze({render,paintTimer});
  }

  root.GFMealWorkflowView=Object.freeze({mount});
})(globalThis);
