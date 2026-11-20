# CL-XDRIP-FOLLOWER-20261120

| ID | Проверка | Статус |
| --- | --- | --- |
| XDRIP-V1-001 | Нативный `GlucoBridge`, HTTP GET, SQLite и callback WebView найдены в Android 0.26 | SOURCE_PASS |
| XDRIP-UPSTREAM-002 | Выбранный стабильный xDrip+ публикует оба read API и поддерживает запрос Follower | SOURCE_PASS |
| XDRIP-V2-003 | Контракт единиц, получения, тренда, времени и дедупликации GFStorage | CODE_PASS |
| XDRIP-AVD-004 | Синтетический пакет в обычном APK, запись SQLite и восстановление | PASS_SYNTHETIC, API 35 для 0.3.15-pilot |
| XDRIP-PHONE-005 | Показание из реального Follower, настройки, фактический вариант APK | NOT_TESTED |
| XDRIP-GAP-006 | История из пропущенных точек после закрытия V2 | PASS_SYNTHETIC, ручной импорт Web Service до 24 часов, REAL_XDRIP NOT_TESTED |
| XDRIP-DUP-007 | Совместная доступность обоих транспортов на телефоне | PASS_SYNTHETIC, совпадение якоря и нет дублей между транспортами. REAL NOT_TESTED |
| XDRIP-SENSOR-008 | Идентификатор конкретного датчика, смена источника и качество для моделей | BLOCKED: часть полей отсутствует в read API |
| XDRIP-HTTP-009 | Возврат старого клиента под политику V2 | PASS_SYNTHETIC, локальный HTTP без прокси и перенаправлений, ограничения адреса и размера |

[Аудит источника](XDRIP_FOLLOWER_AUDIT.md) · [Приёмка 0.3.15-pilot](CL-PILOT-20261120.md)
