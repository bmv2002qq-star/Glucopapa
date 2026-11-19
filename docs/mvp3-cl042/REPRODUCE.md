# Повторение CL‑042.1

Использовать SHA из checkpoint-cl042.json. Команды выполняются из корня QA-ветки. Требуется Node.js 24, Python 3, Playwright и установленный Chromium. Все фикстуры вымышленные.

```sh
export CL042_OUTPUT=../cl042-evidence
mkdir -p "$CL042_OUTPUT"
sha256sum -c --quiet qa/mvp3-android/android-source.sha256
python3 qa/mvp3-full/integrity.py
node --test --test-reporter=tap qa/*/*.test.cjs > "$CL042_OUTPUT/node.tap"
GLUCOPAPA_QA_SOURCE="$PWD" node --test docs/mvp3-cl041/evidence/*.test.cjs > "$CL042_OUTPUT/supplemental.tap"
node qa/mvp3-cl042/context-acceptance.cjs
node docs/mvp3-cl042/evidence/mutation-acceptance.cjs
python3 docs/mvp3-cl042/evidence/browser-single-file.py "$PWD"
python3 docs/mvp3-cl042/evidence/approved-golden.py "$PWD" "$CL042_OUTPUT/approved-ui"
python3 qa/mvp3-full/browser_modules.py --output "$CL042_OUTPUT/modules"
python3 qa/mvp3-calculators/browser.py --output "$CL042_OUTPUT/calculators"
python3 qa/mvp3-cl042/browser.py --output "$CL042_OUTPUT/settings"
python3 qa/mvp3-cl042/browser-acceptance.py --output "$CL042_OUTPUT/catalog-trace"
python3 docs/mvp3-cl041/evidence/browser_context.py "$PWD" "$CL042_OUTPUT/context"
python3 docs/mvp3-cl041/evidence/browser_graph.py "$PWD" "$CL042_OUTPUT/graph"
node qa/mvp3-calculators/stress.cjs "$CL042_OUTPUT"
node qa/mvp3-calculators/physio-stress.cjs "$CL042_OUTPUT"
node docs/mvp3-cl041/evidence/physio-72h.cjs "$PWD" "$CL042_OUTPUT"
(cd android-mvp3 && gradle --offline -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:assembleDebugAndroidTest)
python3 qa/mvp3-full/integrity.py --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk
```

Для воспроизведения архивных формул передать путь к распакованному входному пакету с подпапками nested и deep. Скрипт сверяет SHA исполняемых оригиналов. GFxDrip исполняется только в собственной архивной папке по GPL‑3.0.

```sh
node qa/mvp3-cl042/archive-numerics.cjs "$CL042_INTAKE_ROOT"
node docs/mvp3-cl042/evidence/replay-food-audit.cjs \
  "$PWD/android-mvp3/app/src/main/assets/www" "$GF_REPLAYLAB_STAGE11_ROOT" --full-replay
```

Для Android нужны JDK 17, Gradle 8.13, SDK 36, Build Tools 35 и эмуляторы API 31/34/35/36. Сценарий находится в .github/workflows/mvp3-android-sqlite.yml. CI устанавливает отдельный тестовый APK и проверяет запуск, сохранение, прерывание транзакции, восстановление и чтение настройки после остановки процесса на AVD с синтетическими данными.
