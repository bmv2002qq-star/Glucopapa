"""Check the production history controls with an isolated synthetic bridge in Chromium."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


# Only this test supplies bridge replies. The APK calls the native bridge.
SYNTHETIC_BRIDGE = """
(() => {
    const key='history-test-anchor';
    const ts=Number(sessionStorage.getItem(key)) || (Date.now()-300000);
    sessionStorage.setItem(key,String(ts));
    window.qaProviderActive=false;
    window.qaHistoryActive=false;
    window.qaHistoryRequests=0;
    const latest=()=>JSON.stringify(window.qaProviderActive?{
      status:'MEASUREMENT',measuredAtMs:ts,receivedAtMs:Date.now(),mgdl:108.09354,
      direction:'FortyFiveDown',stale:false
    }:{status:'NO_PROVIDER'});
    window.GFNativeXDrip={peekLatest:latest,pollLatest:latest};
    window.GFNativeXDripHistory={
      request(){
        window.qaHistoryRequests++;
        return JSON.stringify({status:window.qaProviderActive?'HISTORY_FETCHING':'HISTORY_NEEDS_PROVIDER'});
      },
      take(){
        return window.qaHistoryActive?JSON.stringify({
          status:'HISTORY_READY',anchorTs:ts,anchorSgv:108,receivedAtMs:Date.now(),
          items:[{measuredAtMs:ts-300000,mgdl:104,direction:'Flat'}]
        }):null;
      }
    };
})();
"""


def exercise(browser, origin, output):
    plain = browser.new_page()
    plain.goto(origin + '/index.html')
    plain.evaluate("GPApp.open('cgm')")
    expect(plain.locator('#xdripControls')).to_be_hidden()
    plain.close()

    page = browser.new_page(viewport={'width': 390, 'height': 880})
    errors, outgoing = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: outgoing.append(request.url))
    page.add_init_script(SYNTHETIC_BRIDGE)
    page.goto(origin + '/index.html')
    page.evaluate("GPApp.open('cgm')")
    snapshot = lambda: page.evaluate('GPApp.getStorage().exportState()')
    restore = page.locator('#restoreXdripHistory')
    status = page.locator('#xdripHistoryStatus')
    enable = page.locator('#xdripEnabled')
    expect(restore).to_be_visible()
    expect(restore).to_be_disabled()
    enable.check()
    restore.click()
    expect(status).to_contain_text('ContentProvider')
    assert snapshot()['revision'] == 0
    page.evaluate('window.qaProviderActive=true')
    restore.click()
    expect(status).to_contain_text('Получаем историю')
    assert snapshot()['revision'] == 1
    enable.uncheck()
    expect(status).to_contain_text('прерван')
    page.evaluate('window.qaHistoryActive=true')
    expect(restore).to_be_disabled()
    assert snapshot()['revision'] == 1
    enable.check()
    restore.click()
    expect(status).to_contain_text('Добавлено точек истории: 1')
    before = snapshot()
    assert before['revision'] == 2 and len(before['cgm']) == 2
    assert before['cgm'][0]['transport'] == 'xdrip_loopback_history'
    assert before['cgm'][1]['mgdl'] == 108.09354
    assert page.evaluate("GPApp.getStorage().connect('calculator').read('cgm').length") == 1
    restore.click()
    expect(status).to_contain_text('уже есть все')
    assert snapshot() == before
    assert page.evaluate("""async () => {
      const snapshot=GPApp.getStorage().exportState();
      const backup=await GFJournalBackup.create('local',snapshot,GFStorage);
      const verified=await GFJournalBackup.verify(backup,'local',GFStorage);
      return JSON.stringify(verified.snapshot) === JSON.stringify(snapshot);
    }""")
    page.screenshot(path=output / 'cgm-history-synthetic.png', full_page=True)
    page.reload()
    assert snapshot() == before
    assert all(url.startswith(origin + '/') for url in outgoing) and not errors, errors
    return dict(status='PASS', fixture='SYNTHETIC_BRIDGE', browser_without_native_hidden=True,
                no_provider=True, opt_out_during_request=True, history_import=True,
                idempotent=True, backup_roundtrip=True, local_reload=True, actual_network=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    web = Path(__file__).resolve().parents[2] / 'android-mvp3/app/src/main/assets/www'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=web))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as engine:
            browser = engine.chromium.launch(executable_path='/usr/bin/chromium', chromium_sandbox=True)
            result = exercise(browser, f'http://127.0.0.1:{server.server_port}', args.output)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    result_text = json.dumps(result, indent=2) + '\n'
    (args.output / 'report.json').write_text(result_text, encoding='utf-8')
    print(result_text, end='')


if __name__ == '__main__':
    main()
