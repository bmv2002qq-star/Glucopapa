# Воспроизведение MVP3 QA

Команды выполняются из корня QA-ветки. Наборы используют только синтетические данные и исходные виртуальные профили.

```bash
sha256sum -c qa/mvp3-android/android-source.sha256
python3 qa/mvp3-full/integrity.py
node --test qa/mvp3-full/*.test.cjs
python3 qa/mvp3-full/browser_modules.py --output qa-evidence/browser
```

Для Chromium нужен Python Playwright и Chromium с работающей песочницей. Для независимого пересоздания DOP853-эталонов используется SciPy. Запускайте генератор в отдельный файл и сравнивайте числа с сохранённой версией.

```bash
python3 qa/mvp3-full/physio_reference.py \
  android-mvp3/app/src/main/assets/www/modules/GFPhysioProfiles_v0.2.0/gfphysio_profiles_data_v0.2.0.js \
  /tmp/glucopapa-physio-checkpoints.json
```

Тестовый instrumentation APK запускается на отдельном AVD после UI smoke. Проверка 1 000 нативных CAS-записей использует отдельную временную SQLite. Проверка питания использует обычный WebView и SQLite тестового режима. Сценарий с прерванной транзакцией удерживает внешний тестовый SQLite transaction открытым после подготовленной записи. Production APK не содержит instrumentation или его fixture JS.

Тесты 276 исходных Node-сценариев и исполняемые стенды Chromium хранятся в архиве `source-P1-P5.zip` с SHA-256 `10c3c8fb24faf0f07b658ea087770d906f4921801bd6422915b4c084f981ebfb`. Они выполняются из `ПРОГРАММА` в архиве. Обычная команда Node — `node --test tests/*.cjs`. Multi-file Chromium запускается через `python3 tests/browser_mvp3_multifile.py`.
