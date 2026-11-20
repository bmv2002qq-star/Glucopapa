/* GFMainScreen v1.0.0 integration. Projections of the same GFJournal used for export. */
(function (root) {
  'use strict';
  const nutrients = [
    ['Белки','protein','proteinG','г'], ['Жиры','fat','fatG','г'],
    ['Углеводы','carbs','carbsG','г'], ['Калории','kcal','kcal','ккал'],
  ];
  const actionKinds = new Set(['injection','meal','legacy_meal','sport','illness_start','illness_end','activity','note']);
  const factual = row => row.kind !== 'meal' || ['started','completed'].includes(row.status);

  function nutrition(rows, reference) {
    const meals = rows.filter(row => row.kind === 'legacy_meal' || (row.kind === 'meal' && factual(row)));
    const uniqueMeals = [...new Map(meals.map(meal => [meal.id, meal])).values()];
    const valid = uniqueMeals.filter(row => nutrients.every(([,key]) =>
      Number.isFinite(row.meal?.[key]) && row.meal[key] >= 0));
    const incomplete = uniqueMeals.length !== valid.length;
    return {
      incomplete, reference,
      rows:nutrients.map(([name,key,refKey,unit]) => {
        const range = reference?.[refKey] ?? null;
        const eaten = valid.length ? valid.reduce((sum,row) => sum + row.meal[key], 0) : null;
        const remaining = range && eaten!==null && !incomplete ? Math.max(0,range[0]-eaten) : null;
        return {name,key,unit,eaten,range,remaining};
      }),
    };
  }

  function summarize({journal, profile, journalApi, nutritionRef, nowMs}) {
    const day = journalApi.ymd(nowMs,journal.zone);
    const reference = nutritionRef?.recommend(profile,new Date(nowMs).toISOString()) ?? null;
    const rows = journal.rows.filter(row => row.ts<=nowMs);
    return {
      zone:journal.zone,
      nutrition:nutrition(rows.filter(row => row.day===day),reference?.kind==='population_range_not_individual_target'?reference:null),
      actions:rows.filter(row => actionKinds.has(row.kind) && factual(row)).slice(-10).reverse(),
    };
  }

  const api=Object.freeze({summarize,nutrition});
  root.GFMainScreenCore=api;
  if (typeof module==='object' && module.exports) module.exports=api;
})(globalThis);
