"""Verify recovered context on normal multi-file WebView assets served over loopback."""
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread

from playwright.sync_api import sync_playwright


class ServerHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def verify(page, base, out):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.clock.install(time=datetime(2026,11,19,12,0,tzinfo=timezone.utc))
    page.goto(base + '/index.html')
    page.wait_for_function('window.GPApp?.getStorage()')
    assert page.locator('#activityChoice option').evaluate_all('(options) => options.map(x=>x.value)') == ['low','usual','high','sport']
    for choice in ('low','usual','high'):
        page.locator('#activityChoice').select_option(choice)
        assert page.evaluate('GPApp.getStorage().exportState().profile.activityBaseLevel') == choice
    page.locator('#activityChoice').select_option('sport')
    assert page.locator('#sportStart').is_visible() and not page.locator('#sportFinish').is_visible()
    page.locator('#sportStart').click()
    assert page.locator('#sportFinish').is_visible()
    page.locator('#activityChoice').select_option('usual')
    assert page.locator('#activityChoice').input_value() == 'sport'
    page.clock.fast_forward(30*60_000)
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    assert page.locator('#activityChoice').input_value() == 'sport'
    assert page.locator('#sportFinish').is_visible()
    page.locator('#sportFinish').click()
    assert page.locator('#activityChoice').input_value() == 'high'
    sport = page.evaluate("GPApp.getStorage().exportState().conditionPeriods.filter(p=>p.kind==='sport')")
    assert len(sport)==1 and sport[0]['end'] is not None
    page.evaluate("GPApp.open('journal')")
    table = page.frame_locator('#iframeApprovedJournal').locator('tbody')
    table.get_by_text('Спорт', exact=False).first.wait_for()
    assert '30 мин' in table.inner_text(), table.inner_text()
    page.screenshot(path=out/'sport-in-journal.png')

    page.evaluate("GPApp.open('approved-settings'); GFSettingsPanel.refresh()")
    page.locator('#gfIllnessFactor').fill('1.2')
    page.locator('#gfIllnessFactorSave').click()
    assert '1,00' in page.locator('#gfIllnessState').inner_text()
    page.locator('#gfIllnessStart').click()
    assert page.locator('#gfIllnessFinish').is_enabled()
    page.clock.fast_forward(1000)
    page.reload()
    page.wait_for_function('window.GPApp?.getStorage()')
    page.evaluate("GPApp.open('approved-settings'); GFSettingsPanel.refresh()")
    assert page.locator('#gfIllnessFactor').input_value()=='1.2'
    assert 'Болеет' in page.locator('#gfIllnessState').inner_text()
    assert page.locator('#gfIllnessFinish').is_enabled()
    page.locator('#gfIllnessFinish').click()
    assert page.locator('#gfIllnessStart').is_enabled()
    assert '1,00' in page.locator('#gfIllnessState').inner_text()
    snapshot=page.evaluate('GPApp.getStorage().exportState()')
    history=[p for p in snapshot['conditionPeriods'] if p['kind']=='illness']
    assert len(history)==1 and history[0]['end'] and snapshot['profile']['illnessFactor']['value']==1.2
    assert not errors, errors
    return {'status':'PASS','fixture':'SYNTHETIC_BROWSER_PROFILE','activity_options':['low','usual','high','sport'],
            'restored_session':True,'sport_diary_duration_minutes':30,'illness_history_restored':True,
            'illness_effective_when_off':1,'no_double_sessions':True,'revision':snapshot['revision']}


parent = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
handler = partial(ServerHandler, directory=parent/'android-mvp3/app/src/main/assets/www')
with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as engine:
        browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True, headless=True)
        try:
            result=verify(browser.new_page(viewport={'width':390,'height':850}),f'http://127.0.0.1:{server.server_port}',out)
            (out/'context-browser.json').write_text(json.dumps(result, indent=2)+'\n')
            print(json.dumps(result))
        finally:
            browser.close()
            server.shutdown()
