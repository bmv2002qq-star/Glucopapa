/* Explicit, read-only model run from a single GFStorage revision. No treatment output. */
(function (root) {
  'use strict';
  const absorption = typeof module === 'object' && module.exports
    ? require('./GFMealAbsorption_v0.1.0.js') : root.GFMealAbsorption;
  const HOUR = 3_600_000;
  const stopped = (code, reason) => ({status: 'UNAVAILABLE', code, reason, points: []});

  function prepare({host,safetyVerdict,foodHistoryDeclaration,mealCoverageRevision,kineticsByMealId,nowMs = Date.now(),mode}) {
    if (mode !== 'local') return stopped('TEST_JOURNAL', 'Тестовый журнал проверяется в изолированном стенде.');
    const trusted = root.GFForecastStorageAdapter.trustedReadings(host, {safetyVerdict});
    if (!trusted.available) return stopped(trusted.code, 'Требуются свежие показания с известным качеством и проверка GFSafety.');

    const research = host.connect('research');
    const snapshot = research.getSnapshot();
    if (snapshot.revision !== safetyVerdict.sourceRevision) {
      return stopped('REVISION_CHANGED', 'История изменилась во время чтения.');
    }
    const coverage = snapshot.coverage;
    if (!coverage?.confirmedComplete || coverage.declaredBy !== 'parent' ||
        !(Date.parse(coverage.startIso) <= nowMs - 48 * HOUR && Date.parse(coverage.endIso) >= nowMs)) {
      return stopped('INJECTION_COVERAGE', 'Требуется подтверждённая история инъекций за 48 часов.');
    }
    const food = absorption.inspect({host,snapshot,nowMs,
      options:{historyDeclaration:foodHistoryDeclaration,mealCoverageRevision,kineticsByMealId}});
    if (!food.historyDeclaration) {
      const code = food.code === 'REVISION_CHANGED' ? food.code : 'MEAL_COVERAGE';
      return {...stopped(code,'Для этой ревизии нужна подтверждённая история фактической еды.'),foodCode:food.code};
    }
    if (!food.forecastReady) {
      const code = food.forecastCode ?? food.code;
      const reasons = {
        SMOOTH_PROFILE_MISSING:'Для плавной модели не определён параметр усвоения из состава блюда.',
        LINEAR_INTERVAL_NO_POINT_MODEL:'Выбранная линейная модель даёт диапазон. Точечный вклад в прогноз не определён.',
        RESEARCH_PARAMETERS_REQUIRED:'Для линейной модели не хватает параметров записанного блюда.'
      };
      return {...stopped(code,reasons[code] ?? 'Вклад записанной еды не определён.'),mealModel:food.model};
    }
    const nowIso = new Date(nowMs).toISOString();
    const timeline = root.GFSettings.coefficientTimeline(snapshot.coefficients, nowIso, snapshot.profile.timeZone);
    const settings = {};
    const coefficients = [];
    for (const [kind, field] of [['carb_g_per_u', 'carbRatioGPerUnit'], ['isf_mmol_per_u', 'isfMmolPerUnit']]) {
      const rows = timeline.filter(x => x.kind === kind && x.isEffectiveAt);
      if (snapshot.profile.coefficientModes?.[kind] !== 'manual' || rows.length !== 1 ||
          !['manual', 'doctor'].includes(rows[0].source) || !Number.isFinite(rows[0].value)) {
        return stopped('COEFFICIENT_UNKNOWN', 'Нет однозначной действующей ручной записи УК и ФЧИ.');
      }
      settings[field] = rows[0].value;
      coefficients.push({kind, id: rows[0].id, value: rows[0].value, source: rows[0].source});
    }
    const at = date => Date.parse(date);
    const active = kind => snapshot.conditionPeriods.some(p => p.kind === kind && at(p.start) <= nowMs &&
      (p.end === null || at(p.end) > nowMs));
    const readings = trusted.readings.filter(r => at(r.measuredAt) >= nowMs - HOUR &&
      at(r.measuredAt) <= nowMs && at(r.receivedAt) <= nowMs);
    if (!readings.length || readings.length !== trusted.readings.filter(r => at(r.measuredAt) >= nowMs - HOUR).length) {
      return stopped('SOURCE_TIME_UNAVAILABLE', 'Измерение или его получение позже времени расчёта.');
    }
    const injections = snapshot.events.filter(e=>e.type==='insulin_injection'&&e.status==='confirmed'&&
      at(e.administeredAt)>=nowMs-48*HOUR);
    if (injections.some(e=>at(e.administeredAt)>nowMs))
      return stopped('INJECTION_TIME_UNAVAILABLE','Подтверждённая инъекция находится в будущем относительно расчёта.');
    const engine = root.RinfastEngine;
    const profile = snapshot.models?.rinfast?.profile;
    if (!profile || profile.modelVersion!==engine?.ENGINE_VERSION)
      return stopped('RINFAST_PROFILE_UNKNOWN','Версия профиля РинФаста не определена.');
    engine.validateProfile(profile);
    const input = {nowIso,readings,injections,
      // The selected model established zero modeled carbs. Do not reinsert meals into another model.
      meals: [],
      settings, conditions: {illness: active('illness'), activity: active('sport') || active('activity')},
      sourceIsComplete:true,rinfastEngine:{ENGINE_VERSION:engine.ENGINE_VERSION,DEFAULT_PROFILE:profile,
        getCurve:age=>engine.getCurve(age,profile)}};
    return research.getRevision() === snapshot.revision
      ? {status:'READY',input,snapshot,coefficients,foodHistoryDeclaration:food.historyDeclaration,mealModel:food.model}
      : stopped('REVISION_CHANGED', 'История изменилась во время подготовки.');
  }

  function run(options) {
    const state = prepare(options);
    if (state.status !== 'READY') return state;
    const result = root.GFForecast.predict(state.input);
    return options.host.connect('research').getRevision() === state.snapshot.revision
      ? {...result,sourceRevision:state.snapshot.revision,coefficients:state.coefficients,mealModel:state.mealModel}
      : stopped('REVISION_CHANGED', 'История изменилась во время вычисления.');
  }

  const api = Object.freeze({run, prepare});
  root.GFForecastReadout = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
