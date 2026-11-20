"""Verify CL-042 settings and interrupted entry on the real local multi-file UI."""

import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


class LocalHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def register_source(page):
    page.evaluate("""() => {
        const host=GPApp.getStorage(), min=60000, now=Math.floor(Date.now()/min)*min;
        const sensor='SYNTHETIC-EDIT-QA', iso=x=>new Date(x).toISOString();
        const cgm=host.connect('cgmAdapter'), writer=host.connect('forecastWriter');
        cgm.setSourceMetadata({sourceDeviceId:sensor,sourceType:'device_recorded',samplingMinutes:5,qualityScore:1},cgm.getRevision());
        cgm.ingestReadings([15,10,5,0].map(n=>({ts:now-n*min,sourceDeviceId:sensor,mmol:7,
            receivedAt:iso(now-n*min),valid:true,qualityFlag:'ok'})),cgm.getRevision());
        const payload={contract:'glucopapa.research-forecast/2',modelId:'GFForecast',modelVersion:'0.1.2',version:'GFForecast@0.1.2',
            forecastAt:iso(now),sourceTime:iso(now),sourceReceivedAt:iso(now),sourceRevision:writer.getRevision(),
            mode:'RESEARCH_FORECAST',status:'EXPERIMENTAL',inputDigest:'b'.repeat(64),clinicalUse:false,modelValidated:false,
            snapshot:{sensorSourceId:sensor},points:Array.from({length:25},(_,i)=>({horizonMin:5*i,at:iso(now+i*5*min),glucoseMmol:7}))};
        writer.appendResearchEvents({schema:'gfforecast.research-events/1',writerRequired:true,assessments:[],
            forecasts:[{id:[payload.forecastAt,payload.sourceTime,payload.version].join('|'),kind:'research_forecast',payload}]},writer.getRevision());
    }""")


def arrive(page):
    page.clock.fast_forward(5 * 60_000)
    page.evaluate("""() => {
        const ts=Math.floor(Date.now()/60000)*60000, cgm=GPApp.getStorage().connect('cgmAdapter');
        cgm.ingestReadings([{ts,sourceDeviceId:'SYNTHETIC-EDIT-QA',mmol:7.2,
            receivedAt:new Date(ts).toISOString(),valid:true,qualityFlag:'ok'}],cgm.getRevision());
    }""")


def verify(page, origin, out):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install(time=datetime(2026, 11, 19, 12, 0, tzinfo=timezone.utc))
    page.goto(origin + '/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    register_source(page)
    page.evaluate("GPApp.open('cgm')")
    curve = page.locator('#cgmDetailChart [data-forecast-model]')
    assert curve.count() == 1

    page.evaluate("GPApp.open('injections')")
    units = page.locator('#injectionUnits')
    units.fill('0.5')
    arrive(page)
    assert units.input_value() == '0.5'
    assert page.evaluate('GPApp.getStorage().exportState().events.length') == 0
    page.evaluate("GPApp.open('cgm')")
    assert curve.count() == 0
    frozen = page.evaluate('JSON.stringify(GPApp.getStorage().exportState().forecasts)')

    page.evaluate("GPApp.open('approved-nutrition')")
    plate = page.frame_locator('#iframeApprovedNutrition')
    plate.locator('#catalogSearch').fill('гречка')
    plate.locator('#productCards button.food-main').first.click()
    portion = plate.locator('#portionAmount')
    portion.fill('75')
    arrive(page)
    assert portion.input_value() == '75'
    assert page.evaluate('GPApp.getStorage().exportState().mealSessions.length') == 0
    assert page.evaluate('JSON.stringify(GPApp.getStorage().exportState().forecasts)') == frozen

    page.evaluate("GPApp.open('approved-settings')")
    select = page.locator('#gfMealAbsorptionModel')
    assert select.input_value() == 'GFForecast'
    select.select_option('GFCOB')
    page.evaluate('GFSettingsPanel.refresh()')
    assert select.input_value() == 'GFCOB'
    page.locator('#gfMealAbsorptionSave').click()
    selected = "GPApp.getStorage().connect('settings').read('profile').mealAbsorptionModel"
    assert page.evaluate(selected) == {'id':'GFCOB','version':'0.1.1'}, page.locator('#gfContextMessage').inner_text()
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("GPApp.open('approved-settings')")
    assert select.input_value() == 'GFCOB', (page.evaluate(selected),page.locator('#gfContextMessage').inner_text(),errors)
    assert page.evaluate("GPApp.getStorage().connect('settings').read('profile').mealAbsorptionModel.version") == '0.1.1'
    page.locator('#gfContextPanel').scroll_into_view_if_needed()
    page.screenshot(path=out / 'meal-model-setting-390.png')

    page.evaluate("GPApp.open('approved-low')")
    frame = page.frame_locator('#iframeLowTarget')
    frame.locator('#lowTracePanel summary').click()
    panel = frame.locator('#w06cStudyLow')
    panel.get_by_role('button',name='Подтверждаю, что еды за последние 12 часов не было').click()
    assert 'PARENT_ATTESTED_EMPTY_WINDOW' in panel.inner_text()
    low = panel.inner_text()
    assert 'GFCOB 0.1.1' in low and '0.0–0.0' in low
    assert 'GFCOB 0.1.1' in frame.locator('#lowTrace').inner_text()
    assert not errors, errors
    assert page.evaluate('JSON.stringify(GPApp.getStorage().exportState().forecasts)') == frozen
    page.screenshot(path=out / 'declared-empty-window-390.png')
    return {'status':'PASS','origin':'LOOPBACK_HTTP','all_inputs_synthetic':True,'criteria':['CGM-05','FOOD-06'],
            'preserved_manual_fields':['0.5 units','75 g'],'no_unconfirmed_fact':True,
            'old_current_path_removed':True,'archive_bytes_preserved':True,'selector_persisted':True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1',0),partial(LocalHandler,directory=web)) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as engine:
                browser = engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
                try:
                    result = verify(browser.new_page(viewport={'width':390,'height':880}),
                                    f'http://127.0.0.1:{server.server_port}',args.output)
                finally:
                    browser.close()
        finally:
            server.shutdown()
    output = json.dumps(result,ensure_ascii=False,indent=2)
    (args.output / 'browser-cl042.json').write_text(output+'\n')
    print(output)


if __name__ == '__main__':
    main()
