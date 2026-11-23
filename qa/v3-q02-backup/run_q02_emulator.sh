#!/usr/bin/env bash
set -euo pipefail
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
ROOT="$RUNNER_TEMP/q02-runtime"
mkdir -p "$ROOT/evidence"
cd "$ROOT/source"
test -e app/src/main/java/org/glukopapa/v3/m00/GfV3EncryptedSnapshot.kt
sha256sum app/src/main/java/org/glukopapa/v3/m00/GfV3EncryptedSnapshot.kt | tee "$ROOT/evidence/q02-code.sha256"
set +e
gradle --no-daemon --console=plain :app:connectedDebugAndroidTest >"$ROOT/evidence/connected-tests.log" 2>&1
rc=$?
set -e
cat "$ROOT/evidence/connected-tests.log" | tail -80
if [ -d app/build/outputs/androidTest-results ]; then cp -R app/build/outputs/androidTest-results "$ROOT/evidence/";fi
if [ -d app/build/reports/androidTests ]; then cp -R app/build/reports/androidTests "$ROOT/evidence/";fi
adb logcat -d -t 1000 >"$ROOT/evidence/logcat-tail.txt" || true
adb shell dumpsys package org.glukopapa.v3.m00.q02qa >"$ROOT/evidence/package.txt" || true
exit "$rc"
