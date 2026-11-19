/* ГлюкоПапа V2 · approved v5 surface, replaced experimental calculation internals.
   No localStorage for patient records; user changes to food are what-if only.
 */
(()=>{'use strict';
const el=id=>document.getElementById(id),fmt=(n,d=1)=>Number.isFinite(n)?n.toLocaleString('ru-RU',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
let testProfileId='T10',testPeriod='auto';let snapshot=null,mode='none',lastResult=null,lastAmount=null,writer=null,savedSignature=null,version=0,activityService=null,activityHost=null,activityConfig={enabled:true,level:'none',overrides:null};
const demoFoods={
 juice:{name:'Яблочный сок (демо)',carbsPer100:10,absorptionTauMin:40,unit:'мл'},
 marshmallow:{name:'Зефир (демо)',carbsPer100:78,absorptionTauMin:65,unit:'г'},
 crisp:{name:'Хлебец (демо)',carbsPer100:68,absorptionTauMin:105,unit:'г'},
 candy:{name:'Конфета (демо)',carbsPer100:75,absorptionTauMin:60,unit:'г'},
 apple:{name:'Яблоко (демо)',carbsPer100:11,absorptionTauMin:100,unit:'г'},
 pear:{name:'Груша (демо)',carbsPer100:10,absorptionTauMin:110,unit:'г'}
};
const phase=(n,m)=>{const t=new Date(n+m*60000);return t.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});};
function createDemo(){const coef=GFVirtualProfileBridge.getDemoCoefficients(testProfileId,testPeriod);const now=Date.now();const iso=m=>new Date(now+m*60000).toISOString();return {nowIso:iso(0),cgm:[...Array(9)].map((_,i)=>({measuredAt:iso(-40+i*5),receivedAt:iso(-39+i*5),glucoseMmol:Number((4.15-.065*i).toFixed(3)),sourceId:'DEMO-GS1',sensorId:'DEMO-SENSOR'})),
 injections:[{id:'demo-inj',insulinId:'rinfast',units:.5,status:'confirmed',administeredAt:iso(-145)}],
 meals:[{id:'demo-meal',status:'confirmed',eatenAt:iso(-70),carbsG:8,absorptionTauMin:60}],
 settings:{isfMmolPerUnit:coef.isfMmolPerUnit,carbRatioGPerUnit:coef.carbRatioGPerUnit,mealTauMin:60},historyComplete:true,virtualFixtureId:'demo_cgm_2026_11_13_14_user_metadata_update_v02',testProfileId:coef.profileId,testPeriod:coef.period,
 products:demoFoods,conditions:{activity:false,illness:false},synthetic:true};}

function installVirtualProfileControls(){
 const section=el('gfHypoSource');if(!section||el('gfTestProfile'))return;
 const holder=document.createElement('div');holder.id='gfVirtualProfilePanel';holder.style.cssText='border-top:1px solid #d7e3e6;padding-top:10px;margin-top:12px';
 holder.innerHTML='<strong style="font-size:12px">Тестовый профиль ребёнка · 13–14.11.2026</strong>'+
  '<div id="gfVirtualFacts" class="smallhint" style="margin:7px 0">Возраст 7 лет · вес 20 кг · рост 120 см. 14.11 в 07:00 Левемир 1 ЕД (подтверждённый исторический факт). Эти сведения не задают коэффициенты расчёта.</div>'+
  '<div class="smallhint" style="margin:6px 0">ФЧИ и УК ребёнка НЕ определены. Выбранный набор T10/A/B/C — условная тестовая модель, не коэффициенты ребёнка. CGM на экране синтетический, не восстановлен из сводки xDrip+.</div>'+
  '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0">'+
  '<label style="font-size:11px">Набор коэффициентов<select id="gfTestProfile" class="input" style="width:100%;margin-top:4px"><option value="T10" selected>T10 · УК 10 г/ЕД</option><option value="A">A · условный</option><option value="B">B · условный</option><option value="C">C · условный</option></select></label>'+
  '<label style="font-size:11px">Временной период<select id="gfTestPeriod" class="input" style="width:100%;margin-top:4px"><option value="auto">Авто · Минск</option><option value="morning">Утро 06–11</option><option value="day">День 11–17</option><option value="evening">Вечер/ночь 17–06</option></select></label></div>'+
  '<div class="smallhint" id="gfTestCoefSummary" role="status" style="padding:8px;border-radius:8px;background:#f1f5f7"></div>';
 section.appendChild(holder);
 const badge=document.createElement('div');badge.id='gfVirtualProfileBadge';badge.setAttribute('role','status');badge.style.cssText='font-size:11px;line-height:1.5;border:1px solid #dce9ec;border-radius:8px;padding:9px 11px;margin:11px 0;color:#4a6370;background:#f6f9fa';
 badge.textContent='ДЕМО · профиль 7 лет, 20 кг, 120 см · личные коэффициенты неизвестны';
 const summary=el('lowPane').querySelector('.summary');if(summary)summary.insertAdjacentElement('afterend',badge);
 for(const [id,key] of [['gfTestProfile','profile'],['gfTestPeriod','period']])el(id).addEventListener('change',()=>{
   testProfileId=el('gfTestProfile').value;testPeriod=el('gfTestPeriod').value;
   if(mode==='demo'&&snapshot?.virtualFixtureId==='demo_cgm_2026_11_13_14_user_metadata_update_v02'){
     const c=GFVirtualProfileBridge.getDemoCoefficients(testProfileId,testPeriod);
     snapshot.settings={...snapshot.settings,isfMmolPerUnit:c.isfMmolPerUnit,carbRatioGPerUnit:c.carbRatioGPerUnit};
     snapshot.testProfileId=c.profileId;snapshot.testPeriod=c.period;
     draw();
   }
   updateVirtualProfileControls();
 });
 updateVirtualProfileControls();
}
function updateVirtualProfileControls(){
 if(!el('gfTestCoefSummary'))return;
 const ownDemo=mode==='demo'&&snapshot?.virtualFixtureId==='demo_cgm_2026_11_13_14_user_metadata_update_v02';
 el('gfTestProfile').disabled=!ownDemo;el('gfTestPeriod').disabled=!ownDemo;
 const x=GFVirtualProfileBridge.getDemoCoefficients(testProfileId,testPeriod);
 el('gfTestCoefSummary').textContent=ownDemo?`Набор ${x.profileId} · ${x.periodText} · ФЧИ ${fmt(x.isfMmolPerUnit,1)} ммоль/л/ЕД · УК ${fmt(x.carbRatioGPerUnit,1)} г/ЕД. Не индивидуальные коэффициенты.`:'ФЧИ и УК тестовой модели не используются для реального снимка GFStorage.';
 if(el('gfVirtualProfileBadge'))el('gfVirtualProfileBadge').textContent=ownDemo?
  `ДЕМО · 7 лет · 20 кг · 120 см · тестовый набор ${x.profileId}, ${x.periodText.toLowerCase()} · ФЧИ ${fmt(x.isfMmolPerUnit,1)}, УК ${fmt(x.carbRatioGPerUnit,1)} (условные)`:
  'Реальные данные GFStorage: тестовые коэффициенты T10/A/B/C не подставляются.';
}

function panel(){const old=el('lowResult');let p=el('gfHypoResult');if(!p){p=document.createElement('div');p.id='gfHypoResult';p.className='result visible';old.insertAdjacentElement('afterend',p)}return p;}
function sourcePanel(){const low=el('lowPane');if(el('gfHypoSource'))return;
 const div=document.createElement('details');div.id='gfHypoSource';div.className='extra';div.innerHTML='<summary>Данные расчёта и источник</summary><div class="gf-hypo-tools"><span id="gfHypoMode">Нет данных</span> <button type="button" class="gf-hypo-small" id="gfDemo">Тестовый пример</button><label class="gf-hypo-small">Открыть снимок JSON<input type="file" id="gfImport" accept=".json,application/json" hidden></label></div><div class="smallhint">Для рабочего приложения снимок передаётся из единого GFStorage; HTML сам не обращается к xDrip+ и не хранит события.</div>';
 low.appendChild(div);el('gfDemo').addEventListener('click',()=>setContext(createDemo()));el('gfImport').addEventListener('change',async e=>{
   const f=e.target.files?.[0];if(!f)return;try{const d=JSON.parse(await f.text());if(d.mode==='DEMO_ONLY' || d.schema==='glucopapa.virtual_test_fixture.v2'){setContext(createDemo());el('gfHypoMode').textContent='Тестовая фикстура v0.3 · T10/A/B/C, без реальных коэффициентов';}else setContext(d)}catch(err){setContext(null);el('gfHypoMode').textContent='Ошибка JSON: '+String(err.message||err)}});
}
function applyProducts(){const select=el('product');const products=snapshot?.products;
 const current=select.value;select.innerHTML='';
 if(!products||typeof products!=='object'||!Object.keys(products).length){
   const option=document.createElement('option');option.value='';option.textContent='Нет доступного каталога';select.appendChild(option);
   select.disabled=true;return;
 }
 select.disabled=false;
 for(const [key,p] of Object.entries(products)){
  if(!p||typeof p.name!=='string')continue;const option=document.createElement('option');option.value=key;option.textContent=p.name;select.appendChild(option);
 }
 if([...select.options].some(o=>o.value===current))select.value=current;
}
function setContext(s){const previousMode=mode;
 snapshot=s&&typeof s==='object'?s:null;mode=!snapshot?'none':snapshot.synthetic?'demo':'gfstorage';version++;
 // Never carry a synthetic 100 g/ml preview into a real patient's snapshot.
 if(mode==='none'||(previousMode==='demo'&&mode==='gfstorage'))el('foodAmount').value='';
 applyProducts();el('gfHypoMode').textContent=mode==='demo'?'ДЕМО · данные вымышлены':mode==='gfstorage'?'Снимок GFStorage / JSON':'Данные не подключены';
 savedSignature=null;
 // Demonstration only: an initial test portion lets the product selector visibly
 // recalculate immediately. Never invent a default portion for real GFStorage data.
 if(mode==='demo'&&previousMode!=='demo')el('lowTarget').value='6.0';
 if(mode==='demo' && el('foodAmount').value.trim()==='')el('foodAmount').value='100';
 updateVirtualProfileControls();draw();}
function normalized(){const d=snapshot;if(!d)return {status:'INCOMPLETE',errors:['Нет данных GFStorage']};
 const n=GFHypoStorageAdapter.adapt({...d,nowIso:d.synthetic?new Date().toISOString():(d.nowIso||new Date().toISOString())});
 return n;
}
function product(){const p=snapshot?.products?.[el('product').value];return p&&typeof p==='object'?p:null}
function readyContext(){const context=normalized();const p=product();return {context,p};}
function message(status,details=''){const live=el('gfHypoLive');if(live)live.textContent=status+(details?' · '+details:'');const r=panel();r.innerHTML='<div class="result-kicker">РАСЧЁТ ПО ДАННЫМ</div><div class="result-note"></div><div class="recommend"><b></b></div>';
 r.querySelector('.result-note').textContent=status;r.querySelector('.recommend b').textContent=details;r.classList.add('visible');}
const path=(pts,key,x,y)=>pts.filter(p=>Number.isFinite(p[key])).map((p,i)=>(i?'L':'M')+x(p.horizonMin).toFixed(1)+','+y(p[key]).toFixed(1)).join(' ');
function makeSvg(result){
 const points=result.points, all=[result.targetMmol,...points.map(p=>p.withMmol??p.withoutMmol),...points.map(p=>p.withoutMmol)],low=Math.max(0,Math.floor((Math.min(...all)-.6)*2)/2),high=Math.max(low+2,Math.ceil((Math.max(...all)+.6)*2)/2), x=t=>37+(t/120)*286,y=v=>127-(v-low)/(high-low)*108;
 const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 340 154');svg.setAttribute('role','img');svg.setAttribute('aria-label','Модельный прогноз глюкозы в ммоль/л. Цифры у зелёной и серой кривых показывают расчётные значения через 0, 30, 60, 90 и 120 минут.');svg.style.cssText='display:block;width:100%;height:auto;margin-top:7px';
 const line=(d,color,dash,w)=>{const e=document.createElementNS(ns,'path');e.setAttribute('d',d);e.setAttribute('fill','none');e.setAttribute('stroke',color);e.setAttribute('stroke-width',w);if(dash)e.setAttribute('stroke-dasharray',dash);svg.appendChild(e)};
 const text=(xx,yy,s)=>{const e=document.createElementNS(ns,'text');e.setAttribute('x',xx);e.setAttribute('y',yy);e.setAttribute('fill','#718b92');e.setAttribute('font-size','10');e.textContent=s;svg.appendChild(e)};
 for(const v of [3.9,5.5,8]){if(v<low||v>high)continue;line(`M37 ${y(v)} H330`,'#e5eeee','4 4',1);text(2,y(v)+3,fmt(v))}
 line('M37 12 V127 H330','#bed1d3','',1);
 const sy=y(result.targetMmol);if(sy>=0&&sy<=128){line(`M37 ${sy} H330`,'#b1c4b9','2 6',1);text(292,Math.max(10,sy-3),'цель')}
 line(path(points,'withoutMmol',x,y),'#88939e','5 4',2.5);
 if(result.amount!==null)line(path(points,'withMmol',x,y),'#159b83','6 3',2.8);
 for(const h of [0,30,60,90,120])text(x(h)-8,146,String(h));
 // Labels are computed from the same points that draw the curves. No separate
 // prediction formula and no cached numeric values. A single common label at t=0
 // prevents overlap of identical starting values. Per-series labels update on draw().
 const mark=(minute,value,series,side)=>{
   if(!Number.isFinite(value))return;
   const xx=x(minute),yy=y(value),color=series==='with'?'#087d69':'#627784';
   const dot=document.createElementNS(ns,'circle');dot.setAttribute('class','gf-chart-dot');dot.setAttribute('data-series',series);dot.setAttribute('data-minute',minute);dot.setAttribute('cx',xx.toFixed(2));dot.setAttribute('cy',yy.toFixed(2));dot.setAttribute('r','2.3');dot.setAttribute('stroke','#fff');dot.setAttribute('stroke-width','1.1');dot.setAttribute('fill',color);svg.appendChild(dot);
   const caption=document.createElementNS(ns,'text');caption.setAttribute('class','gf-chart-value');caption.setAttribute('data-series',series);caption.setAttribute('data-minute',minute);caption.setAttribute('data-value',value.toFixed(2));caption.setAttribute('x',Math.max(52,Math.min(311,xx)).toFixed(1));
   const preferred=yy+(side==='above'?-13:17);caption.setAttribute('y',Math.max(11,Math.min(135,preferred)).toFixed(1));
   caption.setAttribute('text-anchor','middle');caption.setAttribute('font-size','10');caption.setAttribute('font-weight','700');caption.setAttribute('fill',color);
   caption.setAttribute('stroke','#f9fdfc');caption.setAttribute('stroke-width','3.2');caption.setAttribute('stroke-linejoin','round');caption.setAttribute('paint-order','stroke');
   caption.textContent=fmt(value,2);svg.appendChild(caption);
 };
 for(const minute of [0,30,60,90,120]){
   const p=points.find(row=>row.horizonMin===minute);if(!p)continue;
   if(minute===0){mark(minute,p.withMmol??p.withoutMmol,result.amount!==null?'with':'without','above');continue;}
   mark(minute,p.withoutMmol,'without','below');
   if(result.amount!==null)mark(minute,p.withMmol,'with','above');
 }
 return svg;
}
function renderIob(ctx){const n=ctx?.context;if(!n||n.status!=='OK'){el('lowIob').textContent='—';el('lowIobMeta').textContent='История инъекций не подтверждена';el('lowIobTime').textContent='';return}
 const events=n.injections.map(x=>({...x,type:'insulin_injection'}));let r;
 try{r=RinfastEngine.calculate({nowIso:n.nowIso,events})}catch(e){r={status:'INCOMPLETE'}}
 if(r.status==='MODEL_ESTIMATE'){
  el('lowIob').textContent='≈ '+fmt(r.modelRemainingUnits,2)+' ЕД';el('lowIobMeta').textContent='РинФаст · подтверждённых инъекций: '+r.acceptedCount;el('lowIobTime').textContent='IOB показан отдельно; повторно не вычитается из сахара.';
 }else{el('lowIob').textContent='—';el('lowIobMeta').textContent='РинФаст: неполная история';el('lowIobTime').textContent=''}
}
function renderSummary(n){const box=el('lowPane').querySelector('.summary');if(!n||n.status!=='OK'){
  box.querySelector('.data-label').textContent='Данные CGM · нет достоверного снимка';box.querySelector('.big').textContent='—';box.querySelector('.tags').textContent='Ожидаем GFStorage';return;
 }
 const rows=n.readings.sort((a,b)=>Date.parse(a.measuredAt)-Date.parse(b.measuredAt));const last=rows.at(-1);
 box.querySelector('.data-label').textContent=mode==='demo'?'CGM · тестовый пример':'CGM · последний зарегистрированный замер';
 const big=box.querySelector('.big');big.textContent=fmt(last.glucoseMmol,2);
 const first=rows[0],dt=(Date.parse(last.measuredAt)-Date.parse(first.measuredAt))/60000;const slope=dt>0?(last.glucoseMmol-first.glucoseMmol)/dt:0;const trend=slope<=-0.015?'↓ снижается':slope>=0.015?'↑ повышается':'→ стабильно';
 box.querySelector('.unit').textContent='ммоль/л · '+trend;box.querySelector('.tags').textContent=mode==='demo'?'CGM · тестовый тренд '+fmt(slope,3)+' ммоль/л/мин':'CGM · '+new Date(last.measuredAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+' · '+trend;
}
function showLive(r,p){
 const label=el('gfHypoLive');if(!label)return;
 const activity=el('gfApprovedActivity')?.value||'none';
 const activityText={none:'',low:'Низкая',normal:'Обычная',high:'Высокая',sport:'Спорт'}[activity]||'';
 const prefix=r.amount===null?`Выбран ${p.name}. Для прогноза с едой введите количество.`:
   `Выбрано: ${fmt(r.amount,1)} ${r.unit} — через ${r.horizonMin} мин ≈ ${fmt(r.withAtHorizon,2)} ммоль/л.`;
 const desired=r.modelAmount===null?'Подбор для цели сейчас недоступен.':
   `Цель ${fmt(r.targetMmol,1)}: модельная порция ${fmt(r.modelAmount,1)} ${r.unit}.`;
 const act=activityText?` Активность: ${activityText.toLowerCase()}, множитель ${fmt(r.activity.factor,2)}${r.activity.enabled?'':' (отключён)'}.`:'';
 label.textContent=prefix+' '+desired+act;
}
function show(r,p,ctx){const box=panel();box.innerHTML='';
 const kicker=document.createElement('div');kicker.className='result-kicker';kicker.textContent=mode==='demo'?'ТЕСТОВЫЙ ПРОГНОЗ · 2 СЦЕНАРИЯ':'МОДЕЛЬНЫЙ ПРОГНОЗ · 2 СЦЕНАРИЯ';box.append(kicker);
 const title=document.createElement('div');title.className='result-number';title.textContent=r.withAtHorizon===null?'—':'≈ '+fmt(r.withAtHorizon,2)+' ммоль/л';box.append(title);
 const note=document.createElement('div');note.className='result-note';note.textContent='Через '+r.horizonMin+' мин · без новой еды: '+fmt(r.baselineAtHorizon,2)+' · цель: '+fmt(r.targetMmol,1);box.append(note);
 const details=document.createElement('div');details.className='result-row';const m=r.amount===null?'—':fmt(r.amount,1)+' '+r.unit;details.innerHTML='<span>Выбранная порция</span><strong></strong>';details.querySelector('strong').textContent=m;box.append(details);
 const carbs=document.createElement('div');carbs.className='result-row';carbs.innerHTML='<span>Углеводы</span><strong></strong>';carbs.querySelector('strong').textContent=r.carbsG===null?'—':fmt(r.carbsG,1)+' г';box.append(carbs);
 const min=document.createElement('div');min.className='result-row';min.innerHTML='<span>Минимум за 120 минут</span><strong></strong>';min.querySelector('strong').textContent=r.scenarioMin===null?'—':fmt(r.scenarioMin,2)+' ммоль/л';box.append(min);
 box.append(makeSvg(r));
 const leg=document.createElement('p');leg.className='smallhint';leg.textContent='Серый пунктир — без новой еды; зелёный — с выбранной порцией. Числа у кривых — прогноз глюкозы в ммоль/л через 0, 30, 60, 90 и 120 минут, не измеренные значения.';box.append(leg);
 const model=document.createElement('div');model.className='recommend';const b=document.createElement('b');b.textContent='Для цели в выбранной модели';model.append(b);
 const v=document.createElement('span');v.textContent=r.modelAmountStatus==='OUTSIDE_RANGE'?'Цель вне диапазона проверки':fmt(r.modelAmount,1)+' '+r.unit+' (только математический сценарий)';model.append(v);box.append(model);
 const formula=document.createElement('details');formula.className='extra';formula.innerHTML='<summary>Расчёт</summary><div class="smallhint" id="gfFormulaText"></div>';box.append(formula);
 formula.querySelector('#gfFormulaText').textContent=`Активность: ${r.activity.levelLabel||'Не указана'}, учёт ${r.activity.enabled?'включён':'выключен'}, K=${fmt(r.activity.factor,2)} (${r.activity.source}, модельный параметр). Gбез(${r.horizonMin})=${fmt(r.baselineAtHorizon,2)}. Кугл=ФЧИ/УК=${fmt(ctx.settings.isfMmolPerUnit,2)}/${fmt(ctx.settings.carbRatioGPerUnit,2)}=${fmt(r.kCarbsMmolPerG,4)} ммоль/л/г. Gc едой = Gбез + ${fmt(r.carbsG??0,2)} г × Кугл / K × F(${r.horizonMin} мин; τ=${p.absorptionTauMin} мин). Минимум без еды: ${fmt(r.baselineMin,2)}. Данные: CGM, РинФаст, подтверждённая еда. Остаточный тренд рассчитан без двойного учёта.`;
 const foot=document.createElement('div');foot.className='smallhint';foot.textContent=mode==='demo'&&snapshot?.virtualFixtureId?'Набор '+snapshot.testProfileId+' является условным. Реальные индивидуальные коэффициенты неизвестны. Модель не предназначена для лечения.':'Модель не прошла клиническую проверку для ребёнка. Расчёт не равен рекомендации по лечению.';box.append(foot);
 const given=document.createElement('button');given.id='gfFoodGiven';given.className='outline';given.textContent='✓ Дал еду · записать факт';given.disabled=mode==='none'||!Number.isFinite(r.carbsG)||r.amount<=0;given.onclick=()=>confirmMeal(r,p);box.append(given);
 const stamp=document.createElement('div');stamp.id='gfSaved';stamp.className='stamp';box.append(stamp);
 box.classList.add('visible');
 showLive(r,p);
}
async function confirmMeal(r,p){const status=el('gfSaved'),sig=JSON.stringify([snapshot?.nowIso,r.productName,r.amount,r.carbsG]);if(sig===savedSignature){status.textContent='Эта порция уже была подтверждена';status.classList.add('show');return}
 if(!writer){status.textContent='Запись не выполнена: требуется подключение единого GFStorage через оболочку V2.';status.classList.add('show');return;}
 const item={id:'hypo-'+Date.now().toString(36),performedAt:new Date().toISOString(),productId:el('product').value,productName:p.name,amount:r.amount,unit:r.unit,carbsPer100:p.carbsPer100,carbsG:r.carbsG};
 try{const out=await writer(item);if(out===false)throw Error('Хранилище не подтвердило запись');savedSignature=sig;status.textContent='✓ Факт записан в GFStorage';status.classList.add('show')}catch(e){status.textContent='Ошибка записи: '+String(e.message||e);status.classList.add('show');}
}
function draw(){const n=normalized();renderSummary(n);renderIob({context:n});const p=product();
 const target=Number(el('lowTarget').value),qtyText=el('foodAmount').value.trim(),amount=qtyText===''?null:Number(qtyText),horizon=Number(el('gfHorizon')?.value||60);
 if(n.status!=='OK'){lastResult=null;message('Нет данных для расчёта',n.errors.join('; '));return}
 if(!p){lastResult=null;message('Выберите продукт с проверенным составом');return}
 el('foodLabel').textContent=`${p.name} · ${p.carbsPer100} г углеводов на 100 ${p.unit} · τ=${p.absorptionTauMin} мин (параметр модели)`;
 el('foodUnit').innerHTML='<option>'+p.unit+'</option>';
 const request={...n,product:p,targetMmol:target,horizonMin:horizon,amount,synthetic:mode==='demo',hypoActivity:effectiveActivity()};
 const result=GFHypoScenario.run(request,GFForecastHypo,RinfastEngine,GFHypoActivity);
 lastResult=result.status==='MODEL_SCENARIO'?result:null;
 if(lastResult)show(lastResult,p,n);else message(result.message||'Невозможно рассчитать',result.code||'');
}
function choose(){const n=normalized(),p=product();if(n.status!=='OK'||!p){draw();return}
 const r=GFHypoScenario.run({...n,product:p,targetMmol:Number(el('lowTarget').value),horizonMin:Number(el('gfHorizon').value),amount:null,synthetic:mode==='demo',hypoActivity:effectiveActivity()},GFForecastHypo,RinfastEngine,GFHypoActivity);
 if(r.status!=='MODEL_SCENARIO'||r.modelAmount===null||r.modelAmount>500){
   draw();const live=el('gfHypoLive');if(live)live.textContent=
   r.status!=='MODEL_SCENARIO'?(r.message||'Расчёт для выбранных условий недоступен'):
   'Для заданной цели автоматическое заполнение порции недоступно. Проверьте расчёт и параметры.';
   return;
 }
 // Solver explores a model scenario; no automated recording or treatment action.
 el('foodAmount').value=String(r.modelAmount);draw();el('gfHypoResult').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function effectiveActivity(){
 return {enabled:activityConfig.enabled&&mode==='demo',level:activityConfig.level,overrides:activityConfig.overrides};
}
function readActivityFromProfile(profile){
 activityConfig={enabled:profile?.hypoActivityEnabled!==false,
   level:activityConfig.level,overrides:profile?.hypoActivityMultipliers||null};
 GFHypoActivity.select(effectiveActivity());
 const sel=el('gfApprovedActivity');if(sel)sel.value=activityConfig.level;
 updateActivityInputs();draw();
}
function updateActivityInputs(){
 const effective=activityConfig.overrides||GFHypoActivity.DEFAULTS;
 const checkbox=el('gfHypoActivityEnabled');if(checkbox)checkbox.checked=activityConfig.enabled;
 for(const k of ['low','normal','high','sport']){
   const item=el('gfHypoMultiplier_'+k);if(item)item.value=effective[k].toFixed(2);
 }
 const label=el('gfHypoActivitySource');if(label)label.textContent=(activityConfig.overrides?'Задано пользователем':'Тестовые значения по умолчанию')+' · не норматив ISPAD';
}
function persistActivity(patch){
 if(!activityService){
   activityConfig={...activityConfig,...patch};if(snapshot)snapshot.conditions={...(snapshot.conditions||{}),activity:activityConfig.enabled&&activityConfig.level!=='none'};updateActivityInputs();draw();
   if(el('gfHypoActivityNotice'))el('gfHypoActivityNotice').textContent='Изменено в этом HTML; постоянное сохранение доступно через GFSettings/GFStorage V2.';
   return;
 }
 try{
   if('overrides' in patch)activityService.saveHypoActivityMultipliers(patch.overrides,activityService.getRevision());
   if('enabled' in patch)activityService.saveHypoActivityEnabled(patch.enabled,activityService.getRevision());
   const profile=activityService.getView().profile;
   activityConfig={...activityConfig,enabled:profile.hypoActivityEnabled!==false,overrides:profile.hypoActivityMultipliers||null};
   if(snapshot)snapshot.conditions={...(snapshot.conditions||{}),activity:activityConfig.enabled&&activityConfig.level!=='none'};
   updateActivityInputs();draw();
   if(el('gfHypoActivityNotice'))el('gfHypoActivityNotice').textContent='✓ Настройки сохранены в едином GFStorage.';
 }catch(e){
   if(el('gfHypoActivityNotice'))el('gfHypoActivityNotice').textContent='Не удалось сохранить: '+String(e.message||e);
   updateActivityInputs();
 }
}
function activityTools(){
 const select=el('gfApprovedActivity');if(!select)return;
 select.innerHTML='<option value="none">Не указана</option><option value="low">Низкая</option><option value="normal">Обычная</option><option value="high">Высокая</option><option value="sport">Спорт / очень высокая</option>';
 select.value=activityConfig.level;
 const wrap=select.closest('.field');if(!wrap)return;
 const hint=wrap.querySelector('.smallhint');if(hint)hint.textContent='Экспериментальные множители для теста прогноза; не рекомендации по количеству быстрых углеводов.';
 const div=document.createElement('details');div.className='extra';div.id='gfHypoActivitySettings';
 div.innerHTML='<summary>Настроить коэффициенты активности</summary>'+
   '<label class="gf-hypo-switch" style="display:flex;align-items:center;gap:10px;margin:12px 0 6px"><input id="gfHypoActivityEnabled" type="checkbox" checked> Учитывать активность в расчёте</label>'+
   '<div class="smallhint">При выключении K = 1,00. Выбранный уровень сохраняется.</div>'+
   '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px">'+
   ['low','normal','high','sport'].map(k=>'<label style="font-size:11px">'+GFHypoActivity.LEVELS[k]+'<input class="input" type="number" id="gfHypoMultiplier_'+k+'" min="0.5" max="2" step="0.01" style="width:100%;margin-top:5px" /></label>').join('')+'</div>'+
   '<div id="gfHypoActivitySource" class="smallhint" style="margin-top:9px"></div>'+
   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="outline" type="button" id="gfHypoSaveActivity">Сохранить коэффициенты</button><button class="outline" type="button" id="gfHypoResetActivity">По умолчанию</button></div>'+
   '<div id="gfHypoActivityNotice" class="smallhint" role="status" style="margin-top:8px"></div>';
 wrap.insertAdjacentElement('afterend',div);
 // Keep the user-requested on/off switch visible, outside collapsed settings.
 const visibleToggle=div.querySelector('.gf-hypo-switch');const note=visibleToggle.nextElementSibling;
 div.insertAdjacentElement('beforebegin',visibleToggle);
 visibleToggle.insertAdjacentElement('afterend',note);
 visibleToggle.classList.add('gf-hypo-toggle-visible');
 el('gfHypoActivityEnabled').addEventListener('change',e=>persistActivity({enabled:e.target.checked}));
 el('gfHypoSaveActivity').addEventListener('click',()=>{
   const values=Object.fromEntries(['low','normal','high','sport'].map(k=>[k,Number(el('gfHypoMultiplier_'+k).value)]));
   try{
     for(const k of Object.keys(values))if(el('gfHypoMultiplier_'+k).value.trim()==='')throw Error('Заполните все коэффициенты');
     GFHypoActivity.validate({version:1,source:'user_override',...values,editedAt:new Date().toISOString()});
     persistActivity({overrides:values});
   }catch(e){el('gfHypoActivityNotice').textContent='Ошибка: '+e.message;}
 });
 el('gfHypoResetActivity').addEventListener('click',()=>persistActivity({overrides:null}));
 updateActivityInputs();
}
function wiring(){
 sourcePanel();installVirtualProfileControls();panel();el('lowResult').setAttribute('aria-hidden','true');
 // This standalone preview only covers LOW; the legacy HIGH educational calculator is not part of this release.
 for(const id of ['openHigh','navHigh']){const b=el(id);if(b){b.disabled=true;b.title='Высокий сахар проверяется отдельно';}}
 const foodHint=el('foodAmount')?.closest('.field')?.querySelector('.smallhint');if(foodHint)foodHint.textContent='Изменяйте количество — модельный прогноз и график обновятся сразу.';
 const iobFoot=el('lowPane').querySelector('.iob-foot');if(iobFoot)iobFoot.textContent='IOB из подтверждённой истории РинФаста; повторно из прогноза не вычитается.';
 const oldScenario=el('gf30ScenarioLow');if(oldScenario)oldScenario.parentElement.style.display='none';
 // Compact status stays beside the original quantity field: switching product or target
 // changes a visible number without forcing the user to scroll to the forecast plot.
 const amountField=el('foodAmount')?.closest('.field');
 if(amountField && !el('gfHypoLive')){
   const info=document.createElement('div');info.id='gfHypoLive';info.className='smallhint';
   info.style.cssText='margin:10px 0 2px;padding:10px 12px;border-radius:10px;background:#edf8f5;color:#196d69;font-size:12px;line-height:1.45';
   info.setAttribute('role','status');info.setAttribute('aria-live','polite');amountField.appendChild(info);
 }
 const activitySelect=el('lowPane').querySelector('.gf-approved-activity');
 if(activitySelect){activitySelect.id='gfApprovedActivity';activityTools();activitySelect.addEventListener('change',()=>{
    activityConfig.level=activitySelect.value;
    if(snapshot)snapshot.conditions={...(snapshot.conditions||{}),activity:activityConfig.enabled&&activityConfig.level!=='none',activityLevel:activityConfig.level};
    draw();
  });}
  // Preserve original layout, add horizon field only inside collapsed details
 const opts=document.createElement('details');opts.className='extra';opts.innerHTML='<summary>Время прогноза</summary><label for="gfHorizon">Показать прогноз через</label> <select id="gfHorizon" class="input" style="margin-top:5px"><option value="30">30 минут</option><option value="60" selected>60 минут</option><option value="90">90 минут</option><option value="120">120 минут</option></select>';
 el('lowPane').append(opts);el('gfHorizon').addEventListener('change',draw);
 // Capture before any legacy v5 callbacks to prevent the old toy math or demo diary writing.
 document.addEventListener('click',event=>{const id=event.target.closest('button')?.id;
  if(!['calcFood','foodGiven'].includes(id))return;event.preventDefault();event.stopImmediatePropagation();event.stopPropagation();if(id==='calcFood')choose();},true);
 document.addEventListener('input',event=>{if(!['foodAmount','lowTarget','lowPrevDose','lowPrevAge'].includes(event.target.id))return;
  event.stopImmediatePropagation();event.stopPropagation();if(['foodAmount','lowTarget'].includes(event.target.id))draw();},true);
 document.addEventListener('change',event=>{if(event.target.id!=='product')return;event.stopImmediatePropagation();event.stopPropagation();
  // Do not erase the amount: a product change is a what-if comparison with the same number in its own units.
  draw();},true);
 const style=document.createElement('style');style.textContent=' .gf-hypo-toggle-visible{justify-content:space-between;border:1px solid #d5e6e4;background:#f1f9f7;padding:12px 13px;border-radius:12px;color:#1f6260;font-weight:650}.gf-hypo-toggle-visible input[type=checkbox]{appearance:none;width:43px;min-width:43px;height:24px;background:#bdcdcd;border-radius:15px;position:relative;cursor:pointer;transition:background .14s}.gf-hypo-toggle-visible input[type=checkbox]:checked{background:#169c8c}.gf-hypo-toggle-visible input[type=checkbox]::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:white;transition:transform .14s}.gf-hypo-toggle-visible input[type=checkbox]:checked::after{transform:translateX(19px)}' + '#lowResult{display:none!important}#gf32-context-low{display:none!important}#lowFormula{display:none!important}#lowPane>.mini{display:none!important}#gfHypoResult.result{display:block}#lowPane .iob-card details{display:none!important}#lowPane .iob-fields{display:none}#lowPane .iob-foot{font-size:10px}#gfHypoSource{margin-top:18px} .gf-hypo-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}.gf-hypo-small{border:1px solid #d6e7e4;background:#f7fbfa;border-radius:7px;color:#287e78;padding:5px 8px;font-size:11px;cursor:pointer}';document.head.appendChild(style);
 // Override misleading old IOB status from the original demonstration after page settles.
 setTimeout(()=>{el('openLow').click();setContext(createDemo())},40);
}
window.GFHypoUI=Object.freeze({version:'0.3.5',getDemoProfile:()=>({profileId:testProfileId,period:testPeriod,coefficient:GFVirtualProfileBridge.getDemoCoefficients(testProfileId,testPeriod),isHistoricalCGM:false,isClinical:false}),setContext,bindWriter(fn){writer=typeof fn==='function'?fn:null},bindHost(host,settingsAndMeta={}){
  activityHost=host;activityService=null;try{if(globalThis.GFSettings){activityService=GFSettings.createSettingsService({settingsPort:host.connect('settings')});readActivityFromProfile(activityService.getView().profile);}}catch(e){activityService=null;}
  const a=GFHypoStorageAdapter.fromHost(host,settingsAndMeta);if(a.status!=='OK'){setContext(null);return a}setContext({...a,cgm:a.readings,products:settingsAndMeta.products,historyComplete:true});try{const p=host.connect('hypo');writer=typeof p.recordHypoCarbs==='function'?item=>p.recordHypoCarbs(item,p.getRevision()):null;}catch(_){writer=null}return a;},getScenario:()=>lastResult,getActivity:()=>({ ...activityConfig }),attachSettingsService(svc){activityService=svc;readActivityFromProfile(svc.getView().profile);},clear(){setContext(null)}});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wiring);else wiring();
})();