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
compatibility_options=()
if [[ $api == 31 ]]; then
    compatibility_options+=(-feature -Vulkan)
fi
"$sdk/emulator/emulator" -avd "$avd" -port 5554 -accel on -gpu swiftshader "${compatibility_options[@]}" \
  -no-window -no-audio -no-snapshot -no-boot-anim -no-metrics -camera-back none -camera-front none \
  > "$evidence/emulator.raw" 2>&1 &
emulator_pid=$!
cleanup() {
    "$adb" -s "$serial" logcat -d -t 900 -s AndroidRuntime ActivityManager WebViewFactory chromium \
        > "$evidence/device.log" 2>&1 || true
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
"$adb" -s "$serial" shell svc power stayon true
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard
if [[ $api == 36 ]]; then
    # Changing the overlay restarts System UI. Do it before opening any app windows.
    "$adb" -s "$serial" shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural \
        > "$evidence/android-back-mode.log" 2>&1 || true
    for ((attempt=0; attempt<20; attempt++)); do
        mode=$("$adb" -s "$serial" shell settings get secure navigation_mode | tr -d '\r')
        [[ $mode != 2 ]] || break
        sleep 1
    done
    printf 'Navigation mode: %s\n' "$mode" >> "$evidence/android-back-mode.log"
fi
if [[ $api == 31 ]]; then
    "$adb" -s "$serial" shell wm size 720x1560
    "$adb" -s "$serial" shell wm density 360
fi
# Let the initial boot broadcasts and WebView provider settle.
sleep 10
if [[ ${ANDROID_QA_REPLAY_ONLY:-false} == true ]]; then
    fixture=com.glucopapa.shell.fixture
    runner="$fixture.test/com.glucopapa.shell.qa.StorageInstrumentation"
    "$adb" -s "$serial" install android-mvp3/app/build/outputs/apk/fixture/app-fixture.apk
    "$adb" -s "$serial" install -t android-mvp3/app/build/outputs/apk/androidTest/fixture/app-fixture-androidTest.apk
    for step in write restored; do
        "$adb" -s "$serial" shell am force-stop "$fixture"
        "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase pilot-replay -e step "$step" "$runner" \
            | tee "$evidence/pilot-replay-$step.log"
        grep -F 'QA_PASS pilot-replay' "$evidence/pilot-replay-$step.log"
    done
    exit 0
fi

# Check the exact ordinary APK before installing the separately named fixture.
ordinary_apk=android-mvp3/app/build/outputs/apk/debug/app-debug.apk
"$adb" -s "$serial" install "$ordinary_apk"
installed_apk=$("$adb" -s "$serial" shell pm path com.glucopapa.shell | tr -d '\r')
[[ "$installed_apk" == package:/data/app/*/base.apk && "$installed_apk" != *$'\n'* ]]
installed_apk=${installed_apk#package:}
"$adb" -s "$serial" shell run-as com.glucopapa.shell sha256sum "$installed_apk" | tr -d '\r' > "$evidence/installed-apk.sha256"
sha256sum "$ordinary_apk" > "$evidence/production-apk.sha256"
test "$(cut -d ' ' -f 1 "$evidence/installed-apk.sha256")" = "$(cut -d ' ' -f 1 "$evidence/production-apk.sha256")"
"$adb" -s "$serial" install -t android-mvp3/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
ordinary_runner=com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation
production_isolation() {
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase production "$ordinary_runner"
}
production_isolation | tee "$evidence/production-isolation.log"
if grep -Fq 'WebView startup timed out: null' "$evidence/production-isolation.log"; then
    mv "$evidence/production-isolation.log" "$evidence/production-startup-attempt1.log"
    "$adb" -s "$serial" shell am force-stop com.glucopapa.shell
    "$adb" -s "$serial" shell am start -W -n com.glucopapa.shell/.MainActivity > "$evidence/production-warmup.log"
    "$adb" -s "$serial" shell am force-stop com.glucopapa.shell
    production_isolation | tee "$evidence/production-isolation.log"
fi
grep -F 'QA_PASS production' "$evidence/production-isolation.log"
"$adb" -s "$serial" shell am force-stop com.glucopapa.shell
for step in provider-write provider-restored history-write history-restored web-write web-restored window-write window-restored profile-write profile-restored; do
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase production -e step "$step" \
        com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation | tee "$evidence/$step.log"
    grep -F 'QA_PASS production' "$evidence/$step.log"
    "$adb" -s "$serial" shell am force-stop com.glucopapa.shell
done
"$adb" -s "$serial" shell input keyevent KEYCODE_WAKEUP
"$adb" -s "$serial" shell wm dismiss-keyguard
"$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase back \
    com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation | tee "$evidence/production-back.log"
back_failure=0
if ! grep -F 'QA_PASS back' "$evidence/production-back.log" ||
    { [[ $api == 36 ]] && ! grep -Fq '"systemGesture":"PASS"' "$evidence/production-back.log"; }; then
    back_failure=1
    "$adb" -s "$serial" shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' > "$evidence/back-focus.log" || true
fi

# The tested fixture has its own package and app-private directory.
export GLUCOPAPA_QA_PACKAGE=com.glucopapa.shell.fixture
smoke_options=(--automated --fixture-test-apk android-mvp3/app/build/outputs/apk/androidTest/fixture/app-fixture-androidTest.apk)
smoke_options+=(--stock-webview)
python3 qa/mvp3-android/sqlite_smoke.py "${smoke_options[@]}" --adb "$adb" --serial "$serial" \
  --avd "$avd" --apk android-mvp3/app/build/outputs/apk/fixture/app-fixture.apk --output "$evidence/checks" \
  2>&1 | tee "$evidence/smoke.log"

test "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" = "$api"
bash qa/mvp3-android/run-native-stress.sh "$adb" "$serial" "$evidence"
extended_failure=0
if [[ ${ANDROID_QA_EXTENDED:-false} == true && $api == 35 ]]; then
    if ! python3 qa/mvp3-android/ai_export_saf.py "$adb" "$serial" "$evidence" 2>&1 | tee "$evidence/ai-saf.log"; then
        extended_failure=1
    fi
fi
if [[ ${ANDROID_QA_EXTENDED:-false} == true && $api != 31 ]]; then
    if ! python3 qa/mvp3-android/gui_sizing.py "$adb" "$serial" "$evidence" 2>&1 | tee "$evidence/android-gui.log"; then
        extended_failure=1
    fi
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
    if [[ $api == 35 ]]; then
        "$adb" -s "$serial" shell pm clear "$GLUCOPAPA_QA_PACKAGE"
        for step in write restored; do
            "$adb" -s "$serial" shell am force-stop "$GLUCOPAPA_QA_PACKAGE"
            "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase pilot-replay -e step "$step" "$runner" \
              | tee "$evidence/pilot-replay-$step.log"
            grep -F 'QA_PASS pilot-replay' "$evidence/pilot-replay-$step.log"
        done
    fi
fi
# A fresh fixture journal isolates the synthetic matching cases from other suites.
"$adb" -s "$serial" shell pm clear "$GLUCOPAPA_QA_PACKAGE"
for step in write restored; do
    "$adb" -s "$serial" shell am force-stop "$GLUCOPAPA_QA_PACKAGE"
    "$adb" -s "$serial" shell am instrument -w -r -e fixture SYNTHETIC -e phase meal-timing -e step "$step" "$runner" \
      | tee "$evidence/meal-timing-$step.log"
    grep -F 'QA_PASS meal-timing' "$evidence/meal-timing-$step.log"
done

exit "$((back_failure || extended_failure))"
