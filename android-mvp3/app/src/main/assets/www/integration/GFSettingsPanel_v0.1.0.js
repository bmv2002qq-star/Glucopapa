/* GFSettingsPanel v0.1.0: candidate-only host panel; never modifies approved iframe.
 * Connects exclusively via GFStorage ports and GFSettings service. No dose changes. */
(()=>{'use strict';
 const $=id=>document.getElementById(id);
 const b=$('gfContextPanel'); if(!b)return;
 const modelSelect=$('gfMealAbsorptionModel');
 let lastHost=null,lastService=null,dispose=null,mealModelDraft=null;
 const get=()=>{const host=globalThis.GPApp?.getStorage?.();if(!host)throw Error('GFStorage недоступен');
   if(host!==lastHost){if(typeof dispose==='function')dispose();mealModelDraft=null;lastHost=host;lastService=GFSettings.createSettingsService({settingsPort:host.connect('settings')});
    const sub=host.connect('settings').subscribe(()=>refresh());dispose=typeof sub==='function'?sub:null;}
   return {host,service:lastService};};
 const period=(s)=>s.conditionPeriods.filter(p=>p.kind==='illness'&&p.end===null).at(-1)||null;
 const message=(text,error=false)=>{const e=$('gfContextMessage');e.textContent=text;e.dataset.error=String(error);};
 function refresh(){try{const {host,service}=get();const s=host.connect('settings').getSnapshot(),view=service.getView();
   $('gfCarbMode').value=s.profile.coefficientModes.carb_g_per_u;
   $('gfIsfMode').value=s.profile.coefficientModes.isf_mmol_per_u;
   modelSelect.value=mealModelDraft??GFMealAbsorption.selected(s.profile).id;
   $('gfIllnessFactor').value=s.profile.illnessFactor?.value??'';
   const p=period(s);
   $('gfIllnessStart').disabled=!!p;
   $('gfIllnessFinish').disabled=!p;
   $('gfIllnessState').textContent=p?'Болеет · период с '+new Date(p.start).toLocaleString('ru-RU')+' · коэффициент '+(view.illness.effectiveFactor??'не указан'):'Не болеет · действующий коэффициент 1,00';
   $('gfResearchRev').textContent='Ревизия GFStorage #'+s.revision+' · только учёт настроек, не дозирование';
 }catch(e){message('Не удалось загрузить настройки: '+String(e.message||e),true)}}
 function run(fn){try{fn();refresh();message('Сохранено в GFStorage, история изменений сохранена. Это не расчёт доз.')}catch(e){message(String(e.message||e),true)}}
 $('gfModeSave').addEventListener('click',()=>run(()=>{const {host,service}=get();
   const c=$('gfCarbMode').value,i=$('gfIsfMode').value;
   const s=host.connect('settings').getSnapshot();
   // Only changed values are written; no duplicate history when clicking save twice.
   if(s.profile.coefficientModes.carb_g_per_u!==c)service.setCoefficientMode('carb_g_per_u',c,host.connect('settings').getRevision());
   if(s.profile.coefficientModes.isf_mmol_per_u!==i)service.setCoefficientMode('isf_mmol_per_u',i,host.connect('settings').getRevision());
 }));
 modelSelect.addEventListener('change',()=>{mealModelDraft=modelSelect.value;});
 $('gfMealAbsorptionSave').addEventListener('click',()=>run(()=>{const {service}=get();
   service.setMealAbsorptionModel(mealModelDraft??modelSelect.value,service.getRevision());
   mealModelDraft=null;
 }));
 $('gfIllnessFactorSave').addEventListener('click',()=>run(()=>{const {host,service}=get();const raw=$('gfIllnessFactor').value;
   if(!raw.trim())throw Error('Укажите коэффициент для сохранения');
   const val=Number(raw);if(!Number.isFinite(val)||val<0.1||val>10)throw Error('Значение должно быть от 0,1 до 10');
   if(host.connect('settings').getSnapshot().profile.illnessFactor?.value===val)return;
   service.setIllnessFactor(val,host.connect('settings').getRevision());
 }));
 $('gfIllnessStart').addEventListener('click',()=>run(()=>{const {host}=get(),c=host.connect('context'),s=c.getSnapshot();
   if(period(s))throw Error('Период болезни уже открыт');
   c.openPeriod({id:'illness-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9),kind:'illness',start:new Date().toISOString(),note:'Отмечено в настройках'},c.getRevision());
 }));
 $('gfIllnessFinish').addEventListener('click',()=>run(()=>{const {host}=get(),c=host.connect('context'),s=c.getSnapshot(),p=period(s);
   if(!p)throw Error('Нет открытого периода болезни');
   const t=new Date().toISOString();if(Date.parse(t)<=Date.parse(p.start))throw Error('Подождите хотя бы секунду, прежде чем завершать период');
   c.closePeriod({id:p.id,end:t},c.getRevision());
 }));
 $('gfContextRefresh').addEventListener('click',()=>{refresh();message('Настройки прочитаны без записи в базу')});
 window.addEventListener('focus',refresh);
 document.addEventListener('click',e=>{if(e.target.closest('[data-screen="settings"]'))setTimeout(refresh,0)});
 refresh();
 globalThis.GFSettingsPanel=Object.freeze({VERSION:'0.1.0-candidate',refresh});
})();