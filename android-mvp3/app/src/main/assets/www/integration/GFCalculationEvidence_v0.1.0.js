/* Read-only calculation evidence for the three MVP3 routes. No recommendation or action-writing API. */
(function (root) {
  'use strict';
  const absorption = typeof module === 'object' && module.exports
    ? require('./GFMealAbsorption_v0.1.0.js') : root.GFMealAbsorption;
  const minute = 60_000;
  const kindLabels = {carb_g_per_u: 'Углеводный коэффициент', isf_mmol_per_u: 'Чувствительность к инсулину'};
  const messages = {
    CGM_SOURCE_UNKNOWN: 'Источник CGM отсутствует.',
    CGM_NOT_ENOUGH: 'В журнале нет подходящих показаний CGM.',
    CGM_STALE: 'Последнее показание CGM устарело.',
    CGM_FUTURE_TIMESTAMP: 'Время измерения CGM находится в будущем.',
    CGM_FUTURE_RECEIPT: 'Время получения CGM находится в будущем.',
    CGM_QUALITY_REJECTED: 'Последнее CGM отклонено по качеству.',
    CGM_SOURCE_QUALITY_LOW: 'У источника CGM низкое или неизвестное качество.',
    XDRIP_MODEL_QUALITY_UNKNOWN: 'Источник xDrip+ не передаёт качество, необходимое для расчёта.',
    XDRIP_FRESHNESS_UNKNOWN: 'Источник xDrip+ не указал свежесть показания.',
    CGM_SYNTHETIC: 'Рабочий расчёт требует несинтетического источника CGM.',
    CGM_TREND_INCOMPLETE: 'Для скорости изменения нужны три показания подряд за последние 25 минут.',
    JOURNAL_COVERAGE_UNKNOWN: 'Полнота истории инъекций не подтверждена.',
    JOURNAL_COVERAGE_INSUFFICIENT: 'Заявленное покрытие истории инъекций не включает последние 48 часов.',
    FOOD_COVERAGE_MISSING: 'Не подтверждена полнота еды за последние 12 часов.',
    NEEDS_FRESH_USER_ATTESTATION: 'Подтвердите полноту еды за последние 12 часов.',
    NO_CONFIRMED_MEALS_IN_WINDOW: 'Подтверждённых приёмов пищи нет; нужна декларация полноты.',
    SMOOTH_PROFILE_MISSING: 'Для плавной модели нет проверенного правила выбора параметра усвоения по составу блюда.',
    RESEARCH_PARAMETERS_REQUIRED: 'Линейной модели нужны известные параметры усвоения всех записанных блюд.',
    MEAL_NOT_CONFIRMED: 'В истории есть начатая и незавершённая еда.',
    FOOD_COMPOSITION_INCOMPLETE: 'Фактический состав одного или нескольких приёмов пищи неизвестен.',
    KINETICS_NOT_DEFINED: 'У одного или нескольких приёмов пищи нет модельного профиля усвоения.',
    REVISION_CHANGED: 'Журнал изменился во время сверки. Обновите данные.',
  };
  const quantity = (value, unit) => Number.isFinite(value)
    ? new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 5}).format(value) + ' ' + unit
    : 'неизвестно';
  const issue = (code, field, message) => ({code, field, message: message || messages[code] || 'Проверка входа не пройдена (' + code + ').'});

  function trendFromReadings(readings, nowMs, source) {
    const recent = readings.filter(point => point.ts >= nowMs - 25 * minute && point.ts <= nowMs);
    const first = recent[0], last = recent.at(-1);
    if (recent.length < 3 || last.ts - first.ts < 10 * minute ||
        recent.some((point, i) => i && point.ts - recent[i - 1].ts > 15 * minute)) {
      return {rateMmolPerMinute: null, direction: last?.direction || null, source};
    }
    return {rateMmolPerMinute: (last.mmol - first.mmol) / ((last.ts - first.ts) / minute),
      direction: last.direction || null, source, firstTs: first.ts, lastTs: last.ts, points: recent.length};
  }

  function coefficient(rows, profile, kind) {
    if (!profile.timeZone) return {issue: issue('COEFFICIENT_ZONE', kind, 'Часовой пояс профиля не задан.')};
    if (profile.coefficientModes?.[kind] !== 'manual') {
      return {issue: issue('COEFFICIENT_MODE', kind, kindLabels[kind] + ' в исследовательском режиме Auto.')};
    }
    const active = rows.filter(row => row.kind === kind && row.isEffectiveAt);
    if (active.length !== 1) {
      return {issue: issue(active.length ? 'COEFFICIENT_CONFLICT' : 'COEFFICIENT_MISSING', kind,
        kindLabels[kind] + (active.length ? ' имеет конфликтующие записи.' : ' не задан на этот интервал.'))};
    }
    const row = active[0];
    if (row.source !== 'manual' || !root.GFTimeGrid.slotOf(row.windowLocal) ||
        !Number.isFinite(row.value) || row.value <= 0) {
      return {issue: issue('COEFFICIENT_UNVERIFIED', kind, kindLabels[kind] + ' имеет неподдерживаемый формат или источник.')};
    }
    return {value: row.value, id: row.id, source: row.source, window: row.windowLocal, effectiveFrom: row.effectiveFrom};
  }

  function plateFor(host, sessionId, blockers, uncertainties) {
    const session = host.connect('calculator').read('mealSessions').find(item => item.id === sessionId);
    const plate = session?.actualPlate || session?.plannedPlate;
    if (!plate) {
      blockers.push(issue('PLATE_MISSING', 'food', 'Добавьте план из «Моей тарелки».'));
      return null;
    }
    if (plate.items.some(item => !Number.isFinite(item.amount) || !['г', 'мл'].includes(item.unit))) {
      blockers.push(issue('PLATE_QUANTITY_UNKNOWN', 'food', 'Масса или объём одного из продуктов неизвестны.'));
    }
    if (plate.items.some(item => item.carbs > 0 &&
        (!Number.isFinite(item.glycemicIndex) || !item.glycemicIndexStatus))) {
      blockers.push(issue('PLATE_GI_UNKNOWN', 'food', 'ГИ или его источник неизвестны у одного или нескольких продуктов.'));
    }
    if (plate.containsEstimatedValues) {
      uncertainties.push(issue('PLATE_KINETICS_UNCERTAIN', 'food', 'Для состава тарелки есть оценочные данные.'));
    }
    return {id: session.id, status: session.status, source: session.actualPlate ? 'actual' : 'planned',
      carbsG: plate.totals.carbs, fatG: plate.totals.fat, proteinG: plate.totals.protein};
  }

  function inspect({host, route, nowMs = Date.now(), activeMeal = null, cobOptions = {}}) {
    if (!['low', 'high', 'meal'].includes(route)) throw Error('CALC_UNKNOWN_ROUTE');
    const checkedAt = new Date(nowMs).toISOString();
    const settingsPort = host.connect('settings'), settings = settingsPort.getSnapshot();
    const revision = settings.revision;
    const blockers = [], uncertainties = [];
    const cgm = root.GFCgmEvidencePolicy.inspect(host, {nowMs});
    const trend = trendFromReadings(cgm.readings, nowMs, cgm.sourceStatus);
    if (cgm.status !== 'OK') blockers.push(issue(cgm.code, 'cgm'));
    if (cgm.sourceStatus === 'SYNTHETIC') blockers.push(issue('CGM_SYNTHETIC', 'cgm'));
    if (trend.rateMmolPerMinute === null) blockers.push(issue('CGM_TREND_INCOMPLETE', 'trend'));

    const rapid = root.GFInsulinEvidenceGate.calculateFromHost(host, checkedAt, root.RinfastEngine);
    if (rapid.status !== 'MODEL_ESTIMATE') blockers.push(issue(rapid.code, 'iob', messages[rapid.code] || rapid.detail));
    const cob = absorption.inspect({host,nowMs,options:cobOptions});
    if (cob.status === 'RESEARCH_INTERVAL')
      uncertainties.push(issue('COB_MODEL_INTERVAL', 'cob', 'COB оценён модельным диапазоном.'));
    else if (cob.status !== 'MODEL_ZERO') {
      const absent = ['NEEDS_FRESH_USER_ATTESTATION','NO_CONFIRMED_MEALS_IN_WINDOW'].includes(cob.code);
      blockers.push(issue(absent?'FOOD_COVERAGE_MISSING':cob.code,'cob',messages[cob.code]));
    }
    const timeline = root.GFSettings.coefficientTimeline(settings.coefficients, checkedAt, settings.profile.timeZone);
    const needed = route === 'meal' ? ['isf_mmol_per_u', 'carb_g_per_u'] : ['isf_mmol_per_u'];
    const coefficients = Object.fromEntries(needed.map(kind => [kind, coefficient(timeline, settings.profile, kind)]));
    for (const value of Object.values(coefficients)) if (value.issue) blockers.push(value.issue);

    const plate = route === 'meal' ? plateFor(host, activeMeal, blockers, uncertainties) : null;
    if (route === 'low') blockers.push(issue('LOW_SCENARIO_MISSING', 'scenario', 'Рабочие параметры сценария цели и продукта не подключены.'));
    if (route === 'high') blockers.push(issue('HIGH_TARGET_MISSING', 'scenario', 'Рабочий параметр цели не подключён.'));
    if (route === 'meal') blockers.push(issue('MEAL_TIMING_MODEL_UNAVAILABLE', 'timing', 'Метод оценки паузы между инъекцией и едой не утверждён.'));

    const illness = root.GFSettings.createSettingsService({settingsPort}).getView(checkedAt).illness;
    const sportActive = settings.conditionPeriods.some(period => period.kind === 'sport' &&
      Date.parse(period.start) <= nowMs && (period.end === null || nowMs < Date.parse(period.end)));
    if (illness.active) uncertainties.push(issue('ILLNESS_CONTEXT', 'illness', 'Болезнь зафиксирована; влияние на результат не определено.'));
    if (sportActive) uncertainties.push(issue('SPORT_CONTEXT', 'sport', 'Спорт идёт; влияние на результат не определено.'));
    let basal;
    try {
      basal = root.GPModuleHub.levemirModel(host, checkedAt);
    } catch {
      basal = {status: 'MODEL_READ_FAILED', remainingModelActionUnits: null};
    }
    if (basal.status !== 'MODEL_ESTIMATE') {
      uncertainties.push(issue('LEVEMIR_UNAVAILABLE', 'basal', (basal.issues || []).join(' ') || 'Модель Левемира недоступна.'));
    }
    if (settingsPort.getRevision() !== revision ||
        [cgm.revision, cob.sourceRevision].some(value => value != null && value !== revision)) {
      return {route, revision: null, status: 'BLOCKED', result: null,
        blockers: [issue('REVISION_CHANGED', 'storage')], uncertainties: [], trace: null};
    }
    return {route, revision, status: 'BLOCKED', result: null, blockers, uncertainties,
      trace: {checkedAt, timeZone: settings.profile.timeZone, coefficients, plate, sportActive, illness,
        activity: settings.profile.activityBaseLevel, glucose: {source: cgm.sourceStatus, code: cgm.code,
          measuredAt: cgm.latestAt, ageMinutes: cgm.ageMinutes ?? null, observedMmol: cgm.currentMmol ?? cgm.reportedMmol ?? null},
        trend, iob: {status: rapid.status, method: rapid.method, coverageStartIso: rapid.coverageStartIso,
          contributions: rapid.parts, valueU: rapid.totalModelUnits},
        cob: {model:cob.model,status:cob.status,code:cob.code,lowerG:cob.lowerG,upperG:cob.upperG,contributions:cob.contributions},
        levemir: {status: basal.status, valueU: basal.remainingModelActionUnits}},
    };
  }

  function render(node, evidence) {
    const text = node.querySelector('[data-calc-summary]');
    const list = node.querySelector('[data-calc-blockers]');
    const trace = node.querySelector('[data-calc-trace]');
    text.textContent = 'Расчёт недоступен';
    list.replaceChildren(...evidence.blockers.map(blocker => {
      const item = node.ownerDocument.createElement('li');
      item.textContent = blocker.message;
      item.dataset.code = blocker.code;
      return item;
    }));
    const s = evidence.trace;
    if (!s) {
      trace.textContent = 'Снимок данных недоступен.';
      return;
    }
    const lines = [
      'GFStorage · ревизия ' + evidence.revision + ' · проверено ' + s.checkedAt,
      'CGM · ' + s.glucose.source + ' · ' + (s.glucose.measuredAt || 'время неизвестно') +
        ' · ' + quantity(s.glucose.observedMmol, 'ммоль/л') + ' · возраст ' +
        quantity(s.glucose.ageMinutes, 'мин'),
      'Скорость CGM · ' + quantity(s.trend.rateMmolPerMinute, 'ммоль/л/мин') +
        ' · тренд источника ' + (s.trend.direction || 'не передан'),
      ...Object.entries(s.coefficients).map(([kind, v]) => kindLabels[kind] + ' · ' +
        (v.issue ? v.issue.message : quantity(v.value, kind === 'carb_g_per_u' ? 'г/ЕД' : 'ммоль/л/ЕД') +
          ' · ручная запись ' + v.id + ' · ' + v.window.from + '–' + v.window.to)),
      'IOB РинФаста · ' + quantity(s.iob.valueU, 'ЕД модели') + ' · ' + (s.iob.method || s.iob.status),
      ...(s.iob.contributions || []).map(row => '  ' + row.id + ' · введено ' + quantity(row.units, 'ЕД') +
        ' · прошло ' + quantity(row.ageMinutes, 'мин') + ' · вклад ' + quantity(row.remainingModelUnits, 'ЕД модели')),
      'COB · '+s.cob.model.id+' '+s.cob.model.version+' · ' + (['RESEARCH_INTERVAL','MODEL_ZERO'].includes(s.cob.status) ?
        quantity(s.cob.lowerG, 'г') + ' – ' + quantity(s.cob.upperG, 'г') : s.cob.code),
      ...(s.cob.contributions || []).map(row => '  ' + row.mealId + ' · всего ' + quantity(row.carbsRecordedG, 'г') +
        ' · модельный вклад ' + quantity(row.lowerG, 'г') + ' – ' + quantity(row.upperG, 'г')),
      'Левемир · ' + quantity(s.levemir.valueU, 'ЕД модели') + ' · ' + s.levemir.status,
      'Контекст · активность ' + (s.activity || 'неизвестна') + ' · спорт ' + (s.sportActive ? 'идёт' : 'не идёт') +
        ' · болезнь ' + s.illness.status,
    ];
    if (s.plate) lines.push('Тарелка · ' + (s.plate.source === 'planned' ? 'план' : 'подтверждённый факт') +
      ' · углеводы ' + quantity(s.plate.carbsG, 'г') + ' · жиры ' + quantity(s.plate.fatG, 'г') +
      ' · белки ' + quantity(s.plate.proteinG, 'г'));
    lines.push(...evidence.uncertainties.map(v => 'Неопределённость · ' + v.message),
      'Итог и прогноз не вычислены.');
    trace.textContent = lines.join('\n');
  }

  const api = Object.freeze({VERSION: '0.1.0', inspect, render});
  root.GFCalculationEvidence = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
