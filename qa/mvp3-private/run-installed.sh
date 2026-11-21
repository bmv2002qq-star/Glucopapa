#!/usr/bin/env bash
set -euo pipefail

sdk=${ANDROID_HOME:?Set ANDROID_HOME}
serial=${GLUCOPAPA_QA_EMULATOR:?Set the isolated emulator serial}
evidence=${EVIDENCE:?Set a private evidence directory}
root=$(cd "$(dirname "$0")/../.." && pwd)
adb="$sdk/platform-tools/adb"
[[ "$serial" =~ ^emulator-[0-9]+$ ]]
[[ $("$adb" -s "$serial" emu avd name | head -n1 | tr -d '\r') == "${GLUCOPAPA_QA_AVD:?Set the isolated AVD name}" ]]
[[ $("$adb" -s "$serial" shell getprop sys.boot_completed | tr -d '\r') == 1 ]]
umask 077
mkdir -p "$evidence"
test ! -e "$evidence/verified-installed.sha256"
for variant in Main Research; do
    build="private$variant"
    package=com.glucopapa.shell
    database=gfstorage_v5.db
    if [[ "$variant" == Research ]]; then
        package="$package.qa"
        database=gfstorage_research_v5.db
    fi
    app="$root/android-mvp3/app/build/outputs/apk/$build/app-$build.apk"
    test_app="$root/android-mvp3/app/build/outputs/apk/androidTest/$build/app-$build-androidTest.apk"
    log_name="${variant,,}"
    timeout 180 "$adb" -s "$serial" install -r "$app" | tee "$evidence/$log_name-install.log"
    timeout 180 "$adb" -s "$serial" install -r -t "$test_app" | tee "$evidence/$log_name-instrumentation-install.log"
    installed=$(timeout 40 "$adb" -s "$serial" shell pm path "$package" | sed 's/^package://' | tr -d '\r')
    [[ "$installed" == /data/app/*/base.apk && "$installed" != *$'\n'* ]]
    hash=$(sha256sum "$app" | cut -d ' ' -f 1)
    in_guest=$(timeout 45 "$adb" -s "$serial" shell run-as "$package" sha256sum "$installed" | cut -d ' ' -f 1)
    test "$in_guest" = "$hash"
    printf '%s %s\n' "$hash" "$package" >> "$evidence/verified-installed.sha256"
    for step in first reopened; do
        timeout 60 "$adb" -s "$serial" shell am force-stop "$package"
        timeout 270 "$adb" -s "$serial" shell am instrument -w -r -e fixture PRIVATE_LOCAL -e phase private-seed -e step "$step" \
            "$package.test/com.glucopapa.shell.qa.StorageInstrumentation" | tee "$evidence/$log_name-$step.log"
        rg -F 'QA_PASS private-seed' "$evidence/$log_name-$step.log"
    done
    timeout 60 "$adb" -s "$serial" shell am force-stop "$package"
    timeout 60 "$adb" -s "$serial" exec-out run-as "$package" cat "databases/$database" > "$evidence/.native-$log_name.db"
    python3 - "$evidence/.native-$log_name.db" "$package" <<'PY' >> "$evidence/sqlite-integrity.log"
import hashlib, json, sqlite3, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro&immutable=1', uri=True) as database:
    assert database.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    revision, data, digest = database.execute('SELECT revision, data, payload_sha256 FROM snapshots').fetchone()
    assert hashlib.sha256(data.encode()).hexdigest() == digest
    assert json.loads(data)['revision'] == revision
    print(sys.argv[2], 'integrity_check=ok', 'snapshot_sha256=match', 'revision=match')
PY
    rm "$evidence/.native-$log_name.db"
done
