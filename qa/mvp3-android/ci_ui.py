"""Drive the candidate's normal Android UI on the disposable Actions AVD."""
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

from sqlite_smoke import require

UI_PATH = '/data/local/tmp/glucopapa-mvp3-qa.xml'
BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def label(node):
    return ' '.join((node.get('text', ''), node.get('content-desc', ''))).strip()


def screen_navigation(root):
    for node in root.iter('node'):
        if node.get('resource-id') == 'nav' or label(node) == 'Основные разделы':
            return node
    return None


def find_node(root, resource_id, captions, tappable=False):
    navigation = screen_navigation(root) if tappable else None
    navigation_bounds = BOUNDS.fullmatch(navigation.get('bounds', '')) if navigation is not None else None
    navigation_top = int(navigation_bounds.group(2)) if navigation_bounds else None
    navigation_nodes = set(navigation.iter('node')) if navigation is not None else set()
    candidates = []
    for node in root.iter('node'):
        match = BOUNDS.fullmatch(node.get('bounds', ''))
        if match is None or node.get('enabled') != 'true':
            continue
        left, top, right, bottom = map(int, match.groups())
        if navigation_top is not None and node not in navigation_nodes:
            bottom = min(bottom, navigation_top)
        minimum_height = 28 if tappable else 1
        if left >= right or bottom - top < minimum_height:
            continue
        node_id = node.get('resource-id', '').rsplit('/', 1)[-1]
        exact_id = resource_id and node_id == resource_id
        matches_caption = any(caption.casefold() in label(node).casefold() for caption in captions)
        if exact_id or matches_caption:
            rank = (bool(exact_id), node.get('clickable') == 'true', -(right-left)*(bottom-top))
            candidates.append((rank, node, (left, top, right, bottom)))
    if not candidates:
        return None
    _, node, bounds = max(candidates, key=lambda item: item[0])
    return node, bounds


class CandidateUI:
    def __init__(self, emulator, output):
        self.emulator = emulator
        self.output = Path(output)
        self.last_root = None

    def hierarchy(self):
        self.emulator.execute('shell', 'rm', '-f', UI_PATH)
        response = self.emulator.execute('shell', 'uiautomator', 'dump', UI_PATH, timeout=20, check=False)
        if response.returncode:
            return None
        contents = self.emulator.execute('exec-out', 'cat', UI_PATH, check=False)
        if contents.returncode or not contents.stdout:
            return None
        try:
            self.last_root = ET.fromstring(contents.stdout)
        except ET.ParseError:
            return None
        (self.output / 'ui-latest.xml').write_bytes(contents.stdout)
        return self.last_root

    def wait(self, resource_id=None, captions=(), scroll=False, tappable=False):
        end = time.monotonic() + 65
        scrolled = 0
        while time.monotonic() < end:
            try:
                root = self.hierarchy()
            except subprocess.TimeoutExpired:
                root = None
            if root is not None:
                node = find_node(root, resource_id, captions, tappable)
                if node is not None:
                    return node
                if scroll and scrolled < 4:
                    self.scroll()
                    scrolled += 1
            time.sleep(.6)
        raise RuntimeError(f'Android control unavailable: {resource_id or captions}')

    def scroll(self):
        webviews = [node for node in self.last_root.iter('node') if node.get('class') == 'android.webkit.WebView']
        if not webviews:
            return
        match = BOUNDS.fullmatch(webviews[0].get('bounds', ''))
        if not match:
            return
        left, top, right, bottom = map(int, match.groups())
        x = left + (right-left)*2//3
        start = top + (bottom-top)*3//4
        finish = top + (bottom-top)//4
        self.emulator.execute('shell', 'input', 'swipe', str(x), str(start), str(x), str(finish), '270')

    def tap(self, resource_id=None, captions=(), scroll=False):
        node, (left, top, right, bottom) = self.wait(resource_id, captions, scroll, tappable=True)
        x, y = (left+right)//2, (top+bottom)//2
        print(f'Tap {resource_id or captions} at ({x}, {y})', flush=True)
        self.emulator.execute('shell', 'input', 'tap', str(x), str(y))
        return node

    def home(self):
        self.wait('modeBadge', ('Тестовые данные',))
        require(any('Тестовые данные' in label(node) for node in self.last_root.iter('node')),
                'The app did not enter its synthetic journal')

    def injection(self, confirmed):
        self.home()
        self.scroll()
        self.tap('openHigh', ('Высокий сахар',), scroll=True)
        self.tap(captions=('Записать выполненный укол',))
        self.tap('injectionUnits', ('Фактически введено', 'Например: 0,5'))
        self.emulator.execute('shell', 'input', 'text', '0.5')
        keyboard = self.emulator.text('shell', 'dumpsys', 'input_method')
        if re.search(r'\b(?:mInputShown|mIsInputViewShown)=true', keyboard):
            self.emulator.execute('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        self.tap('injectionRegion', ('Не указано', 'Место укола'), scroll=True)
        self.tap(captions=('Живот',))
        checkbox, _ = self.wait('injectionConfirm', ('Я подтверждаю',), scroll=True, tappable=True)
        require(checkbox.get('checked') != 'true', 'A new injection must start unconfirmed')
        if confirmed:
            self.tap('injectionConfirm', ('Я подтверждаю',), scroll=True)
            checked, _ = self.wait('injectionConfirm', ('Я подтверждаю',), scroll=True, tappable=True)
            if checked.get('checkable') == 'true':
                require(checked.get('checked') == 'true', 'Confirmation was not selected')
        self.tap(captions=('Сохранить фактический укол',), scroll=True)
        if confirmed:
            self.wait(captions=('0,5 ЕД · abdomen',), scroll=True)

    def journal(self):
        self.tap(captions=('Дневник',))
        self.wait(captions=('РинФаст',), scroll=True)
        self.wait(captions=('Живот',), scroll=True)


class StockWebViewUI:
    """Use installed WebView DOM on stock Chromium 91 where accessibility drops its tree."""

    def __init__(self, emulator):
        self.emulator = emulator

    def run(self, action):
        result = self.emulator.text(
            'shell', 'am', 'instrument', '-w', '-r', '-e', 'fixture', 'SYNTHETIC',
            '-e', 'phase', 'stock', '-e', 'step', action,
            'com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation', timeout=110)
        print(result, flush=True)
        require('QA_PASS stock' in result, f'Installed stock WebView failed {action}')

    def home(self):
        self.run('home')

    def injection(self, confirmed):
        self.run('confirmed' if confirmed else 'unconfirmed')

    def wait(self, captions=()):
        require(captions == ('База #1',), 'Unexpected stock WebView selector')
        self.run('restored')

    def journal(self):
        self.run('journal')
