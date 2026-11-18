/*
 * ГлюкоПапа: независимый исследовательский модуль IOB для РинФаста (инсулин аспарт).
 * v0.3.0. Расчётная кривая OpenAPS exponential (rapid acting), не индивидуальная
 * фармакодинамическая оценка и НЕ алгоритм назначения инсулина/еды.
 * Не требуется сеть, CGM, журнал еды или другие модули.
 * License of THIS implementation: MIT. Reference method: OpenAPS/oref0.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RinfastEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const ENGINE_VERSION = "0.3.0";
  const DEFAULT_PROFILE = Object.freeze({
    drugId: "rinfast", drugName: "РинФаст", substance: "инсулин аспарт",
    model: "openaps_exponential_rapid", modelVersion: "0.3.0",
    diaMinutes: 300, peakMinutes: 75,
    dataSource: "https://help.geropharm.ru/rinfast-insulin-aspart",
    modelSource: "https://github.com/openaps/oref0/blob/master/lib/iob/calculate.js",
    clinicalValidation: false
  });
  // Диапазоны — из инструкции производителя, НЕ параметры кривой OpenAPS.
  const LABEL_TIME_RANGES = Object.freeze({
    onsetMinutes: Object.freeze([10, 20]),
    maximumEffectMinutes: Object.freeze([60, 180]),
    durationMinutes: Object.freeze([180, 300]),
    source: "https://help.geropharm.ru/rinfast-insulin-aspart"
  });
  const WARNINGS = Object.freeze([
    "Расчёт — модель доли оставшегося эффекта, не измерение инсулина в крови.",
    "Профиль 300/75 минут — исследовательские параметры OpenAPS, не индивидуальная кривая РинФаста.",
    "Число IOB нельзя использовать самостоятельно для расчёта доз, углеводов или лечения гипогликемии.",
    "Отсутствие записей в журнале не доказывает отсутствия введённого инсулина.",
    "Ноль через выбранную DIA означает только завершение выбранной математической кривой, не гарантирует отсутствия действия в организме.",
    "Начало 10–20 мин, максимум 1–3 ч, длительность 3–5 ч — диапазоны по инструкции, не персональные пороги.",
    "Рост математической активности до 10 минут НЕ означает подтверждённый клинический эффект до 10 минут.",
    "Модельная продолжительность 360+ минут выходит за пределы типичного диапазона 3–5 часов из инструкции и служит только анализу чувствительности."
  ]);
  function finiteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function validateProfile(profile) {
    const p = profile == null ? DEFAULT_PROFILE : profile;
    if (!p || p.drugId !== "rinfast" || p.model !== "openaps_exponential_rapid") {
      throw new Error("Профиль должен быть для РинФаста с моделью openaps_exponential_rapid.");
    }
    if (!finiteNumber(p.diaMinutes) || p.diaMinutes < 300 || p.diaMinutes > 480) {
      throw new Error("Некорректная длительность DIA: разрешён исследовательский диапазон 300–480 мин.");
    }
    if (!finiteNumber(p.peakMinutes) || p.peakMinutes < 50 || p.peakMinutes > 120 || p.peakMinutes >= p.diaMinutes / 2) {
      throw new Error("Некорректное время пика: 50–120 мин и строго меньше половины DIA.");
    }
    return p;
  }
  function parameters(profile) {
    const p = validateProfile(profile);
    const D = p.diaMinutes, P = p.peakMinutes;
    const tau = P * (1 - P / D) / (1 - 2 * P / D);
    const a = 2 * tau / D;
    const scale = 1 / (1 - a + (1 + a) * Math.exp(-D / tau));
    if (![tau, a, scale].every(Number.isFinite) || tau <= 0 || scale <= 0) {
      throw new Error("Не удалось рассчитать устойчивые параметры кривой.");
    }
    return { D, P, tau, a, scale };
  }
  /** Returns a fraction of insulin GLUCOSE-LOWERING EFFECT remaining, not plasma insulin. */
  function getCurve(ageMinutes, profile = DEFAULT_PROFILE) {
    if (!finiteNumber(ageMinutes) || ageMinutes < 0) throw new Error("Возраст инъекции должен быть неотрицательным числом минут.");
    const { D, tau, a, scale } = parameters(profile);
    if (ageMinutes >= D) return { remainingFraction: 0, usedFraction: 1, activityFractionPerMinute: 0 };
    if (ageMinutes === 0) return { remainingFraction: 1, usedFraction: 0, activityFractionPerMinute: 0 };
    const t = ageMinutes;
    const exp = Math.exp(-t / tau);
    // Algebraically equivalent to OpenAPS iobContrib, but avoids / (1-a)
    // singularity when peak makes a exactly 1.
    const remaining = 1 - scale * ((t * t / (tau * D) - (1 - a) * (t / tau + 1)) * exp + (1 - a));
    const activity = (scale / (tau * tau)) * t * (1 - t / D) * exp;
    const r = clamp01(remaining);
    return { remainingFraction: r, usedFraction: 1 - r, activityFractionPerMinute: Math.max(0, activity) };
  }
  /** Instruction-based qualitative phase, deliberately independent of model action. */
  function getPhase(ageMinutes, profile = DEFAULT_PROFILE) {
    const p = validateProfile(profile);
    if (!finiteNumber(ageMinutes) || ageMinutes < 0) throw new Error("Возраст инъекции должен быть неотрицательным числом минут.");
    if (ageMinutes >= p.diaMinutes) return {code:"MODEL_HORIZON_PASSED",label:"За пределами выбранного модельного интервала",modelMinutesRemaining:0};
    const modelMinutesRemaining = p.diaMinutes - ageMinutes;
    if (ageMinutes < 10) return {code:"BEFORE_TYPICAL_ONSET",label:"До типичного начала действия по инструкции",modelMinutesRemaining};
    if (ageMinutes < 20) return {code:"ONSET_WINDOW",label:"Диапазон начала действия по инструкции",modelMinutesRemaining};
    if (ageMinutes < 60) return {code:"BEFORE_MAX_EFFECT_WINDOW",label:"После начала, до диапазона максимального эффекта",modelMinutesRemaining};
    if (ageMinutes <= 180) return {code:"MAX_EFFECT_WINDOW",label:"Диапазон максимального эффекта по инструкции",modelMinutesRemaining};
    if (ageMinutes < 300) return {code:"LATE_EFFECT_WINDOW",label:"Поздняя часть диапазона действия по инструкции",modelMinutesRemaining};
    return {code:"EXTENDED_RESEARCH_MODEL",label:"Исследовательское продление за 5 часов — вне типичного диапазона инструкции",modelMinutesRemaining};
  }
  function timestampMs(value) {
    if (typeof value !== "string" || !/T\d\d:\d\d/.test(value) || !/(?:Z|[+\-]\d\d:\d\d)$/i.test(value)) {
      throw new Error("Время должно быть ISO 8601 с часовым поясом, например 2026-11-13T13:00:00+03:00.");
    }
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error("Невозможно прочитать время.");
    return ms;
  }
  function validateHorizons(horizons) {
    if (!Array.isArray(horizons) || horizons.length < 1 || horizons.length > 12 ||
        !horizons.every(v => Number.isInteger(v) && v > 0 && v <= 480) ||
        new Set(horizons).size !== horizons.length) {
      throw new Error("Горизонты прогноза: уникальные положительные целые минуты (1–480), не более 12.");
    }
    return horizons;
  }
  /**
   * Input: {nowIso, events, profile, horizonsMinutes?}
   * Event: {id, type:'insulin_injection', insulinId:'rinfast', status:'confirmed',
   *         administeredAt:'ISO8601 with offset', units: positive number}
   * On any ambiguous relevant record -> INCOMPLETE and ALL computed values null.
   */
  function calculate(request) {
    if (!request || typeof request !== "object") throw new Error("Передайте объект запроса.");
    const profile = validateProfile(request.profile || DEFAULT_PROFILE);
    const now = timestampMs(request.nowIso);
    if (!Array.isArray(request.events) || request.events.length > 10000) {
      throw new Error("События журнала должны быть массивом длиной до 10 000.");
    }
    const horizons = validateHorizons(request.horizonsMinutes || [15, 30, 60]);
    const issues = [], ignored = [];
    const accepted = [], ids = new Set();
    for (const event of request.events) {
      if (!event || typeof event !== "object") {
        issues.push("В журнале обнаружена повреждённая запись."); continue;
      }
      if (event.type !== "insulin_injection") {
        if (!event.type) issues.push("В журнале запись без типа события.");
        continue;
      }
      if (typeof event.insulinId !== "string" || !event.insulinId.trim()) {
        issues.push("Инъекция без идентификатора инсулина."); continue;
      }
      if (event.insulinId !== "rinfast") {
        if (event.insulinId === "levemir") {
          ignored.push({ id: String(event.id || "?"), reason: "Левемир учитывается отдельным модулем" });
        } else {
          issues.push(`Инъекция ${String(event.id || "?")}: препарат ${event.insulinId} неизвестен этому модулю или является другим коротким инсулином; требуется сверка журнала.`);
        }
        continue;
      }
      if (typeof event.id !== "string" || !event.id.trim() || ids.has(event.id)) {
        issues.push("Отсутствует или повторяется идентификатор инъекции РинФаста."); continue;
      }
      ids.add(event.id);
      if (event.status !== "confirmed") {
        issues.push(`Инъекция ${event.id}: нет подтверждения фактического введения (status=confirmed).`);
        continue;
      }
      if (!finiteNumber(event.units) || event.units <= 0 || event.units > 200) {
        issues.push(`Инъекция ${event.id}: недостоверная доза.`); continue;
      }
      let administration;
      try { administration = timestampMs(event.administeredAt); }
      catch (_) { issues.push(`Инъекция ${event.id}: недостоверное время.`); continue; }
      if (administration > now) {
        issues.push(`Инъекция ${event.id}: время в будущем относительно момента расчёта.`); continue;
      }
      const ageMinutes = (now - administration) / 60000;
      if (ageMinutes >= profile.diaMinutes) {
        ignored.push({ id: event.id, reason: "За пределами расчётной длительности действия" });
        continue;
      }
      accepted.push({ id: event.id, units: event.units, ageMinutes, administeredAt: event.administeredAt });
    }
    const base = {
      engineVersion: ENGINE_VERSION, modelVersion: profile.modelVersion || ENGINE_VERSION,
      drugId: "rinfast", drugName: "РинФаст", model: profile.model,
      diaMinutes: profile.diaMinutes, peakMinutes: profile.peakMinutes,
      nowIso: request.nowIso, issues, ignored,
      warnings: Array.from(WARNINGS), timingSource: LABEL_TIME_RANGES.source, instructionTiming: LABEL_TIME_RANGES, acceptedCount: accepted.length,
      clinicalValidation: false,
      statusMeaning: "MODEL_ESTIMATE означает математический расчёт, не индивидуально проверенное действие",
      assumesCompleteJournal: true,
      durationBeyondLabel: profile.diaMinutes > 300,
      labelOnsetIsNotHardCutoff: true
    };
    if (issues.length) {
      return { ...base, status: "INCOMPLETE", modelRemainingUnits: null,
        activityModelUnitsPerMinute: null, futureActionModelUnits: null, contributions: null };
    }
    let modelRemainingUnits = 0, activityModelUnitsPerMinute = 0;
    const futureActionModelUnits = Object.fromEntries(horizons.map(h => [String(h), 0]));
    const contributions = accepted.map(inj => {
      const atNow = getCurve(inj.ageMinutes, profile);
      const actionNext = {};
      for (const h of horizons) {
        const after = getCurve(inj.ageMinutes + h, profile);
        const part = Math.max(0, inj.units * (atNow.remainingFraction - after.remainingFraction));
        actionNext[String(h)] = part;
        futureActionModelUnits[String(h)] += part;
      }
      const remainingUnits = inj.units * atNow.remainingFraction;
      const usedUnits = inj.units * atNow.usedFraction;
      const activityUnitsPerMinute = inj.units * atNow.activityFractionPerMinute;
      modelRemainingUnits += remainingUnits;
      activityModelUnitsPerMinute += activityUnitsPerMinute;
      return {
        id: inj.id, administeredAt: inj.administeredAt, ageMinutes: inj.ageMinutes,
        phase: getPhase(inj.ageMinutes, profile),
        doseUnits: inj.units, remainingFraction: atNow.remainingFraction,
        usedFraction: atNow.usedFraction, remainingModelUnits: remainingUnits,
        usedModelUnits: usedUnits, activityModelUnitsPerMinute: activityUnitsPerMinute,
        futureActionModelUnits: actionNext
      };
    });
    return {
      ...base, status: "MODEL_ESTIMATE", modelRemainingUnits,
      activityModelUnitsPerMinute, futureActionModelUnits, contributions
    };
  }
  /**
   * Исследовательская серия по времени вокруг nowIso.
   * Перед инъекцией её действие = 0, после DIA = 0 только в рамках модели.
   * Данные используются только для построения отдельных и суммарных графиков.
   * Не оценивает фактический сахар и не назначает терапию.
   */
  function calculateTimeline(request, options = {}) {
    if (!request || typeof request !== "object") throw new Error("Нужен объект запроса.");
    const profile = validateProfile(request.profile || DEFAULT_PROFILE);
    const now = timestampMs(request.nowIso);
    const start = options.startOffsetMinutes == null ? -240 : options.startOffsetMinutes;
    const end = options.endOffsetMinutes == null ? 360 : options.endOffsetMinutes;
    const step = options.stepMinutes == null ? 5 : options.stepMinutes;
    if (![start, end, step].every(finiteNumber) || !Number.isInteger(start) || !Number.isInteger(end) ||
        !Number.isInteger(step) || start < -600 || end > 600 || end <= start || step < 1 || step > 60 ||
        Math.ceil((end - start) / step) > 1200) {
      throw new Error("Некорректный интервал графика: -600..+600 минут, шаг 1–60 минут.");
    }
    const audit = calculate({ nowIso: request.nowIso, events: request.events, profile });
    if (audit.status !== "MODEL_ESTIMATE") return {
      status: "INCOMPLETE", issues: audit.issues, rows: null, shotIds: null, clinicalValidation: false
    };
    const shots = request.events.filter(e => e.type === "insulin_injection" && e.insulinId === "rinfast")
      .map(e => ({ id: e.id, units: e.units, administeredAt: e.administeredAt,
        ageAtNowMinutes: (now - timestampMs(e.administeredAt)) / 60000 }));
    const rows = [];
    for (let offset = start; offset <= end; offset += step) {
      const perShot = []; let totalActivityUnitsPerMinute = 0, totalRemainingModelUnits = 0;
      for (const shot of shots) {
        const age = shot.ageAtNowMinutes + offset;
        const curve = age < 0 ? null : getCurve(age, profile);
        const activityUnitsPerMinute = curve ? shot.units * curve.activityFractionPerMinute : 0;
        const remainingModelUnits = curve ? shot.units * curve.remainingFraction : 0;
        perShot.push({ id: shot.id, activityUnitsPerMinute, remainingModelUnits });
        totalActivityUnitsPerMinute += activityUnitsPerMinute;
        totalRemainingModelUnits += remainingModelUnits;
      }
      rows.push({ offsetMinutes: offset, totalActivityUnitsPerMinute, totalRemainingModelUnits, perShot });
    }
    if (rows.at(-1).offsetMinutes !== end) {
      const tail = calculateTimeline(request, { startOffsetMinutes: end-1, endOffsetMinutes: end, stepMinutes: 1 });
      // Include endpoint without duplicating previous data.
      rows.push(tail.rows.at(-1));
    }
    return { status: "MODEL_ESTIMATE", modelVersion: ENGINE_VERSION,
      profile: {diaMinutes: profile.diaMinutes, peakMinutes: profile.peakMinutes},
      shotIds: shots.map(x => x.id), rows,
      labelTiming: LABEL_TIME_RANGES, clinicalValidation: false };
  }
  /** Sensitivity analysis; NEVER chooses a patient-specific DIA. */
  function compareDurations(request, durationMinutes = [300, 360]) {
    if (!Array.isArray(durationMinutes) || durationMinutes.length < 2 || durationMinutes.length > 6 ||
        new Set(durationMinutes).size !== durationMinutes.length) {
      throw new Error("Нужны 2–6 уникальных вариантов исследовательского времени DIA.");
    }
    const baseline = validateProfile(request.profile || DEFAULT_PROFILE);
    const alternatives = durationMinutes.map(diaMinutes => {
      const profile = {...baseline, diaMinutes};
      validateProfile(profile);
      const r = calculate({...request, profile});
      return {diaMinutes, peakMinutes: profile.peakMinutes, status: r.status,
        modelRemainingUnits: r.modelRemainingUnits,
        futureActionModelUnits: r.futureActionModelUnits, issues: r.issues};
    });
    return {status: alternatives.every(a => a.status === "MODEL_ESTIMATE") ? "MODEL_ESTIMATE" : "INCOMPLETE",
      scenarios: alternatives, clinicalValidation: false,
      note: "Диапазон сценариев НЕ является доверительным интервалом и НЕ предсказывает клиническую погрешность."};
  }
  return Object.freeze({ ENGINE_VERSION, DEFAULT_PROFILE, LABEL_TIME_RANGES, WARNINGS, getPhase,
    validateProfile, getCurve, calculate, calculateTimeline, compareDurations });
});
