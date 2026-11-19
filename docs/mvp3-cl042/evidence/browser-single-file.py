"""Serve independently generated original files one at a time via loopback."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import sys
from playwright.sync_api import sync_playwright

root=Path(sys.argv[1]).resolve()/'android-mvp3/app/src/main/assets/www/approved'
files={
    'GFNutrition_v0.4.6_LIVE.html':'catalogSearch',
    'GFJournal_v0.1.2_3COL_CANDIDATE.html':'tbody',
    'GFSettings_v0.1.4_LIVE.html':None,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):
        pass

    def do_GET(self):
        if self.path[1:] not in files:
            self.send_error(404)
            return
        body=(root/self.path[1:]).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=UTF-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)


result={}
with ThreadingHTTPServer(('127.0.0.1',0),Handler) as server, sync_playwright() as engine:
    Thread(target=server.serve_forever,daemon=True).start()
    browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
    origin=f'http://127.0.0.1:{server.server_port}'
    try:
        for name,marker in files.items():
            checks=[]
            for width in [320,390,428,1280]:
                page=browser.new_page(viewport={'width':width,'height':880})
                errors=[]
                page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(origin+'/'+name,wait_until='load')
                if marker:
                    assert page.locator('#'+marker).count()==1
                assert page.title() and not errors,(name,width,errors)
                checks.append(width)
                page.close()
            result[name]=checks
    finally:
        browser.close()
        server.shutdown()
print(json.dumps({'status':'PASS','origin':'loopback single-document','file_uri':'ENV_BLOCKED_BY_BROWSER_POLICY',
    'widths':result},ensure_ascii=False,indent=2))
