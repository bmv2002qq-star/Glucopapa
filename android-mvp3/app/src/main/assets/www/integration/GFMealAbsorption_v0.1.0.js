/* Resolves the selected research model on the same GFStorage revision as the consumer. */
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const storage = isNode ? require('../modules/GFStorage_v0.5.11/src/gfstorage_core.js') : root.GFStorage;
  const coverage = isNode ? require('./GFMealCoverageStudy_v0.1.1.js') : root.GFMealCoverageStudy;
  const linear = isNode ? require('./GFCOBResearch_v0.1.1.js') : root.GFCOBResearch;
  const smoothWindowMs = 6 * 3600_000;

  function selected(profile) {
    return profile.mealAbsorptionModel ?? storage.MEAL_MODELS.GFForecast;
  }

  function inspect({host, snapshot = host.connect('research').getSnapshot(), nowMs, options = {}}) {
    const model = selected(snapshot.profile);
    const base = {model, sourceRevision:snapshot.revision, status:'UNKNOWN', lowerG:null, upperG:null,
      contributions:[], forecastReady:false, historyDeclaration:null};
    const isCurrent = () => host.connect('research').getRevision() === snapshot.revision;
    if (!isCurrent()) return {...base,code:'REVISION_CHANGED'};
    const history = options.historyDeclaration;
    const attestation = options.mealCoverageRevision === snapshot.revision && history
      ? {...history,scope:'all_meals',sourceRevision:snapshot.revision} : null;
    const study = coverage.inspect({host,nowMs,acknowledgement:attestation,kineticsByMealId:options.kineticsByMealId});
    if (!isCurrent()) return {...base,code:'REVISION_CHANGED'};
    if (!study.historyDeclaration) return {...base,code:study.code};
    const declared = {...base,historyDeclaration:study.historyDeclaration};

    if (model.id === 'GFCOB') {
      if (!study.eligible) return {...declared,code:study.code};
      const result = linear.inspect({host,nowMs,...study.researchOptions});
      if (!isCurrent() || result.sourceRevision !== snapshot.revision) return {...base,code:'REVISION_CHANGED'};
      const forecastReady = result.status === 'RESEARCH_INTERVAL' && result.upperG === 0;
      return {...declared,...result,model,forecastReady,
        forecastCode:result.status === 'RESEARCH_INTERVAL' ? 'LINEAR_INTERVAL_NO_POINT_MODEL' : result.code};
    }

    // Canonical GFForecast ignores meals older than six hours. The archive's default
    // tau is a single fixture parameter; there is no meal-composition-to-tau contract.
    const active = study.mealRows.filter(meal =>
      nowMs - Date.parse(meal.startedAt) <= smoothWindowMs && meal.carbsRecordedG > 0);
    if (active.length) return {...declared,code:'SMOOTH_PROFILE_MISSING',mealIds:active.map(meal=>meal.id)};
    return {...declared,status:'MODEL_ZERO',code:'NO_MODELED_CARBS',forecastReady:true,lowerG:0,upperG:0};
  }

  const api = Object.freeze({selected,inspect});
  root.GFMealAbsorption = api;
  if (isNode) module.exports = api;
})(globalThis);
