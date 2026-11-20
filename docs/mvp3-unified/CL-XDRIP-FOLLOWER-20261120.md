# CL-XDRIP-FOLLOWER-20261120

| ID | Проверка | Статус |
| --- | --- | --- |
| XDRIP-V1-001 | Нативный `GlucoBridge`, HTTP GET, SQLite и callback WebView найдены в Android 0.26 | SOURCE_PASS |
| XDRIP-UPSTREAM-002 | Выбранный стабильный xDrip+ публикует оба read API и поддерживает запрос Follower | SOURCE_PASS |
| XDRIP-V2-003 | Контракт единиц, получения, тренда, времени и дедупликации GFStorage | CODE_PASS |
| XDRIP-AVD-004 | Синтетический пакет в обычном APK, запись SQLite и восстановление | PASS_SYNTHETIC, API 31/34/35/36 |
| XDRIP-PHONE-005 | Показание из реального Follower, настройки, фактический вариант APK | NOT_TESTED |
| XDRIP-GAP-006 | История из пропущенных точек после закрытия V2 | Ограничение текущего ContentProvider, возвращает одну точку |
| XDRIP-DUP-007 | Совместная доступность обоих транспортов на телефоне | NO SECOND TRANSPORT IN V2 / REAL NOT_TESTED |
| XDRIP-SENSOR-008 | Идентификатор конкретного датчика, смена источника и качество для моделей | BLOCKED: часть полей отсутствует в read API |
| XDRIP-HTTP-009 | Возврат старого клиента под политику V2 | BLOCKED: требуется подтверждение совместимости и решение о локальном HTTP |

Подробности в [отчёте по xDrip+](XDRIP_FOLLOWER_AUDIT.md).
