# Совместимость Android · проверка GFStorage v11

CI повторяет 207 интегрированных и 8 offline тестов. APK сравнивались с исходным v11 по SHA256 всех 53 dex/assets entries для каждого режима.

| API | Интегрированные | Offline | Решение |
|---|---:|---:|---|
| 31 / Android 12 | 192/207 | 8/8 | Приёмка для Android 12 заблокирована |
| 34 / Android 14 | выполняется | выполняется | Ожидается артефакт |
| 35 / Android 15 | 207/207 | 8/8 | Gate пройден |
| 36 / Android 16 | 207/207 | 8/8 | Gate пройден |

API 31 artifact 15205386449 SHA256 f2a8a03f2fb7105d2a5093afd08cddbce368d0d92cc5472390c5b600c5523f37. API 36 artifact 15204642270 SHA256 ef0431db7ae8c65eb89f3589f3693516481baeeff3aff37dd28de027e2331b2f. Проверены SHA256, CRC ZIP и все testcase ID. [Матрица CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/46012322617).

## 15 отказов API 31

Все четыре теста очередей подтверждения v11, включая исправленный Settings, прошли. Q08 same-revision restore прошёл. В API 31 присутствовали все ожидаемые ID.

| ID | Случаев | Локализация и предлагаемая проверка |
|---|---:|---|
| GFV3-A08 · P1 | 1 | `yearChronologicalSessionExactUtcAndLeastScope`. `same-a` с `+00:00` исчезает из упорядоченных строк, обе записи со стандартным `Z` остаются. Наиболее вероятная причина — поведение `Instant.parse` текущего Android runtime. Предложен запасной разбор `OffsetDateTime` в `proposed-offset-parser.patch`. На Android проверить существующий assert без изменения данных и добавить проверку ненулевого смещения, наносекунд и неверной даты. |
| GFV3-A09 · P1 | 9 | Один Q01, восемь Q11 WebView/Shell. Logcat подтверждает `Object.hasOwn is not a function` и `rows.at is not a function`. Предложение — заменить системно в исходных версиях экранов на `Object.prototype.hasOwnProperty.call` и индекс длины массива, затем пересобрать встроенные assets. Прогнать те же UI-тесты с исходным WebView API 31. |
| GFV3-A10 · P1 для совместимости | 1 | Q08 `scopedRelatedHistoryRetainsBasalAndUnknownMealsWithoutLifetimeNoise` получает `UNFILTERED_FALLBACK` вместо `BASAL_HISTORY`. Logcat подтверждает `no such function: json_valid`. Fallback предусмотрен кодом, но нарушает ожидаемый профиль чтения. Требуется сохранить точную выборку и пределы истории на SQLite без JSON-функций. Проверить реальную SQLite API 31 с большим числом посторонних строк, неизвестным временем еды и повреждённым payload. |
| GFV3-A11 · P2 | 3 | Q10 отвечает BLOCKED/INPUT_REJECTED. Immutable donor и адаптер вызывают `Object.hasOwn` и `Array.at`; общий механизм совместимости вероятен. Отчёт CI фиксирует фактические статусы. Проверить isolated WebView со стандартными совместимыми реализациями методов перед загрузкой SHA-проверенных donor bytes, сохраняя политику и тесты fail-closed. |
| GFV3-A12 · P2 | 1 | Q12 не показывает ожидаемую пару эпизодов. В `q12_runtime.js` и `gf_high_low_v3_adapter.js` есть `Array.at`. Отдельно зафиксирован TypeError в policy screen при чтении hidden у null. Точную причину связать с неизменённым тестом на API 31 и trace обоих окон. |

`api31-comparison.json` содержит исходные ошибки, стеки и идентификаторы. Исправления приложения на этапе 01 находятся в предложениях. Для Android 12 допуска следует дождаться штатного зелёного Android-прогона и проверок физического телефона. Обновлённый WebView может решить часть проблем UI, но не меняет системную SQLite и поведение runtime при разборе времени.
