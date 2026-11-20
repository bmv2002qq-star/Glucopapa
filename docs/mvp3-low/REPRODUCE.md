# Повторение LOW

Использовать SHA из checkpoint-low.json. Нужны Node.js 24, Python 3, Playwright и Chromium. Для Android — JDK 17, Gradle 8.13, SDK 36, Build Tools 35.0.0 и изолированный AVD. Все сценарии синтетические.

```sh
mkdir -p ../qa-results
python3 qa/mvp3-low/derive.py --check
sha256sum -c --quiet qa/mvp3-android/android-source.sha256
python3 qa/mvp3-full/integrity.py
node --test --test-reporter=tap qa/*/*.test.cjs
GLUCOPAPA_QA_SOURCE="$PWD" node --test docs/mvp3-cl041/evidence/*.test.cjs
node qa/mvp3-low/replay.cjs
python3 qa/mvp3-low/browser.py --output ../qa-results/low
python3 qa/mvp3-high-analytics/browser.py --output ../qa-results/high-cl047
python3 qa/mvp3-full/browser_modules.py --output ../qa-results/modules
python3 qa/mvp3-cl042/browser.py --output ../qa-results/settings
python3 qa/mvp3-calculators/browser.py --output ../qa-results/meal
(cd android-mvp3 && gradle --offline -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:assembleDebugAndroidTest)
python3 qa/mvp3-full/integrity.py --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk
```

Исходные программы tests/run_all.sh повторяются в копии распакованного архива LOW. В копии tests/smoke_ui.py установлен chromium_sandbox=True. Результаты сравниваются с оригинальным архивом и новой рабочей сборкой отдельно. В основном APK отсутствует GFLOWPreviewFixture. Отдельный HTML из исходного архива запускает его для автономной синтетической проверки.

Нативный сценарий проверяет чтение LOW, отмену, одну фактическую порцию, SQLite и перезапуск. Обе проверенные порции в нативном fixture относятся к тестовому журналу. Их модельные параметры не подставляются во входы обычного приложения.

Для запущенного в CI сценария нужны SDK system-images;android-35;default;x86_64 и аппаратное ускорение KVM. После сборки тестового APK тот же изолированный AVD можно проверить командой ниже. Переменная ANDROID_HOME должна указывать на установленный SDK, avdmanager — быть доступен в PATH.

```sh
EVIDENCE="$PWD/../qa-results/api35" ANDROID_QA_API=35 ANDROID_QA_EXTENDED=true bash qa/mvp3-android/run-on-emulator.sh
```
