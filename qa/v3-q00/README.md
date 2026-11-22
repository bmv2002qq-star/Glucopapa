# GlukoPapa V3 · Q00 approved M03 APK smoke test

This **QA-only** branch does not modify approved M00–M03 sources. Its only goal is to build the exact, owner-approved V3 M03 archive, not the separate V2 `android-mvp3` project present in this repository.

## Locked source

- Archive: `СОГЛАСОВАНО_МОДУЛЬ_ГлюкоПапа_V3_M03_GFModuleDirectory_GFModuleHub_v0.1.0.zip`
- Required SHA-256: `853e7a2ac97ac20148eb096ca33c1b0ebe02e09742dcdad11a85beb692df5484`
- Expected archive: 275 files listed in `SHA256_MANIFEST.json`, plus the manifest itself.
- Gradle root inside archive: `android-app/` (AGP 8.7.3, Kotlin 2.0.21, Android SDK 35).
- Expected APK application ID: `org.glukopapa.v3.m00`.

## Public archive (owner authorization, 2026-11-22)

The owner explicitly authorized placing the approved ZIP on public GitHub, including its personal data if present. A safety review found no obvious password, API key, or private-key material in the ZIP's text files; the archive does contain synthetic/demo data and review artifacts. Its contents are now publicly reconstructable from `qa/v3-q00/archive.parts/part-000.b64` through `part-017.b64`. **Public commits cannot be made confidential again simply by deleting the branch.**

The QA workflow reconstructs the exact original ZIP, validates each part's SHA-256, pins the archive's SHA-256, verifies all 275 file checksums, and only then builds the V3 application. The workflow does not use a private download link, does not fall back to V2, and does not change approved source files.

GitHub Actions workflow: `.github/workflows/q00-v3-m03-apk-smoke.yml`, triggered on pushes to this QA branch. A manual workflow_dispatch trigger may require the workflow to exist on the default branch before GitHub allows manual invocation.

All artifacts are QA evidence only: a debug APK is not proof of real Android device tests or approval of M03 integration. Continue with separate owner integration approval after a genuine successful APK build and remaining host checks.
