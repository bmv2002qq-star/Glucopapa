# Android · LOW и общая регрессия

Источник 575efb5940295c2ef3ea45731a8ce1504e1d83e6. Запуск завершился во второй попытке. В первой Android 12 остановился на ожидании WebView, повтор того же SHA прошёл. Проверки выполнены на изолированных эмуляторах с синтетическими журналами. [GitHub Actions](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533)

| Среда | Общий запуск и SQLite | GFInjectionAnalytics | Один факт LOW и восстановление |
|---|---|---|---|
| Android 12 | PASS | PASS | PASS · [SQLite](evidence/android/api31/low-fact-restored.log) · [CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533/job/136002505754) |
| Android 14 | PASS | PASS | PASS · [SQLite](evidence/android/api34/low-fact-restored.log) · [CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533/job/135997854007) |
| Android 15, базовая | PASS | NOT_TESTED | NOT_TESTED · [CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533/job/135997853930) |
| Android 15, расширенная | PASS | PASS | PASS · [SQLite](evidence/android/api35/low-fact-restored.log) · [CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533/job/135997854138) |
| Android 16 | PASS | PASS | PASS · [SQLite](evidence/android/api36/low-fact-restored.log) · [CI](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44648671533/job/135997853767) |

Проверки LOW на заполненном журнале прошли в 4 расширенных задачах. Скрипт сравнивает один и тот же event ID и ревизию до и после force-stop. Синтетический факт 25 г имеет 4,975 г углеводов и ГИ 49. Перед подтверждением расчёт и отмена оставляют снимок неизменным. После подтверждения повторное нажатие не увеличивает ревизию.

На Android 12 статус системных касаний PASS, дерева доступности WebView — ENV_BLOCKED. Промежуточный d6eae43 заменён кандидатом с исправлением навигации. Отменённый прогон не используется как доказательство.

Локальная debug-сборка имеет SHA‑256 dc25899cf0f41d978c04b3a5f0bd66c48aaa098e6de3d645caa565ccb5f52a48. Все 133 ресурса APK совпали с исходниками. Подпись v2 проверена. CI строит те же исходники с собственными debug-подписями, SHA установленных APK указаны в result.json.

Физический телефон и реальный xDrip+ имеют статус NOT_TESTED. Отдельного фактического 24-часового Android soak в протоколе нет. Клиническая пригодность NOT_VALIDATED.
