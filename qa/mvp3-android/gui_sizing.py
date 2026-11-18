"""Observe installed WebView at Android screen sizes and during a bounded wall-clock soak."""
import json
import re
from pathlib import Path
import sys
import time

from ci_ui import BOUNDS, CandidateUI, screen_navigation
from sqlite_smoke import Emulator, require


def bounds(node):
    return tuple(map(int, BOUNDS.fullmatch(node.get('bounds')).groups()))


def capture(emulator, output, name):
    screen = emulator.execute('exec-out', 'screencap', '-p').stdout
    require(screen.startswith(b'\x89PNG\r\n\x1a\n'), 'Invalid screenshot')
    (output / name).write_bytes(screen)


def rss(emulator):
    meminfo = emulator.text('shell', 'dumpsys', 'meminfo', 'com.glucopapa.shell')
    match = re.search(r'TOTAL PSS:\s+(\d+)', meminfo)
    return int(match.group(1)) if match else None


def main():
    adb, serial, evidence = sys.argv[1:]
    output = Path(evidence)
    emulator = Emulator(adb, serial, 'GlucoPapaMvp3CiQa')
    emulator.check_avd()
    ui = CandidateUI(emulator, output)
    if emulator.pid():
        emulator.stop()
    results = []
    try:
        emulator.execute('shell', 'wm', 'density', '160')
        for width, height in [(320, 760), (390, 850), (428, 900), (1280, 850)]:
            emulator.execute('shell', 'wm', 'size', f'{width}x{height}')
            emulator.start()
            ui.home()
            webview = next(n for n in ui.last_root.iter('node') if n.get('class') == 'android.webkit.WebView')
            nav = screen_navigation(ui.last_root)
            require(nav is not None, f'Navigation missing at width {width}')
            bar = next((n for n in ui.last_root.iter('node')
                        if n.get('resource-id') == 'android:id/navigationBarBackground'), None)
            left, top, right, bottom = bounds(webview)
            require(0 <= left < right <= width and 0 <= top < bottom <= height, 'WebView outside window')
            safe_bottom = min(bottom, bounds(bar)[1]) if bar is not None else bottom
            items = [n for n in nav.iter('node') if n.get('class') == 'android.widget.Button']
            require(len(items) == 6 and all(bounds(n)[3] <= safe_bottom for n in items),
                    f'System bars cover navigation buttons at width {width}')
            capture(emulator, output, f'home-{width}.png')
            ui.tap(captions=('Дневник',))
            ui.wait(captions=('Дневник · кандидат',), scroll=True)
            capture(emulator, output, f'diary-{width}.png')
            results.append({'width': width, 'height': height, 'density': 160, 'navigation_safe': True})
            emulator.stop()
    finally:
        emulator.execute('shell', 'wm', 'size', 'reset')
        emulator.execute('shell', 'wm', 'density', 'reset')

    emulator.start()
    ui.home()
    pid = emulator.pid()
    start = time.monotonic()
    memory = [rss(emulator)]
    for _ in range(3):
        time.sleep(20)
        ui.tap(captions=('Дневник',))
        ui.wait(captions=('Дневник · кандидат',), scroll=True)
        ui.tap(captions=('Главная',))
        ui.home()
        require(emulator.pid() == pid, 'App process restarted during soak')
        memory.append(rss(emulator))
    data = {'fixture': 'SYNTHETIC', 'sizes': results,
            'soak_seconds': round(time.monotonic() - start, 1), 'pss_kb': memory}
    (output / 'android-gui.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    print('PASS installed WebView sizes and bounded wall-clock soak')


if __name__ == '__main__':
    main()
