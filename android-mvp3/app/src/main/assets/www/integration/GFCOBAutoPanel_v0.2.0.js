/* W06d research-only low/high external panel.
 * Automatic model preset from actual GFPlate.v1 in GFStorage (v0.5.10).
 * Never ask parent for per-meal absorption time, never modify approved views.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFCOBStudyPanel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
let currentHost=null,unsubscribe=null,revision=null,ack=null,initialised=false;
const IDS=['w06cStudyLow','w06cStudyHigh'];
const el=(tag,text)=>{const n=root.document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const getHost=()=>root.GPApp?.getStorage?.()||null;
function bindHost(host){
 if(currentHost!==host){
  unsubscribe?.();
  currentHost=host;
  unsubscribe=host?.connect('journal').subscribe(render)||null;
  revision=null;
  ack=null;
 }
 const nextRevision=host?.connect('research').getRevision()??null;
 if(nextRevision!==revision){revision=nextRevision;ack=null;}
 return nextRevision;
}
function data(nowMs=Date.now()){
 const host=getHost();
 bindHost(host);
 if(!host||!root.GFAutoCOBProfile||!root.GFMealCoverageStudy)return null;
 const profile=root.GFAutoCOBProfile.inspect({host,nowMs});
 const coverage=root.GFMealCoverageStudy.inspect({host,nowMs,acknowledgement:ack,kineticsByMealId:profile.kineticsByMealId});
 return {host,profile,coverage};
}
function optionsForRevision(host,nowMs=Date.now()){
 if(!host||host!==getHost()||!root.GFAutoCOBProfile||!root.GFMealCoverageStudy)return {};
 bindHost(host);
 const profile=root.GFAutoCOBProfile.inspect({host,nowMs});
 if(profile.status!=='RESEARCH_PROFILES_READY')return {};
 const coverage=root.GFMealCoverageStudy.inspect({host,nowMs,acknowledgement:ack,kineticsByMealId:profile.kineticsByMealId});
 return coverage.eligible&&coverage.researchOptions?{...coverage.researchOptions,mealCoverageRevision:coverage.sourceRevision}:{};
}
function populate(node,state){node.replaceChildren();node.append(el('strong','Профиль усвоения из «Моей тарелки» · исследовательский'));
 node.append(el('p','Профиль выбирается автоматически по углеводно-взвешенному ГИ и жирам фактически съеденной порции. Ручной ввод времени не нужен. Часы — непроверенные модельные ориентиры, не фактическая скорость усвоения.'));
 if(!state){node.append(el('p','GFStorage недоступен'));return;}
 const {host,profile,coverage}=state;
 const subtitle=el('p','Данные: '+(profile.status||'UNKNOWN')+' · проверка истории: '+(coverage.code||'UNKNOWN'));subtitle.className='soft';node.append(subtitle);
 for(const row of profile.rows||[]){const box=el('div');box.className='w06c-meal';
  box.append(el('div',String(row.mealId)+' · съедено углеводов: '+(row.recordedCarbsG??'неизвестно')+' г'));
  if(row.status==='RESEARCH_PROFILE'){
   box.append(el('div','Профиль: '+row.label));
   box.append(el('div','Ориентировочный ГИ ≈ '+row.weightedGI+' · Ж '+row.recordedFatG+' г · Б '+row.recordedProteinG+' г'));
   box.append(el('small',row.estimatedGI?'ГИ из каталога оценочный. Скорость усвоения точно не известна.':'Данные ГИ сохранены из тарелки; скорость усвоения не измерялась.'));
   if(!row.compositionVerified)box.append(el('div','Состав оценочный: численный интервал COB не разрешён.'));
  }else box.append(el('div','Профиль не вычислен: '+row.code+' (исходные данные недостаточны).'));
  node.append(box);
 }
 if(profile.status!=='RESEARCH_PROFILES_READY')node.append(el('p','Для полного расчётного интервала нужны известные поля ГИ у всех углеводных продуктов. Старые приёмы пищи без перенесённого ГИ остаются неизвестными.'));
 node.append(el('p','Заявление о полноте истории — отдельная проверка, а не время усвоения. Даже подтверждение не гарантирует объективную полноту записей.'));
 const btn=el('button','Подтверждаю, что вся съеденная еда за последние 12 ч 15 мин записана');btn.type='button';
 btn.disabled=profile.status!=='RESEARCH_PROFILES_READY'||!coverage.mealRows?.length||['AMBIGUOUS_MEAL_TIME','UNFINISHED_MEAL','CROSS_WINDOW_MEAL','FOOD_DATA_UNKNOWN','FUTURE_MEAL','REVISION_CHANGED','NO_CONFIRMED_MEALS_IN_WINDOW'].includes(coverage.code);
 btn.addEventListener('click',()=>{
  const active=getHost(),rev=bindHost(active);
  if(active!==host||rev!==coverage.sourceRevision){render();return;}
  const now=Date.now();
  ack={source:'user_declared',scope:'all_meals',confirmedComplete:true,sourceRevision:rev,startIso:new Date(now-12.25*3600000).toISOString(),endIso:new Date(now+15*60000).toISOString(),declaredAtIso:new Date(now).toISOString()};
  render();
 });
 node.append(btn);
 const reset=el('button','Сбросить подтверждение полноты');reset.type='button';reset.addEventListener('click',()=>{ack=null;render()});node.append(reset);
 if(coverage.eligible&&coverage.researchOptions){const cob=root.GFCOBResearch?.inspect?.({host,nowMs:Date.now(),...coverage.researchOptions});if(cob?.status==='RESEARCH_INTERVAL'){node.append(el('p','Исследовательский интервал COB: '+cob.lowerG.toFixed(1)+'–'+cob.upperG.toFixed(1)+' г. Не использовать для определения дозы или лечения.'));}}
}
function render(){if(!root.document)return;const state=data();for(const id of IDS){const node=root.document.getElementById(id);if(node)populate(node,state)}}
function clear(){revision=null;ack=null;render()}
function init(){if(initialised)return;initialised=true;render();root.document?.addEventListener?.('visibilitychange',()=>{if(!root.document.hidden)render()})}
return Object.freeze({VERSION:'0.2.0-research-candidate',init,render,clear,optionsForRevision});
});
