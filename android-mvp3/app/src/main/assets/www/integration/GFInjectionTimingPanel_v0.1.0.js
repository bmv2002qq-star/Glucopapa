/* Optional retrospective panel. It never writes records or sets dosing controls. */
(() => {
  'use strict';
  const select=document.getElementById('timingHistorySession');
  const run=document.getElementById('timingHistoryRun');
  const output=document.getElementById('timingHistoryResult');
  const heading=document.getElementById('timingHistorySummary');
  const reasons=Object.freeze({
    MEAL_NOT_CONFIRMED:'Нужна завершённая запись с фактически съеденной порцией.',
    CONFIRMED_MEAL_INJECTION_REQUIRED:'Нужна одна связанная подтверждённая инъекция РинФаста под эту еду.',
    HISTORICAL_IOB_UNKNOWN:'У связанной инъекции не сохранён IOB.',
    INDEX_UNAVAILABLE:'История CGM или часовой пояс не подходят для анализа.',
    CGM_UNAVAILABLE:'Недостаточно достоверных показаний CGM на момент выбранной еды.',
    HISTORY_LESS_THAN_3_DAYS:'В этом периоде суток пока меньше трёх дней подходящей истории.',
    SIMILAR_CASES_INSUFFICIENT:'Недостаточно похожих фактических приёмов пищи.',
    SYNTHETIC_HISTORY_EXCLUDED:'Синтетический дневник не используется для этой истории.',
    REVISION_CHANGED:'Журнал изменился. Повторите анализ по текущим данным.'
  });
  let lastHost=null, unsubscribe=null;

  function refresh(){
    const host=GPApp.getStorage();
    if(lastHost!==host){
      unsubscribe?.();
      lastHost=host;
      unsubscribe=host.connect('research').subscribe(refresh);
    }
    const old=select.value;
    const meals=GPApp.mode()==='local'?GFInjectionTimingStorage.list(host):[];
    select.replaceChildren(new Option('Выберите завершённый приём пищи',''));
    for(const row of meals)select.add(new Option(new Date(row.startedAt).toLocaleString('ru-RU'),row.id));
    if(meals.some(row=>row.id===old))select.value=old;
    run.disabled=!select.value;
    heading.textContent=meals.length?'Выберите запись для сопоставления.':'Нет подходящих завершённых приёмов пищи.';
    output.textContent='';
  }
  select.addEventListener('change',()=>{
    run.disabled=!select.value;
    heading.textContent='Запустите анализ для выбранной записи.';
    output.textContent='';
  });
  run.addEventListener('click',()=>{
    let result;
    try{
      result=GFInjectionTimingStorage.inspect({host:GPApp.getStorage(),mode:GPApp.mode(),sessionId:select.value});
    }catch{
      heading.textContent='Не удалось прочитать согласованную историю GFStorage.';
      output.textContent='';
      return;
    }
    heading.textContent=result.status==='HISTORICAL_ESTIMATE'
      ?'Прежние наблюдавшиеся интервалы · '+result.rangeMinutes.join('–')+' мин'
      :reasons[result.code]??'Для исторической оценки недостаточно данных.';
    output.textContent=JSON.stringify(result,null,2);
  });
  document.getElementById('timingHistoryPanel').addEventListener('toggle',event=>{
    if(event.currentTarget.open)refresh();
  });
  globalThis.GFInjectionTimingPanel=Object.freeze({refresh});
})();
