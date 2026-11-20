"""Verify calculation disclosures and blockers on the real loopback web shell."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


class LocalHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def verify(browser, origin, artifact):
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    exceptions = []
    page.on('pageerror', lambda error: exceptions.append(str(error)))
    page.goto(origin + '/index.html', wait_until='load')
    page.wait_for_function('window.GPApp?.getStorage()')
    assert page.evaluate('GPApp.mode()') == 'local'
    evidence = []
    for width in (320, 390, 428, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        before = page.evaluate('GPApp.getStorage().diagnostics().revision')
        page.evaluate("GPApp.open('approved-meal')")
        panel = page.frame_locator('#iframeApprovedMeal')
        panel.locator('#doseExplain').get_by_text('Сначала соберите',exact=False).wait_for()
        assert panel.locator('details').get_attribute('open') is None
        panel.locator('summary').click()
        for code in ['CGM_SOURCE_UNKNOWN', 'JOURNAL_COVERAGE_UNKNOWN', 'FOOD_COVERAGE_MISSING', 'PLATE_MISSING']:
            assert panel.locator('[data-code="' + code + '"]').is_visible(), code
        trace = panel.locator('[data-calc-trace]').inner_text()
        assert f'GFStorage · ревизия {before}' in trace
        assert 'IOB РинФаста · неизвестно' in trace and 'NO_CONFIRMED_MEALS_IN_WINDOW' in trace
        assert 'INPUT_READ_FAILED' not in trace
        assert page.evaluate('GPApp.getStorage().diagnostics().revision') == before
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        if width == 390:
            page.screenshot(path=artifact / 'meal-390.png')
        panel.locator('summary').click()
        evidence.append({'route': 'approved-meal', 'width': width, 'revision': before, 'reasons_in_details': 'PASS'})
    page.evaluate("GPApp.open('approved-nutrition')")
    frame = page.frame_locator('#iframeApprovedNutrition')
    frame.locator('#catalogSearch').fill('гречка')
    frame.locator('#productCards button.food-main').first.click()
    frame.locator('#portionAmount').fill('75')
    frame.locator('#addToPlate').click()
    page.locator('#approvedSavePlate').click()
    page.locator('#approvedPlateStatus').get_by_text('План питания сохранён.', exact=False).wait_for()
    page.evaluate("GPApp.open('approved-meal')")
    panel = page.frame_locator('#iframeApprovedMeal')
    panel.locator('#minutesChosen').wait_for()
    assert panel.locator('[data-code="PLATE_MISSING"]').count() == 0
    panel.locator('summary').click()
    assert 'Тарелка · план' in panel.locator('[data-calc-trace]').inner_text()
    assert page.evaluate('GPApp.getStorage().exportState().mealSessions[0].actualPlate') is None
    assert not exceptions, exceptions
    evidence.append({'route': 'approved-nutrition', 'meal_plan_revision': 'PASS', 'confirmed_food_created': False})
    return {'status': 'PASS', 'checks': evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1', 0), partial(LocalHandler, directory=web)) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with sync_playwright() as engine:
                browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True, headless=True)
                try:
                    findings = verify(browser, 'http://127.0.0.1:' + str(server.server_port), args.output)
                finally:
                    browser.close()
        finally:
            server.shutdown()
    (args.output / 'calculators-browser.json').write_text(json.dumps(findings, indent=2) + '\n')
    print(f'PASS {len(findings["checks"])} browser checks')


if __name__ == '__main__':
    main()
