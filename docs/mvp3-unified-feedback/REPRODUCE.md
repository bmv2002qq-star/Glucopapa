# Воспроизведение 0.3.18-qa

Команды запускаются из корня QA-ветки. Для сценариев используются синтетические журналы, Node.js 24, Python 3 и Chromium с Playwright. Закреплённые SHA и раздельные идентификаторы сборки и испытаний находятся в контрольной точке. [Контрольная точка](checkpoint.json)

## Локальный прогон

```bash
sha256sum --check --quiet qa/mvp3-android/android-source.sha256
python3 qa/mvp3-full/integrity.py
python3 qa/mvp3-unified-feedback/derive_meal_interface.py --check
mapfile -t glucopapa_cases < <(rg --files qa | rg '^qa/mvp3[^/]*/[^/]*\.test\.cjs$' | sort)
node --test --test-reporter=tap "${glucopapa_cases[@]}"
python3 qa/mvp3-full/browser_modules.py --output qa-evidence/modules
python3 qa/mvp3-unified-feedback/browser_meal.py --output qa-evidence/meal
node qa/mvp3-pilot/replay-90d.cjs
node qa/mvp3-calculators/physio-stress.cjs qa-evidence
node qa/mvp3-unified-feedback/physio-incomplete.cjs qa-evidence/physio-cases.jsonl
```

## Архивные эталоны

Для FOOD-013 и REPLAY-013 нужен `vendor/GFReplayLab_v0.1.0` из архива Stage 11 с SHA-256 `de021ce0b241db29ffdb7466d9c19053b089c54d79dbbfeda24e8e06d04d3b90`. В историческом сценарии меняется только путь загрузки GFStorage с архивной 0.5.11 на активную 0.5.12. Оригинальная лаборатория работает в отдельном каталоге.

```bash
glucopapa_replay_check=$(mktemp --suffix=.cjs)
sed 's/GFStorage_v0\.5\.11/GFStorage_v0.5.12/' \
  docs/mvp3-cl042/evidence/replay-food-audit.cjs > "$glucopapa_replay_check"
node "$glucopapa_replay_check" "$PWD/android-mvp3/app/src/main/assets/www" \
  "$GF_REPLAYLAB_STAGE11_ROOT" --full-replay
```

[Эталоны формул и распаковка CL-042](../mvp3-cl042/REPRODUCE.md) · [Протокол Stage 11](evidence/replay-food.json)

## Android

Workflow устанавливает обычный APK на Android 15 и сравнивает байты установленного файла. Расширенный контур использует отдельное приложение `com.glucopapa.shell.fixture`. Аварийные действия ограничены выделенным AVD. Для нативного запуска нужны Gradle 8.13, Java 17, Android SDK 36 и доступ к KVM. [Workflow](../../.github/workflows/mvp3-android-device.yml) · [Сценарий](../../qa/mvp3-android/run-on-emulator.sh) · [Протокол Android](evidence/android.json)
