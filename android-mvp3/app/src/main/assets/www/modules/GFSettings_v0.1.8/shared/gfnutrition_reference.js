/* GlucoPapa reference nutrition ranges; Belarus MoH decree 180, 20 Nov 2012, Appendix 1 Table 2.
   Historical published text, NOT verified as consolidated 2026 revision.
   Age-sex population bands, NOT patient-specific targets and NOT meal/dose calculation.
*/
(function(root,factory){'use strict'; const a=factory();if(typeof module==='object'&&module.exports)module.exports=a;if(root)root.GFNutritionReference=a;})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
 const VERSION='0.1.0';
 const SOURCE_URL='https://faolex.fao.org/docs/pdf/blr163786.pdf';
 const SOURCE_ID='BY_MOH_2012_180_APP1_TABLE2_ORIGINAL';
 const bands=Object.freeze([
  {id:'1-3',minAge:1,maxAge:3,sex:'any',label:'1–3 года',kcal:[1200,1500],proteinG:[36,56],fatG:[40,53],carbsG:[175,210]},
  {id:'4-6',minAge:4,maxAge:6,sex:'any',label:'4–6 лет',kcal:[1500,2000],proteinG:[49,75],fatG:[50,71],carbsG:[203,280]},
  {id:'7-10',minAge:7,maxAge:10,sex:'any',label:'7–10 лет',kcal:[2100,2300],proteinG:[74,87],fatG:[70,82],carbsG:[284,322]},
  {id:'11-13-male',minAge:11,maxAge:13,sex:'male',label:'11–13 лет · мальчики',kcal:[2400,2700],proteinG:[84,102],fatG:[80,96],carbsG:[324,378]},
  {id:'11-13-female',minAge:11,maxAge:13,sex:'female',label:'11–13 лет · девочки',kcal:[2300,2500],proteinG:[81,94],fatG:[77,89],carbsG:[311,350]},
  {id:'14-17-male',minAge:14,maxAge:17,sex:'male',label:'14–17 лет · юноши',kcal:[2800,3000],proteinG:[98,113],fatG:[93,107],carbsG:[378,420]},
  {id:'14-17-female',minAge:14,maxAge:17,sex:'female',label:'14–17 лет · девушки',kcal:[2400,2600],proteinG:[84,98],fatG:[80,92],carbsG:[336,364]}
 ]);
 const freezeDeep=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freezeDeep);Object.freeze(o);}return o;};
 function dateParts(iso,zone){
  const d=new Date(iso);if(!Number.isFinite(d.getTime()))throw Error('Некорректная дата расчёта');
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  const p=Object.fromEntries(format.formatToParts(d).filter(x=>['year','month','day'].includes(x.type)).map(x=>[x.type,+x.value]));
  return p;
 }
 function ageOn(birthDate,asOfIso,timeZone){
  if(!birthDate)return null;
  if(typeof birthDate!=='string'||!/^\d{4}-\d\d-\d\d$/.test(birthDate)||!Number.isFinite(Date.parse(birthDate+'T00:00:00Z'))||new Date(birthDate+'T00:00:00Z').toISOString().slice(0,10)!==birthDate)throw Error('Некорректная дата рождения');
  const p=dateParts(asOfIso,timeZone||'UTC'),[y,m,d]=birthDate.split('-').map(Number);
  const result=p.year-y-((p.month<m||p.month===m&&p.day<d)?1:0);
  return result>=0&&result<=130?result:null;
 }
 function select(age,sex){
  if(!Number.isInteger(age)||age<0)return null;
  if(sex!==null&&sex!==undefined&&!['male','female'].includes(sex))throw Error('Неверный пол');
  const row=bands.find(x=>age>=x.minAge&&age<=x.maxAge&&(x.sex==='any'||x.sex===sex));
  return row?freezeDeep(JSON.parse(JSON.stringify(row))):null;
 }
 function recommend(profile,asOfIso){
  const zone=profile.timeZone||'UTC';const p=dateParts(asOfIso,zone),atDate=[p.year,String(p.month).padStart(2,'0'),String(p.day).padStart(2,'0')].join('-');
  const age=ageOn(profile.birthDate,asOfIso,zone);
  const sex=profile.sex??null;
  const row=select(age,sex);
  if(!row)return null;
  return freezeDeep({sourceId:SOURCE_ID,sourceUrl:SOURCE_URL,sourceVersion:'2012-original',referenceStatus:'historical_original_not_current_edition_verified',
    groupId:row.id,groupLabel:row.label,asOfDate:atDate,ageYears:age,sex:sex||null,
    kcal:row.kcal,proteinG:row.proteinG,fatG:row.fatG,carbsG:row.carbsG,kind:'population_range_not_individual_target'});
 }
 return Object.freeze({VERSION,SOURCE_ID,SOURCE_URL,bands:freezeDeep(bands),ageOn,select,recommend});
});
