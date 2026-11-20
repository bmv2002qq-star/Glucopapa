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
 const snapshot=host.connect('research').getSnapshot();
 const model=root.GFMealAbsorption.selected(snapshot.profile);
 const profile=model.id==='GFCOB'?root.GFAutoCOBProfile.inspect({host,nowMs}):null;
 const coverage=root.GFMealCoverageStudy.inspect({host,nowMs,acknowledgement:ack,kineticsByMealId:profile?.kineticsByMealId});
 return {host,model,profile,coverage,nowMs};
}
function optionsForRevision(host,nowMs=Date.now()){
 if(!host||host!==getHost()||!root.GFAutoCOBProfile||!root.GFMealCoverageStudy)return {};
 bindHost(host);
 const state=data(nowMs);
 return state?.coverage.historyDeclaration?{
  historyDeclaration:state.coverage.historyDeclaration,mealCoverageRevision:state.coverage.sourceRevision,
  kineticsByMealId:state.coverage.researchOptions?.kineticsByMealId
 }:{};
}
function populate(node,state){node.replaceChildren();node.append(el('strong','История фактической еды'));
 if(!state){node.append(el('p','GFStorage недоступен'));return;}
 const {host,model,profile,coverage,nowMs}=state;
 const result=root.GFMealAbsorption.inspect({host,nowMs,options:{
  historyDeclaration:coverage.historyDeclaration,mealCoverageRevision:coverage.sourceRevision,
  kineticsByMealId:coverage.researchOptions?.kineticsByMealId
 }});
 const subtitle=el('p',model.id+' '+model.version+' · история: '+coverage.code);subtitle.className='soft';node.append(subtitle);
 if(model.id==='GFForecast'&&result.code==='SMOOTH_PROFILE_MISSING')
  node.append(el('p','Для плавной модели не определено, как получить параметр усвоения из состава записанного блюда.'));
 if(model.id==='GFCOB'&&profile?.rows?.length)
  node.append(el('p','Линейный профиль использует ГИ и жиры фактически съеденной порции.'));
 for(const row of profile?.rows||[]){const box=el('div');box.className='w06c-meal';
  box.append(el('div',String(row.mealId)+' · съедено углеводов: '+(row.recordedCarbsG??'неизвестно')+' г'));
  if(row.status==='RESEARCH_PROFILE'){
   box.append(el('div','Профиль: '+row.label));
   box.append(el('div','Ориентировочный ГИ ≈ '+row.weightedGI+' · Ж '+row.recordedFatG+' г · Б '+row.recordedProteinG+' г'));
   box.append(el('small',row.estimatedGI?'ГИ из каталога оценочный. Скорость усвоения точно не известна.':'Данные ГИ сохранены из тарелки; скорость усвоения не измерялась.'));
   if(!row.compositionVerified)box.append(el('div','Состав оценочный: численный интервал COB не разрешён.'));
  }else box.append(el('div','Профиль не вычислен: '+row.code+' (исходные данные недостаточны).'));
  node.append(box);
 }
 const label=coverage.mealRows?.length?'Подтверждаю, что вся съеденная еда за последние 12 часов записана':
  'Подтверждаю, что еды за последние 12 часов не было';
 const btn=el('button',label);btn.type='button';
 btn.disabled=coverage.status==='BLOCKED'||coverage.historyDeclaration!=null;
 btn.addEventListener('click',()=>{
  const active=getHost(),rev=bindHost(active);
  if(active!==host||rev!==coverage.sourceRevision){render();return;}
  const now=Date.now();
  ack={source:'user_declared',scope:'all_meals',confirmedComplete:true,sourceRevision:rev,startIso:new Date(now-12.25*3600000).toISOString(),endIso:new Date(now+15*60000).toISOString(),declaredAtIso:new Date(now).toISOString()};
  render();
  root.GFHighTargetView?.render();
  root.GFLOWView?.render();
 });
 node.append(btn);
 const reset=el('button','Сбросить подтверждение полноты');reset.type='button';reset.addEventListener('click',()=>{ack=null;render();root.GFHighTargetView?.render();root.GFLOWView?.render();});node.append(reset);
 if(result.status==='RESEARCH_INTERVAL')node.append(el('p','Исследовательский интервал COB: '+result.lowerG.toFixed(1)+'–'+result.upperG.toFixed(1)+' г.'));
 if(result.status==='MODEL_ZERO')node.append(el('p','В окне модели отсутствует вклад подтверждённой еды.'));
}
function render(){if(!root.document)return;const state=data();for(const id of IDS){
 const node=root.document.getElementById(id)??root.document.getElementById('iframeLowTarget')?.contentDocument?.getElementById(id);
 if(node)populate(node,state);
}}
function clear(){revision=null;ack=null;render()}
function init(){if(initialised)return;initialised=true;render();root.document?.addEventListener?.('visibilitychange',()=>{if(!root.document.hidden)render()})}
return Object.freeze({VERSION:'0.2.0-research-candidate',init,render,clear,optionsForRevision});
});
