"""Cross-check the on-device synthetic meal from the test-only WebView scenario."""
import json
from pathlib import Path
import shutil
import sys
import tempfile

from sqlite_smoke import DB_NAME, DEMO_KEY, Emulator, inspect_database, require


def main():
    adb, serial, evidence = sys.argv[1:]
    output = Path(evidence)
    emulator = Emulator(adb, serial, 'GlucoPapaMvp3CiQa')
    emulator.check_avd()
    log = (output / 'native-web.log').read_text(encoding='utf-8')
    line = next(row for row in log.splitlines() if row.startswith('INSTRUMENTATION_RESULT: webview='))
    web = json.loads(line.split('=', 1)[1])

    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        if not emulator.pid():
            emulator.start()
        before, first_pid = emulator.capture(folder / 'before')
        emulator.start()
        after, second_pid = emulator.capture(folder / 'after')
        require(first_pid != second_pid and before == after, 'Meal snapshot changed after restart')
        require(set(after) == {DEMO_KEY}, 'Synthetic test data escaped into local mode')
        state = after[DEMO_KEY]
        require(state['revision'] == web['corrected']['revision'], 'Native and WebView revisions differ')
        require(len(state['mealSessions']) == 1 and len(state['events']) == 1, 'Expected one meal and one injection')
        meal = state['mealSessions'][0]
        row = meal['actualPlate']['items'][0]
        require(row['amount'] == 50 and row['glycemicIndex'] == 49 and
                abs(meal['actualPlate']['totals']['carbs'] - 9.95) < 1e-8, 'Unexpected SQLite food fixture')
        require(meal['plannedPlate']['items'][0]['amount'] == 100, 'Meal correction changed the plan')
        for phase in ['before', 'after']:
            shutil.copyfile(folder / phase / 'screen.png', output / f'food-{phase}.png')

    (output / 'native-meal.json').write_text(json.dumps({
        'status': 'PASS', 'fixture': 'SYNTHETIC', 'database': DB_NAME, 'same_after_restart': True,
        'meal_count': 1, 'revision': state['revision'], 'actual': web['actual'], 'corrected': web['corrected'],
    }, indent=2) + '\n', encoding='utf-8')
    print('PASS native SQLite meal and correction across restart')


if __name__ == '__main__':
    main()
