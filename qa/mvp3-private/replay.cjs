'use strict';

// A detached GFStorage instance with fictional observations. This tool never opens
// either application journal and cannot supply a recommendation or change a setting.
const assert = require('node:assert/strict');
const web = '../../android-mvp3/app/src/main/assets/www/';
const Storage = require(web+'modules/GFStorage_v0.5.12/src/gfstorage_core.js');
const Controller = require(web+'modules/GFMealCalc_v0.1.2/adapters/gfmeal_controller.js');
const Coefficients = require(web+'modules/GFCoefficients_v0.1.2/src/gfcoefficients.js');
const Analytics = require(web+'modules/GFInjectionAnalytics_v0.2.1/GFInjectionAnalytics_v0.2.1.js');
const minute = 60000, day = 1440*minute;
const anchor = Date.parse('2040-02-01T00:00:00Z'), sensor = 'SYNTHETIC-REPLAY';
const slots = [
    {id:'night',hour:1,carb:12,change:2,lag:10},
    {id:'morning',hour:7,carb:15,change:3,lag:15},
    {id:'day',hour:13,carb:18,change:4,lag:20},
    {id:'evening',hour:19,carb:12,change:3,lag:25},
];
const iso = t => new Date(t).toISOString();
const context = {activity:'usual',iobU:0,site:'abdomen',plannedDoseU:2,settingRevision:1};

function plate(at, carbs) {
    const nutrition = {carbs,fat:5,protein:10,kcal:4*carbs+85};
    return {schema:'GFPlate.v1',source:'GFFoodOnly',createdAt:iso(at),containsEstimatedValues:false,
        items:[{kind:'manual',foodId:null,name:'SYNTHETIC',amount:100,unit:'г',glycemicIndex:50,
            glycemicIndexStatus:'verified',...nutrition}],
        totals:{count:1,amount:100,...nutrition}};
}

function replay() {
    let clock=anchor;
    const host=Storage.createHost({clock:()=>iso(clock)});
    const write=(role,method,value)=>{
        const port=host.connect(role);
        return port[method](value,port.getRevision());
    };
    const controller=Controller.createController(host);
    const readings=[], corrections=[];
    const glucose=(ts,mmol)=>readings.push({ts,mmol,sourceDeviceId:sensor,receivedAt:iso(ts)});
    write('settings','updateProfile',{timeZone:'UTC'});
    write('activityUi','setBaseLevel','usual');
    for(let i=0;i<7;i++)for(const slot of slots){
        const when=anchor+i*day+slot.hour*60*minute;
        const id='replay-'+i+'-'+slot.id;
        clock=when;
        if(i%2===0){
            const served=plate(when,slot.carb*2);
            const started=when+slot.lag*minute;
            controller.createFromFood(served,id);
            controller.ready(id);
            write('actionWriter','recordSessionInjection',{sessionId:id,expectedVersion:controller.lookup(id).version,
                opId:id+'-op',injectionId:id+'-shot',insulinId:'rinfast',units:2,administeredAt:iso(when),
                injectionSite:{region:'abdomen'},injectionContext:{illness:'no',activity:'usual',iobU:0,
                    carbsG:slot.carb*2,mealLagMinutes:slot.lag,mealGroup:'with_meal',settingRevision:1,
                    localHour:slot.hour,utcOffsetMinutes:0}});
            clock=started;
            controller.startMeal(id,iso(started),{actuallyStarted:true});
            controller.actualFood(id,served,{parentConfirmed:true});
            clock+=15*minute;
            controller.finishMeal(id,iso(clock),{confirmed:true});
            for(let d=-25;d<=slot.lag+180;d+=5){
                const excursion=d===slot.lag+30?0.5:0;
                glucose(when+d*minute,7+excursion);
            }
        }else{
            write('actionWriter','recordInjection',{id,insulinId:'rinfast',units:1,
                administeredAt:iso(when),injectionSite:{region:'abdomen'}});
            corrections.push({injectionId:id,intent:'correction_only',userVerified:true});
            for(let d=0;d<=180;d+=5)glucose(when+d*minute,10-slot.change*d/180);
        }
    }
    clock=anchor+7*day;
    write('cgmAdapter','setSourceMetadata',{sourceDeviceId:sensor,sourceType:'synthetic',samplingMinutes:5,qualityScore:1});
    write('cgmAdapter','ingestReadings',readings);
    const source={...host.connect('research').getSnapshot(),...host.connect('injectionAnalytics').getSnapshot()};
    assert.equal(Analytics.buildIndex(source,{asOf:clock}).status,'CGM_SOURCE_SYNTHETIC');
    const observations=source.mealSessions.map(session=>{
        const [shotId]=session.injectionIds;
        const shot=source.events.find(row=>row.id===shotId);
        const at=Date.parse(session.startedAt);
        const measured=source.cgm.filter(row=>row.ts>=at&&row.ts<=at+180*minute).map(row=>row.mmol);
        assert.equal(measured.length,37);
        const min=Math.min(...measured),max=Math.max(...measured);
        return {id:session.id,shotId,at,slot:Analytics.slotFor(at,'UTC'),
            lagMin:(at-Date.parse(shot.administeredAt))/minute,plate:Analytics.normalizePlate(session.actualPlate),
            context:{activity:'usual',iobU:0,cobG:null,settingRevision:'1'},site:shot.injectionSite.region,
            units:shot.units,quality:{baseline:{glucose:measured[0],trend:'flat'},min,max,low:false,
                excursionUp:max-measured[0],excursionDown:measured[0]-min}};
    });
    // The replay exercises the pure estimator without altering live provenance rules.
    const index={version:Analytics.VERSION,status:'READY',timeZone:'UTC',cgmCount:source.cgm.length,
        asOf:iso(clock),meals:observations,corrections:[]};
    const service=Coefficients.createService({researchPort:host.connect('research')});
    const stats=[3,4,7].map(windowDays=>{
        const result=service.run({windowDays,asOfIso:iso(clock),correctionTags:corrections});
        assert.deepEqual(result.statuses,{medicalUse:false,coefficientProposalCreated:false,automaticallyApplied:false});
        return {windowDays,result};
    });
    const before=host.exportState();
    const groups=slots.map(spec=>{
        const at=clock+spec.hour*60*minute;
        const request={atIso:iso(at),plate:plate(at,spec.carb*2),context,cgm:{glucose:7,trend:'flat'}};
        const result=Analytics.analyze(index,request);
        assert.equal(result.status,'HISTORICAL_ESTIMATE');
        assert.equal(result.descriptiveLagMinutes,spec.lag);
        assert.equal(result.matchedCases,4);
        assert.equal(result.clinicalUse,false);
        const negative=Analytics.analyze(index,{...request,context:{...context,activity:'sport'}});
        assert.equal(negative.code,'SIMILAR_CASES_INSUFFICIENT');
        assert.equal(Analytics.analyze({...index,meals:index.meals.filter(row=>row.at>=anchor+2*day)},request).code,
            'SIMILAR_CASES_INSUFFICIENT');
        assert.equal(Analytics.analyze(index,{...request,cgm:null}).code,'CGM_UNAVAILABLE');
        assert.equal(Analytics.analyze(index,{...request,context:{...context,iobU:2}}).code,'SIMILAR_CASES_INSUFFICIENT');
        assert.equal(Analytics.analyze(index,{...request,plate:plate(at,180)}).code,'SIMILAR_CASES_INSUFFICIENT');
        const capped=Analytics.analyze(index,{...request,atIso:iso(at-4*day)});
        assert.equal(capped.code,'HISTORY_LESS_THAN_3_DAYS');
        const windows=stats.map(({windowDays,result})=>{
            const slotFromId=id=>id.split('-').at(-1);
            const meals=result.mealObservations.filter(row=>slotFromId(row.mealId)===spec.id);
            const paired=result.correctionObservations.filter(row=>slotFromId(row.injectionId)===spec.id);
            const gramsPerUnit=Coefficients.median(meals.map(row=>row.observedGramsPerUnit));
            const changePerUnit=Coefficients.median(paired.map(row=>row.observedChangePerUnit));
            assert.equal(meals.length,windowDays===7?4:2);
            assert.equal(paired.length,windowDays===7?3:windowDays===4?2:1);
            assert.equal(gramsPerUnit,spec.carb);
            assert.equal(changePerUnit,spec.change);
            return {days:windowDays,meals:meals.length,corrections:paired.length,gramsPerUnit,changePerUnit};
        });
        return {slot:spec.id,windows,historicalMinutes:result.descriptiveLagMinutes,matched:result.matchedCases};
    });
    assert.deepEqual(host.exportState(),before);
    assert.equal(before.coefficients.length,0);
    return {version:1,provenance:'synthetic_replay',clinicalUse:false,appliedToProfile:false,
        cgmCount:readings.length,groups};
}

if(require.main===module)process.stdout.write(JSON.stringify(replay(),null,2)+'\n');
module.exports={replay};
