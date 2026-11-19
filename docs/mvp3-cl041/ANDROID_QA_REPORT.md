# Android QA. CL-041

Коммит `d54157a2c8c8e48648c8424891bcc6140935eabb`. [GitHub Actions](https://github.com/bmv2002qq-star/Glucopapa/actions/runs/44438602617). Локально собран и подписан debug APK. SHA‑256 `5efabf76f6ff3beaf3c870da5fb5d09dbcf652d03ba7d56189fdde8d60cbe173`. В нём побайтно совпали 118 ресурсов WebView. Проверены 26 защищённых исходников.

| Android | Установочный smoke | SQLite, force-stop | Нативная ротация и JSONL | Системная доступность | Реальный soak |
|---:|---|---|---|---|---|
| 12 | PASS | PASS | PASS | PASS | — |
| 14 | PASS | PASS | PASS | см. логи | 85.8 с |
| 15 | PASS | PASS | PASS | см. логи | 84.8 с |
| 16 | PASS | PASS | PASS | см. логи | 85.1 с |

**Новый SAF:** PASS. Шесть календарных периодов прошли через DocumentsUI. Проверены конечные байты каждого документа, границы, SHA‑256, отмена, повтор и неизменность SQLite с PRAGMA integrity_check.

Итог CI — completed / success. Android 15 core job — success. Первый Android 15 core дошёл до запуска приложения, а автоматизированный запуск WebView вышел по тайм-ауту. Повтор Android 15 core на том же SHA прошёл. Первоначальный тайм-аут и успешный повтор сохранены отдельно.

Площадки — CODE PASS для доступных регрессий, BROWSER_MULTI_FILE PASS, BROWSER_SINGLE_FILE NOT_RUN, ANDROID_EMULATOR по таблице, ANDROID_DEVICE NOT_TESTED, LIVE_CGM NOT_TESTED, CLINICAL NOT_VALIDATED.

Данные всех Android-прогонов синтетические. Доказательства находятся в evidence/android. История первых попыток SAF сохранена в evidence/intermediate. Сохранившийся в новом SAF файл создаёт системный локальный поставщик документов. AndroidManifest новых разрешений и разрешения сети не получил.
