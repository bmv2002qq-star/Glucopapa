'use strict';
const NOW=Date.parse('2026-11-11T12:00:00Z'),DAY=86400000,MIN=60000;
function makeFixture(extra={}){
 const events=[],readings=[],meals=[],corrections=[];
 const first=Date.parse('2026-11-06T00:00:00Z');
 for(let d=0;d<5;d++){
  const day=first+d*DAY;
  events.push({type:'insulin',insulinType:'long',insulinName:'Левемир',ts:day+21*3600000,units:12});
  const m=[{h:8,carbs:46,units:2,p:9,f:6},{h:13,carbs:64,units:3,p:20,f:12},{h:19,carbs:54,units:3,p:14,f:16}];
  for(const v of m){
   const mt=day+v.h*3600000;const m0={type:'meal',status:'eaten',ts:mt,carbs:v.carbs,protein:v.p,fat:v.f};
   meals.push(m0);events.push(m0);
   events.push({type:'insulin',insulinType:'short',insulinName:'НовоРапид',ts:mt-5*MIN,units:v.units});
  }
  if(d<=2){const t=day+2*3600000;corrections.push(t);
   events.push({type:'insulin',insulinType:'short',insulinName:'НовоРапид',ts:t,units:0.5,doseReason:extra.noCorrectionPurpose?undefined:'correction'});
  }
  if(extra.activity&&d===2)events.push({type:'activity',ts:day+15.5*3600000,typeOfActivity:'walk',durationMin:45});
  if(extra.illness&&d===3)events.push({type:'illness',ts:day+7*3600000,isActive:true});
  if(extra.illness&&d===4)events.push({type:'illness',ts:day+22*3600000,isActive:false});
 }
 // Independent, deterministic CGM fixture. This describes artificial dynamics,
 // NOT a physiological model. Does not prove ability to personalize in vivo.
 for(let d=0;d<5;d++)for(let i=0;i<288;i++){
  const ts=first+d*DAY+i*5*MIN;
  let g=9.7+0.28*Math.sin(i*2*Math.PI/288+d*0.8);
  for(const e of meals){const age=(ts-e.ts)/MIN;if(age>=0&&age<240)g+=2.2*Math.sin(Math.PI*age/240)**2;}
  for(const t of corrections){const age=(ts-t)/MIN;
   if(age>=0&&age<=240)g-=2.75*(age/240);
   if(age>240&&age<360)g-=2.75*(360-age)/120;
  }
  readings.push({ts,mmol:Number(g.toFixed(3))});
 }
 // fresh measurement for scenario; not included in five completed days
 readings.push({ts:NOW,mmol:8.1});
 return {now:NOW,input:{profile:{timeZone:'UTC',expectedBasalInjectionsPerDay:1},events,readings}};
}
if(require.main===module){const fs=require('fs');const path=require('path');fs.writeFileSync(path.join(__dirname,'fixture_5days_v024.json'),JSON.stringify(makeFixture(),null,2));console.log('wrote',makeFixture().input.readings.length,'CGM readings');}
module.exports={makeFixture,NOW};
