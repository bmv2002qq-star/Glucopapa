"""Exercise the approved GFMealCalc route with the real engine on synthetic history."""
import argparse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2] / 'android-mvp3'
WEB = ROOT / 'app/src/main/assets/www'
SYNTHETIC_CASE = ROOT / 'app/src/androidTest/assets/meal-timing-case.js'
TIME = datetime(2026,11,20,8,30,tzinfo=timezone.utc)
CARDS = ['plateCard','calcCard','timerCard','mealCard','endCard']


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def check(browser, origin, width, output):
    page = browser.new_page(viewport={'width':width,'height':850},timezone_id='UTC')
    page.clock.set_fixed_time(TIME)
    page.goto(origin+'/index.html')
    page.wait_for_function('()=>window.GPApp?.getStorage()')
    page.evaluate(SYNTHETIC_CASE.read_text())
    page.evaluate('GFMealTimingQACase.prepare(GPApp.getStorage(),Date.now())')
    page.reload()
    page.evaluate("GPApp.open('approved-meal')")
    panel=page.frame_locator('#iframeApprovedMeal')
    assert panel.locator('section.card').evaluate_all('(elements)=>elements.map(el=>el.id)')==CARDS
    expect(panel.locator('#plannedFoods')).to_contain_text('SYNTHETIC PLATE')
    expect(panel.locator('#minutesChosen')).to_have_attribute('readonly','')
    expect(panel.locator('#timerText')).to_have_text('--:--')
    panel.locator('#shotSite').select_option('abdomen')
    panel.locator('#doseChosen').fill('1.3')
    expect(panel.locator('#confirmInjection')).to_be_disabled()
    panel.locator('#doseChosen').fill('1.5')
    curve=panel.locator('#chartSvg polyline').get_attribute('points')
    panel.locator('#doseChosen').fill('2')
    expect(panel.locator('#chartSvg polyline')).not_to_have_attribute('points',curve)
    expect(panel.locator('#minutesExplain')).to_contain_text('6 случаев')
    estimate=int(panel.locator('#minutesChosen').input_value())
    assert 10<=estimate<=15
    assert page.evaluate("GPApp.getStorage().exportState().events.length")==6
    page.once('dialog',lambda dlg:dlg.dismiss())
    panel.locator('#confirmInjection').click()
    assert page.evaluate("GPApp.getStorage().exportState().events.length")==6
    page.once('dialog',lambda dlg:dlg.accept())
    panel.locator('#confirmInjection').click()
    expect(panel.locator('#timerText')).to_have_text(f'{estimate:02d}:00')
    event=page.evaluate("GPApp.getStorage().exportState().events.at(-1)")
    assert event['mealTiming']['estimate']['minutes']==estimate
    assert event['injectionSite']['region']=='abdomen'
    expect(panel.locator('#confirmInjection')).to_be_disabled()

    page.clock.set_fixed_time(datetime(2026,11,20,8,31,tzinfo=timezone.utc))
    page.reload()
    page.evaluate("GPApp.open('approved-meal')")
    expect(panel.locator('#timerText')).to_have_text(f'{estimate-1:02d}:00')
    expect(panel.locator('#doseSuggested')).to_have_text('—')
    panel.locator('#mealStartTime').fill('2026-11-20T08:29')
    panel.locator('#startMeal').click()
    expect(panel.locator('#finalInterval')).to_contain_text('Еда до укола')
    panel.locator('#editActual').click()
    panel.locator('#editFoodRows input').fill('75')
    panel.locator('#saveActual').click()
    panel.locator('#finishMeal').click()
    expect(panel.locator('#finalActual')).to_have_text('15 г У')
    panel.locator('#showCorrection').click()
    panel.locator('#editFoodRows input').fill('50')
    panel.locator('#saveActual').click()
    expect(panel.locator('#mealOperationStatus')).to_contain_text('причину')
    panel.locator('#editReason').fill('SYNTHETIC portion correction')
    panel.locator('#saveActual').click()
    expect(panel.locator('#finalActual')).to_have_text('10 г У')
    assert page.evaluate("GPApp.getStorage().exportState().events.at(-1)")==event
    assert page.evaluate("GPApp.getStorage().exportState().events.length")==7
    page.screenshot(path=output/f'meal-{width}.png')
    page.close()
    return {'width':width,'cards':CARDS,'matched':6,'historySaved':True,'writeCount':1,'restart':True,'correctionGrams':50}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    output=parser.parse_args().output
    output.mkdir(parents=True,exist_ok=True)
    with ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=WEB)) as server:
        thread=Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True)
                results=[check(browser,'http://127.0.0.1:'+str(server.server_port),w,output) for w in [320,390,428]]
        finally:
            server.shutdown()
            thread.join()
    report={'status':'PASS','environment':'BROWSER_MULTI_FILE','data':'SYNTHETIC_ONLY','actualEngine':'0.2.1-history-only','results':results}
    rendered=json.dumps(report,ensure_ascii=False,indent=2)+'\n'
    (output/'report.json').write_text(rendered)
    print(rendered,end='')


if __name__=='__main__':
    main()
