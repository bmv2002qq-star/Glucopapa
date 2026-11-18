#!/usr/bin/env bash
set -euo pipefail
adb=("$1" -s "$2")
evidence=$3
[[ $2 =~ ^emulator-[0-9]+$ ]]
test "$("${adb[@]}" emu avd name | head -n1 | tr -d '\r')" = 'GlucoPapaMvp3CiQa'
runner=com.glucopapa.shell.test/com.glucopapa.shell.qa.StorageInstrumentation
"${adb[@]}" install -t android-mvp3/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

instrument() {
    "${adb[@]}" shell am instrument -w -r -e fixture SYNTHETIC -e phase "$1" "$runner"
}

instrument exercise | tee "$evidence/native-exercise.log"
rg -F 'QA_PASS exercise' "$evidence/native-exercise.log"
instrument interrupt > "$evidence/native-interrupt.log" 2>&1 &
process=$!
pending=0
for ((attempt=0; attempt<60; attempt++)); do
    if "${adb[@]}" logcat -d -s 'GlucoPapaQA:I' | rg -F 'QA_PENDING_TRANSACTION' > "$evidence/native-pending.log"; then
        pending=1
        break
    fi
    kill -0 "$process" 2>/dev/null || break
    sleep 0.5
done
test "$pending" = 1
"${adb[@]}" shell am force-stop com.glucopapa.shell
wait "$process" || true

instrument reopen | tee "$evidence/native-reopen.log"
rg -F 'QA_PASS reopen' "$evidence/native-reopen.log"
