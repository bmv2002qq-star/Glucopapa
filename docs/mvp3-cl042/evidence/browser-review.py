"""Load the exact working tree on loopback and verify the new read-only screens."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread
from playwright.sync_api import sync_playwright

class LocalFileHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

web = Path(sys.argv[1]) / 'android-mvp3/app/src/main/assets/www'
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
with ThreadingHTTPServer(('127.0.0.1', 0), partial(LocalFileHandler, directory=web)) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    with sync_playwright() as engine:
        browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True, headless=True)
        page = browser.new_page(viewport={'width':390, 'height':900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + '/index.html')
        page.wait_for_function('window.GPApp?.getStorage()')
        page.evaluate("GPApp.open('insulin-models')")
        page.locator('#runBasalReview').click()
        assert 'TIMEZONE_UNKNOWN' in page.locator('#basalReviewStatus').inner_text()
        page.evaluate("GPApp.open('settings')")
        page.locator('#settingsTZ').select_option('UTC')
        page.locator('#settingsForm button[type=submit]').click()
        initial = page.evaluate('GPApp.getStorage().exportState()')
        assert initial['profile']['timeZone'] == 'UTC'
        assert page.locator('#aiExportControls').get_attribute('hidden') is not None
        for width in (320,390,428,1280):
            page.set_viewport_size({'width':width,'height':900})
            page.evaluate("GPApp.open('insulin-models')")
            button = page.locator('#runBasalReview')
            for days in ('3','7','14'):
                page.locator('#basalReviewPeriod').select_option(days)
                assert 'по нажатию' in page.locator('#basalReviewStatus').inner_text()
                button.click()
                assert 'Расчёт дозы недоступен' in page.locator('#basalReviewStatus').inner_text(), (page.locator('#basalReviewStatus').inner_text(), errors, page.locator('#toast').all_text_contents())
                assert 'Пригодных окон 0' in page.locator('#basalReviewTrace').text_content()
                assert page.evaluate('GPApp.getStorage().exportState()') == initial
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if width == 390:
                page.locator('#basalReviewDetails summary').click()
                page.screenshot(path=output / 'basal-observation-390.png')
        page.reload()
        page.wait_for_function('window.GPApp?.getStorage()')
        page.evaluate("GPApp.open('insulin-models')")
        assert 'по нажатию' in page.locator('#basalReviewStatus').inner_text()
        page.evaluate("GPApp.open('analytics')")
        page.locator('#runConsensusReview').click()
        assert 'данных для лидера недостаточно' in page.locator('#consensusReviewStatus').inner_text()
        assert page.evaluate('GPApp.getStorage().exportState()') == initial
        assert not errors, errors
        page.screenshot(path=output / 'consensus-no-leader.png')
        print(json.dumps({'origin':'LOOPBACK_HTTP','basal_manual_only':True,'basal_periods':[3,7,14],
                          'consensus_real_empty_state':'NO_LEADER','source_unchanged':True,'page_errors':len(errors),
                          'viewport_widths':[320,390,428,1280],'android_saf':'NOT_TESTED'},ensure_ascii=False))
        native = browser.new_page(viewport={'width':390,'height':900})
        native.add_init_script('''
          window.qaCalls=[];
          window.AndroidExporter={
            saveAiExport(mode,period){window.qaCalls.push([mode,period]);},
            takeFileResult(){return JSON.stringify({aiExport:true,status:'FILE_CANCELLED'});}
          };
        ''')
        native.goto(origin + '/index.html')
        native.wait_for_function('window.GPApp?.getStorage()')
        native.evaluate("GPApp.open('system')")
        assert native.locator('#aiExportControls').is_visible()
        for period in ('1d','2d','5d','1m','3m','6m'):
            native.locator('#aiExportPeriod').select_option(period)
            native.locator('#saveAiExport').click()
            assert native.locator('#saveAiExport').is_disabled()
            native.evaluate('GPApp.consumeFileResult()')
            assert native.locator('#saveAiExport').is_enabled()
        assert native.evaluate('window.qaCalls') == [['local',p] for p in ('1d','2d','5d','1m','3m','6m')]
        print(json.dumps({'six_period_controls':'PASS','cancel_feedback':'PASS','bridge':'STUB_FOR_UI_ONLY'}))
        browser.close()
    server.shutdown()
