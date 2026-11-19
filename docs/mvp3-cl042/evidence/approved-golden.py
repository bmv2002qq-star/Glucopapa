"""Compare approved standalone screens without the newly added host panels."""
from datetime import datetime,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
from threading import Thread
from PIL import Image,ImageChops
from playwright.sync_api import sync_playwright

repo=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2])
out.mkdir(parents=True,exist_ok=True)
path='android-mvp3/app/src/main/assets/www/approved'
files={
    'plate':'GFNutrition_v0.4.6_LIVE.html',
    'low-high':'GFHighLow_v5_ORIGINAL_1to1.html',
    'settings':'GFSettings_v0.1.4_LIVE.html',
    'journal':'GFJournal_v0.1.2_3COL_CANDIDATE.html',
}
payloads={}
for label,name in files.items():
    before=subprocess.check_output(['git','show',f'd54157a:{path}/{name}'],cwd=repo)
    after=(repo/path/name).read_bytes()
    assert before==after,label
    payloads[f'/baseline/{label}']=before
    payloads[f'/candidate/{label}']=after


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_):
        pass

    def do_GET(self):
        body=payloads.get(self.path)
        if body is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=UTF-8')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)


with ThreadingHTTPServer(('127.0.0.1',0),Handler) as server,sync_playwright() as engine:
    Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_port}'
    browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
    evidence={}
    try:
        for label in files:
            pictures=[]
            for kind in ['baseline','candidate']:
                page=browser.new_page(viewport={'width':390,'height':880},locale='ru-RU',timezone_id='UTC')
                page.clock.set_fixed_time(datetime(2026,11,19,12,0,tzinfo=timezone.utc))
                page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
                page.goto(f'{origin}/{kind}/{label}',wait_until='load')
                image=page.screenshot(path=out/f'{label}-{kind}.png',animations='disabled',caret='hide')
                pictures.append(Image.open(BytesIO(image)).convert('RGB'))
                page.close()
            a,b=pictures
            evidence[label]=a.size==b.size and ImageChops.difference(a,b).getbbox() is None
    finally:
        browser.close()
        server.shutdown()
assert all(evidence.values()),evidence
print(json.dumps({'status':'PASS','scope':'protected standalone screens','width':390,'pixels':evidence},indent=2))
