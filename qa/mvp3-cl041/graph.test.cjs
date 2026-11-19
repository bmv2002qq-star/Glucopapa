'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {iso,at,minute,fromWeb,testJournal,mutate,Rinfast}=require('../mvp3-calculators/fixture.cjs');
const Consensus=fromWeb('integration/GFConsensusReview_v0.1.0.js');
const UI=fromWeb('integration/GFResearchForecastGraph_v0.1.0.js');
const Chart=fromWeb('modules/CGMChart_v0.2/xdrip_chart.js');
const Bridge=fromWeb('integration/GFGraphEvidenceBridge_v0.1.0.js');

const source='SYNTHETIC-MODEL-SERIES', step=5*minute;
const say=(origin,index,errors)=>({kind:'research_forecast',payload:{
    contract:'glucopapa.research-forecast/2',forecastAt:iso(origin),sourceTime:iso(origin),
    snapshot:{sensorSourceId:source},sourceRevision:index,inputDigest:'a'.repeat(64),
    modelId:Consensus.MODELS[index%3],modelVersion:'1.0.0',
    points:Array.from({length:25},(_,n)=>({horizonMin:n*5,at:iso(origin+n*step),glucoseMmol:6+errors(index%3,n*5)})),
}});
function batch(origin,rev,errors) {
    return Consensus.MODELS.map((model,index)=>{
        const row=say(origin,index,errors);row.payload.sourceRevision=rev;return row;
    });
}
const request=(history,errors,settings={})=>{
    const current=batch(at,999,errors);
    const cgm=Array.from({length:400},(_,n)=>({ts:at-(400-n)*step,receivedAt:iso(at-(400-n)*step),
        sourceDeviceId:source,valid:true,mmol:6}));
    return {forecasts:[...history,...current],cgm,sourceId:source,sourceTime:at,nowMs:at+minute,preferences:settings};
};

test('GRAPH-02: eight visibility combinations change the visible paths independently of archive',()=>{
    const input=request([],()=>0);
    const original=JSON.stringify(input.forecasts);
    for(let mask=0;mask<8;mask++){
        const modelIds=Consensus.MODELS.filter((_,i)=>mask&(1<<i));
        const preferences={autoConsensus:false,forecastVisibility:Object.fromEntries(Consensus.MODELS.map(id=>[id,modelIds.includes(id)]))};
        assert.deepEqual(UI.select({...input,preferences}).lines.map(r=>r.modelId),modelIds);
        assert.equal(JSON.stringify(input.forecasts),original);
    }
    const onlyTwo={...input,forecasts:input.forecasts.slice(0,2)};
    assert.equal(UI.select(onlyTwo).status,'INSUFFICIENT_MODELS');
    assert.equal(UI.select(onlyTwo).lines.length,2);
    assert.equal(UI.select({...input,sourceTime:at+step}).status,'NO_CURRENT_FORECAST');
});

test('GRAPH-03/04: no future learning, visible leader only and composite exits to manual settings',()=>{
    for(const [mode,errors] of [['leader',(model)=>[0,.5,1][model]],
        ['composite',(model,h)=>model===(h<=30?0:h<=60?1:2)?0:1]]){
        const history=Array.from({length:288},(_,i)=>batch(at-(398-i)*step,i+1,errors)).flat();
        const input=request(history,errors);
        const auto=UI.select(input);
        if(mode==='leader'){
            assert.equal(auto.status,'LEADER');
            assert.deepEqual(auto.lines.map(r=>r.highlight),[true,false,false]);
            const hidden=UI.select({...input,preferences:{forecastVisibility:{GFForecast:false}}});
            assert.equal(hidden.lines.length,2);
            assert.ok(hidden.lines.every(line=>!line.highlight));
        }else{
            assert.equal(auto.status,'COMPOSITE');
            assert.equal(auto.lines.length,1);
            assert.equal(auto.lines[0].modelId,'GFConsensus');
            assert.equal(auto.lines[0].points.length,241);
            const manual=UI.select({...input,preferences:{autoConsensus:false,forecastVisibility:{GFxDrip:false}}});
            assert.deepEqual(manual.lines.map(r=>r.modelId),['GFForecast','GFAPSEnhancer']);
        }
        const late={...input,cgm:input.cgm.map(p=>({...p,receivedAt:iso(at+minute)}))};
        assert.equal(UI.select(late).status,'NO_LEADER');
    }
});

test('GRAPH guard rejects mixed snapshot revisions and keeps original renderer geometry',()=>{
    const host=testJournal({glucose:6});
    mutate(host,'actionWriter','recordInjection',{id:'SYNTHETIC-GRAPH-SHOT',units:0.5,insulinId:'rinfast',
        administeredAt:iso(at-30*minute),injectionSite:{region:'abdomen'}});
    const result=Bridge.render({host,renderer:Chart,engine:Rinfast,nowMs:at});
    assert.equal(result.shotCount,1);
    assert.ok(result.svg.includes('gp-cgm-trace'));
    assert.ok(result.svg.includes('gp-rinfast-model'));
    assert.equal(result.sourceRevision,host.diagnostics().revision);
    const torn={getSchemaVersion:host.getSchemaVersion,connect(name){
        const port=host.connect(name);
        if(name!=='graph')return port;
        return {...port,getSnapshot:()=>({...port.getSnapshot(),revision:port.getRevision()+1})};}};
    assert.equal(Bridge.render({host:torn,renderer:Chart,engine:Rinfast,nowMs:at}).code,'REVISION_CHANGED');
});
