#!/usr/bin/env bash
set -euo pipefail

sdk=${ANDROID_HOME:?Set ANDROID_HOME to the installed SDK}
evidence=${EVIDENCE:?Set EVIDENCE to a new test output directory}
api=${ANDROID_QA_API:-35}
serial=emulator-5554
avd=GlucoPapaMvp3CiQa
adb="$sdk/platform-tools/adb"
mkdir -p "$evidence" "$evidence/android-user" "$evidence/avd"
export ANDROID_USER_HOME="$evidence/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$evidence/avd"

printf 'no\n' | avdmanager create avd --name "$avd" --package "system-images;android-$api;default;x86_64" --device pixel_5
"$adb" start-server
"$sdk/emulator/emulator" -avd "$avd" -port 5554 -accel on -gpu swiftshader \
  -no-window -no-audio -no-snapshot -no-boot-anim -no-metrics -camera-back none -camera-front none \
  > "$evidence/emulator.raw" 2>&1 &
emulator_pid=$!
cleanup() {
    tr -d '\r' < "$evidence/emulator.raw" | sed '/Sending adb public key/d; /androidboot\.qemu\.adb\.pubkey/d' > "$evidence/emulator.log"
    if kill -0 "$emulator_pid" 2>/dev/null; then
        kill "$emulator_pid" || true
    fi
}
trap cleanup EXIT

booted=0
for ((attempt=0; attempt<72; attempt++)); do
    kill -0 "$emulator_pid" 2>/dev/null || break
    if [[ $(timeout 8s "$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true) == 1 ]]; then
        booted=1
        break
    fi
    sleep 5
done

if (( ! booted )); then
    echo 'Android emulator did not complete boot' | tee "$evidence/boot.log"
    exit 1
fi
actual=$("$adb" -s "$serial" emu avd name | head -n1 | tr -d '\r')
test "$actual" = "$avd"
printf 'AVD %s on %s booted with hardware acceleration\n' "$avd" "$serial" > "$evidence/boot.log"
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard

# Check the exact ordinary APK before installing the separately named fixture.
"$adb" -s "$serial" install android-mvp3/app/build/outputs/apk/debug/app-debug.apk
"$adb" -s "$serial" install -t android-mvp3/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase production \
    com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation | tee "$evidence/production-isolation.log"
grep -F 'QA_PASS production' "$evidence/production-isolation.log"
"$adb" -s "$serial" shell am force-stop com.glucopapa.shell
for step in provider-write provider-restored; do
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase production -e step "$step" \
        com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation | tee "$evidence/$step.log"
    grep -F 'QA_PASS production' "$evidence/$step.log"
    "$adb" -s "$serial" shell am force-stop com.glucopapa.shell
done
sha256sum android-mvp3/app/build/outputs/apk/debug/app-debug.apk > "$evidence/production-apk.sha256"

# The tested fixture has its own package and app-private directory.
export GLUCOPAPA_QA_PACKAGE=com.glucopapa.shell.fixture
smoke_options=(--automated --fixture-test-apk android-mvp3/app/build/outputs/apk/androidTest/fixture/app-fixture-androidTest.apk)
if [[ $api == 31 ]]; then
    smoke_options+=(--stock-webview)
fi
python3 qa/mvp3-android/sqlite_smoke.py "${smoke_options[@]}" --adb "$adb" --serial "$serial" \
  --avd "$avd" --apk android-mvp3/app/build/outputs/apk/fixture/app-fixture.apk --output "$evidence/checks" \
  2>&1 | tee "$evidence/smoke.log"

test "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" = "$api"
bash qa/mvp3-android/run-native-stress.sh "$adb" "$serial" "$evidence"
if [[ ${ANDROID_QA_EXTENDED:-false} == true && $api == 35 ]]; then
    python3 qa/mvp3-android/ai_export_saf.py "$adb" "$serial" "$evidence" 2>&1 | tee "$evidence/ai-saf.log"
fi
if [[ ${ANDROID_QA_EXTENDED:-false} == true && $api != 31 ]]; then
    python3 qa/mvp3-android/gui_sizing.py "$adb" "$serial" "$evidence" 2>&1 | tee "$evidence/android-gui.log"
fi

# Exercise the real settings panel against production GFStorage and its native SQLite driver.
runner="$GLUCOPAPA_QA_PACKAGE.test/com.glucopapa.shell.qa.StorageInstrumentation"
for step in meal-model-save meal-model-restored high-settings-save high-settings-restored unified-save unified-restored; do
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase stock -e step "$step" "$runner" \
      | tee "$evidence/$step.log"
    grep -F 'QA_PASS stock' "$evidence/$step.log"
    if [[ $step == *-save ]]; then
        "$adb" -s "$serial" shell am force-stop "$GLUCOPAPA_QA_PACKAGE"
    fi
done

if [[ ${ANDROID_QA_EXTENDED:-false} == true ]]; then
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase timing-history "$runner" \
      | tee "$evidence/injection-timing-history.log"
    grep -F 'QA_PASS timing-history' "$evidence/injection-timing-history.log"
    for step in low-fact-write low-fact-restored; do
        "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase stock -e step "$step" "$runner" \
          | tee "$evidence/$step.log"
        grep -F 'QA_PASS stock' "$evidence/$step.log"
        if [[ $step == low-fact-write ]]; then
            "$adb" -s "$serial" shell am force-stop "$GLUCOPAPA_QA_PACKAGE"
        fi
    done
fi
