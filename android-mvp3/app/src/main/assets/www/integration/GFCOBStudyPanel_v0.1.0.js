/* ГлюкоПапа · W06c / GFCOBStudyPanel v0.1.0 · research controls, session-only.
 * No saved parallel database, no defaults, no dose. UI external to APPROVED LOW/HIGH.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFCOBStudyPanel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';let currentRevision=null,ack=null,parameters={},initDone=false;
const IDS=['w06cStudyLow','w06cStudyHigh'];
function doc(){return root.document}
function snapshot(nowMs=Date.now()){
 const host=root.GPApp?.getStorage?.();
 if(!host||!root.GFMealCoverageStudy)return null;
 const rev=host.connect('research').getRevision();
 if(rev!==currentRevision){currentRevision=rev;ack=null;parameters={}}
 return root.GFMealCoverageStudy.inspect({host,nowMs,acknowledgement:ack,kineticsByMealId:parameters});
}
function optionsForRevision(host,nowMs=Date.now()){
 if(!host||!root.GFMealCoverageStudy)return {};
 const rev=host.connect('research').getRevision();
 if(rev!==currentRevision){currentRevision=rev;ack=null;parameters={}}
 const r=root.GFMealCoverageStudy.inspect({host,nowMs,acknowledgement:ack,kineticsByMealId:parameters});
 return r.eligible&&r.researchOptions?r.researchOptions:{};
}
function clear(){currentRevision=null;ack=null;parameters={};render()}
function element(tag,text){const e=doc().createElement(tag);if(text!==undefined)e.textContent=text;return e}
function field(row,key,label,min,max){const cell=element('label');cell.style.display='inline-block';cell.style.marginRight='8px';cell.textContent=label+' ';
 const input=element('input');input.type='number';input.min=String(min);input.max=String(max);input.step='1';input.style.width='76px';input.placeholder='введите';input.setAttribute('aria-label',label+' '+row.id);
 const old=parameters[row.id]?.[key];if(Number.isFinite(old))input.value=String(old);
 input.addEventListener('change',()=>{const v=input.value.trim();parameters[row.id]||={origin:'explicit_research_scenario'};parameters[row.id][key]=v===''?null:Number(v);root.setTimeout?.(render,0)});cell.appendChild(input);return cell}
function populate(node,report){node.replaceChildren();const strong=element('strong','Исследовательское усвоение еды · W06c');node.append(strong);
 const status=element('div',report?'Состояние: '+report.code+' · ревизия '+(report.sourceRevision??'—'):'Недоступно');status.className='soft';node.append(status);
 node.append(element('p','Проверка не подтверждает полноту дневника. Ни одно значение не используется как доза или рекомендация. Ввод только на время открытого сеанса; после перезагрузки нужно повторить.'));
 if(!report)return;
 if(report.mealRows?.length){for(const m of report.mealRows){const box=element('div');box.className='w06c-meal';box.append(element('div',m.id+' · углеводы по факту: '+m.carbsRecordedG+' г · '+m.startedAt));box.append(field(m,'lagMinutes','Задержка, мин',0,120));box.append(field(m,'fastDurationMinutes','Быстрое полное усвоение, мин',15,720));box.append(field(m,'slowDurationMinutes','Медленное полное усвоение, мин',15,720));node.append(box)}}
 const btn=element('button','Я вручную подтвердил(а) полноту записей еды за последние 12 ч 15 мин');btn.type='button';btn.disabled=!report.mealRows?.length||['AMBIGUOUS_MEAL_TIME','UNFINISHED_MEAL','CROSS_WINDOW_MEAL','FOOD_DATA_UNKNOWN','FUTURE_MEAL','REVISION_CHANGED','NO_CONFIRMED_MEALS_IN_WINDOW'].includes(report.code);
 btn.addEventListener('click',()=>{const host=root.GPApp?.getStorage?.();if(!host)return;const now=Date.now();const rev=host.connect('research').getRevision();ack={source:'user_declared',scope:'all_meals',confirmedComplete:true,sourceRevision:rev,startIso:new Date(now-12.25*3600000).toISOString(),endIso:new Date(now+15*60000).toISOString(),declaredAtIso:new Date(now).toISOString()};render()});node.append(btn);
 const reset=element('button','Сбросить исследовательское подтверждение');reset.type='button';reset.addEventListener('click',()=>{ack=null;parameters={};render()});node.append(reset);
 if(report.eligible&&report.researchOptions){const host=root.GPApp?.getStorage?.();const cob=root.GFCOBResearch?.inspect?.({host,nowMs:Date.now(),...report.researchOptions});if(cob?.status==='RESEARCH_INTERVAL')node.append(element('p','Сценарный интервал COB: '+cob.lowerG.toFixed(2)+'–'+cob.upperG.toFixed(2)+' г. Не для дозирования.'))}
}
function render(){if(!doc())return;const r=snapshot();for(const id of IDS){const node=doc().getElementById(id);if(node)populate(node,r)}}
function init(){if(initDone)return;initDone=true;render();doc()?.addEventListener?.('visibilitychange',()=>{if(!doc().hidden)render()});root.GPApp?.getStorage?.()?.connect?.('journal')?.subscribe?.(()=>render())}
return Object.freeze({init,render,optionsForRevision,clear});
});
