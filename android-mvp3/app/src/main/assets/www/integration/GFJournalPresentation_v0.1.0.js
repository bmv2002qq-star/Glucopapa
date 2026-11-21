/* Presentation for the existing three-column diary. Only reads the journal and settings ports. */
(function (root) {
  'use strict';
  const Mounted = new WeakMap();
  const dayMs = 86_400_000;
  const dayValue = day => /^\d{4}-\d\d-\d\d$/.test(day) ? Date.parse(day + 'T00:00:00Z') : NaN;
  const dayOf = ms => new Date(ms).toISOString().slice(0,10);
  const measure = [['carbs','carbsG','Углеводы','г'],['protein','proteinG','Белки','г'],
    ['fat','fatG','Жиры','г'],['kcal','kcal','Энергия','ккал']];
  const fmt = value => value.toLocaleString('ru-RU',{maximumFractionDigits:2});
  function textElement(doc,tag,text){
    const el=doc.createElement(tag);
    el.textContent=text;
    return el;
  }

  function fromControls(doc,today){
    const selected=doc.getElementById('date').value||today;
    const chosen=doc.getElementById('journalSpan').value;
    if(chosen==='custom'){
      const start=doc.getElementById('journalStart').value,end=doc.getElementById('journalEnd').value;
      if(Number.isFinite(dayValue(start))&&Number.isFinite(dayValue(end))&&start<=end)return {start,end,valid:true};
      return {start:selected,end:selected,valid:false};
    }
    return {start:dayOf(dayValue(selected)-(Number(chosen)-1)*dayMs),end:selected,valid:true};
  }

  function within(rows,range) {
    return range.valid ? rows.filter(row=>row.day>=range.start&&row.day<=range.end) : [];
  }

  function matching(rows,kind){
    if(kind==='all')return rows;
    if(kind==='other')return rows.filter(row=>!['meal','injection'].includes(row.kind));
    return rows.filter(row=>row.kind===kind);
  }

  function calendarMonth(day,today){
    const start=day.slice(0,7)+'-01';
    const next=new Date(start+'T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth()+1);
    const last=dayOf(next.getTime()-dayMs);
    return {start,end:start.slice(0,7)===today.slice(0,7)?day<today?day:today:last,valid:true};
  }

  function nutritionRange(settings,range,zone,today){
    const total=Object.fromEntries(measure.map(([,key])=>[key,[0,0]]));
    if(!range.valid||range.end>today)return null;
    const changes=settings.history.filter(item=>item.domain==='profile'&&item.changes)
      .map(item=>({ms:Date.parse(item.at),patch:item.changes})).reverse();
    for(let day=dayValue(range.start);day<=dayValue(range.end);day+=dayMs){
      const target=dayOf(day);
      let at=target===today?Date.now():day+dayMs/2;
      const local=root.GFJournal.ymd(at,zone);
      if(local!==target)at+=(local>target?-1:1)*dayMs;
      const profile={...settings.profile,timeZone:zone};
      for(const item of changes){
        if(item.ms<=at)break;
        for(const key of ['birthDate','sex','timeZone'])if(item.patch[key])profile[key]=item.patch[key].before;
      }
      const reference=root.GFNutritionReference.recommend(profile,new Date(at).toISOString());
      if(!reference)return null;
      for(const [,key] of measure)for(const i of [0,1])total[key][i]+=reference[key][i];
    }
    return total;
  }

  function paintSummary(doc,id,rows,norms){
    const total=root.GFJournal.totals(rows),target=doc.getElementById(id);
    target.replaceChildren(...[
      ['РинФаст',fmt(total.rinfast)+' ЕД'],
      ['Левемир',fmt(total.levemir)+' ЕД'],
      ...measure.map(([fact,key,name,unit])=>{
        const actual=total[fact];
        const text=norms? ' · Норма '+norms[key].map(fmt).join('–')+' '+unit+
          ' · Осталось '+norms[key].map(n=>fmt(Math.max(0,n-actual))).join('–')+' '+unit : ' · Норма недоступна';
        return [name,'Съедено '+fmt(actual)+' '+unit+text];
      }),
    ].map(([label,value])=>{
      const box=doc.createElement('div');
      box.className='stat';
      box.append(textElement(doc,'span',label),textElement(doc,'b',value));
      return box;
    }));
  }

  function install(doc,refresh){
    const entry={refresh,result:null};
    Mounted.set(doc,entry);
    for(const selector of ['.top','.callout','#meta','.foot'])doc.querySelector(selector)?.setAttribute('hidden','');
    const toolbar=doc.querySelector('.toolbar'), daily=doc.getElementById('dailyStats');
    const timezone=doc.getElementById('timezone');
    doc.querySelector('.tablewrap').closest('.section').after(daily);
    if(timezone)daily.after(timezone);
    const heading=textElement(doc,'h2','Итоги за выбранный период');
    daily.before(heading);
    const span=doc.createElement('select');
    span.id='journalSpan';
    for(const [label,value] of [['1 день','1'],['3 дня','3'],['7 дней','7'],['Выбрать период','custom']]){
      const item=textElement(doc,'option',label);item.value=value;span.append(item);
    }
    const custom=doc.createElement('span');
    custom.hidden=true;
    for(const [id,label] of [['journalStart','С'],['journalEnd','По']]){
      const wrapper=textElement(doc,'label',label+' ');
      const input=doc.createElement('input');
      input.type='date';input.id=id;
      wrapper.append(input);
      custom.append(wrapper);
      input.addEventListener('change',()=>entry.refresh());
    }
    span.addEventListener('change',()=>{custom.hidden=span.value!=='custom';entry.refresh();});
    toolbar.append(span,custom);
    const sport=textElement(doc,'option','Только спорт');sport.value='sport';
    doc.getElementById('kind').append(sport);
    for(const id of ['date','kind'])doc.getElementById(id).addEventListener('change',()=>entry.refresh());
    for(const id of ['prev','next'])doc.getElementById(id).addEventListener('click',()=>entry.refresh());
    const style=textElement(doc,'style','[hidden]{display:none!important}#tbody tr.ill td{background:#ffe8ef}.sick-swatch{background:#f5bbd1}'+
      'tr.sport-period td{background:#e7f6ff}.sport-swatch{background:#b6def5}');
    doc.head.append(style);
    const legend=textElement(doc,'span','Период спорта');legend.className='key';
    const swatch=doc.createElement('i');swatch.className='swatch sport-swatch';
    legend.prepend(swatch);
    doc.querySelector('.legend')?.append(legend);
    const additional=textElement(doc,'section','');
    additional.className='section';additional.hidden=true;
    daily.after(additional);
    doc.defaultView.addEventListener('message',event=>{
      if(event.origin!==root.location.origin||event.source!==root||event.data?.type!=='gp:snapshot'||
          event.data?.role!=='journal'||!entry.result)return;
      const d=entry.result;
      doc.getElementById('dayTitle').textContent=d.range.valid?d.range.start+' — '+d.range.end:'Проверьте даты периода';
      doc.getElementById('monthLabel').textContent=d.month.start+' — '+d.month.end;
      paintSummary(doc,'dailyStats',d.rows,d.norms);
      paintSummary(doc,'monthlyStats',d.monthly,d.monthlyNorms);
      const elements=doc.querySelectorAll('#tbody tr');
      d.rows.forEach((row,index)=>{
        if(row.kind==='sport')elements[index]?.classList.add('sport-period');
        if(d.history&&row.id.startsWith('qa-seed-')){
          const label=textElement(doc,'small','Сценарий · ');
          label.className='sub';
          elements[index]?.lastElementChild?.prepend(label);
        }
      });
      additional.hidden=!d.history;
      if(d.history){
        const notes=within(d.history.notes,d.range);
        const meters=d.history.meter.map(row=>({...row,day:root.GFJournal.ymd(row.ts,d.history.timeZone)}));
        const title=textElement(doc,'h2','Архивные примечания и замеры глюкометром');
        const list=[...notes.map(note=>[note.day,note.time??'Время неизвестно','Со слов владельца',note.text]),
          ...within(meters,d.range).map(row=>[row.day,new Date(row.ts).toLocaleTimeString('ru-RU',{
            timeZone:d.history.timeZone,hour:'2-digit',minute:'2-digit'}),'Глюкометр',fmt(row.mmol)+' ммоль/л'])];
        additional.replaceChildren(title,...list.map(parts=>textElement(doc,'p',parts.join(' · '))));
      }
    });
    return entry;
  }

  function prepare(doc,all,settings,today,refresh){
    const entry=Mounted.get(doc)||install(doc,refresh);
    entry.refresh=refresh;
    const date=doc.getElementById('date');
    if(!date.dataset.chosen)date.value=today;
    const range=fromControls(doc,today),month=calendarMonth(range.end,today);
    const rows=within(all.rows,range), monthly=within(all.rows,month);
    entry.result={range,month,rows:matching(rows,doc.getElementById('kind').value),monthly,history:all.researchHistory,
      norms:nutritionRange(settings,range,all.zone,today),monthlyNorms:nutritionRange(settings,month,all.zone,today)};
    const illnessEnds=new Map(all.illness.filter(p=>p.end!==null).map(p=>[p.id+'-end',Math.round((p.end-p.start)/60000)]));
    return {...all,rows:rows.map(row=>{
      const duration=illnessEnds.get(row.id);
      return {...row,...(duration===undefined?{}:{ill:true,durationMinutes:duration}),day:date.value,
        time:range.start!==range.end?row.day+' '+row.time:row.time};
    })};
  }
  root.GFJournalPresentation=Object.freeze({prepare});
})(globalThis);
