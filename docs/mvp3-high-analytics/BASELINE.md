# Входные пакеты HIGH и GFInjectionAnalytics

Дата 20.11.2026. Исходный HEAD QA — 6224d9454b708fee642fd27a007ce9e5e251a72f. Исходники проверенной Android-сборки предыдущего этапа соответствуют b15f44ef1fb772bfe598be68d1684feaba01d3fd. Ветка этапа qa/mvp3-high-analytics-20261120.

| Пакет | SHA-256 | Сверка |
|---|---|---|
| HIGH v0.1.4 RAR | 650a966dad99dbde9185c9754695bd0ec405ca115bb52ffa4880aacfb869bb06 | 44 строки сопроводительного SHA совпали. Оба вложенных ZIP прошли CRC. |
| HIGH FULL_SOURCE | 8bb6199874aefc6b207dcd75f6a2abe28f87286848996ba0ee9848472e82964d | Манифест 42/42. Это источник утверждённого HTML и обоих JS. |
| HIGH VIRTUAL_QA | 8cdb0dc5054c33e8b5a4082b9d9b8598307933f49b013bf16dcfe555c1b6c247 | Во вложенной копии манифест совпал для 41/42. Отличается сгенерированный checks/stress_results.json. Результаты повторены самостоятельно. |
| GFInjectionAnalytics v0.2.1 ZIP | bc1134abc5464f740062d7758f07dcb842ff8600b14915981b7005633dbbe279 | CRC и манифест 18/18. |

Эталон HIGH v0.1.3 сохранён в originals/HIGH_v0.1.3.html, SHA-256 d82001e180b561f759a7d464813f6057c67991e22c90660b49954e02d9a6c26b. Версия v0.1.4 обозначает поставку. TARGET core v0.1.0 имеет SHA 0fba7876858145be7b361ce8fd70d745c7e7c6c72d9215a030243dcf509a120e. Архивный адаптер v0.1.0 с SHA d2d28ff868b275440cfbd8e50aa93ac05e3379ee23296477713b72f4fce2637d сохранён для сверки. GFInjectionAnalytics v0.2.1 загружается под собственным именем GFInjectionAnalyticsV2. SHA источника 8d482c02cb999fdae58b8b5366b94e9df3adb83f80d683fec3798a9777389951.

Общие зависимости текущей базы — GFStorage schema 5, GFSettings 0.1.8, GFTimeGrid 0.1.0 с четырьмя окнами, RinfastEngine 0.3.0, GFForecast 0.1.2, GFCOBResearch 0.1.1 и глобальная опция mealAbsorptionModel. GFIA 0.1.1 остаётся действующим анализатором мест. Левемир исключён из входов HIGH. Тестовые копии vendor и старое хранилище из пакета HIGH в runtime не входят.
