'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const web = path.resolve(__dirname, '../../android-mvp3/app/src/main/assets/www');
const load = resource => require(path.join(web, resource));
const Storage = load('modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const Controller = load('modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js');
const Coefficients = load('modules/GFCoefficients_v0.1.2/src/gfcoefficients.js');
const TimeGrid = load('shared/GFTimeGrid_v0.1.0.js');
const {replay} = require('./replay.cjs');
const NUTRIENTS = ['protein', 'fat', 'carbs', 'kcal'];
const MINUTE = 60000, DAY = 86400000;
const dinners = [
    [['Картофель варёный', 115], ['Яйцо куриное', 40], ['Капуста квашеная', 35]],
    [['Киноа отварная', 100], ['Помидор свежий', 55], ['Кефир 2,5%', 120]],
    [['Каша пшённая на воде', 110], ['Сыр российский', 22], ['Огурец свежий', 50]],
];
const breakfast = [
    [['Гречка варёная', 105], ['Яйцо куриное', 48], ['Груша', 55]],
    [['Хлеб пшеничный', 35], ['Масло сливочное 82,5%', 8], ['Сыр российский', 25], ['Яблоко', 60]],
    [['Каша пшённая на воде', 125], ['Кефир 2,5%', 90], ['Яблоко', 55]],
];
const lunches = [
    [['Борщ с мясом', 185], ['Хлеб пшеничный', 24], ['Огурец свежий', 32]],
    [['Киноа отварная', 118], ['Яйцо куриное', 45], ['Помидор свежий', 55]],
    [['Гречка варёная', 120], ['Сыр российский', 25], ['Капуста квашеная', 38]],
];
const snacks = [[['Яблоко', 83]], [['Груша', 71]], [['Апельсин', 88]], [['Кефир 2,5%', 120]],
    [['Сок яблочный', 60], ['Зефир', 11]]];

const iso = value => new Date(value).toISOString();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mutate = (host, role, method, value) => {
    const port = host.connect(role);
    return port[method](value, port.getRevision());
};

function foodCatalog() {
    const html = fs.readFileSync(path.join(web, 'approved/GFNutrition_v0.4.6_LIVE.html'), 'utf8');
    const json = /<script id="foodsData" type="application\/json">([\s\S]+?)<\/script>/.exec(html);
    assert(json, 'CATALOG_JSON_MISSING');
    const foods = JSON.parse(json[1]).filter(row => row.venueId === null);
    return new Map(foods.slice().reverse().map(row => [row.name, row]));
}

function plate(recipe, foods, createdAt, adjust) {
    const items = recipe.map(([name, grams]) => {
        const food = foods.get(name);
        assert(food, 'QA_CATALOG_PRODUCT_MISSING');
        const amount = grams + adjust;
        const values = Object.fromEntries(NUTRIENTS.map(key => {
            assert(Number.isFinite(food[key]));
            return [key, Number((food[key] * amount / 100).toFixed(3))];
        }));
        return {kind: 'catalog', foodId: food.id, name: food.name, amount, unit: food.unit,
            ...values, nutritionStatus: food.nutritionStatus,
            glycemicIndex: food.glycemicIndex ?? null, glycemicIndexStatus: food.glycemicIndexStatus ?? 'unknown'};
    });
    const sum = key => Number(items.reduce((total,item)=>total+item[key],0).toFixed(3));
    return {schema:'GFPlate.v1', source:'GFFoodOnly', createdAt, items, containsEstimatedValues:true,
        totals:{...Object.fromEntries(NUTRIENTS.map(key=>[key,sum(key)])),amount:sum('amount'),count:items.length}};
}

function initialProfile(profile, host) {
    mutate(host,'settings','updateProfile',{
        displayName:profile.displayName,birthDate:profile.birthDate,timeZone:profile.timeZone,
    });
    mutate(host,'settings','addMeasurement',{
        id:'profile-seed-last-reported', measuredAt:profile.reportedAt,
        heightCm:profile.heightCm,weightKg:profile.weightKg,
    });
}

function seedResearch(host, archive, setTime) {
    const start=archive.points[0][0], end=archive.points.at(-1)[0], zone=archive.timeZone;
    const firstDay=Coefficients.localParts(start,zone).key;
    const lastDay=Coefficients.localParts(end,zone).key;
    const firstDate=Date.parse(firstDay+'T00:00:00Z');
    const lastDate=Date.parse(lastDay+'T00:00:00Z');
    const foods=foodCatalog();
    let operator=0;
    const controller=Controller.createController(host,{makeId:prefix=>'qa-seed-'+prefix+'-'+(++operator)});
    const effectiveFrom=iso(Coefficients.localStartUtc(firstDay,zone));
    for (const slot of TimeGrid.SLOTS) {
        for (const [kind,value] of [['carb_g_per_u',10],['isf_mmol_per_u',3]]) {
            mutate(host,'settings','addCoefficient',{id:'qa-seed-'+kind+'-'+slot.from.replace(':',''),
                kind,value,source:'manual',effectiveFrom,windowLocal:{from:slot.from,to:slot.to},
                sourceNote:'Начальное значение исследовательского стенда'});
        }
    }
    mutate(host,'settings','setHighSettings',{targetMmol:6});
    const allSites=['abdomen','thigh','arm'];
    for (let offset=0;firstDate+offset*DAY<=lastDate;offset++) {
        const day=iso(firstDate+offset*DAY).slice(0,10);
        const midnight=Coefficients.localStartUtc(day,zone);
        const at=minutes=>midnight+minutes*MINUTE;
        const id='qa-seed-'+day;
        const schedule=[];
        for (const [kind,minute,pool,dose] of [
            ['breakfast',490,breakfast,1.5], ['lunch',775,lunches,2],
            ['snack',950,snacks,offset%2===0?0.5:0], ['dinner',1135,dinners,2],
        ]) {
            if (kind==='snack'&&offset%3===1) continue;
            const startAt=at(minute),plannedAt=startAt-20*MINUTE,endAt=startAt+16*MINUTE;
            if (plannedAt<start||endAt>end) continue;
            schedule.push([plannedAt,()=>{
                const sessionId=id+'-'+kind;
                const recipe=pool[offset%pool.length];
                const plan=plate(recipe,foods,iso(plannedAt),offset%4*3);
                controller.createFromFood(plan,sessionId,kind);
                controller.ready(sessionId);
                const action=host.connect('actionWriter');
                if (dose) {
                    setTime(startAt-11*MINUTE);
                    const current=controller.lookup(sessionId);
                    action.recordSessionInjection({sessionId,expectedVersion:current.version,opId:'qa-seed-op-'+(++operator),
                        injectionId:sessionId+'-injection',insulinId:'rinfast',units:dose,
                        administeredAt:iso(startAt-11*MINUTE),injectionSite:{region:allSites[offset%allSites.length]}},
                        action.getRevision());
                }
                setTime(startAt);
                controller.startMeal(sessionId,iso(startAt),{actuallyStarted:true});
                setTime(endAt);
                const actual=offset%4===0?plate(recipe,foods,iso(endAt),-4):plan;
                controller.actualFood(sessionId,actual,{parentConfirmed:true});
                controller.finishMeal(sessionId,iso(endAt),{confirmed:true});
            }]);
        }
        for (const [time,label] of [[405,'morning'],[1260,'evening']]) {
            if (at(time)>=start&&at(time)<=end) schedule.push([at(time),()=>mutate(host,'actionWriter','recordInjection',{
                id:id+'-basal-'+label,insulinId:'levemir',units:2.5,administeredAt:iso(at(time)),injectionSite:{region:'thigh'},
            })]);
        }
        if (offset%9===1&&at(1030)<end) schedule.push([at(1030),()=>mutate(host,'actionWriter','recordInjection',{
            id:id+'-correction',insulinId:'rinfast',units:0.5,administeredAt:iso(at(1030)),injectionSite:{region:'abdomen'},
        })]);
        if (offset%5===1&&at(1070)<=end) schedule.push([at(1045),()=>{
            const sportId=id+'-sport';
            mutate(host,'sport','startSport',{id:sportId,start:iso(at(1045))});
            setTime(at(1070));
            mutate(host,'sport','finishSport',{id:sportId,end:iso(at(1070))});
        }]);
        if (offset%21===4&&at(1240)<=end) schedule.push([at(1175),()=>{
            const illnessId=id+'-illness';
            mutate(host,'settings','updateProfile',{illnessFactor:{value:1.1,source:'user_input',editedAt:iso(at(1175))}});
            mutate(host,'context','openPeriod',{id:illnessId,kind:'illness',start:iso(at(1175))});
            setTime(at(1240));
            mutate(host,'context','closePeriod',{id:illnessId,end:iso(at(1240))});
        }]);
        for (const [when,action] of schedule.sort((a,b)=>a[0]-b[0])) {
            setTime(when);
            action();
        }
    }
    setTime(end);
    mutate(host,'researchSeed','install',archive);
    mutate(host,'researchSeed','recordReplay',replay());
}

function build(profile,archive=null) {
    let now=archive?archive.points[0][0]:Date.parse(profile.reportedAt);
    const host=Storage.createHost({clock:()=>iso(now)});
    initialProfile(profile,host);
    if(archive)seedResearch(host,archive,time=>{now=time;});
    const state=host.exportState();
    const verified=Storage.createHost({driver:{load:()=>state,save:()=>assert.fail('readonly')}}).exportState();
    assert.deepEqual(verified,state);
    return state;
}

if(require.main===module) {
    const [profilePath,archivePath,output]=process.argv.slice(2);
    assert(profilePath&&archivePath&&output,'Provide private profile JSON, archive JSON, output directory');
    process.umask(0o077);
    const profile=read(profilePath),archive=read(archivePath);
    assert.equal(profile.timeZone,archive.timeZone);
    fs.mkdirSync(output,{recursive:true,mode:0o700});
    const normal=build(profile);
    const research=build(profile,archive);
    assert.equal(normal.events.length,0);
    assert.equal(normal.cgm.length,0);
    assert.equal(normal.privateHistory,undefined);
    assert.deepEqual(normal.measurements,research.measurements);
    for(const [name,state] of [['main',normal],['research',research]]) {
        fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(state),{mode:0o600});
    }
    console.log(JSON.stringify({mainRevision:normal.revision,researchRevision:research.revision,
        archivePoints:research.privateHistory.points.length,meter:research.privateHistory.meter.length,
        reportedNotes:research.privateHistory.notes.length,syntheticMeals:research.mealSessions.length,
        syntheticInjections:research.events.length,syntheticPeriods:research.conditionPeriods.length}));
}
module.exports={build};
