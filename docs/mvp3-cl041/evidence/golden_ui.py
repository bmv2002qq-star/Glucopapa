"""Compare the same locked-time PNGs on the baseline and current calculational routes."""
from datetime import datetime, timezone
from functools import partial
from http.server import ThreadingHTTPServer
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import sys
from threading import Thread

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


class LockedClockBrowser:
    def __init__(self, browser):
        self.browser = browser

    def new_page(self, **kwargs):
        page = self.browser.new_page(**kwargs)
        instant = datetime(2026,11,19,12,0,tzinfo=timezone.utc)
        page.clock.set_fixed_time(instant)
        return page


def capture(browser, repo, output):
    output.mkdir(parents=True, exist_ok=True)
    spec=spec_from_file_location('calculators',repo/'qa/mvp3-calculators/browser.py')
    module=module_from_spec(spec)
    spec.loader.exec_module(module)
    web=repo/'android-mvp3/app/src/main/assets/www'
    with ThreadingHTTPServer(('127.0.0.1',0),partial(module.LocalHandler,directory=web)) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            module.verify(LockedClockBrowser(browser),f'http://127.0.0.1:{server.server_port}',output)
        finally:
            server.shutdown()


baseline, candidate, output=map(Path,sys.argv[1:])
with sync_playwright() as engine:
    browser=engine.chromium.launch(executable_path='/usr/bin/chromium',chromium_sandbox=True,headless=True)
    try:
        capture(browser,baseline,output/'baseline')
        capture(browser,candidate,output/'candidate')
    finally:
        browser.close()
results={}
for image in sorted((output/'baseline').glob('*.png')):
    before=Image.open(image).convert('RGB')
    after=Image.open(output/'candidate'/image.name).convert('RGB')
    results[image.name]=before.size==after.size and ImageChops.difference(before,after).getbbox() is None
assert len(results)==3 and all(results.values()),results
(output/'golden-ui.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
