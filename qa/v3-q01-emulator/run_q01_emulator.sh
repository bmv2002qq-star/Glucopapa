#!/usr/bin/env bash
set -euo pipefail
project="$RUNNER_TEMP/q01-runtime/source"
evidence="$RUNNER_TEMP/q01-runtime/evidence"
mkdir -p "$evidence"
[ -f "$project/app/build.gradle.kts" ]
grep -F 'namespace = "org.glukopapa.v3.m00"' "$project/app/build.gradle.kts"
grep -F 'testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"' "$project/app/build.gradle.kts"
echo "Q01_EXACT_PROJECT_CONFIRMED $project"
status=0
gradle -p "$project" --no-daemon --console=plain :app:connectedDebugAndroidTest > "$evidence/connected-tests.log" 2>&1 || status=$?
tail -n 140 "$evidence/connected-tests.log"
if [ -d "$project/app/build/outputs/androidTest-results" ]; then
  cp -R "$project/app/build/outputs/androidTest-results" "$evidence/"
fi
adb shell dumpsys package org.glukopapa.v3.m00.q01qa | head -50 > "$evidence/package-dumpsys.txt" || true
adb logcat -d -t 500 > "$evidence/logcat-last-500.txt" || true
exit "$status"