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

python3 qa/mvp3-android/sqlite_smoke.py --automated --adb "$adb" --serial "$serial" \
  --avd "$avd" --apk android-mvp3/app/build/outputs/apk/debug/app-debug.apk --output "$evidence/checks" \
  2>&1 | tee "$evidence/smoke.log"

test "$("$adb" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')" = "$api"
bash qa/mvp3-android/run-native-stress.sh "$adb" "$serial" "$evidence"
if [[ $api == 35 ]]; then
    python3 qa/mvp3-android/gui_sizing.py "$adb" "$serial" "$evidence" 2>&1 | tee "$evidence/android-gui.log"
fi
