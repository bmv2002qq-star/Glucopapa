const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const html=fs.readFileSync(__dirname+'/../app/src/main/assets/index.html','utf8');
const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const foodData=JSON.parse(fs.readFileSync(__dirname+'/../app/src/main/assets/foods_seed.json','utf8'));
let view={innerHTML:''};let memory={};let handlers={};
const document={
 querySelector(s){if(s==='#view')return view;if(s==='#modalRoot')return {set innerHTML(v){handlers.modal=v}};return null},
 querySelectorAll(){return []},
 getElementById(s){if(s==='foodSearch')return null;return {innerHTML:'',value:'100'}},
 addEventListener(ev,f){handlers[ev]=f},
 createElement(){return {style:{},remove(){},textContent:'',innerHTML:'',querySelectorAll(){return []}}},body:{appendChild(){}}
};
const context=vm.createContext({document,window:{scrollTo(){}},localStorage:{getItem(k){return memory[k]||null},setItem(k,v){memory[k]=v}},fetch:async()=>({json:async()=>foodData}),Date,Intl,Math,Number,String,JSON,Set,Object,console,setTimeout,confirm:()=>true,alert:()=>{},});
vm.runInContext(js,context);
(async()=>{
await new Promise(r=>setTimeout(r,100));
assert(view.innerHTML.includes('Глюкоза сейчас'));assert(view.innerHTML.includes('Болеет'));
vm.runInContext("navigate('foods')",context);assert(view.innerHTML.includes('Гречка варёная'));
vm.runInContext("navigate('diary')",context);assert(view.innerHTML.includes('Фактических записей пока нет')); 
vm.runInContext("addEvent({type:'note',name:'Тест',note:'Всё нормально'})",context);
assert(vm.runInContext('app.events.some(x=>x.name === \"Тест\")',context)); 
vm.runInContext("navigate('home');toggleIll()",context);assert(view.innerHTML.includes('Режим болезни включён'));
vm.runInContext("window.onGlucoseUpdate({readings:[{ts:Date.now(),mmol:6.4,direction:'Flat'}],message:'OK'})",context);
assert(view.innerHTML.includes('6,4'));
console.log('Smoke UI passed: home, foods, diary, note, illness, xDrip update');
})().catch(e=>{console.error(e);process.exit(1)});
