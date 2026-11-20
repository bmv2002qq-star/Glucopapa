/* GFMainScreen UI v1.0.0 - approved v0.4 geometry + GFStorage-backed controller.
 * No localStorage/parallel journal. Data flows through GFMainScreenCore only. */
(function(root){'use strict';
const MIN=60000,HOUR=3600000,STEP=300000;
let zone='Europe/Minsk',nowMs=Date.now(),sourceId=null,latestAt=null;
let CGM=[],lines=[],markers=[],current=null;
let initialized=false;
const DEFAULT_VIEW={t0:nowMs-6*HOUR,t1:nowMs+2*HOUR,y0:4.3,y1:9.3};
const view={...DEFAULT_VIEW};
const LIMITS={t0:nowMs-24*HOUR,t1:nowMs+2.5*HOUR,minT:35*MIN,minY:.7,maxY:18,glucoseLow:0,glucoseHigh:20};
function setDefault(now,last){const at=last?.at||now;Object.assign(DEFAULT_VIEW,{t0:at-6*HOUR,t1:at+2*HOUR,y0:last?Math.max(0,last.mmol-2.5):4.3,y1:last?Math.min(30,last.mmol+2.5):9.3});
  Object.assign(LIMITS,{t0:at-24*HOUR,t1:at+2.5*HOUR,glucoseLow:0,glucoseHigh:30});
  Object.assign(view,DEFAULT_VIEW);
}
const PLOT=Object.freeze({W:660,H:288,L:47,R:648,T:15,B:247});
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function element(tag,attrs={},content){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(content!==undefined)e.textContent=content;return e;}
function resetView(){Object.assign(view,DEFAULT_VIEW);rerender();}
function constrainTime(start,end){
  const full=LIMITS.t1-LIMITS.t0;
  const span=clamp(end-start,LIMITS.minT,full);
  let left=start, right=start+span;
  if(left<LIMITS.t0){left=LIMITS.t0;right=left+span;}
  if(right>LIMITS.t1){right=LIMITS.t1;left=right-span;}
  view.t0=left;view.t1=right;
}
function constrainGlucose(low,high){
  const span=clamp(high-low,LIMITS.minY,LIMITS.maxY);
  let bottom=low,top=low+span;
  if(bottom<LIMITS.glucoseLow){bottom=LIMITS.glucoseLow;top=bottom+span;}
  if(top>LIMITS.glucoseHigh){top=LIMITS.glucoseHigh;bottom=top-span;}
  view.y0=bottom;view.y1=top;
}
function niceStep(span,target,steps){const need=span/target;return steps.find(step=>step>=need)||steps[steps.length-1];}
function glucoseText(value){return Number(value.toFixed(2)).toLocaleString('ru-RU',{maximumFractionDigits:2});}
function drawChart(svg){
  if(!svg)return;
  const {L,R,T,B}=PLOT;
  const left=view.t0,right=view.t1,low=view.y0,high=view.y1;
  const x=t=>L+(t-left)/(right-left)*(R-L);
  const y=g=>B-(g-low)/(high-low)*(B-T);
  svg.replaceChildren();svg.setAttribute('viewBox','0 0 660 288');svg.setAttribute('preserveAspectRatio','none');
  svg.dataset.xSpanHours=((right-left)/HOUR).toFixed(4);
  svg.dataset.ySpanMmol=(high-low).toFixed(4);
  svg.dataset.yMin=low.toFixed(4);svg.dataset.yMax=high.toFixed(4);
  svg.dataset.timeStart=String(left);svg.dataset.timeEnd=String(right);
  const clipId='clip-'+svg.id;
  const defs=element('defs'),clip=element('clipPath',{id:clipId});clip.append(element('rect',{x:L,y:T,width:R-L,height:B-T}));defs.append(clip);svg.append(defs);
  svg.append(element('rect',{x:L,y:T,width:R-L,height:B-T,fill:'#ffffff'}));
  const futureStart=clamp(x(nowMs),L,R);
  if(futureStart<R)svg.append(element('rect',{x:futureStart,y:T,width:R-futureStart,height:B-T,fill:'#f3f6f7'}));
  // Nice ticks recalculate after vertical zoom, including tenths when appropriate.
  const gStep=niceStep(high-low,6,[.1,.2,.25,.5,1,2,2.5,5,10]);
  const gFrom=Math.ceil((low-1e-9)/gStep)*gStep;
  for(let n=0;n<200;n++){
    let g=Number((gFrom+n*gStep).toFixed(5));if(g>high+1e-7)break;
    const yy=y(g),warning=Math.abs(g-4)<.001||Math.abs(g-10)<.001;
    svg.append(element('line',{x1:L,x2:R,y1:yy,y2:yy,stroke:warning?'#e5b2b9':'#ecf0f2','stroke-width':warning?1.2:.8}));
    svg.append(element('text',{x:L-8,y:yy+4,'text-anchor':'end',fill:warning?'#bb6670':'#81949a','font-size':11},glucoseText(g)));
  }
  const tStep=niceStep(right-left,7,[5,10,15,20,30,60,90,120,180,240,360,720,1440].map(n=>n*MIN));
  const firstTick=Math.ceil(left/tStep)*tStep;
  for(let t=firstTick,n=0;t<=right&&n<100;t+=tStep,n++){
    const tx=x(t);if(tx<L-1||tx>R+1)continue;
    svg.append(element('line',{x1:tx,x2:tx,y1:T,y2:B,stroke:'#edf1f2','stroke-width':.85}));
    svg.append(element('text',{x:tx,y:267,'text-anchor':'middle','font-size':11,fill:'#87999d'},new Date(t).toLocaleTimeString('ru-RU',{timeZone:zone,hour:'2-digit',minute:'2-digit'})));
  }
  for(const ev of markers){
    const xx=x(ev.t);if(xx<L||xx>R)continue;
    svg.append(element('line',{x1:xx,x2:xx,y1:T,y2:B,stroke:ev.col,'stroke-width':1,'stroke-dasharray':'2 5',opacity:.52}));
    svg.append(element('circle',{cx:xx,cy:27,r:8,fill:'#fff',stroke:ev.col,'stroke-width':1}));
    svg.append(element('text',{x:xx,y:30,'text-anchor':'middle','font-size':11},ev.name));
  }
  const currentX=x(nowMs);
  if(currentX>=L&&currentX<=R)svg.append(element('line',{x1:currentX,y1:T,x2:currentX,y2:B,stroke:'#688b96','stroke-width':1.2,'stroke-dasharray':'4 4'}));
  svg.append(element('text',{x:L,y:281,'font-size':9.5,fill:'#8a9a9e'},'ммоль/л'));
  const history=CGM.filter(p=>p.at>=left-STEP&&p.at<=Math.min(right+STEP,nowMs));
  function pathFor(arr,color,width,dash,modelId){
    if(arr.length<2)return;
    const d=arr.map((p,i)=>{
      const move=!i||(!modelId&&p.t-arr[i-1].t>12*MIN);
      return (move?'M':'L')+x(p.t).toFixed(2)+' '+y(p.g).toFixed(2);
    }).join(' ');
    const path=element('path',{d,stroke:color,'stroke-width':width,fill:'none','stroke-linecap':'round',
      'stroke-linejoin':'round','clip-path':'url(#'+clipId+')'});
    if(dash)path.setAttribute('stroke-dasharray',dash);
    if(modelId){
      path.setAttribute('data-forecast-model',modelId);
      path.append(element('title',{},modelId+' · исследовательский прогноз'));
    }
    svg.append(path);
  }
  pathFor(history.map(p=>({t:p.at,g:p.mmol})),'#129fc0',2.5);
  for(const p of history.filter((_,i)=>i%3===0)){
    const xx=x(p.at),yy=y(p.mmol);
    if(xx>=L&&xx<=R&&yy>=T&&yy<=B)svg.append(element('circle',{cx:xx,cy:yy,r:1.7,fill:'#179cbd','data-cgm-point':'1'}));
  }
  for(const line of lines)pathFor(line.points.map(p=>({t:Date.parse(p.at),g:p.glucoseMmol})),
    line.color,line.isMean?2.8:1.9,line.isMean?'6 3':'4 3',line.modelId);
  const currentG=current?.mmol??null,cy=currentG===null?NaN:y(currentG);
  const measuredX=current?x(current.at):NaN;
  if(currentG!==null&&measuredX>=L&&measuredX<=R&&cy>=T&&cy<=B){
    svg.append(element('circle',{cx:measuredX,cy,r:4.5,fill:'#079cb9',stroke:'#fff','stroke-width':1.4}));
    svg.append(element('rect',{x:clamp(measuredX-24,L+2,R-50),y:Math.max(T,cy-30),width:48,height:21,rx:6,fill:'#0c9eb8'}));
    svg.append(element('text',{x:clamp(measuredX,L+26,R-26),y:Math.max(T+14,cy-15),'text-anchor':'middle','font-size':12,'font-weight':750,fill:'#fff'},glucoseText(currentG)));
  }
}
function rerender(){
  drawChart($('main-chart'));
  const hours=(view.t1-view.t0)/HOUR;
  if($('zoomLabel'))$('zoomLabel').textContent=(hours>=10?hours.toFixed(0):hours.toFixed(1)).replace('.',',')+' ч';
}
function zoomAxis(axis,factor,anchor=0.5){
  const ratio=clamp(anchor,0,1);
  if(axis==='x'){
    const old=view.t1-view.t0,span=clamp(old*factor,LIMITS.minT,LIMITS.t1-LIMITS.t0);
    const at=view.t0+ratio*old;constrainTime(at-ratio*span,at+(1-ratio)*span);
  }else{
    const old=view.y1-view.y0,span=clamp(old*factor,LIMITS.minY,LIMITS.maxY);
    const at=view.y1-ratio*old;constrainGlucose(at-(1-ratio)*span,at+ratio*span);
  }
  rerender();
}
$('zoomIn').addEventListener('click',()=>zoomAxis('x',.8));
$('zoomOut').addEventListener('click',()=>zoomAxis('x',1.25));
$('zoomReset').addEventListener('click',resetView);
/* Horizontal distance controls time span; vertical distance controls glucose span.
 * Both may change in one gesture. Midpoint fixes the zoom focus; pan uses both axes. */
function attachZoom(el){
  if(!el)return;
  const active=new Map();let previousPair=null;
  const plotPixels=()=>{const r=el.getBoundingClientRect(),w=r.width,h=r.height;
    return {left:r.left+PLOT.L/PLOT.W*w,right:r.left+PLOT.R/PLOT.W*w,
      top:r.top+PLOT.T/PLOT.H*h,bottom:r.top+PLOT.B/PLOT.H*h};};
  const fractions=(clientX,clientY)=>{const r=plotPixels();return {
    x:clamp((clientX-r.left)/(r.right-r.left),0,1),
    y:clamp((clientY-r.top)/(r.bottom-r.top),0,1),width:r.right-r.left,height:r.bottom-r.top};};
  const pair=()=>{const [a,b]=[...active.values()].slice(0,2);return {
    mx:(a.x+b.x)/2,my:(a.y+b.y)/2,dx:Math.abs(a.x-b.x),dy:Math.abs(a.y-b.y)};};
  el.addEventListener('wheel',e=>{
    e.preventDefault();const f=fractions(e.clientX,e.clientY);
    zoomAxis(e.shiftKey?'y':'x',e.deltaY>0?1.13:1/1.13,e.shiftKey?f.y:f.x);
  },{passive:false});
  el.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;
    try{el.setPointerCapture(e.pointerId);}catch{}
    active.set(e.pointerId,{x:e.clientX,y:e.clientY});
    previousPair=active.size>=2?pair():null;
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove',e=>{
    if(!active.has(e.pointerId))return;
    const old=active.get(e.pointerId);
    active.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(active.size===1){
      const px=plotPixels(),w=px.right-px.left,h=px.bottom-px.top;
      const dx=e.clientX-old.x,dy=e.clientY-old.y;
      if(Math.abs(dx)+Math.abs(dy)<.001)return;
      const dt=dx/w*(view.t1-view.t0),dg=dy/h*(view.y1-view.y0);
      constrainTime(view.t0-dt,view.t1-dt);
      constrainGlucose(view.y0+dg,view.y1+dg);
      rerender();return;
    }
    if(active.size>=2){
      const next=pair(),prev=previousPair||next;
      const oldCenter=fractions(prev.mx,prev.my),newCenter=fractions(next.mx,next.my);
      const oldTimeRange=view.t1-view.t0,oldYRange=view.y1-view.y0;
      // Guard near-zero spread: vertical-only pinches must not change X and vice versa.
      const timeFactor=prev.dx>=30&&next.dx>=12?clamp(prev.dx/next.dx,.4,2.5):1;
      const glucoseFactor=prev.dy>=30&&next.dy>=12?clamp(prev.dy/next.dy,.4,2.5):1;
      const xAnchor=view.t0+oldCenter.x*oldTimeRange;
      const yAnchor=view.y1-oldCenter.y*oldYRange;
      const timeSpan=clamp(oldTimeRange*timeFactor,LIMITS.minT,LIMITS.t1-LIMITS.t0);
      const ySpan=clamp(oldYRange*glucoseFactor,LIMITS.minY,LIMITS.maxY);
      constrainTime(xAnchor-newCenter.x*timeSpan,xAnchor+(1-newCenter.x)*timeSpan);
      constrainGlucose(yAnchor-(1-newCenter.y)*ySpan,yAnchor+newCenter.y*ySpan);
      previousPair=next;rerender();
    }
  });
  const end=e=>{
    active.delete(e.pointerId);previousPair=active.size>=2?pair():null;
    if(!active.size)el.classList.remove('dragging');
  };
  el.addEventListener('pointerup',end);
  el.addEventListener('pointercancel',end);
  el.addEventListener('lostpointercapture',e=>{if(active.has(e.pointerId))end(e);});
  el.addEventListener('dblclick',e=>{e.preventDefault();resetView();});
}
attachZoom($('main-chart').parentElement);

const stamp=ts=>new Date(ts).toLocaleTimeString('ru-RU',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
const num=(v,d=1)=>Number(v).toLocaleString('ru-RU',{maximumFractionDigits:d});
function renderNutrition(model){
 const rows=$('nutritionRows');if(!rows)return;rows.replaceChildren();
 const make=(tag,txt)=>{const e=document.createElement(tag);e.textContent=txt;return e;};
 for(const item of model.nutrition.rows){const tr=document.createElement('tr');tr.dataset.nutrient=item.key;
   tr.append(make('td',item.name),make('td',item.eaten===null?'—':num(item.eaten)+' '+item.unit),make('td',item.range?item.range.map(x=>num(x)).join('–'):'—'));
   tr.append(make('td',item.remaining!==null?num(item.remaining)+' '+item.unit:'—'));rows.append(tr);
 }
 const foot=$('nutritionFootnote');if(foot){const ref=model.nutrition.reference;
   foot.textContent=(ref?'Съедено по подтверждённым записям. * Справочный диапазон GFSettings ('+ref.groupLabel+', источник 2012 г.). «Осталось» — до нижней границы, не индивидуальная цель.':'Справочная норма недоступна: проверьте профиль ребёнка в настройках.')+
      (model.nutrition.incomplete?' Не все приёмы еды подтверждены: сумма частичная.':'');
 }
}
function drawRows(target,rows){if(!target)return;target.replaceChildren();
 const cell=(tr,content)=>{const td=document.createElement('td');td.textContent=content;tr.append(td);return td;};
 for(const r of rows){const tr=document.createElement('tr');tr.dataset.kind=r.kind;tr.dataset.eventId=r.id;
   cell(tr,stamp(r.ts)); const g=r.glucose;cell(tr,g&&Number.isFinite(g.value)?num(g.value)+' '+(g.direction||''): '—');
   const td=cell(tr,r.description||r.kind);const sub=document.createElement('span');sub.className='recent-entry-sub';
   if(r.kind==='injection')sub.textContent=(r.insulinName||'Инсулин')+' · '+num(r.dose)+' ЕД'+(r.siteLabel?' · '+r.siteLabel:'');
   else if(r.kind==='meal'&&r.meal)sub.textContent='У '+num(r.meal.carbs)+' · Ж '+num(r.meal.fat)+' · Б '+num(r.meal.protein)+' г · '+num(r.meal.kcal)+' ккал';
   else if(r.kind==='sport')sub.textContent=r.durationMinutes===null?'Спорт продолжается':'Продолжительность '+num(r.durationMinutes)+' мин';
   else sub.textContent=r.detail||'';
   if(sub.textContent)td.append(sub);target.append(tr);
 }
 if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=3;td.textContent='Нет записанных действий';tr.append(td);target.append(tr)}
}
function renderSummary(model) {
 zone=model.zone;
 renderNutrition(model);
 drawRows($('recentRows'),model.actions);
 $('recentCount').textContent=String(model.actions.length);
}
function draw({evidence, now, timezone, forecastLines, actions}) {
 const last=evidence.readings.at(-1);
 const nextId=evidence.sourceDeviceId;
 if(!initialized||nextId!==sourceId||(last&&latestAt===null)){
   setDefault(now,last?{at:last.ts,mmol:last.mmol}:null);
   initialized=true;
 }else if(last&&latestAt!==null&&last.ts>latestAt&&view.t1>=latestAt){
   const delta=last.ts-latestAt;
   view.t0+=delta;view.t1+=delta;
   LIMITS.t0+=delta;LIMITS.t1+=delta;
   DEFAULT_VIEW.t0+=delta;DEFAULT_VIEW.t1+=delta;
 }
 sourceId=nextId;latestAt=last?.ts??null;
 nowMs=now;zone=timezone;
 CGM=evidence.readings.map(row=>({at:row.ts,mmol:row.mmol}));
 current=last&&Number.isFinite(evidence.currentMmol??evidence.reportedMmol)?
   {at:last.ts,mmol:last.mmol}:null;
 lines=forecastLines;
 markers=actions.filter(row=>row.kind==='injection'||(row.kind==='meal'&&row.meal))
   .map(row=>({t:row.ts,name:row.kind==='injection'?'💉':'🍽',col:row.kind==='injection'?'#dc8c4c':'#619b85'}));
 rerender();
}
root.GFMainScreenUI=Object.freeze({VERSION:'1.0.0',draw,renderSummary,getViewport:()=>({...view})});
})(globalThis);
