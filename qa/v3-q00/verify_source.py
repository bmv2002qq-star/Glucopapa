#!/usr/bin/env python3
"""Fail-closed integrity gate for the exact approved GlukoPapa V3 M03 ZIP."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import sys
from zipfile import ZipFile

PINNED_SHA256 = "853e7a2ac97ac20148eb096ca33c1b0ebe02e09742dcdad11a85beb692df5484"
MANIFEST = "SHA256_MANIFEST.json"
EXPECTED_COUNT = 275
REQUIRED = (
    "android-app/build.gradle.kts",
    "android-app/settings.gradle.kts",
    "android-app/app/build.gradle.kts",
    "android-app/app/src/main/AndroidManifest.xml",
    "android-app/app/src/main/assets/www/index.html",
    "android-app/app/src/main/assets/www/m02/gfmain_home_adapter.js",
    "android-app/app/src/main/assets/www/m03/gfmodule_hub_core.js",
    "android-app/app/src/main/assets/www/m03/gfmodule_directory_adapter.js",
)


def fail(message: str) -> None:
    raise SystemExit("Q00_APPROVED_SOURCE_REJECTED: " + message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify(archive: Path, destination: Path) -> dict:
    if not archive.is_file():
        fail("The owner-approved M03 archive is missing")
    observed_archive = hashlib.sha256(archive.read_bytes()).hexdigest()
    if observed_archive != PINNED_SHA256:
        fail(f"ZIP SHA mismatch: {observed_archive} != {PINNED_SHA256}")
    with ZipFile(archive) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            fail("Duplicate ZIP member name")
        if len(names) != EXPECTED_COUNT + 1:
            fail(f"Archive member count {len(names)} != {EXPECTED_COUNT + 1}")
        if MANIFEST not in names:
            fail("Missing SHA256_MANIFEST.json")
        for entry in z.infolist():
            p = PurePosixPath(entry.filename)
            if entry.is_dir() or p.is_absolute() or ".." in p.parts or "\\" in entry.filename:
                fail(f"Unsafe archive entry: {entry.filename!r}")
            mode = entry.external_attr >> 16
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                fail(f"Symlink in archive: {entry.filename}")
        if z.testzip() is not None:
            fail("ZIP CRC test failed")
        manifest = json.loads(z.read(MANIFEST))
        recorded = manifest["files"]
        if len(recorded) != EXPECTED_COUNT or set(recorded) != (set(names) - {MANIFEST}):
            fail("Manifest does not cover every ZIP member")
        for name in sorted(recorded):
            if sha(z.read(name)) != recorded[name]:
                fail(f"Member SHA mismatch: {name}")
        missing = set(REQUIRED) - set(names)
        if missing:
            fail("Missing approved V3 source files: " + repr(sorted(missing)))
        build = z.read("android-app/app/build.gradle.kts").decode("utf-8")
        if 'org.glukopapa.v3.m00' not in build or 'com.glucopapa.shell' in build:
            fail("Wrong application identity (V2/V3 mixup)")
        # Extraction is allowed only after all hash/path/symlink checks.
        destination.mkdir(parents=True, exist_ok=True)
        z.extractall(destination)
    return {
        "archive_sha256": observed_archive,
        "manifest_revision": manifest.get("revision"),
        "members_verified": len(recorded),
        "expected_application_id": "org.glukopapa.v3.m00",
        "gradle_root": "android-app",
        "v2_fallback_allowed": False,
    }


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: verify_source.py APPROVED_M03.zip EXTRACT_DIR EVIDENCE.json")
    info = verify(Path(sys.argv[1]), Path(sys.argv[2]))
    evidence = Path(sys.argv[3])
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(info, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))
