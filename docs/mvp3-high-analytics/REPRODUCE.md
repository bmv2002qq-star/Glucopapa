# Повторить проверки

Из корня рабочей ветки, Node.js 24, Python 3 и Chromium с Playwright.

```sh
mkdir -p ../qa-evidence
python3 qa/mvp3-high-analytics/derive_high_interface.py --check
python3 qa/mvp3-full/integrity.py
sha256sum -c --quiet qa/mvp3-android/android-source.sha256
node --test --test-reporter=tap qa/*/*.test.cjs
GLUCOPAPA_QA_SOURCE="$PWD" node --test docs/mvp3-cl041/evidence/*.test.cjs
python3 qa/mvp3-high-analytics/browser.py --output ../qa-evidence/new
python3 qa/mvp3-full/browser_modules.py --output ../qa-evidence/modules
python3 qa/mvp3-calculators/browser.py --output ../qa-evidence/calculators
python3 qa/mvp3-cl042/browser.py --output ../qa-evidence/food-model
python3 qa/mvp3-cl042/browser-acceptance.py --output ../qa-evidence/catalog
python3 docs/mvp3-cl041/evidence/browser_context.py "$PWD" ../qa-evidence/context
python3 docs/mvp3-cl041/evidence/browser_graph.py "$PWD" ../qa-evidence/graph
node docs/mvp3-cl041/evidence/physio-72h.cjs "$PWD" ../qa-evidence
```

Сторонние пакеты из вложения проверяются в отдельных каталогах. HIGH FULL_SOURCE выполняет node tests/test_core.js, node tests/test_stress.js, python tests/test_release_contract.py и python tests/test_browser_ui_v013.py. Проверку манифеста выполнить перед тестами, которые записывают результаты. В локальных копиях Python браузерных скриптов выбрать chromium_sandbox=True и установленный Chromium. HIGH VIRTUAL_QA исполняет node negative_and_fuzz.js, node virtual_physio_replay.js, node physio_substep_check.js и python browser_matrix.py. Для отдельного прогона кандидата заменить только gfhigh_target_core.js в тестовой копии VIRTUAL_QA. Утверждённый поставщиком архив остаётся источником сравнения.

Для GFInjectionAnalytics выполнить node --test test/GFInjectionAnalytics.test.cjs и node lab/virtual_lab.cjs. В копии compare_v020_v021.py заменить заданный абсолютный путь на корень распакованного модуля. Сравнение использует переданный CSV с прежними 400 результатами.

Собрать обе debug цели Gradle 8.13 с JDK 17, SDK 36 и Build Tools 35.0.0.

```sh
(cd android-mvp3 && gradle --offline -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:assembleDebugAndroidTest)
python3 qa/mvp3-full/integrity.py --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk
```

Android QA использует ветку qa/mvp3-high-analytics-20261120 и матрицу API 31/34/35/36 в .github/workflows/mvp3-android-sqlite.yml. Установленные APK, системный WebView, механизм Android подтверждения, SQLite и журналы фиксируются отдельно от тестов Chromium на ПК. Изолированный журнал эмулятора использует только синтетические записи.

Скрипт timing-history-qa.js входит только в тестовый APK. Он проверяет положительный результат CL‑047, снимок SQLite и очистку панели при смене журнала на свежем изолированном эмуляторе. При отсутствии тестового журнала или при занятом локальном хранилище сценарий останавливается. Chromium исполняет ту же синтетическую фикстуру в чистом профиле.
