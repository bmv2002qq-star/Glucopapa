"""Exercise actual ACTION_CREATE_DOCUMENT and verify files exposed by Android."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time

from ci_ui import BOUNDS, CandidateUI, label
from sqlite_smoke import DEMO_KEY, Emulator, require

AVD = 'GlucoPapaMvp3CiQa'
RUNNER = 'com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation'
PERIODS = ('1d', '2d', '5d', '1m', '3m', '6m')
EXPORTED_NAME = re.compile(r'Glucopapa_AI_Export(?: \(\d+\))?\.jsonl\Z')


def filenames(emulator):
    output = emulator.text('shell', 'find', '/sdcard/Download', '/sdcard/Documents',
                           '-type', 'f', check=False)
    return {line for line in output.splitlines() if EXPORTED_NAME.fullmatch(PurePosixPath(line).name)}


def picker_click(emulator, ui, process):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and process.poll() is None:
        top = emulator.text('shell', 'dumpsys', 'window')
        if any('documentsui' in line.lower() for line in top.splitlines() if 'mCurrentFocus' in line):
            return
        time.sleep(0.45)
    raise RuntimeError('The installed app did not open the Android document picker')


def save(emulator, ui, process):
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline and process.poll() is None:
        dom = ui.hierarchy()
        if dom is not None:
            for node in dom.iter('node'):
                package = node.get('package', '')
                selector = node.get('resource-id', '').rsplit('/', 1)[-1]
                if 'documentsui' not in package or node.get('enabled') != 'true':
                    continue
                if selector not in {'action_menu_save', 'button_save'} and label(node).strip().casefold() not in {'save', 'сохранить'}:
                    continue
                box = BOUNDS.fullmatch(node.get('bounds', ''))
                if box:
                    x1, y1, x2, y2 = map(int, box.groups())
                    if x2 > x1 and y2 > y1:
                        emulator.execute('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                        return
        time.sleep(0.45)
    raise RuntimeError('No enabled Save action in DocumentsUI')


def read_export(emulator, path, period, snapshot):
    # Use shlex.quote because adb shell joins arguments before remote parsing.
    from shlex import quote
    source = emulator.execute('exec-out', 'cat', quote(path)).stdout
    lines = source.splitlines(keepends=True)
    require(len(lines) >= 3 and source.endswith(b'\n'), 'Expected complete JSONL')
    payload = [json.loads(line) for line in lines]
    first, last = payload[0], payload[-1]
    require(first['type'] == 'manifest' and last['type'] == 'footer', 'Manifest or footer missing')
    require(first['period'] == period and first['mode'] == 'demo', 'Export changed period or mode')
    require(first['sourceRevision'] == snapshot['revision'], 'Incorrect durable revision')
    measured = hashlib.sha256(b''.join(lines[:-1])).hexdigest()
    require(last['sha256'] == measured, 'Wrong JSONL digest')
    events = [row for row in payload[1:-1] if row['type'] == 'event']
    require(any(row['subtype'] == 'injection' and row['units'] == 0.5 for row in events), 'Known injection missing')
    require(all('sourceDeviceId' not in row and 'displayName' not in row for row in payload), 'Unexpected identifiers')
    return {'file': PurePosixPath(path).name, 'revision': first['sourceRevision'], 'rows': len(lines)-2,
            'sha256': measured, 'bytes': len(source)}


def main():
    adb, serial, evidence = sys.argv[1:]
    emulator = Emulator(adb, serial, AVD)
    emulator.check_avd()
    output = Path(evidence)
    ui = CandidateUI(emulator, output)
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        if emulator.pid():
            emulator.stop()
        before = emulator.read_persisted(folder / 'before')
        require(set(before) == {DEMO_KEY} and before[DEMO_KEY]['events'], 'Expected completed synthetic journal')
        results = {}
        for period, outcome in [('6m','cancel'), *((period,'save') for period in PERIODS)]:
            existing = filenames(emulator)
            args = emulator.prefix + ['shell','am','instrument','-w','-r','-e','fixture','SYNTHETIC',
                                       '-e','phase','stock','-e','step',f'ai-export:{period}:{outcome}',RUNNER]
            log = output / f'ai-saf-{period}-{outcome}.log'
            with log.open('wb') as trace:
                runner = subprocess.Popen(args, stdout=trace, stderr=subprocess.STDOUT)
                try:
                    picker_click(emulator, ui, runner)
                    if outcome == 'cancel':
                        emulator.execute('shell','input','keyevent','KEYCODE_BACK')
                    else:
                        save(emulator, ui, runner)
                    require(runner.wait(timeout=55) == 0, 'Instrumentation command failed')
                finally:
                    if runner.poll() is None:
                        runner.kill()
                        runner.wait(timeout=10)
            result = log.read_text()
            require('QA_PASS stock' in result, result)
            created = filenames(emulator) - existing
            if outcome == 'cancel':
                require(not created, 'Cancellation created an export file')
                results['cancel'] = 'PASS'
            else:
                require(len(created) == 1, f'Expected one new JSONL, found {created}')
                path, = created
                results[period] = read_export(emulator,path,period,before[DEMO_KEY])
        if emulator.pid():
            emulator.stop()
        after = emulator.read_persisted(folder / 'after')
        require(after == before, 'System file operations changed SQLite')
    (output / 'ai-saf.json').write_text(json.dumps({'status':'PASS','fixture':'SYNTHETIC','sqliteUnchanged':True,
        'picker':'ANDROID_DOCUMENTS_UI','cases':results}, indent=2) + '\n')
    print('PASS Android DocumentsUI cancellation and six saved JSONL periods')


if __name__ == '__main__':
    main()
