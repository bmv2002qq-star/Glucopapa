/* Q03 standalone diagnostic view. Uses only native GFStorage shell read ports.
 * No writes, browser persistence, network, SQL or healthcare calculations.
 */
(function(){'use strict';
const tabs=[...document.querySelectorAll('[data-tab]')];const sections=[...document.querySelectorAll('main section')];
const filter=document.getElementById('eventFilter'),list=document.getElementById('eventList');
const metrics=[...document.querySelectorAll('#summary .metric strong')];
const detail=document.querySelector('#summary .metric')?.parentElement?.nextElementSibling;
const issueCard=document.querySelector('#issues .card');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let normalized=null;
const text={INVALID_UTC:'Недопустимая дата или неизвестный часовой пояс',INVALID_ID:'Некорректный идентификатор',DUPLICATE_ID:'Повторяющийся идентификатор',MEAL_LINK_CONFLICT:'Противоречивые ссылки на приём пищи',MEAL_LINK_UNRESOLVED:'Указанная сессия не найдена',MEAL_POSSIBLE_DUPLICATE:'Возможный повтор еды — только совпадение времени',MEAL_NUTRITION_UNKNOWN:'Нет подтверждённого состава или БЖУ',UNCONFIRMED_MEAL_NOT_COUNTED:'Неподтверждённая еда не учитывается',HISTORY_MAY_BE_TRUNCATED:'История может быть неполной',CGM_ID_UNKNOWN:'Идентификатор CGM отсутствует'};
function showIssues(){if(!issueCard)return;issueCard.querySelectorAll('.row').forEach(n=>n.remove());if(!normalized)return;
 for(const i of normalized.issues){const row=document.createElement('div');row.className='row';row.innerHTML='<div class="avatar">⚠️</div><div class="row-copy"><strong>'+escape(text[i.code]||i.code)+'</strong><small>'+escape(i.id||'Сведения о записи неизвестны')+'</small></div><span class="pill warn">Проверить</span>';issueCard.appendChild(row);}
 if(!normalized.issues.length){const p=document.createElement('p');p.className='small muted';p.textContent='Неоднозначных фактов в доступной проекции нет';issueCard.appendChild(p);}
}
function render(){const rows=normalized?.rows||[];const invalid=new Set(normalized?.issues.map(i=>i.id).filter(Boolean)||[]);
 const shown=rows.filter(r=>filter.value==='all'||(filter.value==='ok'?!invalid.has(r.id):invalid.has(r.id)));
 list.innerHTML=shown.map(r=>'<article class="event"><button type="button" aria-expanded="false"><span class="avatar">'+(r.kind==='mealSession'?'🍽️':r.kind==='cgm'?'📈':'📝')+'</span><span class="row-copy"><strong>'+escape(r.kind)+'</strong><small>'+escape(r.utc)+' · '+escape(r.id)+'</small></span><span class="pill '+(invalid.has(r.id)?'bad':'')+'">'+(invalid.has(r.id)?'Требует проверки':'Принято')+'</span><span class="arrow">⌄</span></button><div class="details"><dl class="pairs"><dt>Источник</dt><dd>'+escape(r.rawDomain)+' · индекс '+escape(r.rawIndex)+'</dd><dt>Время UTC</dt><dd>'+escape(r.utc)+'</dd><dt>Связь</dt><dd>'+escape(r.link||'не указана')+'</dd><dt>Углеводы</dt><dd>'+escape(r.carbsGrams===null?'не определены':r.carbsGrams+' г')+'</dd><dt>Оригинал</dt><dd>Сохранён без изменений</dd></dl></div></article>').join('')||'<p class="small muted">Нет записей для выбранного фильтра.</p>';
 list.querySelectorAll('.event>button').forEach(b=>b.addEventListener('click',()=>{const box=b.closest('.event'),open=!box.classList.contains('open');box.classList.toggle('open',open);b.setAttribute('aria-expanded',String(open));}));
}
function update(){if(!normalized)return;const s=normalized.summary;metrics[0].textContent=String(s.sourceCount);metrics[1].textContent=String(s.normalizedCount);metrics[2].textContent=String(s.issuesCount);if(detail)detail.textContent='GFStorage · ревизия '+normalized.revision+' · исходные данные только для чтения.';
 const all=filter.querySelector('option[value="all"]');if(all)all.textContent='Все '+s.normalizedCount+' записей';render();showIssues();}
function error(code){for(const x of metrics)x.textContent='—';if(detail)detail.textContent='Не удалось получить согласованную проекцию GFStorage: '+code+'. Синтетические данные не показываются.';
 list.innerHTML='<p class="small muted">Чтение недоступно: '+escape(code)+'</p>';if(issueCard){issueCard.querySelectorAll('.row').forEach(n=>n.remove());}
}
tabs.forEach(b=>b.addEventListener('click',()=>{tabs.forEach(x=>x.classList.toggle('active',x===b));sections.forEach(s=>s.hidden=s.id!==b.dataset.tab);if(b.dataset.tab==='events')render();}));filter.addEventListener('change',render);
try{if(!window.GFNormalizedFactsV3)throw Error('Q03_CORE_MISSING');normalized=window.GFNormalizedFactsV3.read(window.GPV3V3Bridge);update();}catch(e){error(e.code||e.message||'Q03_UNAVAILABLE');}
})();
