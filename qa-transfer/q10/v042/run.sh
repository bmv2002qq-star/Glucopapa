#!/usr/bin/env bash
set -euo pipefail
ROOT="$PWD"
adb shell svc power stayon true
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
mkdir -p qa-results/v042/integrated qa-results/v042/offline
cd q07-ci/android-app
set +e
gradle :app:connectedDebugAndroidTest --stacktrace --no-daemon 2>&1 | tee "$ROOT/q07-ci-logs/emulator.log"
primary=${PIPESTATUS[0]}
set -e
cp -a app/build/outputs "$ROOT/qa-results/v042/integrated/"
cd "$ROOT"
python3 qa-transfer/q10/v042/prepare.py offline
adb uninstall org.glukopapa.v3.m00.test || true
adb uninstall org.glukopapa.v3.m00 || true
cd q07-ci/android-app
rm -rf app/build/outputs/androidTest-results app/build/reports/androidTests
set +e
gradle :app:connectedDebugAndroidTest --stacktrace --no-daemon -Pandroid.testInstrumentationRunnerArguments.class=org.glukopapa.v3.m00.Q02AndroidBackupTest 2>&1 | tee "$ROOT/qa-results/v042/offline/emulator.log"
secondary=${PIPESTATUS[0]}
set -e
cp -a app/build/outputs "$ROOT/qa-results/v042/offline/"
cd "$ROOT"
printf '{"integrated_exit":%s,"offline_exit":%s}\n' "$primary" "$secondary" > qa-results/v042/exit.json
test "$primary" = 0 && test "$secondary" = 0
