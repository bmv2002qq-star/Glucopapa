/*
 * GlucoPapa Levemir (insulin detemir) exploratory action model, v0.1.
 * THIS IS NOT a clinically validated PK/PD model and is NOT FOR DOSING.
 * Time anchors are group means from 12 adults (Plank et al, Diabetes Care 2005).
 * Piecewise linear interpolation + trapezoid shape are engineering assumptions.
 * All inputs use actual confirmed injection records with explicit time zone.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LevemirEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '0.1.0';
  const SOURCE = 'https://doi.org/10.2337/diacare.28.5.1107';
  const LABEL = 'https://dailymed.nlm.nih.gov/dailymed/fda/fdaDrugXsl.cfm?setid=82192527-99aa-4b53-8ce9-9173668d309c';
  const DOSE_ANCHORS = Object.freeze([
    Object.freeze({ unitsPerKg: 0.1, meanHours: 5.7 }),
    Object.freeze({ unitsPerKg: 0.2, meanHours: 12.1 }),
    Object.freeze({ unitsPerKg: 0.4, meanHours: 19.9 }),
    Object.freeze({ unitsPerKg: 0.8, meanHours: 22.7 }),
    Object.freeze({ unitsPerKg: 1.6, meanHours: 23.2 })
  ]);
  const PROFILE = Object.freeze({
    drugId: 'levemir', name: 'Левемир', substance: 'инсулин детемир',
    model: 'detemir_population_time_trapezoid', modelVersion: VERSION,
    durationSource: SOURCE, labelSource: LABEL,
    clinicalValidation: false, doseResponseInChildrenValidated: false,
    minimumJournalHours: 48
  });
  const WARNINGS = Object.freeze([
    'Исследовательская иллюстрация, НЕ медицинский алгоритм и НЕ прогноз глюкозы.',
    'Продолжительность — интерполяция средних результатов исследования 12 взрослых с СД1; у детей значения могут отличаться.',
    'Форма кривой (трапеция) задана разработчиком и НЕ восстановлена из измеренных кривых детемира.',
    'Равное нулю действие по модели НЕ означает прекращения действия в организме.',
    'Остаток условных единиц действия нельзя использовать для изменения доз Левемира, расчёта еды или лечения гипогликемии.',
    'Даже полный журнал не исключает ошибок внесения записей: фактические инъекции должны быть подтверждены.',
    'При подозрении на ошибочную/избыточную дозу инсулина нужна немедленная медицинская оценка.'
  ]);
  function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function parseTimestamp(iso) {
    if (typeof iso !== 'string') throw new Error('Время должно быть ISO 8601 с явным часовым поясом.');
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
    if (!m) throw new Error('Требуется YYYY-MM-DDTHH:mm:ss+03:00 или Z.');
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const calendar = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d ||
        h > 23 || mi > 59 || s > 59 || y < 2000 || y > 2100) throw new Error('Недопустимая календарная дата или время.');
    if (m[8] !== 'Z') {
      const hrs = Number(m[8].slice(1, 3)), mins = Number(m[8].slice(4, 6));
      if (hrs > 14 || mins > 59 || (hrs === 14 && mins !== 0)) throw new Error('Недопустимый часовой пояс.');
    }
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new Error('Некорректная временная метка.');
    return ms;
  }
  function estimateDuration(units, weightKg) {
    if (!finite(units) || units <= 0 || !finite(weightKg) || weightKg <= 0 || weightKg > 400) {
      throw new Error('Доза и масса должны быть положительными числами; масса не более 400 кг.');
    }
    const dosePerKg = units / weightKg;
    const min = DOSE_ANCHORS[0].unitsPerKg;
    const max = DOSE_ANCHORS[DOSE_ANCHORS.length-1].unitsPerKg;
    if (dosePerKg < min - 1e-12 || dosePerKg > max + 1e-12) return {
      supported: false, unitsPerKg: dosePerKg, populationMeanDurationHours: null,
      warning: 'Доза на кг вне исследованного диапазона 0,1–1,6 ЕД/кг. Экстраполяция запрещена.'
    };
    for (let k=0; k<DOSE_ANCHORS.length; k++) {
      const a = DOSE_ANCHORS[k];
      if (Math.abs(dosePerKg-a.unitsPerKg) < 1e-11) return {
        supported: true, unitsPerKg: dosePerKg, populationMeanDurationHours: a.meanHours,
        basis: 'observed_adult_cohort_mean', interpolated: false
      };
      if (k+1<DOSE_ANCHORS.length && dosePerKg>a.unitsPerKg && dosePerKg<DOSE_ANCHORS[k+1].unitsPerKg) {
        const b=DOSE_ANCHORS[k+1], w=(dosePerKg-a.unitsPerKg)/(b.unitsPerKg-a.unitsPerKg);
        return {supported:true, unitsPerKg:dosePerKg,
          populationMeanDurationHours:a.meanHours+w*(b.meanHours-a.meanHours),
          basis:'piecewise_linear_interpolation_adult_means', interpolated:true};
      }
    }
    throw new Error('Не удалось рассчитать интервал моделирования.');
  }
  // Illustrative non-biological trapezoid: linear onset, flat middle, linear tail.
  // Exact integral allows tests for conservation and multi-dose consistency.
  function curveGeometry(durationHours) {
    if (!finite(durationHours) || durationHours < 1 || durationHours > 24) throw new Error('Длительность модели: 1–24 ч.');
    const rise = Math.min(3, durationHours*0.3);
    const fallStart = Math.max(rise, durationHours*0.72);
    const area = rise/2 + (fallStart-rise) + (durationHours-fallStart)/2;
    return {rise,fallStart,area};
  }
  function curve(elapsedHours, durationHours) {
    if (!finite(elapsedHours) || elapsedHours<0) throw new Error('Возраст инъекции не может быть отрицательным.');
    const {rise,fallStart,area}=curveGeometry(durationHours);
    const t=clamp(elapsedHours,0,durationHours);
    let cumulative=0, shape=0, phase='MODEL_WINDOW_END';
    if (t === durationHours) {
      cumulative=area;
    } else if (t<rise) {
      cumulative=t*t/(2*rise);shape=t/rise; phase='MODEL_RISE';
    } else if (t<fallStart) {
      cumulative=rise/2+(t-rise);shape=1;phase='MODEL_PLATEAU';
    } else {
      const z=t-fallStart, tail=durationHours-fallStart;
      cumulative=rise/2+(fallStart-rise)+z-z*z/(2*tail);
      shape=1-z/tail;phase='MODEL_FALL';
    }
    const usedFraction=clamp(cumulative/area,0,1);
    return {usedFraction, remainingFraction:1-usedFraction,
      activityFractionPerHour:shape/area, phase};
  }
  function validateHorizons(horizons) {
    if (!Array.isArray(horizons) || horizons.length<1 || horizons.length>12 ||
      horizons.some(x=>!Number.isInteger(x)||x<1||x>1440) ||
      new Set(horizons).size!==horizons.length) throw new Error('Горизонты: уникальные целые минуты от 1 до 1440, максимум 12.');
    return horizons;
  }
  function calculate(req) {
    if (!req || typeof req!=='object') throw new Error('Нужен объект расчёта.');
    const now=parseTimestamp(req.nowIso);
    const weightKg=req.patientWeightKg;
    if (!finite(weightKg)||weightKg<=0||weightKg>400) throw new Error('Нужна достоверная масса тела в кг.');
    if (!Array.isArray(req.events)||req.events.length>10000) throw new Error('Нужен массив событий (не более 10000).');
    const horizons=validateHorizons(req.horizonsMinutes||[60,180,360]);
    const issues=[],ignored=[],accepted=[], completedModelWindows=[];
    const ids=new Set();
    if (!req.coverage || req.coverage.confirmedComplete!==true) issues.push('Журнал не подтверждён полным. Неизвестные инъекции нельзя считать отсутствующими.');
    else {
      try {
        const start=parseTimestamp(req.coverage.startIso), end=parseTimestamp(req.coverage.endIso);
        if (start>now-48*3600000 || end<now || start>end) issues.push('Требуется подтверждённая история инъекций минимум за 48 часов до расчёта.');
      } catch (_) { issues.push('Некорректное покрытие журнала датами.'); }
    }
    for (const e of req.events) {
      if (!e || typeof e!=='object') {issues.push('Повреждённая запись журнала.');continue;}
      if (e.type!=='insulin_injection') {if(!e.type) issues.push('Запись без типа события.'); continue;}
      const id=e.id;
      const drugId=e.insulinId;
      if (typeof drugId!=='string'||!drugId.trim()) {issues.push('Запись инъекции без названия препарата.');continue;}
      if (drugId!=='levemir') {
        const s=drugId.trim().toLowerCase();
        if(s==='rinfast'||s==='rinfast-nik') {ignored.push({id:String(id||'?'),reason:'Другой препарат'});continue;}
        issues.push('Неизвестный либо нестандартизованный ID препарата: '+drugId);continue;
      }
      if (typeof id!=='string'||!id.trim()||ids.has(id)) {issues.push('Повторяющийся или отсутствующий ID инъекции Левемира.'); continue;}
      ids.add(id);
      if(e.status==='planned'||e.status==='cancelled') { ignored.push({id,reason:'Запланирована/отменена, не подтверждена как введённая'}); continue; }
      if(e.status!=='confirmed') {issues.push('Неподтверждённая запись Левемира: '+id);continue;}
      if(!finite(e.units)||e.units<=0||e.units>200) {issues.push('Недостоверная доза Левемира: '+id);continue;}
      let at;
      try {at=parseTimestamp(e.administeredAt);} catch(_){issues.push('Некорректная дата введения: '+id);continue;}
      if(at>now){issues.push('Подтверждённая инъекция Левемира в будущем: '+id);continue;}
      if (e.doseErrorSuspected===true) {issues.push('Подозрение на ошибочную дозу Левемира: '+id+'; нужен медицинский разбор, а не математический прогноз.');continue;}
      const est=estimateDuration(e.units,weightKg);
      if(!est.supported) {issues.push('Инъекция '+id+': '+est.warning);continue;}
      const ageHours=(now-at)/3600000;
      const c=curve(ageHours,est.populationMeanDurationHours);
      const record={id,units:e.units,administeredAt:e.administeredAt,ageHours,
        unitsPerKg:est.unitsPerKg,populationMeanDurationHours:est.populationMeanDurationHours,
        interpolated:est.interpolated};
      if(c.phase==='MODEL_WINDOW_END') {
        completedModelWindows.push({...record, warning:'Модельная граница — не доказательство прекращения действия.'});
      } else accepted.push(record);
    }
    const base={engineVersion:VERSION,drugId:'levemir',drugName:'Левемир',model:PROFILE.model,
      modelVersion:PROFILE.modelVersion, nowIso:req.nowIso, weightKg,
      status:'INCOMPLETE', warnings:Array.from(WARNINGS),issues,ignored,completedModelWindows,
      adultStudySource:SOURCE, labelSource:LABEL,clinicalValidation:false,
      acceptedCount:accepted.length};
    if(issues.length) return {...base,remainingModelActionUnits:null, currentModelActivityUnitsPerHour:null,
      futureActionModelUnits:null, contributions:null};
    let remain=0,activity=0;
    const future=Object.fromEntries(horizons.map(h=>[String(h),0]));
    const contributions=accepted.map(r=>{
      const current=curve(r.ageHours,r.populationMeanDurationHours);
      const next={};
      for(const h of horizons){
        const after=curve(r.ageHours+h/60,r.populationMeanDurationHours);
        const amount=Math.max(0,r.units*(current.remainingFraction-after.remainingFraction));
        next[String(h)]=amount;future[String(h)]+=amount;
      }
      const rem=r.units*current.remainingFraction;
      const rate=r.units*current.activityFractionPerHour;
      remain+=rem;activity+=rate;
      return {...r,phase:current.phase,remainingFraction:current.remainingFraction,
        usedFraction:current.usedFraction, remainingModelActionUnits:rem,
        currentModelActivityUnitsPerHour:rate,
        modelWindowEndsAtIso:new Date(parseTimestamp(r.administeredAt)+r.populationMeanDurationHours*3600000).toISOString(),
        futureActionModelUnits:next};
    });
    return {...base,status:'MODEL_ESTIMATE',remainingModelActionUnits:remain,
      currentModelActivityUnitsPerHour:activity,futureActionModelUnits:future,contributions};
  }
  return Object.freeze({VERSION,SOURCE,LABEL,DOSE_ANCHORS,PROFILE,WARNINGS,parseTimestamp,
    estimateDuration,curveGeometry,curve,calculate});
});
