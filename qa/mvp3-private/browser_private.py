"""Test the packaged multi-file UI with a mocked SQLite transport on loopback."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Thread
import mimetypes
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright


def verify(apk, scope, browser):
    with ZipFile(apk) as package:
        seed = package.read('assets/bootstrap/journal.json').decode()
        state = json.loads(seed)
        assert bool(state.get('privateHistory')) == (scope == 'research')
        web = {name.removeprefix('assets/www/'): package.read(name)
               for name in package.namelist() if name.startswith('assets/www/') and not name.endswith('/')}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            key = str(PurePosixPath(self.path.split('?', 1)[0])).lstrip('/')
            if key not in web:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(key)[0] or 'application/octet-stream')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(web[key])

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            page = browser.new_page(viewport={'width':390,'height':850})
            origin = 'http://127.0.0.1:' + str(server.server_port)
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            init = '''(() => {
              if (location.pathname !== '/index.html' || window.self !== window.top) return;
              let disk=null, imports=0;
              const seed=SEED, scope=SCOPE;
              const reply=(code,raw)=>JSON.stringify(raw===null?{ok:true,code}:
                 {ok:true,code,data:raw,revision:JSON.parse(raw).revision});
              window.GFNativeStorage={
                seedScope:()=>scope, readPrivateSeed:()=>reply('FOUND',seed),
                readSnapshot:()=>reply(disk===null?'ABSENT':'FOUND',disk),
                importIfAbsent(_key,data){
                  if(disk!==null)return reply('EXISTS',null);
                  disk=data;imports++;return reply('IMPORTED',null);
                },
                writeIfRevision(_key,data,rev){
                  if(JSON.parse(disk).revision!==rev)return JSON.stringify({ok:false,code:'STALE'});
                  disk=data;return reply('SAVED',data);
                },
              };
              window.__nativeImports=()=>imports;
            })();'''
            page.add_init_script(init.replace('SEED',json.dumps(seed,ensure_ascii=False)).replace('SCOPE',json.dumps(scope)))
            page.goto(origin+'/index.html', timeout=90000)
            page.wait_for_function('()=>Boolean(window.GPApp?.getStorage())', timeout=90000)
            assert page.evaluate('window.__nativeImports()') == 1
            assert page.evaluate('''()=>{
              const state=GPApp.getStorage().exportState();
              const snapshot=JSON.parse(GFNativeStorage.readSnapshot('GFV2SHELL_DATA_v1_local'));
              return snapshot.revision===state.revision && snapshot.data===JSON.stringify(state);
            }''')
            assert page.evaluate('GPApp.getStorage().exportState().events.length') == len(state['events'])
            assert page.evaluate('''expected=>{
              const snapshot=GPApp.getStorage().exportState();
              return ['displayName','birthDate','timeZone'].every(k=>snapshot.profile[k]===expected.profile[k]) &&
                JSON.stringify(snapshot.measurements)===JSON.stringify(expected.measurements);
            }''', {'profile':state['profile'],'measurements':state['measurements']})
            expect(page.locator('#homeGlucose')).to_have_text('—')
            page.evaluate("GPApp.open('approved-journal')")
            frame = page.frame_locator('#iframeApprovedJournal')
            expect(frame.locator('#date')).to_be_visible()
            if scope == 'research':
                page.evaluate("GPApp.open('system')")
                assert page.locator('#exportState').evaluate('(node)=>node.hidden')
                assert page.locator('#backupControls').evaluate('(node)=>node.hidden')
                page.evaluate("GPApp.open('analytics')")
                expect(page.locator('#qaReplaySummary summary')).to_be_visible()
                page.locator('#qaReplaySummary summary').click()
                expect(page.locator('#qaReplaySummary')).to_contain_text('эталонный интервал')
                page.evaluate("GPApp.open('cgm')")
                expect(page.locator('#archiveCgmDay')).to_be_visible()
                page.locator('#archiveCgmDay').fill(page.locator('#archiveCgmDay').get_attribute('max'))
                expect(page.locator('#cgmDetailChart')).to_contain_text('Историческое окно.')
                assert page.locator('#cgmDetailChart [data-cgm-point]').count() > 1
            else:
                assert not page.locator('#archiveCgmDay').count()
                assert not page.locator('#qaReplaySummary').count()
            page.close()
            return {'scope':scope,'status':'PASS','transport':'mocked native bridge',
                    'real_android':'separate acceptance'}
        finally:
            server.shutdown()
            thread.join()


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--main',type=Path,required=True)
    cli.add_argument('--research',type=Path,required=True)
    args=cli.parse_args()
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True)
        report=[verify(apk,scope,browser) for apk,scope in [(args.main,'main'),(args.research,'research')]]
        browser.close()
    print(json.dumps({'environment':'BROWSER_MULTI_FILE','variants':report},indent=2))


if __name__=='__main__':
    main()
