
const fs=require('node:fs');
const {makeFixture,NOW}=require('./generate_fixture_v024.js');
const M=require('./care_workflow_v025.js');
const f={source:'GF_SYNTHETIC_FIXTURE_V025',now:NOW,raw:{...makeFixture().input,syntheticTag:'GF_SYNTHETIC_FIXTURE_V025'}};
const p={planId:'SYNTHETIC-ONLY-DO-NOT-TREAT',reviewedByClinician:true,validUntilTs:NOW+365*86400000,factors:{isfMmolPerUnit:5,icrGramsPerUnit:{breakfast:15,lunch:20,dinner:18}},targetMmol:6,bolusStepUnits:.5,maxBolusUnits:8,maxCorrectionUnits:4,minCorrectionSpacingMinutes:180,minRoutineGlucoseMmol:4.5,maxKetonesForRoutineMmol:.6,hypo:{fastCarbsGrams:12,recheckMin:15,triggerBelowMmol:3.9}};
const scenario=[['Высокая глюкоза',{glucoseMmol:12.5}],['Обед и высокая',{glucoseMmol:12.5,mealCarbs:40,mealSlot:'lunch'}],['Завтрак',{glucoseMmol:6,mealCarbs:30,mealSlot:'breakfast'}],['Ужин',{glucoseMmol:6,mealCarbs:36,mealSlot:'dinner'}],['Гипогликемия',{glucoseMmol:3.5}],['Недавняя инъекция',{glucoseMmol:13,additionalHistory:[{type:'insulin',insulinType:'short',purpose:'correction',units:1,ts:NOW-30*60000}]}],['Кетоны',{glucoseMmol:15.2,ketonesMmol:0.7}],['Болезнь',{glucoseMmol:14,sick:true}],['Нагрузка',{glucoseMmol:11.5,activityRecent:'intense'}],['Не может глотать',{glucoseMmol:2.8,canSwallow:false}],['Рвота',{glucoseMmol:16,vomiting:true}]];
const results=scenario.map(([name,params])=>{const out=M.simulateSynthetic(f,params,p);return {name,input:params,status:out.status,demoOnly:out.researchNumbers||null,codes:out.calculation?.codes||[],patientPrescriptionUnits:out.patientPrescriptionUnits,finalGlucosePredictionMmol:out.finalGlucosePredictionMmol}});
fs.writeFileSync('./cases_v025.json',JSON.stringify(results,null,2));console.log(results.map(r=>r.name+': '+r.status).join('\n'));
