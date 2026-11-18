/* GFFoodOnly v0.4.0 — food reference and nutrition arithmetic only.
   NO insulin, dose recommendations, CGM, diary, meals journal, file import.
   Storage contains only public/custom food entries and favorites.
   Runtime supports Node.js and ordinary browsers. */
(function(root,fn){'use strict';const api=fn();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.GFFoodOnly=api;})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
 const VERSION='0.4.0';
 const norm=x=>String(x??'').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/g,' ');
 const num=(v,label,max)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)throw Error('Неверное значение: '+label);return v;};
 const small=x=>Math.round((x+Number.EPSILON)*10)/10;
 const same=x=>JSON.parse(JSON.stringify(x));
 const baseFields=['id','name','category','protein','fat','carbs','kcal','fiber','source','verificationStatus','allergens','basis','kind','nutritionStatus','note','venueId','unit','suggestedAmount','kcalMethod'];
 function validateFood(f){
  if(!f||typeof f!=='object'||Array.isArray(f))throw Error('Неверный продукт');
  if(typeof f.id!=='string'||!/^[-a-zA-Z0-9:_.]{3,120}$/.test(f.id))throw Error('Неверный ID');
  if(typeof f.name!=='string'||!f.name.trim()||f.name.length>160)throw Error('Неверное название');
  if(typeof f.category!=='string'||!f.category.trim()||f.category.length>90)throw Error('Неверная категория');
  ['protein','fat','carbs'].forEach(k=>num(f[k],k,100));num(f.kcal,'kcal',900);
  if(f.protein+f.fat+f.carbs>135)throw Error('Сумма БЖУ больше возможной');
  if(!['г','мл'].includes(f.unit))throw Error('Неверная единица');
  if(!['per_100g','per_100ml'].includes(f.basis))throw Error('Неверный базис');
  if((f.unit==='г')!==(f.basis==='per_100g'))throw Error('Несоответствие единиц');
  if(f.glycemicIndex!=null&&(!Number.isInteger(f.glycemicIndex)||f.glycemicIndex<0||f.glycemicIndex>100))throw Error('Неверный гликемический индекс');
  return f;
 }
 function portion(f,amount){validateFood(f);num(amount,'порция',5000);if(amount<=0)throw Error('Порция должна быть больше нуля');
  const result={id:f.id,name:f.name,amount,unit:f.unit,nutritionStatus:f.nutritionStatus,glycemicIndex:f.glycemicIndex??null,glycemicIndexStatus:f.glycemicIndexStatus||'unknown'};
  for(const k of ['protein','fat','carbs','kcal'])result[k]=small(f[k]*amount/100);
  return result;
 }
 function totals(items){if(!Array.isArray(items))throw Error('Ожидаются порции');
  const x={protein:0,fat:0,carbs:0,kcal:0,amount:0,count:items.length};
  for(const item of items){if(!item||typeof item!=='object')throw Error('Неверная порция');
   for(const k of ['protein','fat','carbs','kcal']){num(item[k],k,20000);x[k]+=item[k];}
   if(typeof item.amount==='number')x.amount+=item.amount;
  }for(const k of ['protein','fat','carbs','kcal','amount'])x[k]=small(x[k]);return x;
 }
 function createCatalog({items,venues,storage=null}={}){
  if(!Array.isArray(items)||!Array.isArray(venues))throw Error('Ожидается каталог');
  const base=new Map();for(const f of items){validateFood(f);if(base.has(f.id))throw Error('Дублирующийся ID');base.set(f.id, Object.freeze(same(f)));}
  const places=new Map();for(const v of venues){if(!v||typeof v.id!=='string'||typeof v.name!=='string'||places.has(v.id))throw Error('Неверное заведение');places.set(v.id,Object.freeze(same(v)));}
  const allowedKeys=new Set(['favorites','custom']);let saved={favorites:[],custom:[]},persistent=!!storage;
  if(storage){try{const x=storage.load();if(x&&typeof x==='object'&&!Array.isArray(x)){
    const fav=Array.isArray(x.favorites)?x.favorites.filter(k=>typeof k==='string'&&k.length<125).slice(0,5000):[];
    const custom=Array.isArray(x.custom)?x.custom.filter(f=>{try{validateFood(f);return f.id.startsWith('user:')&&!base.has(f.id)}catch{return false}}).slice(0,5000):[];
    saved={favorites:[...new Set(fav)],custom};}}
   catch(e){persistent=false;}}
  const custom=new Map(saved.custom.map(f=>[f.id,Object.freeze(same(f))]));
  const favorites=new Set(saved.favorites.filter(k=>base.has(k)||custom.has(k)));
  const persist=()=>{if(!storage)return false;storage.save({favorites:[...favorites],custom:[...custom.values()].map(same)});return true;};
  const find=id=>custom.get(id)||base.get(id)||null;
  function favoritesOnly(){return [...favorites]}
  function toggleFavorite(id){if(!find(id))throw Error('Продукт не найден');if(favorites.has(id))favorites.delete(id);else favorites.add(id);try{persist()}catch(e){persistent=false;}return favorites.has(id);}
  function addCustom(value){if(!value||typeof value!=='object')throw Error('Нужен объект');const name=String(value.name||'').trim();
   if(name.length<2||name.length>160)throw Error('Укажите название блюда');
   const category=String(value.category||'Мои продукты');const unit=value.unit==='мл'?'мл':'г';
   const amount=num(value.amount,'масса порции',5000);if(amount<=0)throw Error('Введите массу или объём больше 0');
   const basis=value.inputBasis==='portion'?'portion':'100';const factor=basis==='portion'?100/amount:1;
   const p=num(value.protein,'белки',5000),f=num(value.fat,'жиры',5000),c=num(value.carbs,'углеводы',5000);
   // kcal optional: derive from macro energy if not explicitly supplied
   const energy=value.kcal===null||value.kcal===undefined||value.kcal===''?4*p+9*f+4*c:num(value.kcal,'ккал',25000);
   const id='user:'+Date.now().toString(36)+':'+Math.random().toString(36).slice(2,10);
   const item={id,name,category,protein:small(p*factor),fat:small(f*factor),carbs:small(c*factor),kcal:small(energy*factor),fiber:null,
    source:'Ручной ввод пользователя (включая возможную оценку нейросети)',verificationStatus:'reference_unverified',allergens:null,basis:unit==='г'?'per_100g':'per_100ml',kind:'product',nutritionStatus:'user_estimate',
    note:'Значения введены вручную. Сравните с упаковкой, рецептурой или лабораторными данными.',venueId:null,unit,suggestedAmount:amount,kcalMethod:value.kcal===null||value.kcal===undefined||value.kcal===''?'Оценка по 4/9/4':'Калории введены пользователем'};
   validateFood(item);custom.set(id,Object.freeze(item));try{persist()}catch(e){persistent=false;}return same(item);
  }
  function query({text='',category='Все',venueId=null,favorite=false,limit=100,offset=0}={}){
   if(!Number.isInteger(limit)||limit<1||limit>2000||!Number.isInteger(offset)||offset<0)throw Error('Неверное ограничение');
   const q=norm(text), list=[];
   for(const food of [...base.values(),...custom.values()]){
    if(venueId===null?food.venueId!==null:venueId==='*'?food.venueId===null:food.venueId!==venueId)continue;
    if(category!=='Все'&&food.category!==category)continue;
    if(favorite&&!favorites.has(food.id))continue;
    if(q&&!norm(food.name).includes(q)&&!(venueId==='*'&&norm(places.get(food.venueId)?.name||'').includes(q)))continue;
    list.push(food);
   }list.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
   return {count:list.length,items:list.slice(offset,offset+limit).map(same)};
  }
  function categories(venueId=null){const result=new Set();for(const f of [...base.values(),...custom.values()])if(venueId===null?f.venueId===null:venueId==='*'?f.venueId!==null:f.venueId===venueId)result.add(f.category);return ['Все',...Array.from(result).sort((a,b)=>a.localeCompare(b,'ru'))]}
  return Object.freeze({version:VERSION,find:id=>find(id)?same(find(id)):null,query,categories,venues:()=>[...places.values()].map(same),toggleFavorite, favoritesOnly, isFavorite:id=>favorites.has(id), addCustom,
  portion:(id,amt)=>{const f=find(id);if(!f)throw Error('Нет продукта');return portion(f,amt)},
  totals, stats:()=>({catalog:items.filter(f=>f.venueId===null).length,venues:places.size,restaurant:venues.filter(v=>v.kind==='restaurant').length,stores:venues.filter(v=>v.kind==='store').length,dishes:items.filter(f=>f.venueId!==null).length,custom:custom.size,favorites:favorites.size,persistent})});
 }
 return Object.freeze({VERSION,norm,validateFood,portion,totals,createCatalog});
});
