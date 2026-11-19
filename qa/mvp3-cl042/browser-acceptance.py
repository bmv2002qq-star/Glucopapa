"""Exercise the unchanged nutrition catalog and the application's trace call boundary."""

import argparse
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def run(browser, origin, output):
    page = browser.new_page(viewport={'width':390,'height':880})
    page.add_init_script("""window.qaTrace=[];
      window.AndroidDiagnostics={record(mode,raw){qaTrace.push({mode,...JSON.parse(raw)});}};""")
    page.goto(origin+'/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    results = {}
    page.evaluate("GPApp.open('approved-nutrition')")
    plate = page.frame_locator('#iframeApprovedNutrition')
    plate.locator('#catalogSearch').fill('гречка')
    products = plate.locator('#productCards .food-card')
    assert products.count() >= 1
    first = products.first.locator('[data-open]').inner_text()
    products.first.locator('[data-fav]').click()
    plate.locator('#favCatalog').click()
    assert plate.locator('#favCatalog').get_attribute('aria-pressed') == 'true'
    assert products.count() == 1 and products.first.locator('[data-open]').inner_text() == first
    products.first.locator('[data-open]').click()
    amount = plate.locator('#portionAmount')
    amount.fill('75')
    plate.locator('#addToPlate').click()
    assert page.evaluate('GPApp.getStorage().exportState().mealSessions.length') == 0
    page.locator('#approvedSavePlate').click()
    page.locator('#approvedPlateStatus').get_by_text('План зарегистрирован:',exact=False).wait_for()
    saved = page.evaluate('GPApp.getStorage().exportState().mealSessions[0]')
    live = saved['plannedPlate']
    assert len(live['items']) == 1 and live['items'][0]['amount'] == 75
    assert live['items'][0]['glycemicIndex'] is not None
    assert saved['actualPlate'] is None
    for width in [320,390,428,1280]:
        page.set_viewport_size({'width':width,'height':880})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width':390,'height':880})
    page.screenshot(path=output/'approved-plate-catalog.png')
    results['FOOD-01'] = {'catalog':True,'favorite':True,'portion_unchanged':True,'widths':[320,390,428,1280]}
    result = page.evaluate("""() => {
      qaTrace.length=0;
      const start=performance.now(), before=GPApp.getStorage().diagnostics().revision;
      for(let n=0;n<10000;n++){GPApp.open(n%2?'home':'analytics');window.scrollTo(0,n%100);}
      const afterRender=qaTrace.length;
      GPApp.open('insulin-models');
      for(let n=0;n<10;n++)document.getElementById('runBasalReview').click();
      return {operations:qaTrace.map(row=>row.operation),afterRender,revisionDelta:GPApp.getStorage().diagnostics().revision-before,
         elapsedMs:Math.ceil(performance.now()-start)};
    }""")
    assert result['afterRender'] == 0 and result['operations'] == ['basal_review'] * 10
    assert result['revisionDelta'] == 0
    results['LOG-06'] = {'origin':'Chromium with observer at native bridge boundary','rendersAndScrolls':10000,**result}
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    web=Path(__file__).resolve().parents[2]/'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=web)) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as engine:
                browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
                try:
                    evidence=run(browser,f'http://127.0.0.1:{server.server_port}',args.output)
                finally:
                    browser.close()
        finally:
            server.shutdown()
    evidence['FOOD-01']['sha256']=sha256((web/'approved/GFNutrition_v0.4.6_LIVE.html').read_bytes()).hexdigest()
    result=json.dumps({'status':'PASS','synthetic':True,**evidence},indent=2)+'\n'
    (args.output/'browser-acceptance.json').write_text(result)
    print(result,end='')


if __name__=='__main__':
    main()
