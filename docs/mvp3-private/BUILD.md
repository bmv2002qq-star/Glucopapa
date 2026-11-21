# Воспроизведение двух приватных APK

Нужны JDK 17, Gradle 8.13, Android SDK Platform 36 и Build Tools 35.0.0. Запускайте сборку с файлами профиля и архива в приватном каталоге вне checkout. Имена полей профиля перечислены в `build_seeds.cjs`. Экспорт CSV и резервная SQLite обрабатываются локально. Скрипт импорта читает резервную базу только для сверки.

```bash
umask 077
python3 qa/mvp3-private/import_xdrip_archive.py \
  --primary "$PRIVATE_PRIMARY" --control "$PRIVATE_CONTROL" --previous "$PRIVATE_PREVIOUS" \
  --sqlite "$PRIVATE_SQLITE" --notes "$PRIVATE_SPEC" --zone "$JOURNAL_TIME_ZONE" \
  --start "$JOURNAL_START" --out "$PRIVATE_DIR/archive.json"
node qa/mvp3-private/build_seeds.cjs \
  "$PRIVATE_DIR/profile.json" "$PRIVATE_DIR/archive.json" "$PRIVATE_DIR/seeds"
(
  cd android-mvp3
  gradle --no-daemon \
    -PglucopapaMainSeed="$PRIVATE_DIR/seeds/main.json" \
    -PglucopapaResearchSeed="$PRIVATE_DIR/seeds/research.json" \
    :app:assemblePrivateMain :app:assemblePrivateResearch
)
```

Обычная `assembleDebug` собирается без персонального посева. `privateMain` использует пакет `com.glucopapa.shell` и базу `gfstorage_v5.db`. `privateResearch` использует пакет `com.glucopapa.shell.qa` и базу `gfstorage_research_v5.db`. Обе версии используют одну реализацию GFStorage схемы 5. Результат зависит от ключа подписи, сверяйте его перед обновлением установленного APK.

Для приёмки выбранного приватного APK вызовите `qa/mvp3-full/integrity.py --apk … --private-seed …` и `apksigner verify --verbose --print-certs …`. Для изолированного эмулятора отдельно соберите `:app:assemblePrivateMainAndroidTest` и `:app:assemblePrivateResearchAndroidTest`. В каждом запуске задайте `-PglucopapaTestTarget` как `privateMain` или `privateResearch` соответственно и передайте указанные выше пути к двум посевам. Затем запустите `qa/mvp3-private/run-installed.sh` с `ANDROID_HOME`, `GLUCOPAPA_QA_EMULATOR`, `GLUCOPAPA_QA_AVD` и новым приватным `EVIDENCE`. Сценарий проверяет чистый первый запуск и последующее восстановление на эмуляторе. Тот же instrumentation runner принимает `-e phase private-store -e step first` и `-e step reopened` при `-e fixture PRIVATE_LOCAL`. Этот сценарий сохраняет стартовый снимок в изолированной нативной SQLite и проверяет целостность без WebView.

`qa/mvp3-private/browser_private.py --main … --research …` проверяет многофайловый интерфейс из точных APK. Браузерный тест использует замену нативного транспорта. Отдельные команды `node --test qa/mvp3-private/*.test.cjs` и `node qa/mvp3-private/replay.cjs` используют вымышленные данные.
