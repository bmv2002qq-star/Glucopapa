/**
 * ГлюкоПапа · xDrip-style white chart v0.1.
 * Visual presentation only: CGM points and independent schematic short-insulin activity.
 * No prediction, no medical decisions. Uses UNMODIFIED RinfastEngine.getCurve() from v0.3.1.
 */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.GPCgmWhiteChart=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DAY=86400000, HOUR=3600000, MIN=60000;
 const ANCHOR=Date.parse('2026-11-13T03:00:00+03:00');
 const PALETTE=['#7656c9','#e08739','#288f9a','#c4599e','#5286cb','#a27147'];
 const COLORS={normal:'#26a7d4',high:'#efa525',low:'#de4148',ink:'#354653',lines:'#e4eaee'};
 const COORD={W:550,H:585,L:39,R:539,T:18,B:544};
 const escapeXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 const pad=n=>String(n).padStart(2,'0');
 const tm=t=>{const d=new Date(t+3*HOUR);return pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())};
 const hour=t=>{const d=new Date(t+3*HOUR);return pad(d.getUTCHours())};
 const timeISO=t=>new Date(t).toISOString();
 function fakeCgm(now=ANCHOR){
   // Explicitly synthetic anchors inspired by the user's screenshot; NOT extracted patient data.
   const knots=[[-24,6.0],[-18,5.4],[-15,4.3],[-13,5.4],[-12,5.5],[-11,7.2],[-10.5,8.5],[-10,8.8],[-9.7,6.6],[-9.3,6.4],[-8.5,10.2],[-7.5,7.5],[-7,7.0],[-6.2,8.7],[-5.6,9.7],[-5.15,4.1],[-4.85,2.6],[-4.3,5.4],[-3.4,7.8],[-2.6,9.7],[-2.1,8.0],[-1.5,8.8],[-0.9,6.2],[-0.4,5.0],[0,4.1]];
   const arr=[];const start=now-24*HOUR;
   for(let t=start;t<=now;t+=5*MIN){const h=(t-now)/HOUR;
     let idx=0;while(idx<knots.length-2&&knots[idx+1][0]<h)idx++;
     const [a,va]=knots[idx],[b,vb]=knots[idx+1],u=Math.max(0,Math.min(1,(h-a)/(b-a)));
     let g=va+(vb-va)*u + 0.11*Math.sin((t-start)/MIN*0.23)+0.08*Math.sin((t-start)/MIN*0.53);
     if(t===now)g=4.1;
     arr.push({ts:t,mmol:+Math.max(2.2,g).toFixed(2)});
   }
   return arr;
 }
 function normalizeReadings(rows){
   if(!Array.isArray(rows))throw Error('Ожидался массив CGM');
   const map=new Map();
   for(const v of rows){if(!v||!finite(v.ts)||!finite(v.mmol)||v.mmol<1.5||v.mmol>30)continue;map.set(v.ts,{ts:v.ts,mmol:v.mmol});}
   return [...map.values()].sort((a,b)=>a.ts-b.ts);
 }
 function normalizeShots(shots){
   if(!Array.isArray(shots))throw Error('Ожидался журнал инъекций');
   const seen=new Set();const res=[];
   for(const s of shots){
     if(!s||s.insulinId!=='rinfast')continue;
     if(s.status!=='confirmed')continue;
     if(!finite(s.ts)||!finite(s.units)||s.units<=0||s.units>200||!s.id||seen.has(s.id))throw Error('Некорректная запись РинФаста');
     seen.add(s.id);res.push({id:String(s.id),insulinId:'rinfast',status:'confirmed',ts:s.ts,units:s.units});
   }
   return res.sort((a,b)=>a.ts-b.ts);
 }
 function makeModel(engine,profile){
   if(!engine||typeof engine.getCurve!=='function')throw Error('Нужен модуль RinfastEngine v0.3.1');
   const p=profile||engine.DEFAULT_PROFILE;engine.validateProfile(p);
   return {p,activity:(age)=>age<0||age>=p.diaMinutes?0:engine.getCurve(age,p).activityFractionPerMinute};
 }
 function validView(now,historyH=12,futureH=6,offsetH=0){
   if(!finite(now)||!finite(historyH)||!finite(futureH)||!finite(offsetH)||historyH<2||historyH>24||futureH<0||futureH>8||offsetH>0||offsetH< -24)throw Error('Недопустимое окно');
   return {start:now-historyH*HOUR+offsetH*HOUR,end:now+futureH*HOUR+offsetH*HOUR,now,historyH,futureH,offsetH};
 }
 function overlapIntervals(shots, diaMinutes){
   const ends=[];for(const s of shots){ends.push({t:s.ts,k:1},{t:s.ts+diaMinutes*MIN,k:-1});}
   ends.sort((a,b)=>a.t-b.t||a.k-b.k);
   let n=0,open=null;const result=[];
   for(const e of ends){const prev=n;n+=e.k;if(prev<2&&n>=2)open=e.t;if(prev>=2&&n<2&&open!==null){if(e.t>open)result.push({from:open,to:e.t});open=null;}}
   return result;
 }
 const svgPath=(list)=>list.length?'M'+list.map(([x,y])=>x.toFixed(2)+','+y.toFixed(2)).join(' L'):'';
 function renderSvg({readings,shots,now=ANCHOR,historyH=12,futureH=6,offsetH=0,engine,profile,showInsulin=true,showTotal=false,layout="guided"}){
   const data=normalizeReadings(readings);const inject=normalizeShots(shots);
   if(inject.some(s=>s.ts>now)) throw Error("Подтверждённая инъекция не может находиться в будущем относительно времени графика");
   if(!['guided','inline'].includes(layout))throw Error('Неверный тип отображения');
   const model=makeModel(engine,profile);
   const view=validView(now,historyH,futureH,offsetH), {L,R,T,B,H,W}=COORD;
   const xAt=t=>L+(t-view.start)/(view.end-view.start)*(R-L);
   const yAt=g=>B-(g-2)/(13-2)*(B-T);
   const insideX=x=>Math.max(L,Math.min(R,x));
   let parts=[];
   parts.push(`<defs><clipPath id="gpPlotClip"><rect x="${L}" y="${T}" width="${R-L}" height="${B-T}" /></clipPath></defs>`);
   parts.push('<rect width="550" height="585" fill="#ffffff"/>');
   // Gray future window is separated from observed CGM without fabricating readings.
   if(view.start<now&&view.end>now)parts.push(`<rect x="${xAt(now).toFixed(1)}" y="${T}" width="${(R-xAt(now)).toFixed(1)}" height="${B-T}" fill="#f7f9fc"/>`);
   // Mild low-glucose fill + reference levels, consistent with xDrip visual language.
   parts.push(`<rect x="${L}" y="${yAt(3.9).toFixed(2)}" width="${R-L}" height="${(B-yAt(3.9)).toFixed(2)}" fill="#fbe5e5" opacity="0.70"/>`);
   for(const g of [4,6,8,10,12]){const y=yAt(g);parts.push(`<line x1="${L}" x2="${R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#d9e1e5" stroke-width="1"/><text x="${L-7}" y="${y+4}" font-size="12.5" fill="#667783" text-anchor="end">${g}</text>`);}
   for(let t=Math.ceil(view.start/(2*HOUR))*2*HOUR;t<=view.end;t+=2*HOUR){const x=xAt(t);parts.push(`<line x1="${x}" y1="${T}" x2="${x}" y2="${B}" stroke="#e3e9ec" stroke-width="1"/><text x="${x}" y="571" fill="#687782" font-size="13.5" text-anchor="middle">${hour(t)}</text>`);}
   parts.push(`<line x1="${L}" x2="${R}" y1="${yAt(9.4)}" y2="${yAt(9.4)}" stroke="#d69a26" stroke-width="1.5"/>`);
   parts.push(`<line x1="${L}" x2="${R}" y1="${yAt(3.9)}" y2="${yAt(3.9)}" stroke="#c94450" stroke-width="1.6"/>`);
   parts.push(`<line x1="${L}" x2="${R}" y1="${yAt(7.1)}" y2="${yAt(7.1)}" stroke="#80b34f" stroke-width="1.1" stroke-dasharray="4 5" opacity=".8"/>`);
   const selected=data.filter(r=>r.ts>=view.start&&r.ts<=now&&r.ts<=view.end);
   let chunks=[],c=[];for(const point of selected){if(c.length&&point.ts-c.at(-1).ts>12*MIN){chunks.push(c);c=[];}c.push(point);}if(c.length)chunks.push(c);
   parts.push('<g clip-path="url(#gpPlotClip)" class="gp-cgm-trace">');
   for(const chunk of chunks){const coords=chunk.map(p=>[xAt(p.ts),yAt(p.mmol)]);parts.push(`<path d="${svgPath(coords)}" fill="none" stroke="#9aa0a5" stroke-width="1.55" stroke-linejoin="round"/>`);}
   for(const pt of selected){const fill=pt.mmol<3.9?COLORS.low:pt.mmol>9.4?COLORS.high:COLORS.normal;parts.push(`<circle data-cgm-point="1" cx="${xAt(pt.ts).toFixed(2)}" cy="${yAt(pt.mmol).toFixed(2)}" r="3.25" fill="${fill}"><title>${tm(pt.ts)} · ${pt.mmol.toFixed(1)} ммоль/л · демо</title></circle>`);}
   parts.push('</g>');
   if(view.start<now&&view.end>now){const x=xAt(now);parts.push(`<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="#64758a" stroke-width="1.1" stroke-dasharray="4 5"/><text x="${x+5}" y="${T+15}" fill="#4d6171" font-size="12" font-weight="700">Сейчас</text>`);}
   if(showInsulin){
     // Obtain a CGM value ONLY inside the measured time range and across short valid gaps.
     // If the modelled peak is in the future, never create a fictional glucose point.
     function observedGlucoseAt(ts){
       if(ts>now||data.length===0)return null;
       let lo=0,hi=data.length-1;
       while(lo<=hi){const mid=(lo+hi)>>1;if(data[mid].ts<ts)lo=mid+1;else hi=mid-1;}
       if(lo<data.length&&data[lo].ts===ts)return data[lo].mmol;
       const a=data[lo-1],b=data[lo];
       if(!a||!b||b.ts-a.ts>12*MIN)return null;
       const v=a.mmol+(b.mmol-a.mmol)*(ts-a.ts)/(b.ts-a.ts);
       return finite(v)?v:null;
     }
     // Vertical placement of insulin is SCHEMATIC and NOT tied to mmol/L.
     // Variant 1: activity in upper plot zone. Variant 2: activity gently integrated into the plot body.

     const graphShots=inject.filter(s=>s.ts+model.p.diaMinutes*MIN>=view.start&&s.ts<=view.end);
     const maxA=Math.max(.0001,model.activity(model.p.peakMinutes)*Math.max(4,...graphShots.map(s=>s.units))); // Stable scaling for ordinary demo doses
     const height=layout==='guided'?92:96,baseY=layout==='guided'?165:355,topY=baseY-height;
     parts.push(`<g class="gp-rinfast-model" clip-path="url(#gpPlotClip)">`);
     if(layout==='guided')parts.push(`<text x="${L+10}" y="${topY+17}" fill="#778ba7" font-size="11.5" font-weight="700">Схема активности РинФаста — условная высота</text>`);
     if(layout==='inline')parts.push(`<text x="${L+10}" y="${topY+18}" fill="#778ba7" font-size="11" font-weight="700">Наложение инсулина — не шкала сахара</text>`);

     const ovs=overlapIntervals(graphShots,model.p.diaMinutes);
     for(const [idx,o] of ovs.entries()){const a=Math.max(view.start,o.from),b=Math.min(view.end,o.to);if(b>a)parts.push(`<rect class="gp-overlap" x="${xAt(a)}" y="${T}" width="${xAt(b)-xAt(a)}" height="${B-T}" fill="#e6dbff" opacity="0.12"><title>Временное перекрытие модельных действий: ${tm(a)}–${tm(b)}</title></rect>`);}
     const stepsPerCurve=72;let visible=[];
     graphShots.forEach((s,i)=>{
       const color=PALETTE[i%PALETTE.length],amp=s.units*model.activity(model.p.peakMinutes)/maxA;
       const pts=[];
       for(let k=0;k<=stepsPerCurve;k++){const t=s.ts+model.p.diaMinutes*MIN*k/stepsPerCurve;if(t<view.start||t>view.end)continue;const v=model.activity((t-s.ts)/MIN)*s.units/maxA;pts.push([xAt(t),baseY-height*v]);}
       if(pts.length<2)return;
       parts.push(`<path data-insulin-curve="${escapeXml(s.id)}" d="${svgPath(pts)}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" opacity="0.88"><title>РинФаст ${s.units} ЕД · ${tm(s.ts)}, модельное действие</title></path>`);
       const markings=[{t:s.ts,label:'Укол',yc:baseY},{t:s.ts+model.p.peakMinutes*MIN,label:'Пик',yc:baseY-height*amp},{t:s.ts+model.p.diaMinutes*MIN,label:'Конец модели',yc:baseY}];
       // Peak-to-CGM projection: time is shared, glucose value is measured and interpolated only between adjacent readings.
       const peakAt=s.ts+model.p.peakMinutes*MIN;
       if(peakAt>=view.start&&peakAt<=view.end){
         const px=xAt(peakAt),peakY=baseY-height*amp;
         const measured=observedGlucoseAt(peakAt);
         if(measured!==null){
           const cy=yAt(measured);
           parts.push(`<line data-peak-guide="${escapeXml(s.id)}" x1="${px}" x2="${px}" y1="${peakY+4}" y2="${cy}" stroke="${color}" stroke-width="1.35" stroke-dasharray="3 5" opacity=".75"><title>${tm(peakAt)} · сахар ${measured.toFixed(1)} ммоль/л (демо) во время модельного пика</title></line>`);
           parts.push(`<circle data-peak-cgm="${escapeXml(s.id)}" cx="${px}" cy="${cy}" r="5.1" fill="white" stroke="${color}" stroke-width="2"><title>${tm(peakAt)} · CGM ${measured.toFixed(1)} ммоль/л · демонстрация</title></circle>`);
           parts.push(`<circle cx="${px}" cy="${cy}" r="2.0" fill="${color}"/>`);
         } else {
           parts.push(`<line data-peak-guide="${escapeXml(s.id)}" data-future="true" x1="${px}" x2="${px}" y1="${peakY+4}" y2="${B}" stroke="${color}" stroke-width="1.15" stroke-dasharray="3 5" opacity=".65"><title>Пик ${tm(peakAt)} — фактического CGM на это время нет</title></line>`);
           parts.push(`<text x="${px}" y="${B-8}" fill="${color}" font-size="10.5" text-anchor="middle">пик впереди</text>`);
         }
       }

       markings.forEach((m,j)=>{if(m.t<view.start||m.t>view.end)return;const x=xAt(m.t);parts.push(`<circle data-insulin-mark="${j}" cx="${x}" cy="${m.yc}" r="${j===1?3.3:2.5}" fill="white" stroke="${color}" stroke-width="1.65"><title>${m.label}: ${tm(m.t)} · РинФаст ${s.units} ЕД</title></circle>`);if(j===1)parts.push(`<text x="${x}" y="${m.yc-7}" text-anchor="middle" fill="${color}" font-size="10.5" font-weight="750">пик</text>`);});
       visible.push({...s,color,peak:s.ts+model.p.peakMinutes*MIN,end:s.ts+model.p.diaMinutes*MIN,cgmAtPeak:observedGlucoseAt(s.ts+model.p.peakMinutes*MIN)});
     });
     if(showTotal&&graphShots.length>1){
       const coords=[];for(let t=view.start;t<=view.end;t+=6*MIN){const a=graphShots.reduce((sum,s)=>sum+s.units*model.activity((t-s.ts)/MIN),0);coords.push([xAt(t),baseY-height*a/maxA*.75]);}parts.push(`<path class="gp-insulin-total" d="${svgPath(coords)}" fill="none" stroke="#4a527e" stroke-width="2.1" stroke-dasharray="4 4" opacity=".63"/>`);
     }
     // Visual crossings are NOT pharmacodynamic measurements; these are equality points of two model curves.
     const crossings=[];
     const activityAt=(s,t)=>s.units*model.activity((t-s.ts)/MIN);
     for(let i=0;i<graphShots.length;i++)for(let j=i+1;j<graphShots.length;j++){
       const a=graphShots[i],b=graphShots[j];
       const left=Math.max(a.ts,b.ts,view.start),right=Math.min(a.ts+model.p.diaMinutes*MIN,b.ts+model.p.diaMinutes*MIN,view.end);
       if(right-left<MIN)continue;
       const difference=t=>activityAt(a,t)-activityAt(b,t);
       const step=2*MIN;
       for(let t=left;t<right;t+=step){const nt=Math.min(right,t+step),d1=difference(t),d2=difference(nt);
         if(!(d1*d2<0))continue;
         let lo=t,hi=nt;
         for(let z=0;z<30;z++){const m=(lo+hi)/2;if(difference(lo)*difference(m)<=0)hi=m;else lo=m;}
         const ct=(lo+hi)/2;const val=activityAt(a,ct);
         if(val<=0)continue;
         const cx=xAt(ct),cy=baseY-height*val/maxA;
         parts.push(`<circle class="gp-insulin-crossing" data-cross-marker="${escapeXml(a.id)}-${escapeXml(b.id)}" cx="${cx}" cy="${cy}" r="3.7" fill="#fff" stroke="#515b73" stroke-width="1.8"><title>Схематическое пересечение кривых: ${tm(ct)} · НЕ измерение эффекта</title></circle>`);
         parts.push(`<path d="M${cx-2},${cy-2} l4,4 M${cx+2},${cy-2} l-4,4" stroke="#515b73" stroke-width="1.1" fill="none"/>`);
         crossings.push({at:ct,first:a.id,second:b.id});
         break;
       }
     }
     parts.push('</g>');
     
     parts.push(`</svg>`);
     return {svg:`<svg id="gpXdripSvg" viewBox="0 0 550 585" role="img" aria-label="История CGM и схематическое действие РинФаста" xmlns="http://www.w3.org/2000/svg">${parts.join('')}`,shownShots:visible,overlaps:ovs,crossings,readings:selected.length,view};
   }
   parts.push('</svg>');
   return {svg:`<svg id="gpXdripSvg" viewBox="0 0 550 585" role="img" aria-label="История CGM" xmlns="http://www.w3.org/2000/svg">${parts.join('')}`,shownShots:[],overlaps:[],readings:selected.length,view};
 }
 function renderOverview(readings,now=ANCHOR,view){
   const data=normalizeReadings(readings).filter(p=>p.ts>=now-24*HOUR&&p.ts<=now);
   const W=550,L=38,R=539,top=12,bottom=91,st=now-24*HOUR,ed=now;
   const x=t=>L+(t-st)/(ed-st)*(R-L),y=g=>bottom-(g-2)/11*(bottom-top);
   const path=svgPath(data.map(d=>[x(d.ts),y(d.mmol)]));
   let s=`<svg id="gpOverview" viewBox="0 0 550 117" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Обзор 24 часов, выберите точку для перемещения окна"><rect width="550" height="117" fill="#fff"/>`;
   for(let g of [4,8,12])s+=`<line x1="${L}" x2="${R}" y1="${y(g)}" y2="${y(g)}" stroke="#e0e6ea" stroke-width="1"/>`;
   s+=`<path d="${path}" fill="none" stroke="#8c9ba5" stroke-width="1.15"/>`;
   for(const p of data.filter((r,i)=>i%3===0)){const c=p.mmol<3.9?COLORS.low:p.mmol>9.4?COLORS.high:COLORS.normal;s+=`<circle cx="${x(p.ts)}" cy="${y(p.mmol)}" r="1.8" fill="${c}"/>`;}
   const left=Math.max(L,x(Math.max(st,view.start))),right=Math.min(R,x(Math.min(ed,view.end)));
   s+=`<rect class="gp-overview-window" x="${left}" y="7" width="${Math.max(1,right-left)}" height="94" stroke="#687b91" stroke-width="2" fill="#aab6c2" fill-opacity=".13"/>`;
   for(let t=st;t<=ed;t+=4*HOUR)s+=`<text x="${x(t)}" y="113" fill="#788b97" font-size="10.5" text-anchor="middle">${hour(t)}</text>`;
   s+='</svg>';return s;
 }
 return Object.freeze({ANCHOR,COORD,PALETTE,fakeCgm,normalizeReadings,normalizeShots,makeModel,validView,overlapIntervals,renderSvg,renderOverview,tm,timeISO});
});
