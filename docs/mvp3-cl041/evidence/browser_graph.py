"""Verify forecast overlay and persisted display controls on real loopback assets."""
from datetime import datetime, timezone
from pathlib import Path
import json
import sys

from playwright.sync_api import sync_playwright

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

class LocalHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

def verify(page, base, output):
    errors=[]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time=datetime(2026,11,19,12,0,tzinfo=timezone.utc))
    page.goto(base+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("""() => {
        const host=GPApp.getStorage(), m=60000, now=Math.floor(Date.now()/m)*m;
        const iso=n=>new Date(n).toISOString();
        const scenario='SYNTHETIC-GRAPH-ONLY', call=(r,k,v)=>{
            const p=host.connect(r); return p[k](v,p.getRevision());
        };
        call('cgmAdapter','setSourceMetadata',{sourceDeviceId:scenario,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
        call('cgmAdapter','ingestReadings',[15,10,5,0].map(x=>({ts:now-x*m,sourceDeviceId:scenario,mmol:6,
            receivedAt:iso(now-x*m),valid:true,qualityFlag:'ok'})));
        call('actionWriter','setCoverage',{startIso:iso(now-49*60*m),endIso:iso(now+10*m),confirmedComplete:true,declaredBy:'parent'});
        call('actionWriter','recordInjection',{id:'synthetic-chart-injection',units:0.5,insulinId:'rinfast',
            administeredAt:iso(now-10*m),injectionSite:{region:'abdomen'}});
        const sourceRevision=host.diagnostics().revision, forecasts=GFResearchForecastGraph.IDS.map((model,index)=>{
            const version=model+'@1.0.0';
            const payload={contract:'glucopapa.research-forecast/2',modelId:model,modelVersion:'1.0.0',version,
             mode:'RESEARCH_FORECAST',status:'EXPERIMENTAL',forecastAt:iso(now),sourceTime:iso(now),
             sourceReceivedAt:iso(now),sourceRevision,inputDigest:'a'.repeat(64),snapshot:{sensorSourceId:scenario},
             clinicalUse:false,modelValidated:false,points:Array.from({length:25},(_,n)=>({
                 horizonMin:n*5,at:iso(now+n*5*m),glucoseMmol:6 + index*.2})),
            };
            return {id:[payload.forecastAt,payload.sourceTime,version].join('|'),kind:'research_forecast',payload};
        });
        call('forecastWriter','appendResearchEvents',{schema:'gfforecast.research-events/1',writerRequired:true,forecasts,assessments:[]});
        GPApp.open('cgm');
    }""")
    chart=page.locator('#cgmDetailChart')
    assert chart.locator('.gp-cgm-trace [data-cgm-point]').count()==4
    assert chart.locator('.gp-rinfast-model').count()==1
    patterns=chart.locator('[data-forecast-model]')
    assert patterns.count()==3, page.locator('#forecastGraphLegend').inner_text()
    initial=page.evaluate('JSON.stringify(GPApp.getStorage().exportState().forecasts)')
    page.locator('#forecastGraphOptions summary').click()
    units=['GFForecast','GFxDrip','GFAPSEnhancer']
    for mask in range(8):
        for n,model in enumerate(units):
            page.locator(f'[data-model-visibility="{model}"]').set_checked(bool(mask & (1<<n)))
        assert patterns.count()==mask.bit_count()
        assert chart.locator('.gp-cgm-trace [data-cgm-point]').count()==4
        assert chart.locator('.gp-rinfast-model').count()==1
        assert page.evaluate('JSON.stringify(GPApp.getStorage().exportState().forecasts)')==initial
    page.locator('[data-model-visibility="GFxDrip"]').uncheck()
    page.locator('#forecastAutoConsensus').uncheck()
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("GPApp.open('cgm')")
    assert not page.locator('[data-model-visibility="GFxDrip"]').is_checked()
    assert not page.locator('#forecastAutoConsensus').is_checked()
    assert patterns.count()==2
    assert not errors, errors
    page.screenshot(path=output/'chart-forecast-fixture.png')
    return {'status':'PASS','fixture':'SYNTHETIC_STORED_CURVES','visible_combinations':8,'persisted_visibility':True,
            'past_measurements':4,'rinfast_overlay_preserved':True,'forecasts_unchanged':True,'xdrip_engine_executed':False}

def verify_rank(page, base, strategy):
    page.clock.install(time=datetime(2026,11,19,12,0,tzinfo=timezone.utc))
    page.goto(base+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("""strategy => {
        const host=GPApp.getStorage(), m=60000, now=Math.floor(Date.now()/m)*m;
        const iso=n=>new Date(n).toISOString(), source='SYNTHETIC-RANK';
        const call=(r,k,v)=>{const p=host.connect(r);return p[k](v,p.getRevision());};
        call('cgmAdapter','setSourceMetadata',{sourceDeviceId:source,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1});
        call('cgmAdapter','ingestReadings',Array.from({length:401},(_,n)=>({
            ts:now-(400-n)*5*m,sourceDeviceId:source,mmol:6,receivedAt:iso(now-(400-n)*5*m),valid:true,qualityFlag:'ok',
        })));
        const sourceRevision=host.diagnostics().revision, models=GFResearchForecastGraph.IDS;
        const issue=(idx, model, t)=>{
            const modelVersion='1.0.0', version=model+'@'+modelVersion;
            const points=Array.from({length:25},(_,x)=>{
                const h=x*5;
                const error=strategy==='leader'?[0,.5,1][idx]:strategy==='tie'?0:
                  (idx===(h<=30?0:h<=60?1:2)?0:1);
                return {horizonMin:h,at:iso(t+h*m),glucoseMmol:6+error};
            });
            const payload={contract:'glucopapa.research-forecast/2',modelId:model,modelVersion,version,
                mode:'RESEARCH_FORECAST',status:'EXPERIMENTAL',forecastAt:iso(t),sourceTime:iso(t),sourceReceivedAt:iso(t),
                sourceRevision,inputDigest:'b'.repeat(64),snapshot:{sensorSourceId:source},
                clinicalUse:false,modelValidated:false,points};
            return {kind:'research_forecast',id:[payload.forecastAt,payload.sourceTime,version].join('|'),payload};
        };
        const forecastTimes=Array.from({length:288},(_,n)=>now-(398-n)*5*m).concat(now);
        const forecasts=forecastTimes.flatMap(t=>models.map((id,i)=>issue(i,id,t)));
        call('forecastWriter','appendResearchEvents',{schema:'gfforecast.research-events/1',writerRequired:true,forecasts,assessments:[]});
        GPApp.open('cgm');
    }""", strategy)
    chart=page.locator('#cgmDetailChart')
    paths=chart.locator('[data-forecast-model]')
    names=lambda: paths.evaluate_all('(nodes)=>nodes.map(node=>node.dataset.forecastModel)')
    model_toggle=page.locator('[data-model-visibility="GFForecast"]')
    automatic=page.locator('#forecastAutoConsensus')
    legends=page.locator('#forecastGraphLegend')
    page.locator('#forecastGraphOptions summary').click()
    if strategy=='leader':
        assert paths.count()==3 and '★ GFForecast' in legends.inner_text()
        assert chart.locator('[data-forecast-model="GFForecast"]').get_attribute('stroke-width')=='3'
        model_toggle.uncheck()
        assert names()==['GFxDrip','GFAPSEnhancer'] and '★' not in legends.inner_text()
    elif strategy=='tie':
        assert paths.count()==3 and '★' not in legends.inner_text()
    else:
        assert names()==['GFConsensus']
        model_toggle.uncheck()
        assert names()==['GFConsensus']
        automatic.uncheck()
        assert names()==['GFxDrip','GFAPSEnhancer']
        automatic.check()
        assert names()==['GFConsensus']
    assert page.evaluate('GPApp.getStorage().exportState().forecasts.length')==867
    return True


root, output=Path(sys.argv[1]),Path(sys.argv[2])
output.mkdir(parents=True,exist_ok=True)
with ThreadingHTTPServer(('127.0.0.1',0),partial(LocalHandler,directory=root/'android-mvp3/app/src/main/assets/www')) as server:
    Thread(target=server.serve_forever,daemon=True).start()
    with sync_playwright() as engine:
        browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
        try:
            result=verify(browser.new_page(viewport={'width':428,'height':880}),f'http://127.0.0.1:{server.server_port}',output)
            result['synthetic_ranking']={case:verify_rank(browser.new_page(viewport={'width':428,'height':880}),
                f'http://127.0.0.1:{server.server_port}',case) for case in ('leader','tie','composite')}
            (output/'browser-graph.json').write_text(json.dumps(result,indent=2)+'\n')
            print(json.dumps(result))
        finally:
            browser.close()
            server.shutdown()
