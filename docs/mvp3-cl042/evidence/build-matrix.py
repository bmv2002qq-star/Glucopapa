"""Bind CL-040 test cases to the exact CL-042 acceptance evidence."""
from collections import Counter
from pathlib import Path
import csv
import json

ROOT=Path('docs/mvp3-cl042')
EVIDENCE=ROOT/'evidence'
original=Path('docs/mvp3-cl041/TEST_MATRIX.csv')
with original.open(encoding='utf-8-sig',newline='') as fi:
    rows=list(csv.DictReader(fi))
assert len(rows)==123 and len({row['id'] for row in rows})==123
summary=json.loads((EVIDENCE/'android/status.json').read_text())
sha=summary['sourceCommit']
core=summary['api35core']
extended=summary['api35extended']
stock=summary['api31']
a11y=summary['api31Accessibility']
passes={}
def close(id,evidence,command,actual):
    passes[id]=(evidence,command,actual)

close('CGM-05','evidence/ui/cl042/browser-cl042.json','python3 qa/mvp3-cl042/browser.py --output OUTPUT',
      'При новых показаниях поля 0,5 ЕД и 75 г сохранили ввод. Неподтверждённых фактов нет. Старая кривая снята с текущего графика; архив тот же.')
close('IOB-07','evidence/supplemental.tap','GLUCOPAPA_QA_SOURCE="$PWD" node --test docs/mvp3-cl041/evidence/iob.test.cjs',
      'Отдельная мутация дозы на 0,5 ЕД изменила только соответствующий вклад. Проверка протокола и независимой квадратуры.')
close('FOOD-01','evidence/apk-assets.json; evidence/ui/supplement/browser-acceptance.json','python3 qa/mvp3-cl042/browser-acceptance.py --output OUTPUT',
      'SHA исходной v0.4.6 совпал. Открыли каталог, отметили избранное, проверили фильтр, ГИ, модальное окно и 75 г в плане на четырёх ширинах.')
for id,result in {
    'FOOD-05':'Неизвестный ГИ, неизвестное количество, противоречивый состав и незавершённая сессия дают отдельные причины. Доступность не подменяется нулём.',
    'FOOD-07':'Смена только времени порции A на 30 мин сдвинула её нижний и верхний вклад по независимой формуле. Порция B совпала целиком.',
    'BASAL-02':'Четыре чередующиеся фактические инъекции сохранены отдельно. Левемир даёт свой модельный остаток; быстрый IOB равен нулю.',
    'ACT-06':'Контекст сохраняет окончание и фактические 30 мин. Проверки 0/30/120/360 мин после спорта, включая смену даты. Численных поправок нет.',
    'ILL-01':'Сохранение ручного значения и периода проверено в Chromium и GFStorage. Источник user_input, исходное время и история читаются.',
    'ILL-04':'Активный период без коэффициента даёт null. NaN, отрицательное значение и пересечение отвергнуты. На границах читается корректная версия.'}.items():
    close(id,'evidence/context-acceptance.json; evidence/ui/context.log; evidence/node.tap',
          'node qa/mvp3-cl042/context-acceptance.cjs',result)
close('LOG-06','evidence/ui/supplement/browser-acceptance.json','python3 qa/mvp3-cl042/browser-acceptance.py --output OUTPUT',
      'Chromium: 10 000 render/scroll, 0 сообщений на границе нативного логгера; отдельно 10 осмысленных запусков дали 10 записей, ревизия неизменна.')
close('E2E-02','evidence/node.tap; qa/mvp3-cl042/forecast.test.cjs','node --test qa/mvp3-cl042/forecast.test.cjs',
      'Смена CGM, еды, укола, спорта, болезни и ФЧИ на разных ревизиях во время выдачи прогноза даёт REVISION_CHANGED. Гибрид не записан.')
close('E2E-09','evidence/mutation-acceptance.json','node docs/mvp3-cl042/evidence/mutation-acceptance.cjs',
      'Шесть изолированных мутаций выявлены: знак, mg/dL, сетка времени, COB, IOB, пропущенный факт. Оригинал повторно прошёл.')
if core=='PASS':
    close('HIGH-04','evidence/android/api35/smoke.log; evidence/android/api35/checks/result.json',
          'bash qa/mvp3-android/run-on-emulator.sh (API 35)',
          'Подтверждённые 0,5 ЕД с местом и временем остаются одним фактом SQLite после повторной отправки и запуска приложения.')
if extended=='PASS':
    close('EXP-03','evidence/android/api35-extended/native-trace-export.log','bash qa/mvp3-android/run-on-emulator.sh (API 35 extended)',
          'Шестимесячная синтетическая выгрузка на 53 004 точки CGM и обычные записи. Подробный след ограничен свежими слотами.')
overrides={
    'FOOD-06':('BLOCKED','CL042-TAU / CL042-LINEAR-POINT',
        'Единое хранение выбора, аудит, перезапуск и неизменность исторических рядов проверены. Не хватает определения плавного профиля и точечного вклада линейной модели.'),
    'BASAL-04':('NOT_RUN','CL042-BASAL-SCHEDULE',
        'Проверены рост/снижение, поздняя еда и пропуски CGM. Полный сценарий пропущенной/задержанной плановой инъекции требует сопоставления с действующим расписанием; в обзоре нет такого классификатора.'),
    'ACT-04':('BLOCKED','CL042-CONTEXT',
        'Отсутствие дополнительной поправки и чтение настройки проверены. Исходного правила применения обычного/высокого уровня в расчётах не найдено.'),
    'LOW-03':('BLOCKED','CL042-LOW',
        'Исходное ядро пересчитало 30/40/50/60 мл в исследовательской фикстуре; UI интегрированного LOW ещё не может рассчитать подтверждённый сценарий на общем снимке.'),
    'LOW-07':('NOT_RUN','CL042-LOW-TO-FACT',
        'Сценарий фактической тарелки и повторов проверен через план/факт на синтетике. Полный подтверждённый путь именно из вычислителя LOW не принят.'),
    'HIGH-02':('BLOCKED','CL042-HIGH',
        'Изолированный HIGH-F1 различил вычисленный 0 и пропуск IOB. У общего HIGH нет полной формулы, необходимой для проверки вывода 0 ЕД на его экране.'),
    'MEAL-03':('NOT_RUN','CL041-MEAL-CANCEL',
        'План, частичный факт, исправление и единый аудит повторены. Отмену после подтверждения отдельным методом не проверяли.'),
    'MEAL-06':('BLOCKED','CL042-MEAL',
        'Справочная арифметика сохраняет точность. Шаг строгого HIGH-F1 имеет отдельные тесты; утверждённое правило округления итогового расчёта под еду отсутствует.'),
    'LOG-03':('NOT_RUN','CL042-TRACE-RENAME',
        'Проверено восстановление из .new и отказ на повреждении. Остановка процесса в момент файлового rename отдельно не воспроизведена.'),
    'LOG-04':('NOT_RUN','CL042-TRACE-MIXED-RACE',
        'Нативная серия 100 append и пограничная ротация проверены отдельно. Одновременный импорт CGM, вычисления и ротация в одной серии требуют отдельной фикстуры.'),
    'LOG-07':('NOT_RUN','CL042-TRACE-IO-BASELINE',
        'Получены нативные тайминги SQLite и размеры трасс. Контролируемое сравнение задержки I/O при включённом и выключенном логгере не выполнено.'),
    'EXP-06':('NOT_RUN','CL042-EXPORT-RACE',
        'Экспорт и защита ревизий проверены отдельно. Одновременные ротация лога и смена ревизии на границе чтения не воспроизведены.'),
    'EXP-07':('NOT_RUN','CL041-SAF-DISK-INTERRUPT',
        'Отмена в DocumentsUI и force-stop при ожидающем экспорте проверены. Не выполнены заполнение диска и обрыв в процессе записи файла.'),
    'GRAPH-05':('NOT_RUN','CL042-GRAPH-ORIENTATION',
        'Пустые и устаревшие показания и ширины проверены. Единый сценарий с поворотом устройства и NaN при смене графика остался открытым.'),
    'E2E-03':('NOT_RUN','CL042-FULL-CHAIN-RESTART',
        'Kill/restart во время SQLite и проверки дневника/экспорта проведены отдельно. Сквозной прогон с фактической едой, рассчитанными вкладами, аварией и ротацией требует отдельной фикстуры.'),
    'E2E-08':('NOT_RUN','CL042-STRESS-TRACE-SCOPE',
        '10 000 из 10 000 детерминированных синтетических расчётных сценариев пройдены. Перебор ротации, нативной конкуренции и нехватки ресурса в этом же наборе не выполнялся.'),
    'E2E-11':('BLOCKED','CL041-FINAL-GATE',
        'Общая регрессия доступной части на финальном SHA выполнена. Приёмка всех 123 критериев требует закрытия указанных блокировок и неполных проверок.'),
}
native={'ST-05','ST-06','LOG-01','LOG-02','LOG-08','LOG-09','EXP-01','EXP-02','EXP-04','EXP-05','EXP-08','EXP-09','EXP-10','E2E-06'}
need_extended={'LOG-01','LOG-02','LOG-08','LOG-09','EXP-01','EXP-02','EXP-04','EXP-05','EXP-08','EXP-09','EXP-10'}
sources=lambda rows: rows.replace('evidence/final-node.tap','evidence/node.tap')     .replace('evidence/browser-calculators/','evidence/ui/calculators/').replace('evidence/browser-calculators.log','evidence/ui/calculators.log')     .replace('evidence/browser-graph.log','evidence/ui/graph.log').replace('evidence/browser-context.log','evidence/ui/context.log')     .replace('evidence/browser-review.log','evidence/ui/review.log').replace('evidence/final-integrity.json','evidence/apk-assets.json')     .replace('evidence/github/','evidence/android/').replace('evidence/iob.tap','evidence/supplemental.tap')     .replace('FORMULA_INVENTORY.md','FORMULA_PASSPORTS.md').replace('AUDIT_CL041.md','FORMULA_GAPS.md')     .replace('BASAL_SYNTHETIC_REVIEW.md','FORMULA_PASSPORTS.md').replace('CONTRACT_MATRIX.md','MODEL_CONTRACTS.md')     .replace('evidence/protected-sha256.log','evidence/apk-assets.json').replace('evidence/golden-ui.log','evidence/apk-assets.json')
for row in rows:
    id=row['id']
    row.update(sha=sha,baselineStatus=row['status'],evidence=sources(row['evidence']))
    if id in passes:
        evidence,command,actual=passes[id]
        row.update(status='PASS',evidence=evidence,command=command,actual=actual,defectId='')
        continue
    if id in overrides:
        status,defect,actual=overrides[id]
        row.update(status=status,actual=actual,defectId=defect)
    if id in {'FOOD-06','LOW-03','HIGH-02','MEAL-06'}:
        row['evidence']='evidence/node.tap; evidence/archive-numerics.json; FORMULA_GAPS.md'
    if id=='E2E-08':
        row['evidence']='evidence/stress.log; evidence/android/; STRESS_REPORT.md'
    if id=='E2E-03' or id.startswith('LOG-') or id.startswith('EXP-'):
        row['evidence']=row['evidence'] or 'evidence/android/'
    if row['defectId']=='CL041-XDRIP-LICENSE':
        row['actual']='GFxDrip v0.1.0 найден, отдельно прошёл 44/44. Пакет GPL‑3.0 и отдельный legacy IOB/COB. Рабочий третий ряд пока отсутствует.'
        row['evidence']='evidence/baseline/archive-xdrip.log; FORMULA_GAPS.md; evidence/node.tap'
    if row['defectId']=='CL041-THREE-ENGINE-CONSENSUS':
        row['actual']='Пересчёт и отображение проверены на синтетических входных рядах. Для рабочего сравнения нужен третий совместимый движок и последующие наблюдения.'
    if row['defectId']=='CL040-CALC-FORMULAS':
        model=id.split('-')[0]
        row['actual']=f'Исходная арифметика {model} проверена отдельно. Полный контракт общей модели указан в FORMULA_GAPS.md. В рабочем контуре показывается причина недоступности.'
        row['evidence']+='; evidence/archive-numerics.json; FORMULA_GAPS.md'
    if id in native:
        if (id in need_extended and extended!='PASS') or (id=='E2E-06' and (stock!='PASS' or extended!='PASS' or a11y!='PASS')) or (id in {'ST-05','ST-06'} and core!='PASS'):
            row.update(status='BLOCKED',defectId='CL042-ANDROID-ENV',actual='Требуемый нативный сценарий отсутствует в полном финальном прогоне. Подробности в ANDROID_QA_REPORT.md.')
    if id=='E2E-06':
        row['evidence']='evidence/ui/approved-golden.json; evidence/android/api31/native-touch.log; evidence/android/api35-extended/android-gui.json'
        row['command']='python3 docs/mvp3-cl042/evidence/approved-golden.py "$PWD" OUTPUT; Android Actions'
        if row['status']=='PASS':
            row['actual']='Четыре исходных экрана совпали по пикселям на 390 px. Нативные размеры, клавиатура и маршруты проверены; Android 12 подтвердил касания и дерево доступности.'
        else:
            row['actual']='Совпали пиксели исходных экранов, размерности, касания и навигация. Эмулятор Android 12 не представил дерево доступности.'
    if row['status']!='PASS' and not row['evidence']:
        row['evidence']='FORMULA_GAPS.md; BUGS.md'
out=ROOT/'TEST_MATRIX.csv'
with out.open('w',encoding='utf-8-sig',newline='') as fi:
    w=csv.DictWriter(fi,fieldnames=rows[0].keys(),lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
c=dict(Counter(row['status'] for row in rows)); assert sum(c.values())==123
(ROOT/'matrix-summary.json').write_text(json.dumps({'testedSha':sha,'criteria':123,'counts':c},indent=2)+'\n')
print(c)
