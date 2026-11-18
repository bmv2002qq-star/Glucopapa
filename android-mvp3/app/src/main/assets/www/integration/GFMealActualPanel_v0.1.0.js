/* GFMealActualPanel v0.1.0, W03b candidate. The approved GFNutrition v0.4.6 HTML is unmodified.
 * All meal facts go via existing GFMealController -> GFStorage schema5; no medical calculations.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFMealActualPanel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';
 const ID='gfMealActualPanel',MACROS=['carbs','protein','fat','kcal'];
 const val=(x)=>typeof x==='number'&&Number.isFinite(x);
 const rnd=x=>Math.round((x+Number.EPSILON)*1e5)/1e5;
 function scalePlate(plan,quantities){
   if(!plan||plan.schema!=='GFPlate.v1'||plan.source!=='GFFoodOnly'||!Array.isArray(plan.items))throw Error('Нужен план GFPlate.v1 из утверждённой тарелки');
   if(!Array.isArray(quantities)||quantities.length!==plan.items.length)throw Error('Количество продуктов не совпадает с планом');
   let estimated=false;
   const items=[];
   plan.items.forEach((item,index)=>{
     const amt=quantities[index];
     if(!val(amt)||amt<0||amt>5000)throw Error('Недопустимое фактическое количество продукта №'+(index+1));
     if(!val(item.amount)||item.amount<=0||!['г','мл'].includes(item.unit))throw Error('MEAL_QUANTITY_UNKNOWN: для «'+item.name+'» неизвестна масса/объём по плану. Уточните состав, не заменяйте неизвестное нулём.');
     if(MACROS.some(k=>!val(item[k])))throw Error('MEAL_NUTRIENT_UNKNOWN: БЖУ не заданы, количественный пересчёт запрещён');
     if(!item.nutritionStatus||/unknown|missing|not_provided/i.test(item.nutritionStatus))throw Error('MEAL_NUTRIENT_UNKNOWN: источник БЖУ для «'+item.name+'» неизвестен');
     if(amt===0)return; // Not eaten; absent from actual plate rather than a fictitious zero-nutrition food.
     const ratio=amt/item.amount;
     const o={...item,amount:rnd(amt)};
     for(const k of MACROS)o[k]=rnd(item[k]*ratio);
     if(item.nutritionStatus!=='label_verified')estimated=true;
     items.push(o);
   });
   if(!items.length)throw Error('Ничего не съедено: пустой факт не сохраняется');
   const totals={amount:0,count:items.length};
   for(const k of MACROS)totals[k]=rnd(items.reduce((s,i)=>s+i[k],0));
   // GFStorage v5 requires numeric totals.amount; this may combine g and ml.
   // It is NEVER interpreted as a physical mass; consumers use item-level units.
   totals.amount=rnd(items.reduce((s,i)=>s+i.amount,0));
   return {schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:new Date().toISOString(),items,totals,containsEstimatedValues:estimated||Boolean(plan.containsEstimatedValues)};
 }
 function init(){
   if(typeof document==='undefined')return false;
   const panel=document.getElementById(ID);if(!panel)return false;
   const $=id=>document.getElementById(id);
   const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   let currentHost=null,unsub=null,currentId=null,lastModel='',dirty=false;
   const message=(m,error=false)=>{const a=$('gfMealActualMessage');a.textContent=m;a.dataset.error=String(error)};
   const getHost=()=>{const h=root.GPApp?.getStorage?.();if(!h)throw Error('GFStorage ещё не загружен');return h;};
   function chooseHost(){const h=getHost();if(h!==currentHost){if(unsub)unsub();currentHost=h;currentId=null;unsub=h.connect('journal').subscribe(()=>{dirty=false;render()});}return h;}
   const lookup=(s,id)=>s.find(x=>x.id===id);
   function render(){try{
     const h=chooseHost(),ss=h.connect('journal').read('mealSessions');
     const sel=$('gfMealActualSession'); const previous=currentId;
     if(!ss.some(x=>x.id===currentId))currentId=ss.at(-1)?.id||null;
     sel.innerHTML=ss.slice().reverse().map(s=>'<option value="'+escape(s.id)+'">'+escape(s.id.slice(0,28)+' · '+s.status)+'</option>').join('');
     if(currentId)sel.value=currentId;
     const s=lookup(ss,currentId);
     if(!s){$('gfMealActualRows').innerHTML='<p>Сначала сохраните план из утверждённой «Моей тарелки».</p>';$('gfMealActualSave').disabled=true;return;}
     const editable=['started','completed'].includes(s.status);
     $('gfMealActualSave').disabled=!editable;
     $('gfMealActualSave').textContent=s.actualPlate?'Исправить фактически съеденное':'Подтвердить фактически съеденное';
     $('gfMealActualReason').hidden=!s.actualPlate;
     $('gfMealActualContext').textContent='Статус: '+s.status+' · версия '+s.version+' · одна GFStorage (не лечебный расчёт)';
     const model=s.id+'|'+s.version+'|'+h.connect('journal').getRevision();
     if(dirty&&currentId===previous&&model===lastModel)return;
     lastModel=model;dirty=false;
     const initial=s.actualPlate;
     const actualAmounts=s.plannedPlate.items.map((x,i)=>{
       if(!initial)return x.amount;
       const match=initial.items.find(a=>(a.foodId||a.name)===(x.foodId||x.name)&&a.unit===x.unit);
       return match?.amount??0;
     });
     $('gfMealActualRows').innerHTML=s.plannedPlate.items.map((it,i)=>{
       const amt=it.amount;
       return '<div class="gf-meal-actual-row"><span><strong>'+escape(it.name)+'</strong><small>План: '+(val(amt)?amt:'неизвестно')+' '+escape(it.unit||'')+' · '+escape(it.nutritionStatus||'без источника')+'</small></span><label><span class="sr-only">Фактически съедено: '+escape(it.name)+'</span><input data-actual-index="'+i+'" type="number" min="0" max="5000" step="0.1" '+(!val(amt)||!it.unit?'disabled':'')+' value="'+(val(actualAmounts[i])?actualAmounts[i]:'')+'"/> '+escape(it.unit||'')+'</label></div>';
     }).join('');
     $('gfMealActualSave').disabled=!editable||s.plannedPlate.items.some(it=>!val(it.amount)||it.amount<=0||!it.unit);
   }catch(e){message('Форма недоступна: '+String(e.message||e),true)}}
   $('gfMealActualSession').addEventListener('change',e=>{currentId=e.target.value;dirty=false;render()});
   $('gfMealActualRows').addEventListener('input',()=>{dirty=true});
   $('gfMealActualSave').addEventListener('click',()=>{try{
     const h=chooseHost(),sessions=h.connect('journal').read('mealSessions'),s=lookup(sessions,currentId);
     if(!s)throw Error('Приём пищи не найден');
     if(!['started','completed'].includes(s.status))throw Error('Сначала подтвердите начало еды');
     const reason=$('gfMealActualCorrectionReason').value.trim();
     if(s.actualPlate&&reason.length<8)throw Error('Для исправления факта введите причину (не менее 8 символов)');
     if(!$('gfMealActualConfirm').checked)throw Error('Требуется подтверждение именно фактически съеденного');
     const qty=[...$('gfMealActualRows').querySelectorAll('input[data-actual-index]')].map(input=>input.value.trim()===''?NaN:Number(input.value));
     const plate=scalePlate(s.plannedPlate,qty);
     const controller=GFMealController.createController(h);
     controller.actualFood(s.id,plate,{parentConfirmed:true,...(s.actualPlate?{reason}:{})});
     $('gfMealActualConfirm').checked=false;$('gfMealActualCorrectionReason').value='';dirty=false;message('Сохранено одно событие с новой ревизией GFStorage; дневник и экспорт читают тот же факт.');render();
   }catch(e){message(String(e.message||e),true)}});
   $('gfMealActualRefresh').addEventListener('click',()=>{dirty=false;render();message('Прочитано без записи в GFStorage')});
   document.addEventListener('click',e=>{if(e.target.closest?.('[data-screen="meal-workflow"],[data-screen="meals"],#approvedSavePlate,#mealReady,#mealStart,#mealFinish'))setTimeout(render,0)});
   render();return true;
 }
 return Object.freeze({VERSION:'0.1.0-candidate',scalePlate,init});
});
