# Воспроизведение единого кандидата

Контрольный коммит кода и Android-испытаний — `c091860497d3bae24129ca392c0517be22f653b1`. Для проверки нужны Node 24, Python 3, Chromium с Playwright, JDK 17, Android SDK 36 и Gradle 8.13. CI использует штатные AVD x86_64. Работать с каталогом `android-mvp3` внутри того же checkout.

```bash
sha256sum --check --quiet qa/mvp3-android/android-source.sha256
node --test --test-reporter=tap qa/*/*.test.cjs
python3 qa/mvp3-unified/browser.py --output qa-output/home
python3 qa/mvp3-low/browser.py --output qa-output/low
python3 qa/mvp3-high-analytics/browser.py --output qa-output/high
python3 qa/mvp3-full/browser_modules.py --output qa-output/modules

(cd android-mvp3 && gradle --no-daemon -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:assembleFixture :app:assembleFixtureAndroidTest)
python3 qa/mvp3-full/integrity.py --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk
```

`assembleDebug` выдаёт обычный устанавливаемый APK. `assembleFixture` предназначен для лабораторных сценариев и имеет другой package ID. Для нативной контрольной проверки обычного APK собирается отдельный `test APK` с `-PglucopapaTestTarget=debug :app:assembleDebugAndroidTest`. Нативный сценарий следует запускать на одноразовом AVD. Последовательность установки, сценариев SQLite, force-stop и сбора файлов указана в [GitHub Actions](https://github.com/bmv2002qq-star/Glucopapa/blob/c091860497d3bae24129ca392c0517be22f653b1/.github/workflows/mvp3-android-device.yml).

Локальный APK и APK CI имеют разные debug-подписи. Версия кода и содержимое WebView проверяются одним списком файлов, SHA APK приводятся отдельно. Clinical, телефон и реальный xDrip+ оцениваются независимо от запуска AVD.
