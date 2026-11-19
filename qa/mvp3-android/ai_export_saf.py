"""Exercise actual ACTION_CREATE_DOCUMENT and verify files exposed by Android."""
from calendar import monthrange
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import sqlite3
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

from ci_ui import BOUNDS, CandidateUI, label
from sqlite_smoke import DEMO_KEY, Emulator, require

AVD = 'GlucoPapaMvp3CiQa'
RUNNER = 'com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation'
PERIODS = ('1d', '2d', '5d', '1m', '3m', '6m')
BASE_NAME = 'Glucopapa_AI_Export'


def files(emulator):
    output = emulator.text('shell', 'find', '/sdcard/Download', '/sdcard/Documents',
                           '-type', 'f', check=False)
    paths = [line for line in output.splitlines() if PurePosixPath(line).name.startswith(BASE_NAME)]
    # DocumentsUI versions differ in where they insert duplicate-name suffixes.
    result = {}
    with tempfile.TemporaryDirectory() as temporary:
        local = Path(temporary) / 'snapshot.jsonl'
        for path in paths:
            emulator.execute('pull', path, str(local))
            result[path] = local.read_bytes()
            local.unlink()
    return result


def wait_for_picker(emulator, process):
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


def read_export(source, path, period, snapshot):
    lines = source.splitlines(keepends=True)
    require(len(lines) >= 3 and source.endswith(b'\n'), 'Expected complete JSONL')
    payload = [json.loads(line) for line in lines]
    first, last = payload[0], payload[-1]
    require(first['type'] == 'manifest' and last['type'] == 'footer', 'Manifest or footer missing')
    require(first['period'] == period and first['mode'] == 'demo', 'Export changed period or mode')
    require(first['sourceRevision'] == snapshot['revision'], 'Incorrect durable revision')
    through=datetime.fromisoformat(first['through'])
    zone=timezone.utc if first['timezone']=='Z' else ZoneInfo(first['timezone'])
    local=through.astimezone(zone)
    count=int(period[:-1])
    if period.endswith('d'):
        expected=local-timedelta(days=count)
    else:
        months=local.year*12+local.month-1-count
        year, month=divmod(months,12)
        expected=local.replace(year=year,month=month+1,day=min(local.day,monthrange(year,month+1)[1]))
    first_at=datetime.fromisoformat(first['from'])
    require(first_at == expected and all(first_at <= datetime.fromisoformat(row['at']) <= through
                                        for row in payload[1:-1]), 'Incorrect calendar bounds')
    measured = hashlib.sha256(b''.join(lines[:-1])).hexdigest()
    require(last['sha256'] == measured, 'Wrong JSONL digest')
    events = [row for row in payload[1:-1] if row['type'] == 'event']
    require(any(row['subtype'] == 'injection' and row['units'] == 0.5 for row in events), 'Known injection missing')
    require(all('sourceDeviceId' not in row and 'displayName' not in row for row in payload), 'Unexpected identifiers')
    return {'file': PurePosixPath(path).name, 'revision': first['sourceRevision'], 'rows': len(lines)-2,
            'sha256': measured, 'bytes': len(source), 'from': first['from'], 'through': first['through']}


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
            existing = files(emulator)
            args = emulator.prefix + ['shell','am','instrument','-w','-r','-e','fixture','SYNTHETIC',
                                       '-e','phase','stock','-e','step',f'ai-export:{period}:{outcome}',RUNNER]
            log = output / f'ai-saf-{period}-{outcome}.log'
            with log.open('wb') as trace:
                runner = subprocess.Popen(args, stdout=trace, stderr=subprocess.STDOUT)
                try:
                    wait_for_picker(emulator, runner)
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
            present = files(emulator)
            changed = {path for path, data in present.items() if existing.get(path) != data}
            if outcome == 'cancel':
                require(present == existing, 'Cancellation changed an export file')
                results['cancel'] = 'PASS'
            else:
                require(len(changed) == 1, f'Expected one new JSONL for {period}; before={sorted(existing)}, after={sorted(present)}')
                path, = changed
                if period == '1d':
                    require(PurePosixPath(path).name == BASE_NAME + '.jsonl', 'Incorrect suggested export filename')
                results[period] = read_export(present[path],path,period,before[DEMO_KEY])
        if emulator.pid():
            emulator.stop()
        after = emulator.read_persisted(folder / 'after')
        require(after == before, 'System file operations changed SQLite')
        with closing(sqlite3.connect((folder/'after/gfstorage_v5.db').resolve().as_uri()+'?mode=ro',uri=True)) as database:
            require(database.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity_check failed')
    (output / 'ai-saf.json').write_text(json.dumps({'status':'PASS','fixture':'SYNTHETIC','sqliteUnchanged':True,
        'picker':'ANDROID_DOCUMENTS_UI','cases':results}, indent=2) + '\n')
    print('PASS Android DocumentsUI cancellation and six saved JSONL periods')


if __name__ == '__main__':
    main()
