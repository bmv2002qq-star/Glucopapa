"""Exercise the actual LOW route over HTTP with Chromium's sandbox enabled."""
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


def run(browser, origin, output):
    page = browser.new_page(viewport={'width': 390, 'height': 900}, locale='ru-RU')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(path=Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/fixture/assets/www/qa-shell.js')
    page.goto(origin + '/index.html')
    page.wait_for_function('window.GPApp?.getStorage() && window.GFLOWView')
    state = lambda: page.evaluate('GPApp.getStorage().exportState()')
    empty = state()
    page.locator('#openLow').click()
    frame = page.frame_locator('#iframeLowTarget')
    frame.locator('#lowSource').get_by_text('CGM_SOURCE_UNKNOWN', exact=False).wait_for()
    for width in (320, 390, 428, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        assert frame.locator('main > section').count() == 3
        assert frame.locator('script, #testData, #glucose, #iob, #cob').count() == 0
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert frame.locator('html').evaluate('node => node.scrollWidth <= innerWidth')
        assert frame.locator('#heroGlucose').inner_text() == '—'
        assert frame.locator('#ispadBox').is_hidden()
        assert frame.locator('#juiceNumber').input_value() == ''
        assert frame.locator('#journal').is_disabled()
        page.screenshot(path=output / f'low-{width}.png', full_page=True)
    page.set_viewport_size({'width': 390, 'height': 900})
    frame.locator('#calculate').click()
    assert frame.locator('#resultMl').inner_text() == 'Расчёт недоступен'
    assert frame.locator('#lowBlockers [data-code=JOURNAL_COVERAGE_UNKNOWN]').is_visible()
    assert frame.locator('#applyResult').is_disabled()
    assert state() == empty

    page.evaluate("GPApp.open('system')")
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#modeDemo').click()
    page.evaluate("""() => {
        const host = GPApp.getStorage(), now = Date.now(), iso = t => new Date(t).toISOString();
        const port = host.connect('settings');
        GFSettings.createSettingsService({settingsPort: port}).addMeasurement(
            {measuredAt: iso(now - 60000), heightCm: 120, weightKg: 20}, port.getRevision());
        const sensor = host.connect('cgmAdapter');
        sensor.setSourceMetadata({sourceDeviceId:'SYNTHETIC-LOW-QA',sourceType:'synthetic',
            qualityScore:1,samplingMinutes:5}, sensor.getRevision());
        sensor.ingestReadings([20,15,10,5,0].map(n => ({ts:now-n*60000,receivedAt:iso(now-n*60000),
            sourceDeviceId:'SYNTHETIC-LOW-QA',mmol:3,valid:true,qualityFlag:'ok'})), sensor.getRevision());
        const food = host.connect('food');
        food.createDraft({id:'SYNTHETIC-LOW-PLAN',plate:{schema:'GFPlate.v1',source:'GFFoodOnly',
          createdAt:iso(now),containsEstimatedValues:false,items:[{kind:'manual',foodId:null,
            name:'Синтетическая гречка',unit:'г',amount:100,carbs:19.9,fat:1,protein:5,kcal:100,
            nutritionStatus:'label_verified',glycemicIndex:49,glycemicIndexStatus:'verified'}],
          totals:{amount:100,count:1,carbs:19.9,fat:1,protein:5,kcal:100}}},food.getRevision());
        GPApp.open('approved-low');
    }""")
    frame.locator('#ispadBox').wait_for()
    assert frame.locator('#heroGlucose').inner_text() == '3,0'
    assert 'Синтетическая справка ISPAD' in frame.locator('#ispadJuice').inner_text()
    assert frame.locator('#zoneRed').get_attribute('class').endswith('selected')
    synthetic = state()
    frame.locator('#calcProduct').select_option(index=1)
    frame.locator('#juiceNumber').fill('75')
    assert frame.locator('#journal').is_enabled()
    frame.locator('#calculate').click()
    assert frame.locator('#resultMl').inner_text() == 'Расчёт недоступен'
    assert frame.locator('#chart path').count() == 0 and state() == synthetic

    page.once('dialog', lambda dialog: dialog.dismiss())
    frame.locator('#journal').click()
    assert state() == synthetic
    prompts = []

    def confirm(dialog):
        prompts.append(dialog.message)
        dialog.accept()

    page.once('dialog', confirm)
    frame.locator('#journal').click()
    assert len(prompts) == 1 and '75 г' in prompts[0]
    assert frame.locator('#journal').is_disabled()
    saved = state()
    assert saved['revision'] == synthetic['revision'] + 1
    completed = [row for row in saved['mealSessions'] if row['status'] == 'completed']
    assert len(completed) == 1 and len(saved['events']) == 0
    assert completed[0]['actualPlate']['items'][0]['amount'] == 75
    assert completed[0]['actualPlate']['totals']['carbs'] == 14.925
    assert completed[0]['actualPlate']['items'][0]['glycemicIndex'] == 49
    assert frame.locator('#juiceNumber').input_value() == ''
    page.evaluate("GPApp.open('approved-journal')")
    journal = page.frame_locator('#iframeApprovedJournal')
    journal.get_by_text('Синтетическая гречка', exact=False).first.wait_for()
    assert '75 г' in journal.locator('tbody').inner_text()
    page.screenshot(path=output / 'low-confirmed-in-journal.png')
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    assert state() == saved
    page.evaluate("GPApp.open('system')")
    page.locator('#modeLocal').click()
    assert state() == empty
    page.evaluate("GPApp.open('approved-low')")
    assert frame.locator('#heroGlucose').inner_text() == '—'
    assert frame.locator('#calcProduct option').count() == 7
    assert 'Яблоко' in frame.locator('#calcProduct').inner_text()
    assert 'Синтетическая гречка' not in frame.locator('#calcProduct').inner_text()
    assert not errors, errors
    return {'status': 'PASS', 'widths': [320, 390, 428, 1280], 'safe_empty_model': True,
            'synthetic_low_remains_visible_without_history': True,
            'cancelled': True, 'fact': {'id': completed[0]['id'], 'grams': 75, 'carbs': 14.925, 'gi': 49},
            'reload': True, 'separate_mode': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    output = parser.parse_args().output
    output.mkdir(parents=True, exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=web)) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as engine:
                browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True, headless=True)
                try:
                    result = run(browser, f'http://127.0.0.1:{server.server_port}', output)
                finally:
                    browser.close()
        finally:
            server.shutdown()
    report = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    (output / 'report.json').write_text(report, encoding='utf-8')
    print(report, end='')


if __name__ == '__main__':
    main()
