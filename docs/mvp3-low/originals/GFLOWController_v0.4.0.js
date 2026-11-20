/* UI adapter for approved LOW v0.2 markup. Does not own medical math or storage.
 * For preview only: options.previewFixture(glucose, trend, iob, cob, weight, activity).
 * For production: options.port.readSnapshot() adapter from the real GFStorage v5.
 * There is no automatic preview fallback and no storage writing.
 */
(function(root,factory){'use strict';const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFLOWController=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
'use strict';
const $=id=>document.getElementById(id), SVG='http://www.w3.org/2000/svg';
const fmt=(v,d=1)=>Number.isFinite(v)?v.toFixed(d).replace('.',','):'—';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const node=(type,attrs,text)=>{const el=document.createElementNS(SVG,type);for(const [k,v] of Object.entries(attrs||{}))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;};
function init(options={}){
 if(!root.GFLOWCore)throw new Error('Missing GFLOWCore');
 if(!options.previewFixture&&(!options.port||typeof options.port.readSnapshot!=='function'))throw new Error('GFStorage port is required');
 const CORE=root.GFLOWCore;
 let candidate=null,initialized=false;
 const getNumber=(id,fallback)=>{const n=Number.parseFloat($(id).value);return Number.isFinite(n)?n:fallback};
 const inputs=()=>({glucose:getNumber('glucose',3),trend:getNumber('trend',0),iob:getNumber('iob',0),
   cob:getNumber('cob',0),weight:getNumber('weight',20),activity:$('activity').value,
   goal:getNumber('goal',6),amount:getNumber('juice',60)});
 const getSnapshot=()=>{
  if(options.previewFixture)return options.previewFixture(inputs());
  const snap=CORE.readSnapshot(options.port);
  return snap;
 };
 const getProduct=()=> $('calcProduct').value==='apple'?'dobry_apple':$('calcProduct').value;
 function evaluate(amount){
  const snap=getSnapshot();if(snap.status==='INCOMPLETE')return {result:snap,snap};
  const output=CORE.evaluate(snap,{productId:getProduct(),horizonMin:120,targetMmol:getNumber('goal',6),amount});
  return {result:output,snap};
 }
 function fieldGlucose(snapshot){const arr=snapshot?.cgm;if(!Array.isArray(arr)||!arr.length)return null;return arr.at(-1)?.glucoseMmol;}
 function setAmount(v){if(!finite(v)||v<0||v>2000)return;const value=Math.round(v);$('juice').value=Math.min(200,value);$('juiceNumber').value=value;render();}
 function draw(r,goal,current){
  const svg=$('chart');svg.replaceChildren();
  if(!r||r.status!=='MODEL_SCENARIO'||!Array.isArray(r.points)||r.points.length===0)return;
  const pts=r.points,W=690,H=300,L=50,R=16,T=24,B=35;
  const numbers=pts.flatMap(p=>[p.withoutMmol,p.withMmol]).filter(finite),lo=Math.max(0,Math.floor((Math.min(...numbers,3.9,goal)-.5)*2)/2),hi=Math.max(lo+1,Math.ceil((Math.max(...numbers,3.9,goal)+.5)*2)/2);
  const x=t=>L+(W-L-R)*t/120,y=v=>H-B-(H-B-T)*(v-lo)/(hi-lo);
  const step=hi-lo>10?2:hi-lo>5?1:.5;
  for(let value=Math.ceil(lo/step)*step;value<=hi+1e-8;value+=step){svg.append(node('line',{x1:L,x2:W-R,y1:y(value),y2:y(value),class:'grid'}),node('text',{x:L-9,y:y(value)+4,'text-anchor':'end'},fmt(value,Number.isInteger(value)?0:1)));}
  for(const min of [0,15,30,60,90,120])svg.append(node('text',{x:x(min),y:H-11,'text-anchor':'middle'},String(min)));
  svg.append(node('line',{x1:L,x2:W-R,y1:y(3.9),y2:y(3.9),class:'hypo'}),node('line',{x1:L,x2:W-R,y1:y(goal),y2:y(goal),class:'goal'}));
  const curve=key=>pts.map((p,i)=>(i?'L':'M')+x(p.minute).toFixed(2)+' '+y(p[key]).toFixed(2)).join(' ');
  svg.append(node('path',{d:curve('withoutMmol'),class:'nojuice'}),node('path',{d:curve('withMmol'),class:'juice'}),node('circle',{cx:x(0),cy:y(current),r:5,class:'now'}));
 }
 function render(){
  const {result:r,snap:s}=evaluate(getNumber('juice',60));
  const current=fieldGlucose(s),validG=finite(current),cur=validG?current:getNumber('glucose',NaN),a=inputs();
  $('heroGlucose').textContent=fmt(validG?current:NaN);
  let alert=r.alert;
  if(validG){
   const slope=finite(alert?.slopeMmolPerMin)?alert.slopeMmolPerMin:options.previewFixture?a.trend/5:0;
   const arrow=slope<-.02?'↘':slope>.02?'↗':'→';$('heroArrow').textContent=arrow;
   $('dataAge').textContent=alert?.status==='RISK_WITHIN_WINDOW'?'↓ риск снижения':alert?.status==='VERIFY_READING'?'CGM требует проверки':arrow+' '+(slope<-.02?'снижается':slope>.02?'растёт':'ровный тренд');
  } else {$('heroArrow').textContent='—';$('dataAge').textContent='Ожидается GFStorage';}
  const zone=!validG?'':current<3.9?'Red':current<4.5?'Orange':current<=10?'Green':'';
  for(const z of ['Red','Orange','Green'])$('zone'+z).classList.toggle('selected',z===zone);
  const status=$('statusLabel');status.className='state '+(zone==='Orange'?'amber':zone==='Green'?'green':!zone?'neutral':'');status.textContent=!validG?'Нет CGM':zone==='Red'?'Гипогликемия':zone==='Orange'?'Близко к нижней границе':zone==='Green'?'В диапазоне LOW':'Вне диапазона LOW';
  const weight=s?.profile?.weightKg;
  const age=validG&&s&&Number.isFinite(Date.parse(s.nowIso))&&Number.isFinite(Date.parse(s.cgm.at(-1).measuredAt))?(Date.parse(s.nowIso)-Date.parse(s.cgm.at(-1).measuredAt))/60000:Infinity;
  const fresh=age>=0&&age<=12;
  if(!fresh){status.textContent='Данные CGM устарели';status.className='state neutral';$('dataAge').textContent='Показание не актуально';}
  const er=validG&&fresh?CORE.ispad(weight,current):{visible:false};
  $('ispadBox').hidden=!er.visible;
  if(er.visible){const g=er.initialCarbsG;const p=s?.products?.[getProduct()];$('ispadCarbs').textContent=fmt(g)+' г';
   $('ispadJuice').textContent=p&&finite(p.carbsPer100)?'≈ '+Math.round(100*g/p.carbsPer100)+' '+p.unit+' '+p.name.toLowerCase():'Требуется состав продукта';}
  $('dataChip').textContent='CGM '+fmt(current)+' · '+$('heroArrow').textContent;
  const injections=s?.injections||[];
  let iob=NaN;try{if(s&&root.RinfastEngine){iob=injections.filter(e=>e.insulinId==='rinfast'&&e.status==='confirmed').reduce((sum,e)=>sum+e.units*root.RinfastEngine.getCurve(Math.max(0,(Date.parse(s.nowIso)-Date.parse(e.administeredAt))/60000)).remainingFraction,0);}}catch(_){iob=NaN;}
  $('iobChip').textContent='РинФаст IOB '+fmt(iob)+' ЕД';$('cobChip').textContent='COB: по истории еды';$('activityChip').textContent='Активность: '+(s?.conditions?.activity||'нет данных');
  const amount=getNumber('juice',60),p=s?.products?.[getProduct()];$('carbs').textContent=p&&finite(p.carbsPer100)?fmt(amount*p.carbsPer100/100)+' г':'—';
  document.querySelectorAll('[data-juice]').forEach(b=>b.classList.toggle('active',Number(b.dataset.juice)===amount));
  const available=r?.status==='MODEL_SCENARIO'&&r.amount!==null;
  for(const minute of [15,60,120]){const v=available?r.points.find(p=>p.minute===minute)?.withMmol:null;const el=$('g'+minute);el.textContent=fmt(v);el.className=finite(v)?v<3.9?'risk':Math.abs(v-a.goal)<=.3?'good':'':'';}
  $('points').replaceChildren();if(available){for(const minute of [0,15,30,60,90,120]){const point=r.points.find(p=>p.minute===minute);if(!point)continue;const row=document.createElement('tr');for(const v of [minute===0?'Сейчас':minute+' мин',fmt(point.withoutMmol),fmt(point.withMmol)]){const td=document.createElement('td');td.textContent=v;row.appendChild(td);}$('points').appendChild(row);}}
  $('eta').textContent=available?r.firstTargetCrossingMin===null?'Ориентир '+fmt(a.goal)+': по этой модели не достигается за 120 минут':'Ориентир '+fmt(a.goal)+': пересечение около '+r.firstTargetCrossingMin+' мин':'Нет полного расчёта: '+(r?.detail||r?.message||'данные не готовы');
  draw(r,a.goal,cur);
  if(initialized&&!$('calcResult').hidden)calculate(false);
 }
 function calculate(show=true){
  const {result:r}=evaluate(null);candidate=null;
  const canUse=r?.status==='MODEL_SCENARIO'&&r?.modelAmountStatus==='MODEL_AMOUNT'&&finite(r.modelAmount);
  if(canUse){candidate=r.modelAmount;$('resultMl').textContent=fmt(candidate)+' мл · оценка модели';
   $('resultExplain').textContent='Прогноз без нового сока: '+fmt(r.baselineAtHorizon)+' ммоль/л к 120 минутам. Расчёт не определяет лечебную порцию; для гипогликемии используется отдельный ориентир ISPAD.';
  }else{$('resultMl').textContent='Расчёт недоступен';$('resultExplain').textContent='Причина: '+(r?.detail||r?.message||r?.issues?.join(', ')||r?.modelAmountStatus||'не хватает подтверждённых данных')+'. Прогноз не подменяется нулём или демонстрацией.';}
  $('applyResult').disabled=!canUse;
  if(show){$('calcResult').hidden=false;$('calcResult').scrollIntoView({block:'nearest',behavior:'smooth'});}
 }
 $('calculate').addEventListener('click',()=>calculate(true));
 $('applyResult').addEventListener('click',()=>{if(candidate!==null){setAmount(candidate);$('chart').scrollIntoView({block:'center',behavior:'smooth'});}});
 $('juice').addEventListener('input',e=>setAmount(Number(e.target.value)));
 $('juiceNumber').addEventListener('input',e=>{if(e.target.value.trim())setAmount(Number(e.target.value));});
 $('juiceNumber').addEventListener('change',e=>setAmount(Number(e.target.value)));
 document.querySelectorAll('[data-juice]').forEach(b=>b.addEventListener('click',()=>setAmount(Number(b.dataset.juice))));
 ['goal','calcProduct'].forEach(id=>$(id).addEventListener('input',render));
 if(options.previewFixture){['glucose','trend','iob','cob','weight','activity'].forEach(id=>$(id).addEventListener('input',render));
  $('resetDemo').addEventListener('click',()=>{for(const [k,v] of Object.entries({glucose:3,trend:0,iob:0,cob:0,weight:20,goal:6}))$(k).value=v;$('activity').value='Обычная';setAmount(60);$('calcResult').hidden=true;});
 }else{$('testData').hidden=true;}
 $('journal').disabled=true;$('journalText').textContent='Запись в GFStorage подключает Codex только после проверки GFActionWriter и подтверждения события. Просмотр не создаёт факт еды.';
 initialized=true;render();
 return Object.freeze({render,calculate,evaluate});
}
return Object.freeze({VERSION:'0.4.0',init});
});
