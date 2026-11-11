// Глюкопапа 0.11: offline regression / contract tests for monthly statistics and category coverage.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('app/src/main/assets/index.html','utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/init\(\);\s*$/,'');
const ctx={window:{},document:{addEventListener(){},createElement(){return {style:{},remove(){},querySelectorAll(){return []},innerHTML:''}},body:{appendChild(){}},querySelector(){return {innerHTML:''}},querySelectorAll(){return []},getElementById(){return null}},localStorage:{getItem(){return null},setItem(){}},console,Date,JSON,Math,Number,String,setTimeout(){},clearTimeout(){},navigator:{},confirm(){return true},alert(){},Intl};ctx.window=ctx;
vm.createContext(ctx);vm.runInContext(code,ctx);
const run=x=>vm.runInContext(x,ctx);
const now=Date.now();
function row(day,carbs){return {type:'meal',status:'eaten',ts:day,carbs,protein:15,fat:8,kcal:250,grams:230, fiber:4};}
const x=[row(now-10000,40),row(now-20*86400000,50),{type:'meal',status:'planned',ts:now-10000,carbs:300,protein:0,fat:0,kcal:1000,grams:1000},{type:'insulin',ts:now-10000,insulinType:'short',insulinName:'НовоРапид',units:2.5,site:'Бедро'},{type:'insulin',ts:now-20000,insulinType:'long',insulinName:'Левемир',units:3,site:'Ягодица'}];ctx.testEvents=x;
run('app.events=testEvents;app.foods=SEED_FOODS.map((x,i)=>({...x,id:i+1})); app.profile={age:7,height:123,weight:25}');
const facts=run('gf011EventFacts(app.events)');assert.equal(facts.eaten.length,2);assert.equal(facts.food.carbs,90);assert.equal(facts.short,2.5);assert.equal(facts.long,3);
assert.equal(run('gf011ValidMonth("2026-11")'),true);assert.equal(run('gf011ValidMonth("2026-13")'),false);
const monthly=run('gf011MonthlyCard(dayKey(Date.now()).slice(0,7))');
for(const label of ['Сводка календарного месяца','Клетчатка','НовоРапид','Левемир','Дней с подтверждённым питанием'])assert(monthly.includes(label),label);
const diary=run('renderDiary()');assert(diary.includes('Место введения')||diary.includes('Сводка календарного месяца'));
const food=run('renderFoods()');for(const cat of ['Хлебцы','Конфеты','Зефир','Торты','Орехи','Соки'])assert(food.includes(cat),cat);
for(const name of ['Медовик','Наполеон','Фисташки','Сок грушевый'])assert(run('SEED_FOODS').some(x=>x.name.includes(name)),name);
assert(run('renderHome()').includes('Глюкоза'));
assert(run('gf011PlanNote()').includes('Ручное решение'));
assert(html.includes('gf011SaveRescue')&&html.includes('gf011MealActivity')&&html.includes('gf011OwnDose'));
console.log('Passed 0.11: calendar months, confirmed food, short/long injections, fiber, categories, parent plan, interaction contracts.');
