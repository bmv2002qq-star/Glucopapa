'use strict';const assert=require('assert'),fs=require('fs'),path=require('path');
const temporal=require('./temporal_engine_v018.js');
require('./app/GlucoFamily_Android/tools/medical_engine.js');
const data=JSON.parse(fs.readFileSync('./ГлюкоПапа_данные_120ч.json','utf8'));
const result=JSON.parse(fs.readFileSync('./ГлюкоПапа_0.18_результаты_тестов.json','utf8'));
let n=0;const pass=(condition,msg)=>{assert(condition,msg);n++},close=(a,b,tol=1e-4)=>Math.abs(a-b)<tol;
const now=data.now;
const c=global.GFMedical.replayFiveDays({events:data.events,readings:data.readings,profile:data.profile},now);
pass(close(c.tddMean,21.3),'TDD');
pass(close(c.reference.isfNovorapidMmolPerUnit,100/21.3,1e-3),'rapid ISF');
pass(close(c.reference.isfRegularMmolPerUnit,83/21.3,1e-3),'regular ISF');
pass(close(c.reference.carbGramsPerUnit,500/21.3,1e-3),'carb ratio');
pass(close(temporal.gramsPerUnit(21.3),500/21.3),'native carb');
pass(close(temporal.isfRapid(21.3),100/21.3),'native isf');
pass(c.validDays===5,'five days');
const e={type:'insulin',insulinType:'short',units:2,insulinName:'НовоРапид',ts:1000000};
for(const m of [0,60,120,240,300,360]){
 const got=temporal.iob(e.ts+m*60000,[e]).estimatedRemainingActionUnits;
 pass(got>=0&&got<=2,'IOB range '+m);
 if(m===0)pass(close(got,2),'IOB t0');
 if(m>=300)pass(close(got,0),'IOB tail');
 if(m===120)pass(close(got,result.iobSamples.after120min.IOB_estimateUnits,.001),'IOB Python parity');
}
pass(temporal.iob(e.ts+60*60000,[e,{...e,insulinType:'long',units:50}]).estimatedRemainingActionUnits<2,'basal excluded');
const testIndices=[887,930,1000,1100,1200,1300];
for(const h of [15,30,60,120]){
 for(const i of testIndices){const stamp=data.readings[i].ts;
  const base=temporal.forecast(data.readings,data.events,stamp,h),
  extraCarb=temporal.forecast(data.readings,[...data.events,{type:'meal',ts:stamp-45*60000,carbs:20,protein:0,fat:0}],stamp,h),
  extraRapid=temporal.forecast(data.readings,[...data.events,{type:'insulin',insulinType:'short',ts:stamp-45*60000,units:1}],stamp,h);
  pass(base.status==='experimental','forecast available '+i+h);
  pass(extraCarb.forecastMmol>base.forecastMmol,'carbs must increase forecast '+i+h);
  pass(extraRapid.forecastMmol<base.forecastMmol,'rapid must decrease forecast '+i+h);
  const future=temporal.forecast(data.readings,[...data.events,{type:'meal',ts:stamp+5*60000,carbs:10000}],stamp,h);
  pass(close(base.forecastMmol,future.forecastMmol,1e-6),'no future event leak '+i+h);
 }
}
for(const p of result.clinicalPublishedCase){
 pass(close(temporal.isfRapid(p.tdd),p.formulaIsf,1e-4),'case ISF '+p.period);
 pass(close(temporal.gramsPerUnit(p.tdd),p.formulaIcr,1e-4),'case ICR '+p.period);
}
// Compare with independently computed Python forecasts in 4 horizons x test snapshots
const parity=JSON.parse(fs.readFileSync('./parity_v018.json','utf8'));
for(const x of parity){const got=temporal.forecast(data.readings,data.events,data.readings[x.i].ts,x.h);
 pass(close(got.forecastMmol,x.forecast,.01),'cross-language parity '+x.i+','+x.h+' '+got.forecastMmol+' '+x.forecast);
}
// Check full event window and response shape; no late carbs from already fully absorbed meal
const t=data.readings[1000].ts;
pass(temporal.eventEffects(t,30,[{type:'meal',ts:t-8*3600000,carbs:30}])[0]===0,'meal fully past');
pass(temporal.eventEffects(t,30,[{type:'insulin',ts:t-7*3600000,insulinType:'short',units:3}])[2]===0,'bolus fully past');
pass(temporal.eventEffects(t,30,[{type:'insulin',ts:t,insulinType:'long',units:6}])[3]===0,'basal onset');
pass(temporal.eventEffects(t+120*60000,30,[{type:'insulin',ts:t,insulinType:'long',units:6}])[3]<0,'basal later');
pass(temporal.eventEffects(t+150*60000,30,[{type:'meal',ts:t,carbs:0,protein:20,fat:30}])[1]>0,'late protein fat');
console.log('PASS:',n,'checks, full five-day journal, IOB, 4 horizon × 6 causal counterfactuals, clinical benchmark and Python/JS parity.');
