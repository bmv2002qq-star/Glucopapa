"""Check the ordinary multi-file shell and production layout with an isolated fixture."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def verify(page, origin, output):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.add_init_script("localStorage.setItem('GFV2SHELL_MODE_v1', 'demo')")
    page.goto(origin + '/index.html', wait_until='load')
    page.wait_for_function('window.GPApp?.getStorage()')
    state = lambda: page.evaluate('GPApp.getStorage().exportState()')
    assert state()['revision'] == 0
    assert page.locator('#modeDemo,#seedDemo,#resetDemo,#syntheticCgmTools').count() == 0
    assert page.evaluate("GPApp.mode()==='local' && !window.GFTestJournal")
    assert page.locator('#homeGlucose').inner_text() == '—'
    assert page.locator('[data-nutrient=carbs] td').nth(1).inner_text() == '—'
    assert not page.locator('[data-cgm-point]').count()

    for width in (320, 390, 428, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=output / f'home-empty-{width}.png', full_page=True)
        for button, route in (('openLow','approved-low'),('openHigh','approved-high'),('openBasalQuick','injections')):
            page.locator('#'+button).click()
            assert page.locator('#screen-'+route).is_visible()
            page.evaluate("GPApp.open('home')")
    page.set_viewport_size({'width': 390, 'height': 887})
    assert state()['revision'] == 0
    page.locator('#sportToggle').click()
    page.locator('#activityChoice').select_option('usual')
    assert state()['profile']['activityBaseLevel'] == 'usual'
    page.locator('#sportToggle').click()
    page.locator('#sportStart').click()
    old_period, = state()['conditionPeriods']
    page.reload()
    page.locator('#sportFinish').wait_for()
    assert state()['conditionPeriods'] == [old_period]
    page.once('dialog', lambda dialog: dialog.dismiss())
    page.locator('#sportFinish').click()
    assert state()['conditionPeriods'] == [old_period]
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#sportFinish').click()
    now_period, = state()['conditionPeriods']
    assert now_period['id'] == old_period['id'] and now_period['end']
    assert page.locator('#recentRows [data-event-id="'+now_period['id']+'"]').count() == 1
    page.get_by_role('button', name='Весь дневник').click()
    assert page.locator('#approvedSportRows').count() == 0
    page.frame_locator('#iframeApprovedJournal').locator('tr.sport-period').wait_for()
    page.evaluate("GPApp.open('home')")

    # The readings and forecasts are fabricated inputs in a disposable browser. They
    # exercise the device-recorded contract without any provider or real CGM.
    page.evaluate("""() => {
       const host=GPApp.getStorage(), cgm=host.connect('cgmAdapter'), id='SYNTHETIC-DEVICE-CONTRACT';
       const date=Date.now(), iso=t=>new Date(t).toISOString();
       let refused=false;
       try { cgm.setSourceMetadata({sourceDeviceId:id,sourceType:'synthetic',qualityScore:1,samplingMinutes:5},cgm.getRevision()); }
       catch (error) { refused=error.message==='GF_LOCAL_SYNTHETIC_DATA'; }
       if (!refused) throw Error('Isolation check failed');
       cgm.setSourceMetadata({sourceDeviceId:id,sourceType:'device_recorded',qualityScore:1,samplingMinutes:5},cgm.getRevision());
       const ts=date-5*60000, when=iso(ts);
       cgm.ingestReadings(Array.from({length:7},(_,i)=>{
          const at=ts-(6-i)*300000;
          return {ts:at,receivedAt:iso(at),mmol:6+i/10,sourceDeviceId:id,valid:true,qualityFlag:'ok'};
       }), cgm.getRevision());
       const port=host.connect('forecastWriter'), revision=port.getRevision();
       const forecasts=['GFForecast','GFAPSEnhancer'].map((modelId,i)=>{
          const forecastAt=iso(date), version=modelId+'@1.0.0';
          return {id:[forecastAt,when,version].join('|'),kind:'research_forecast',payload:{
            contract:'glucopapa.research-forecast/2',modelId,modelVersion:'1.0.0',version,mode:'RESEARCH_FORECAST',
            status:'EXPERIMENTAL',forecastAt,sourceTime:when,sourceReceivedAt:when,sourceRevision:revision,inputDigest:'8'.repeat(64),
            mealModel:{id:'GFForecast',version:'0.1.2'},snapshot:{sensorSourceId:id,flags:[]},clinicalUse:false,modelValidated:false,
            points:Array.from({length:25},(_,n)=>({horizonMin:n*5,at:iso(date+n*300000),glucoseMmol:6+i}))}};
       });
       port.appendResearchEvents({schema:'gfforecast.research-events/1',writerRequired:true,forecasts,assessments:[]},revision);
    }""")
    all_models = ['GFConsensus','GFForecast','GFxDrip','GFAPSEnhancer']
    home = page.locator('#screen-home')
    detail = page.locator('#screen-cgm')
    control = lambda route, model: route.locator('[data-model-visibility='+model+']')
    paths = lambda route: set(route.locator('[data-forecast-model]').evaluate_all(
        '(items) => items.map(item=>item.dataset.forecastModel)'))
    assert paths(home) == {'GFConsensus','GFForecast','GFAPSEnhancer'}
    assert '6,6' == page.locator('#homeGlucose').inner_text()
    page.screenshot(path=output/'home-synthetic-390.png', full_page=True)

    client = page.context.new_cdp_session(page)
    chart = page.locator('#main-chart')
    chart.scroll_into_view_if_needed()
    bounds = chart.bounding_box()
    x = round(bounds['x']+bounds['width']/2)
    y = round(bounds['y']+bounds['height']/2)
    get_view = lambda: page.evaluate('GFMainScreenUI.getViewport()')

    def touch(event, points=()):
        client.send('Input.dispatchTouchEvent', {'type': event, 'touchPoints': [
            {'x': px, 'y': py, 'id': i} for i, (px,py) in enumerate(points)
        ]})

    def pinch(dx, dy, dx_end, dy_end):
        before = get_view()
        touch('touchStart', [(x-dx, y-dy), (x+dx, y+dy)])
        touch('touchMove', [(x-dx_end, y-dy_end), (x+dx_end, y+dy_end)])
        touch('touchEnd')
        return before, get_view()

    before, after = pinch(26, 0, 62, 0)
    assert after['t1']-after['t0'] < before['t1']-before['t0'] and after['y0'] == before['y0'], (before, after)
    before, after = pinch(0, 21, 0, 41)
    assert after['y1']-after['y0'] < before['y1']-before['y0'] and after['t0'] == before['t0'], (before, after)
    touch('touchStart', [(x,y)])
    touch('touchMove', [(x+35,y+20)])
    touch('touchEnd')
    assert get_view()['t0'] != after['t0']
    client.detach()

    archived = state()['forecasts']
    for mask in range(16):
        for i, model in enumerate(all_models):
            control(home, model).set_checked(bool(mask & (1<<i)))
        want = {model for i, model in enumerate(all_models) if model!='GFxDrip' and mask & (1<<i)}
        assert paths(home) == want
        page.get_by_role('button', name='Открыть подробный график').click()
        assert paths(detail) == want, (mask, want, paths(detail))
        assert 'демо' not in detail.locator('[data-cgm-point] title').first.text_content()
        page.get_by_role('button', name='Вернуться к графику').click()
    page.get_by_role('button', name='Открыть подробный график').click()
    detail.locator('summary').filter(has_text='Исследовательские прогнозы').click()
    control(detail, 'GFConsensus').uncheck()
    page.get_by_role('button', name='Вернуться к графику').click()
    assert not control(home, 'GFConsensus').is_checked()
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    assert not control(home, 'GFConsensus').is_checked()
    assert paths(home) == {'GFForecast','GFAPSEnhancer'}
    assert state()['forecasts'] == archived
    assert not errors, errors
    return {'status':'PASS','synthetic_only':True,'widths':[320,390,428,1280],
            'forecast_masks':16,'gesture_x_y_pan':True,'real_provider':False,
            'sport_reload':True,'fixtures_absent':True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=web)) as server, sync_playwright() as engine:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True)
            page = browser.new_page(locale='ru-RU', has_touch=True, is_mobile=True, viewport={'width':390,'height':887})
            result = verify(page, f'http://127.0.0.1:{server.server_port}', output)
        finally:
            server.shutdown()
    report = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    (output / 'report.json').write_text(report, encoding='utf-8')
    print(report, end='')


if __name__ == '__main__':
    main()
