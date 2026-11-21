# Функции и контракты

| Функция | Модуль | Контракт | Состояние 0.3.18-qa |
| --- | --- | --- | --- |
| Текущий CGM и история | GFNativeXDripHistory, GFNativeXDrip, GFProviderCgm | `cgmAdapter`, одно окно и время получения | HTTP синтетически проверен на эмуляторе. Живой Follower открыт. |
| Профиль, измерения, справочники | GFSettings, GFGrowthReference, GFNutritionReference | `settings` | Одно представление, парная оценка ИМТ, история из одного профиля. |
| Каталог, тарелка, фактическая порция | GFNutrition, GFFoodMealEntry, GFMealActualPanel | `food`, `mealFlow`, `actionWriter` | Утверждённый каталог. Переход к GFMealCalc. Недостающие нормы приёма видны в балансировке. |
| Контекст расчёта | GFMealCalc, GFCalculationEvidence, GFInsulinEvidenceGate, GFMealAbsorption | `calculator`, `settings`, `rinfast`, `research` | Проверка пригодности и исходных данных. Лечебная доза недоступна. |
| Исторический интервал | GFInjectionAnalytics, GFMealTimingService | `injectionAnalytics`, `research`, `mealTimingPublisher`, `mealTiming` | Реальное ядро на синтетике. Совпадение по текущей сессии, версионный снимок. |
| Факт укола и отсчёт | GFInjectionFact, GFStorage, GFMealWorkflowView | `actionWriter.recordSessionInjection`, `mealTiming` | Один факт, привязка интервала, расчёт оставшегося времени от фактической метки. |
| Дневник | GFJournal и адаптер представления | `journal`, `graph`, `settings` | 3 колонки, диапазоны, два цвета периодов, отдельная сводка и месяц. |
| LOW и HIGH | GFLOW, GFHighTarget | `lowReview`, `actionWriter`, `research`, `graph` | Факты и диагностика доступны. Дальнейший количественный вывод зависит от проверенных моделей и полноты входа. |
| Коэффициенты и периоды | GFCoefficients, GFSettings, GFTimeGrid, GFActivityGuidance | `settings`, `context`, `activityUi`, `sport` | Ручные значения, четыре окна, история, спорт и болезнь. |
| Прогнозы | GFConsensus и исходные модели | `research`, `forecastWriter` | Исследовательский режим с существующей проверкой полноты. |
| Синхронизация телефонов | GFSync, GFSyncStorageAdapter | `syncWriter` | Локальный анализатор пакетов и роли. Рабочая сеть и сервер блокированы. |
| Архив, восстановление и экспериментальные данные | GFJournalBackup, GFAuditExport, GFReplayLab | `journal`, SQLite, тестовый APK | Копия 0.3.17 проверена на новом коде. Исследовательские фикстуры изолированы. |

[Матрица 29 подсистем](МАТРИЦА_29_МОДУЛЕЙ_MVP3.md) · [Текущий прогон 29 маршрутов](evidence/modules-browser.json)
