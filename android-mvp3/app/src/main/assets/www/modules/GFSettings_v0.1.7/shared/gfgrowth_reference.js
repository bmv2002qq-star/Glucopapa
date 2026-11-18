/* ГлюкоПапа · справочная оценка роста и веса, v0.1.0.
 * ВОЗ 2007 BMI-for-age, 5–19 лет; не диагностический или лечебный алгоритм.
 * Цифры BMI -2SD/медиана/+1SD — опубликованные опорные точки таблиц ВОЗ,
 * между ними линейная интерполяция: ПРИБЛИЖЁННЫЙ диапазон.
 * Данные kg ONLY calculated from BMI boundary × observed height² (m²).
 * Источник: https://www.who.int/tools/growth-reference-data-for-5to19-years/indicators/bmi-for-age
 */
(function(root,factory){
 'use strict';const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.GFGrowthReference=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const VERSION='0.1.1';
 const SOURCE_ID='WHO_2007_BMI_FOR_AGE_5_19_ANNUAL_ANCHOR_INTERPOLATION';
 const SOURCE_URL='https://www.who.int/tools/growth-reference-data-for-5to19-years/indicators/bmi-for-age';
 const MALE_URL='https://cdn.who.int/media/docs/default-source/child-growth/growth-reference-5-19-years/bmi-for-age-(5-19-years)/bmifa-boys-5-19years-z.pdf';
 const FEMALE_URL='https://cdn.who.int/media/docs/default-source/child-growth/growth-reference-5-19-years/bmi-for-age-(5-19-years)/bmifa-girls-5-19years-z.pdf';
 // [возраст в полных месяцах, BMI(-2 SD), BMI(медиана), BMI(+1 SD)].
 // Числа перепроверены по таблицам WHO 2007. Не применять за пределами 61..228 мес.
 const TABLES=Object.freeze({
  male:Object.freeze([
   [61,13.0,15.3,16.6],[72,13.0,15.3,16.8],[84,13.1,15.5,17.0],
   [96,13.3,15.7,17.4],[108,13.5,16.0,17.9],[120,13.7,16.4,18.5],
   [132,14.1,16.9,19.2],[144,14.5,17.5,19.9],[156,14.9,18.2,20.8],
   [168,15.5,19.0,21.8],[180,16.0,19.8,22.7],[192,16.5,20.5,23.5],
   [204,16.9,21.1,24.3],[216,17.3,21.7,24.9],[228,17.6,22.2,25.4]
  ]),
  female:Object.freeze([
   [61,12.7,15.2,16.9],[72,12.7,15.3,17.0],[84,12.7,15.4,17.3],
   [96,12.9,15.7,17.7],[108,13.1,16.1,18.3],[120,13.5,16.6,19.0],
   [132,13.9,17.2,19.9],[144,14.4,18.0,20.8],[156,14.9,18.8,21.8],
   [168,15.4,19.6,22.7],[180,15.9,20.2,23.5],[192,16.2,20.7,24.1],
   [204,16.4,21.0,24.5],[216,16.4,21.3,24.8],[228,16.5,21.4,25.0]
  ])
 });
 function dayParts(asOfIso,timeZone){
   if(typeof asOfIso!=='string'||!Number.isFinite(Date.parse(asOfIso)))return null;
   try{
     const f=new Intl.DateTimeFormat('en-GB',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:timeZone||'UTC'});
     const p=Object.fromEntries(f.formatToParts(new Date(asOfIso)).filter(x=>['year','month','day'].includes(x.type)).map(x=>[x.type,Number(x.value)]));
     return p;
   }catch(e){return null;}
 }
 function ageMonths(birthDate,asOfIso,timeZone){
   if(typeof birthDate!=='string'||!/^(\d{4})-(\d\d)-(\d\d)$/.test(birthDate))return null;
   const test=new Date(birthDate+'T00:00:00Z');if(!Number.isFinite(test.getTime())||test.toISOString().slice(0,10)!==birthDate)return null;
   const p=dayParts(asOfIso,timeZone);if(!p)return null;
   const [y,m,d]=birthDate.split('-').map(Number);
   const full=(p.year-y)*12+p.month-m-(p.day<d?1:0);
   return full>=0 && full<=2400?full:null;
 }
 function thresholds(sex,months){
   const arr=TABLES[sex];if(!arr||!Number.isInteger(months)||months<61||months>228)return null;
   let i=0;while(i<arr.length-2&&months>arr[i+1][0])i++;
   const a=arr[i],b=arr[i+1],f=(months-a[0])/(b[0]-a[0]);
   return {bmiLower:a[1]+f*(b[1]-a[1]),bmiMedian:a[2]+f*(b[2]-a[2]),bmiUpper:a[3]+f*(b[3]-a[3]),interpolated:months!==a[0]&&months!==b[0]};
 }
 const round1=n=>Math.round((n+Number.EPSILON)*10)/10;
 const empty=(status,additional={})=>Object.freeze({version:VERSION,sourceId:SOURCE_ID,sourceUrl:SOURCE_URL,
   kind:'approximate_WHO_BMI_for_age_reference',status,clinicallyValidated:false,...additional});
 function evaluate(profile,measurements,atIso=new Date().toISOString()){
   if(!profile||typeof profile!=='object'||!Array.isArray(measurements))return empty('no_data');
   const p=profile,timeZone=p.timeZone||'UTC';
   if(!p.birthDate||!['male','female'].includes(p.sex))return empty('missing_profile');
   // При двух записях в одну минуту более поздняя по порядку сохранения
   // считается последней; это важно для быстрого исправления опечатки.
   const arr=measurements.map((x,index)=>({x,index}))
     .filter(({x})=>x&&typeof x.measuredAt==='string'&&Number.isFinite(Date.parse(x.measuredAt))&&Date.parse(x.measuredAt)<=Date.parse(atIso))
     .sort((a,b)=>Date.parse(b.x.measuredAt)-Date.parse(a.x.measuredAt)||b.index-a.index)
     .map(({x})=>x);
   // Не смешивать рост и вес с разных дат. Однако пользователь должен видеть,
   // если позже последней полной пары уже появилась более свежая частичная запись.
   const measurement=arr.find(x=>Number.isFinite(x.heightCm)&&Number.isFinite(x.weightKg)&&x.heightCm>0&&x.weightKg>0);
   if(!measurement)return empty('needs_paired_measurement');
   const newerPartialMeasurements=arr.slice(0,arr.indexOf(measurement));
   const olderPairDueToNewerPartial=newerPartialMeasurements.length>0;
   const months=ageMonths(p.birthDate,measurement.measuredAt,timeZone);
   const meta={ageMonths:months,sex:p.sex,measurementId:measurement.id||null,measuredAt:measurement.measuredAt,
     weightKg:measurement.weightKg,heightCm:measurement.heightCm,
     measurementAgeDays:Math.max(0,Math.floor((Date.parse(atIso)-Date.parse(measurement.measuredAt))/86400000)),
     olderPairDueToNewerPartial,newerPartialMeasurementsCount:newerPartialMeasurements.length};
   if(months===null)return empty('invalid_date',meta);
   if(months<61||months>228)return empty('unsupported_age',meta);
   const th=thresholds(p.sex,months),metres=measurement.heightCm/100;
   const bmi=measurement.weightKg/(metres*metres);
   const lowWeight=th.bmiLower*metres*metres, highWeight=th.bmiUpper*metres*metres;
   // Статус сравниваем по НЕОКРУГЛЁННОМУ значению, чтобы избежать ложных границ.
   const status=bmi<th.bmiLower?'below_reference':bmi>th.bmiUpper?'above_reference':'within_reference';
   // Показываем обе границы с одинаковой точностью 0.01 кг. Если вес
   // совпадает с отображаемой округлённой границей, не выдаём категоричный
   // текст «ниже/выше» при кажущемся равенстве чисел.
   const round2=n=>Math.round((n+Number.EPSILON)*100)/100;
   const limits=[round2(lowWeight),round2(highWeight)];
   const weightShown=round2(measurement.weightKg);
   const boundaryAdjacent=weightShown===limits[0]||weightShown===limits[1];
   const labels={below_reference:'Ниже справочного интервала',above_reference:'Выше справочного интервала',within_reference:'В пределах справочного интервала'};
   return empty(status,{...meta,bmi:round1(bmi),weightDisplayKg:weightShown,
    weightReferenceKg:limits,weightReferencePrecisionKg:0.01,boundaryAdjacent,
    medianReferenceWeightKg:round2(th.bmiMedian*metres*metres),
    bmiReference:[round1(th.bmiLower),round1(th.bmiUpper)],
    statusLabel:boundaryAdjacent?'Около границы справочного интервала':labels[status],
    anchorInterpolation:th.interpolated,
    referenceMethod:'ВОЗ 2007; BMI для возраста, от −2 SD до +1 SD, опорные годовые точки и линейная интерполяция',
    isCurrentMeasurement:meta.measurementAgeDays<=90&&!olderPairDueToNewerPartial,
    note:'Справочная оценка по ИМТ для возраста, не диагноз и не цель веса. Интервал приближённый.'});
 }
 return Object.freeze({VERSION,SOURCE_ID,SOURCE_URL,MALE_URL,FEMALE_URL,ageMonths,thresholds,evaluate});
});
