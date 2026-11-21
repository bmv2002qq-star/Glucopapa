"""Exercise the 29 module cards, routes, and read-only guarantees on real loopback HTTP."""
import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run(browser, origin, output, legacy=False):
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    if legacy:
        page.add_init_script('delete Object.hasOwn; delete Array.prototype.at;')
    errors = []
    urls = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: urls.append(request.url))
    page.add_init_script(path=Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/fixture/assets/www/qa-shell.js')
    page.goto(origin + '/index.html')
    page.wait_for_function('globalThis.GPApp && globalThis.GPModuleDirectory')
    assert page.evaluate('GPApp.mode()') == 'local'
    assert not page.locator('#banner').is_visible()
    assert page.locator('#syntheticCgmTools').evaluate('(node) => node.hidden')
    initial = page.evaluate('GPApp.getStorage().exportState()')
    assert initial['schemaVersion'] == 5
    metadata = page.evaluate('GPModuleDirectory.list()')
    assert len(metadata) == len({module['id'] for module in metadata}) == 29
    versions = {module['id']: module['version'] for module in metadata}
    assert 'LOW v0.4.0' in versions['low']
    assert 'HIGH v0.1.4' in versions['high']
    assert 'v0.1.1' in versions['injection-analytics'] and 'v0.2.1' in versions['injection-analytics']
    assert versions['shell'] == page.evaluate('GPApp.version')
    assert versions['storage'] == page.evaluate('`v${GFStorage.VERSION} / schema ${GFStorage.SCHEMA_VERSION}`')
    assert next(module['route'] for module in metadata if module['id'] == 'mealcalc') == 'approved-meal'
    page.locator('#nav [data-screen="meals"]').click()
    page.locator('#screen-approved-nutrition').get_by_role('button', name='План / факт еды').click()
    assert page.locator('#screen-approved-meal.active').is_visible()
    results = []
    for module in metadata:
        module_id = module['id']
        page.locator('#nav [data-screen="modules"]').click()
        card = page.locator(f'[data-module-id="{module_id}"].directory-card')
        assert card.is_visible() and module['title'] in card.inner_text(), module_id
        previous = page.locator('.screen.active').get_attribute('id')
        page.evaluate('(id) => GPModuleDirectory.open(id + "-unknown-qa")', module_id)
        assert page.locator('.screen.active').get_attribute('id') == previous, module_id
        card.locator(f'[data-module-action="open"][data-module-id="{module_id}"]').click()
        target = module['route'] or 'module-detail'
        assert page.locator('#screen-' + target + '.active').is_visible(), module_id
        if not module['route']:
            assert page.locator('#directoryTitle').inner_text() == module['title'], module_id
            assert not page.locator('#directoryLaunch').is_visible(), module_id
        assert page.evaluate('GPApp.getStorage().exportState()') == initial, module_id
        results.append({
            'id': module_id, 'version': module['version'], 'integration': module['integration'],
            'route': module['route'], 'card': 'PASS', 'unrecognized_route': 'PASS',
            'navigation_without_mutation': 'PASS',
        })

    page.evaluate("""async () => {
        const messages = [
            {type:'gp:profile',role:'settings',patch:{timeZone:'UTC'}},
            {type:'gp:measurement',role:'settings',record:{}},
            {type:'gp:plate',role:'nutrition',plate:{}},
        ];
        for (const data of messages) {
            await new Promise(resolve => {
                window.addEventListener('message', resolve, {once:true});
                window.postMessage(data, location.origin);
            });
        }
    }""")
    assert page.evaluate('GPApp.getStorage().exportState()') == initial
    assert not any(url.startswith(('http:', 'https:')) and not url.startswith(origin + '/') for url in urls)
    assert not errors, errors
    exact_frames = sorted(page.locator('iframe').evaluate_all('(frames) => frames.map(frame => frame.getAttribute("src"))'))
    assert exact_frames == [
        'approved/GFJournal_v0.1.2_3COL_CANDIDATE.html',
        'approved/GFNutrition_v0.4.6_LIVE.html',
        'approved/GFSettings_v0.1.4_LIVE.html',
        'integration/approved_routes/GFHighTarget_v0.1.3_VIEW.html',
        'integration/approved_routes/GFMealCalc_v0.3.0_VIEW.html',
        'integration/approved_routes/LOW_v0.2_VIEW.html',
    ]
    assert page.locator('#iframeHighTarget').get_attribute('sandbox') == 'allow-same-origin'
    assert page.locator('#iframeLowTarget').get_attribute('sandbox') == 'allow-same-origin'
    assert page.locator('#iframeApprovedMeal').get_attribute('sandbox') == 'allow-same-origin'
    for width in (320, 390, 428, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        page.locator('#nav [data-screen="home"]').click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.locator('#nav button').evaluate_all('''buttons => buttons.every(button => {
            const label = button.lastElementChild;
            const text = document.createRange();
            text.selectNodeContents(label);
            const bounds = button.getBoundingClientRect();
            return [...text.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1);
        })'''), f'Navigation label extends outside its button at {width}px'
        for button in ('openLow', 'openHigh'):
            page.locator('#' + button).click()
            assert not page.locator('.screen.active #calcDose, .screen.active #calcFood').count()
            page.locator('#nav [data-screen="home"]').click()
        page.locator('#nav [data-screen="journal"]').click()
        diary = page.frame_locator('#iframeApprovedJournal')
        assert diary.locator('thead th').count() == 3
        diary.locator('.top').wait_for(state='hidden')
        assert diary.locator('#timezone').evaluate('node => node.getBoundingClientRect().top >= node.ownerDocument.querySelector(".tablewrap").getBoundingClientRect().bottom')
        page.screenshot(path=output / f'journal-{width}.png')
    page.evaluate("GPApp.open('system')")
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('#modeDemo').click()
    assert page.evaluate('GPApp.mode()') == 'demo' and page.locator('#banner').is_visible()
    assert page.evaluate('GPApp.getStorage().exportState()') == initial
    page.locator('#modeLocal').click()
    assert page.evaluate('GPApp.mode()') == 'local' and page.evaluate('GPApp.getStorage().exportState()') == initial
    return {'modules': results, 'fresh_local_no_synthetic': 'PASS', 'frames': exact_frames, 'wrong_source': 'PASS', 'viewport_widths': [320, 390, 428, 1280]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--legacy', action='store_true', help='Remove APIs missing in the stock WebView before startup')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(web)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as engine:
            browser = engine.chromium.launch(executable_path=args.chromium, chromium_sandbox=True, headless=True)
            try:
                report = run(browser, 'http://127.0.0.1:' + str(server.server_port), args.output, args.legacy)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    (args.output / 'modules-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('PASS 29 module cards, routing guards, origin and 4 widths')


if __name__ == '__main__':
    main()
