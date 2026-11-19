# Повтор CL-041

Исходники зафиксированы в source-cl041.zip и GitHub. Для Node использовать v24. Chromium требует Playwright, Android использует JDK 17, Gradle 8.13, SDK 36 и Build Tools 35.0.0. QA_OUTPUT — пустой каталог синтетических доказательств. Папка CL041_ARTIFACT содержит файлы этого отчёта.

```sh
python3 qa/mvp3-full/integrity.py
sha256sum -c --quiet qa/mvp3-android/android-source.sha256
node --test --test-reporter=tap qa/mvp3-full/*.test.cjs qa/mvp3-calculators/*.test.cjs qa/mvp3-cl040/*.test.cjs qa/mvp3-cl041/*.test.cjs
GLUCOPAPA_QA_SOURCE="$PWD" node --test "$CL041_ARTIFACT"/evidence/*.test.cjs
node qa/mvp3-calculators/stress.cjs "$QA_OUTPUT"
node qa/mvp3-calculators/physio-stress.cjs "$QA_OUTPUT"
node "$CL041_ARTIFACT"/evidence/physio-72h.cjs "$PWD" "$QA_OUTPUT"
python3 qa/mvp3-full/browser_modules.py --output "$QA_OUTPUT/modules"
python3 qa/mvp3-calculators/browser.py --output "$QA_OUTPUT/calculators"
python3 "$CL041_ARTIFACT"/evidence/browser_context.py "$PWD" "$QA_OUTPUT/context"
python3 "$CL041_ARTIFACT"/evidence/browser_graph.py "$PWD" "$QA_OUTPUT/graph"
python3 "$CL041_ARTIFACT"/evidence/golden_ui.py "$CL040_SOURCE" "$PWD" "$QA_OUTPUT/golden"
(cd android-mvp3 && gradle --offline -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:assembleDebugAndroidTest)
python3 qa/mvp3-full/integrity.py --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk
```

В Actions `qa/mvp3-android/run-on-emulator.sh` проверяет отдельно API 31, 34, 35 и 36. На расширенном API 35 запускается `qa/mvp3-android/ai_export_saf.py`. У сценария есть строгая проверка отдельного виртуального устройства с именем GlucoPapaMvp3CiQa. Стенд не предназначен для реального телефона.

Архивный Replay повторяется с исходным набором GFReplayLab v0.1.0 из ЭТАП11. Путь к текущему WebView-дереву передаётся первым аргументом, путь к распакованному ЭТАП11 — вторым.

```sh
node "$CL041_ARTIFACT"/evidence/replay-food-audit.cjs "$PWD/android-mvp3/app/src/main/assets/www" "$STAGE11_ROOT" --full-replay
```
