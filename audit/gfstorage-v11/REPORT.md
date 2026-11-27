# ГлюкоПапа V3 · Независимый аудит GFStorage v11

27.11.2026 · этап 01 · решение по приёмке **открыто**. Q04 требует исправления и нативной регрессии перед подключением зависящих от его сохранения модулей. Изолированную разработку независимых модулей можно продолжать. Этап 02 относится к отдельной базе после интеграции.

## Ревизия и исходная регрессия

SHA v11 `d410dfabf1108e403eb12ccd7a9b564d78081502`, дерево Git `302ef57194929c8fe76031b30751279330658232`. Исходный workflow сохраняет переносимые кандидаты, проверяет чистый checkout Q10 `47ddb51fb9886bf2502b971c58845ca18e5ee1d4`, воспроизводит Q04–Q12 и GFStorage v01–v11, проверяет SHA до и после наложений. На host выполнены шаги source/host до и включая 56 по индексации с нуля. `source.sha256` фиксирует 172 файла Android source, включая SQL, grants и instrumentation. Для Android workflow устанавливает Java 17, Gradle 8.10.2 и Android Test Orchestrator.

[Исходный CI v11](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/46008687286) скомпилировался. Оригинальный архив 15203641863 прошёл SHA256 и CRC, `baseline-cases.tsv` содержит все 215 исполнений. Интегрированная часть 206/207, offline 8/8. Сверка ID без пропусков, лишних ID и дубликатов, dex/assets совпадают. В [QA v10](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/46006271333) было 203+8. Тест настроек добавлен в v11 вместе с ещё тремя очередями. Файл `v10-v11.json` подтверждает ровно четыре добавления и отсутствие удалений/дубликатов. Изменение workflow относительно v10 несёт соответствующий overlay, поэтому дерево checkout само по себе эту разницу скрывает.

Повтор Android 15 прошёл **215/215** (207 интегрированных и 8 offline). Проверен artifact 15205510367, SHA256 2dd6adc1a7128c969e5266eae8a19defa311591a5a6a10a74a47df34e5f9afb6. `api35-comparison.json` подтверждает совпадение тестовых ID и отсутствие отказов. Сравнение APK с исходным v11 показало совпадение всех 53 dex/assets entries в каждом режиме. Повторный локальный replay подтвердил все 172 SHA256. Исходный отказ воспроизведён в архивном отчёте и устраняется добавлением обязательного поля.

## Находки

| ID | Приоритет и доказательство | Ожидание, фактическое поведение и действие |
|---|---|---|
| GFV3-A01 | P1 для QA. XML, строка 47 `GfV3LegacyOwnerEpochInstrumentedTest`, и прослеженный путь к `GfV3DomainWriter.recordId` | Старый тикет получает `RESTORE_EPOCH_CHANGED`. Новый достигает writer, где в синтетическом запросе отсутствует обязательный `payload.settingChangeId`. В XML свежий запрос даёт REJECTED вместо FINISHED. Патч `settings-fixture.patch` добавляет обязательный ID, сохраняет assertions и прошёл полный нативный gate Android 15. |
| GFV3-A02 | P1 для Q04. Ранее открыт Q04-DRAFT-CONTEXT-15. Подтверждение в исходном JS и Kotlin, тест JS с подставным bridge | Черновик должен сохраняться в контексте открытия. `nutrition.html:210536` перечитывает текущую ревизию при сохранении, а `GfV3Q04NutritionDrafts.save` читает профиль уже из текущей БД. Старый массив отправлен во второй профиль в host-тесте. При restore с равной ревизией CAS тоже не отличает эпоху. Привязать сохранение к контексту открытия с проверкой профиля, ревизии и restore epoch на native. Для приёмки нужен реальный Android restore между открытием и сохранением. |
| GFV3-A03 | P2. Исходный `renderPlate()` и тест JS | Открытие и отрисовка без правок должны быть read-only. Пустая тарелка при отрисовке вызвала save, который на native может изменить ревизию и input revision, записать audit и feed черновика. Перенести сохранение в обработчики фактических изменений. Проверить устойчивую индикацию отказа при ручном вводе и отсутствие событий еды/инсулина. |
| GFV3-A04 | P2, повысить при подтверждении обычного Android-пути. `finish` Settings, Q05, Journal | Повторное завершение диалога после принятого подтверждения должно игнорироваться. JVM с кодом Settings-очереди и адаптером-заглушкой получила CANCELLED и один вызов записи. После предложенного патча очередь остаётся APPLYING, адаптер вызывается один раз. Такое же условие перехода есть в Q05 и Journal. Q07 и Q08 ограничивают отмену состоянием PENDING. Android-путь и две аналогичные очереди требуют отдельной динамической проверки. |
| GFV3-A05 | P2, статическая находка. `MainActivity.onDestroy` → `GfV3Q08OwnerQueue.close` | `awaitTermination(5, TimeUnit.SECONDS)` выполняется при уничтожении Activity на UI-потоке. При занятом worker teardown может ждать до 5 секунд. Проверить задержку с барьером в writer и вынести ожидание из UI с явным владением временем жизни SQLite helper. |
| GFV3-A06 | P2, статическая находка и host benchmark. `GfV3Storage.NativeYearSession.checked` → `GfV3YearHistory.buildOrder` | Сканирование и сортировка первого хронологического чтения идут под restore fence и SQLite-транзакцией. На host 105120 ключей построились за 677 мс. Измерить удержание блокировки под одновременной записью и restore, профилировать Android по нескольким доменам. |

| GFV3-A07 | P3, статический риск на границе backup → research. `GfV3Storage.readNativeQ10Snapshot` | SQL исключает archived, но допускает synthetic в лимит 2000. `GfV3Q10Evidence` фильтрует provenance=observed позднее. Если synthetic попадёт в аутентифицированный снимок, он может вытеснить часть observed из выборки. Обычный CGM writer synthetic отклоняет. Нужна проверка нативного сценария restore с синтетическим историческим рядом и проверка фильтра перед LIMIT. |

Предложенный патч приложения `proposed-callback.patch` хранится как файл для ревью. Автоматически в Android CI применяется только исправление тестового запроса. Q04-предложение влияет на контракт bridge и остаётся на согласовании в рамках уже открытого проектного пункта.

## Матрица владельцев и путей

`owners.tsv` содержит каталог и декларации ролей. `entrypoints.tsv` содержит строки привязки native adapters, доступов SQLite и WebView. Наличие роли в assets требует проверки registry, включения функции и конкретного read/write пути.

| Узел | Чтение и запись | Доказательство и открытая зависимость |
|---|---|---|
| M00 / Q01 | WebView читает shell settings и передаёт запрос Settings-очереди. Настройки и коэффициенты пишет native GFSettings после диалога | `GfV3Bridge`, `GfV3SettingsTrustedAdapter`, `GfV3NativeModuleGateway.BoundPort`. Сценарий повтора callback открыт |
| M01 журнал | Shell читает факты. Исправление направляется владельцу исходной записи по native resolver | `GfV3OwnerResolver`, `GfV3EditIntentQueue`, `GfV3CorrectionWriter`. Ревизия и версия записи проверяются отдельно |
| Q02 | Доверенный доступ к SQLite и файлам для снимка, staging и restore | `GfV3EncryptedSnapshot`, `GfV3BackupCodec` PBKDF2-HMAC-SHA256 / AES-GCM, локальный автоснимок через отдельный codec. Проверка manifest/schema, ATTACH, транзакция замены и FK-check. Успех restore обновляет WebView |
| Q03 / Q06 | Нормализация и чтение контекста. Численные медицинские поля в Q06 отсутствуют в регрессии host | Host regression, `GfV3Q06Bridge`, Q03 asset hashes |
| Q04 | Прямой native SQLite адаптер черновиков GFNutrition с собственными receipts/audit/feed. Через WebView доступны readDraft/saveDraft | `GfV3Q04NutritionDrafts`, `GfV3Q04Bridge`. Обход общего writer намеренный для draft, контекст открытия не удерживается. См. A02/A03 |
| Q05 | GFSport/GFIllness пишут периоды, GFSettings пишет базовую активность | `GfV3Q05OwnerQueue`, `GfV3Q05ActivityFacts`, registry и grants. Аналог A04 |
| Q07 / Q08 | GFInjectionFact и GFLevemirReview используют раздельные trusted пути подтверждения, историю дают scoped readers | `GfV3Q07OwnerQueue`, `GfV3Q08OwnerQueue`. У Q07 отображение проверяет stamp до и после projection в `GfV3Q11ReadSession`. Детерминированное восстановление между страницами Q08 остаётся открытым |
| Q09 | GFCgmSource, native batch, привязка профиля, источник и время наблюдения | `GfV3NativeModuleGateway.ingestQ09`, `GfV3Q09Controller`. Coverage и фактическое поступление данных проверяются отдельно |
| Q10 / Q11 | Доказательный и экранный read-only пути с привязкой revision/inputRevision/restore epoch | `GfV3Q10Controller`, `GfV3Q11ReadSession`. Сборка overlay и QA приёмка владельцем являются разными статусами |
| Q12 | Аналитический bridge только читает. Отдельная очередь владельца меняет запись политики | `GfV3Q12AnalyticsBridge`, Q12 owner route и настройки политики. Проверки очистки после восстановления и запрета старого контекста в native suite |
| Годовая история | 15 доменов, native scoped session повторно проверяет роль, профиль, ревизии, зону и epoch | `GfV3YearHistory`, `GfV3Storage.NativeYearSession`. Граница по Instant, стабильный порядок, явные записи без доверенного времени. `coverage=NOT_PROVEN` |

В выбранных Q01–Q09 assets поиск localStorage/sessionStorage/indexedDB показал только комментарии. Обращения напрямую к SQLite в Q02 и Q04 проходят через специализированные native адаптеры. Это обзор точек входа по итоговому дереву QA. Полный актуальный реестр ручной приёмки всех модулей не подтверждён. Использованы проектные журнал перехода v10→v11 и отчёты v10 и Q04-DRAFT-CONTEXT.

## Тесты и производительность

| Проверка | Результат |
|---|---|
| Host исходных шагов 9 и 18 | Q03 41 тест и 27 стресс-проверок. Q04 24 source, 23 JS contract, 6 SQLite и 4 зеркала restore. Q08 54 Node. Есть другие проверки Q05/Q06 в логе |
| SQLite миграции Q05 | 28 host, включая upgrade v7/v8 → v9, rollback, integrity |
| Новый SQLite host | Реальные SQL v1–v10. 40 конкурентных коллизий профиль/источник/время, по одному commit и одному rejection. Батч с дублем откатывается, чтение scoped, повторное открытие сохраняет строки |
| Новый Kotlin/JDBC | Пробный read и порядок всех 15 доменов на пустых таблицах. CGM покрывает границы с наносекундами, равное время и стабильный ID, другой профиль, лимит и запрет роли. Дата окончания на смене времени Warsaw. Границы других доменов и конверсия локального ввода требуют дополнительных тестов |
| Callback / Q04 | Два ожидаемых baseline отказа. Callback-патч проверен с Settings JVM. Q04 исправление ожидает отдельного native теста |

| CGM | Строк | SQL чтение p50/p95/p99, мс | SQL запись p50/p95/p99, мс | БД после замера | JVM первая сортировка |
|---|---:|---|---|---:|---:|
| 1 день | 290 | 0,285 / 0,595 / 2,257 | 0,031 / 0,159 / 0,282 | 458752 Б | 60 мс |
| 30 дней | 8642 | 0,496 / 0,801 / 1,044 | 0,028 / 0,119 / 0,208 | 2215936 Б | 172 мс |
| 365 дней | 105122 | 0,502 / 0,727 / 0,947 | 0,030 / 0,124 / 0,208 | 23199744 Б | 677 мс |

Linux host, Python 3.12.14/SQLite 3.53.1, Node 24.22.3, Java 21/Kotlin 2.0.21, SQLite JDBC 3.46.1.3. CGM каждые пять минут и две записи для проверки профиля/источника. 120 SQL чтений по 501 строке и 120 одиночных транзакционных insert. SQLite использовал rowid seek. Peak RSS процесса Python 17504 КиБ. Отдельный JVM-замер использует 120 страниц по 100 строк и настоящее Kotlin-ядро через JDBC, 365 дней p50/p95/p99 11,99 / 14,58 / 23,61 мс, наблюдаемый heap после замера 87,3 МБ. Это heap процесса с fixture и JVM, а не память одного индекса. Предложение для согласования после Android-измерений — держать работу по годовой истории вне UI и отдельно измерять открытие сессии и p95 страницы при параллельной записи. Числовой норматив требует привязки к устройству.

## Воспроизведение

Из корня чистого checkout ветки аудита, после установки PyYAML и инструментов из таблицы.

```bash
audit="$PWD/audit/gfstorage-v11"
python "$audit/replay.py" "$PWD" ../gf-replay
cd ../gf-replay/q07-ci
(cd android-app/app/src && sha256sum -c "$audit/source.sha256")
python "$audit/check_storage.py"
python "$audit/concurrent_storage.py"
node "$audit/q04-context.cjs"
src=android-app/app/src/main/java/org/glukopapa/v3/m00
kotlinc "$src/GfV3RestoreFence.kt" "$src/GfV3SettingsOwnerIntentQueue.kt" "$audit/CallbackCheck.kt" -cp "$JSON_JAR" -include-runtime -d /tmp/gf-callback.jar
java -cp "/tmp/gf-callback.jar:$JSON_JAR" org.glukopapa.v3.m00.CallbackCheckKt
```

Q04/Callback на исходной базе должны завершиться ненулевым кодом. Для JVM history собрать `history/*.kt` с исходным `GfV3YearHistory.kt`, JSON jar; для исполнения добавить SQLite JDBC jar. Перед запуском `YearCheckKt` и каждым `YearBenchmarkKt` в пустой БД применить `schema_v1.sql` → `schema_v10.sql` по порядку. YearCheck принимает путь БД, YearBenchmark принимает путь БД и число дней.

Android выполняется в [API 35](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/46011648421) и [API 31/34/36](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/46012322617), полный gate с исходными ID. Локальный host не имеет Android SDK/Gradle/KVM. [Черновой PR #5](https://github.com/bmv2002qq-star/Glucopapa/pull/5). Журнал, чек-лист, команды, исходный stack trace, тестовые патчи, манифесты и сырые метрики находятся рядом с отчётом. Ветки QA и main в этой работе служили базами чтения. Работа выполнена на синтетических данных.
