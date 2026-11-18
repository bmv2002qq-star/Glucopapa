"""Synthetic-only WebView and SQLite smoke test for a fresh Android AVD."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time


PACKAGE = 'com.glucopapa.shell'
ACTIVITY = f'{PACKAGE}/.MainActivity'
DB_NAME = 'gfstorage_v5.db'
DEMO_KEY = 'GFV2SHELL_DATA_v1_demo'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def inspect_database(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as database:
        require(database.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'SQLite quick_check failed')
        version, = database.execute('PRAGMA user_version').fetchone()
        require(version == 1, f'Unexpected native SQLite version: {version}')
        rows = {}
        for key, revision, data in database.execute('SELECT mode_key, revision, data FROM snapshots'):
            value = json.loads(data)
            require(value['schemaVersion'] == 5 and value['revision'] == revision,
                    f'GFStorage revision/schema mismatch in {key}')
            rows[key] = value
        return rows


def injection_in(rows):
    require(set(rows) == {DEMO_KEY}, 'Expected a single persisted test-mode snapshot')
    snapshot = rows[DEMO_KEY]
    events = snapshot['events']
    require(snapshot['revision'] == 1 and len(events) == 1 and len(snapshot['history']) == 1,
            'Expected one factual record, one audit entry and one revision')
    event, = events
    require(event['status'] == 'confirmed' and event['type'] == 'insulin_injection' and
            event['insulinId'] == 'rinfast' and event['units'] == 0.5 and
            event.get('injectionSite', {}).get('region') == 'abdomen',
            'Stored record differs from the synthetic fixture')
    audit, = snapshot['history']
    require(audit['recordId'] == event['id'] and audit['revision'] == 1 and
            audit['actor'] == 'actionWriter' and audit['action'] == 'injection',
            'Stored audit entry does not identify the confirmed action')
    return {'eventId': event['id'], 'administeredAt': event['administeredAt'],
            'revision': snapshot['revision']}


class Emulator:
    def __init__(self, adb, serial, avd):
        require(re.fullmatch(r'emulator-\d+', serial), 'Use a specific emulator-N serial')
        self.prefix = [adb, '-s', serial]
        self.avd = avd

    def execute(self, *command, timeout=30, check=True):
        result = subprocess.run(self.prefix + list(command), capture_output=True, timeout=timeout)
        if check and result.returncode:
            detail = (result.stderr or result.stdout).decode(errors='replace').strip()
            raise RuntimeError(f'adb {command[0]} failed: {detail}')
        return result

    def text(self, *command, **kwargs):
        return self.execute(*command, **kwargs).stdout.decode(errors='replace').strip()

    def check_avd(self):
        require(self.text('get-state') == 'device', 'ADB target is unavailable')
        require('1' in {self.text('shell', 'getprop', name) for name in ('ro.kernel.qemu', 'ro.boot.qemu')},
                'Android target is not reporting itself as an emulator')
        names = self.text('emu', 'avd', 'name').splitlines()
        require(names and names[0].strip() == self.avd, f'Expected the disposable AVD {self.avd}')
        require(self.text('shell', 'getprop', 'sys.boot_completed') == '1', 'AVD did not complete boot')
        require(self.text('shell', 'am', 'get-current-user') == '0', 'Use the owner of a fresh AVD')

    def check_fresh(self):
        packages = self.text('shell', 'pm', 'list', 'packages', '--user', '0', PACKAGE).splitlines()
        require(f'package:{PACKAGE}' not in packages, 'App already exists on this AVD. Use a separate fresh AVD.')

    def install(self, apk):
        require('Success' in self.text('install', str(apk), timeout=180), 'APK installation did not report Success')

    def start(self):
        result = self.text('shell', 'am', 'start', '-W', '-n', ACTIVITY, timeout=90)
        require('Status: ok' in result.splitlines(), f'App did not start: {result}')
        require(self.pid(), 'App has no running process after am start')
        return result

    def pid(self):
        result = self.execute('shell', 'pidof', PACKAGE, check=False)
        require(not result.stderr and result.returncode in (0, 1), 'Could not check application process')
        return result.stdout.decode().strip()

    def stop(self):
        previous = self.pid()
        require(previous, 'App process ended unexpectedly before the stop')
        self.execute('shell', 'am', 'force-stop', PACKAGE)
        for _ in range(20):
            if not self.pid():
                return previous
            time.sleep(0.25)
        raise RuntimeError('Android app process did not stop')

    def capture(self, directory):
        directory.mkdir(exist_ok=False)
        shot = self.execute('exec-out', 'screencap', '-p').stdout
        require(shot.startswith(b'\x89PNG\r\n\x1a\n'), 'Emulator screenshot is not PNG')
        (directory / 'screen.png').write_bytes(shot)
        stopped_pid = self.stop()
        available = self.text('shell', 'run-as', PACKAGE, 'ls', '-1', 'databases').splitlines()
        require(DB_NAME in available, 'Native SQLite file is absent for the debug application')
        for name in (DB_NAME, f'{DB_NAME}-wal', f'{DB_NAME}-shm', f'{DB_NAME}-journal'):
            if name in available:
                copy = self.execute('exec-out', 'run-as', PACKAGE, 'cat', f'databases/{name}').stdout
                (directory / name).write_bytes(copy)
        return inspect_database(directory / DB_NAME), stopped_pid


def prompt(message):
    print('\n' + message, flush=True)
    require(input('Нажмите Enter после проверки или Ctrl+C для остановки. ').strip() == '',
            'Оператор остановил проверку')


def run(args):
    apk = args.apk.resolve(strict=True)
    require(apk.is_file(), 'APK path must be a local file')
    emulator = Emulator(args.adb, args.serial, args.avd)
    emulator.check_avd()
    emulator.check_fresh()
    args.output.mkdir(parents=True, exist_ok=False)
    ui = None
    if args.automated:
        from ci_ui import CandidateUI
        ui = CandidateUI(emulator, args.output)
    outcome = {
        'status': 'INCOMPLETE', 'fixture': 'SYNTHETIC_ONLY', 'apk_sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
        'serial': args.serial, 'avd': args.avd, 'checks': [],
        'android_device': 'NOT_TESTED', 'real_xdrip': 'NOT_TESTED', 'clinical': 'NOT_VALIDATED',
    }
    try:
        outcome['android_api'] = emulator.text('shell', 'getprop', 'ro.build.version.sdk')
        (args.output / 'webview.txt').write_text(emulator.text('shell', 'dumpsys', 'webviewupdate'), encoding='utf-8')
        emulator.install(apk)
        emulator.start()
        if ui:
            ui.home()
        else:
            prompt('Убедитесь, что главная открылась в режиме «Тестовые данные».')
        baseline, baseline_pid = emulator.capture(args.output / '01_initial')
        require(not baseline, 'A fresh database already contains a snapshot')
        outcome['checks'].append({'initial_empty_store': True, 'stopped_pid': baseline_pid})

        emulator.start()
        if ui:
            ui.injection(confirmed=False)
        else:
            prompt('Откройте HIGH, затем «Записать выполненный укол». '
                   'Введите тестовый факт РинФаст 0,5 ЕД, место «Живот». '
                   'Нажмите сохранить с пустым флажком подтверждения.')
        unconfirmed, unconfirmed_pid = emulator.capture(args.output / '02_unconfirmed')
        require(unconfirmed == baseline, 'Unconfirmed input changed SQLite')
        outcome['checks'].append({'unconfirmed_injection_no_write': True, 'stopped_pid': unconfirmed_pid})

        emulator.start()
        if ui:
            ui.injection(confirmed=True)
        else:
            prompt('Введите ту же синтетическую запись, явно отметьте подтверждение и сохраните один раз. '
                   'Проверьте появление записи на экране инъекций.')
        committed, committed_pid = emulator.capture(args.output / '03_committed')
        outcome['checks'].append({'confirmed_injection_sqlite': injection_in(committed), 'stopped_pid': committed_pid})

        restart = emulator.start()
        if ui:
            ui.home()
            ui.wait(captions=('База #1',))
        else:
            prompt('После повторного запуска проверьте, что главная показывает ревизию базы #1.')
        restored, restored_pid = emulator.capture(args.output / '04_restarted')
        require(restored == committed, 'SQLite snapshot changed across force-stop and relaunch')
        require(injection_in(restored) == injection_in(committed), 'Confirmed event differs after relaunch')
        outcome['checks'].append({'force_stop_relaunch_same_snapshot': True, 'start': restart, 'stopped_pid': restored_pid})
        emulator.start()
        if ui:
            ui.journal()
        else:
            prompt('Откройте «Дневник» и проверьте ту же запись.')
        outcome['checks'].append({'confirmed_injection_visible_in_journal': True})
        outcome['status'] = 'PASS'
        print('PASS Android emulator UI and native SQLite smoke')
    except Exception as error:
        outcome['status'] = 'FAIL'
        outcome['error'] = str(error)
        try:
            failure_screen = emulator.execute('exec-out', 'screencap', '-p', timeout=8, check=False)
            if failure_screen.stdout.startswith(b'\x89PNG\r\n\x1a\n'):
                failure_dir = args.output / 'failure'
                failure_dir.mkdir(exist_ok=True)
                (failure_dir / 'screen.png').write_bytes(failure_screen.stdout)
        except (OSError, subprocess.TimeoutExpired):
            pass
        raise
    finally:
        (args.output / 'result.json').write_text(json.dumps(outcome, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--automated', action='store_true', help='Drive the UI through ADB accessibility')
    parser.add_argument('--adb', default='adb', help='Android SDK platform-tools adb')
    parser.add_argument('--serial', required=True, help='Emulator serial, for example emulator-5554')
    parser.add_argument('--avd', required=True, help='Exact fresh AVD name as reported by adb emu avd name')
    parser.add_argument('--apk', required=True, type=Path, help='Local debug APK')
    parser.add_argument('--output', required=True, type=Path, help='New directory for synthetic evidence')
    try:
        run(parser.parse_args())
    except (OSError, RuntimeError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
