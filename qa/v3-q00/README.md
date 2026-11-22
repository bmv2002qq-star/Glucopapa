# GlukoPapa V3 · Q00 approved M03 APK smoke test

This **QA-only** branch does not modify approved M00–M03 sources. Its only goal is to build the exact, owner-approved V3 M03 archive, not the separate V2 `android-mvp3` project present in this repository.

## Locked source

- Archive: `СОГЛАСОВАНО_МОДУЛЬ_ГлюкоПапа_V3_M03_GFModuleDirectory_GFModuleHub_v0.1.0.zip`
- Required SHA-256: `853e7a2ac97ac20148eb096ca33c1b0ebe02e09742dcdad11a85beb692df5484`
- Expected archive: 275 files listed in `SHA256_MANIFEST.json`, plus the manifest itself.
- Gradle root inside archive: `android-app/` (AGP 8.7.3, Kotlin 2.0.21, Android SDK 35).
- Expected APK application ID: `org.glukopapa.v3.m00`.

## Source injection / privacy

The approved archive currently exists only in the user's private project Library; it is **not present in GitHub**. Do not upload its contents to this public repository without the owner's explicit approval.

To run the real APK smoke test, configure the repository Actions secret `GFV3_M03_ARCHIVE_URL` with a temporary HTTPS URL that returns the exact approved ZIP to the GitHub Actions runner. Limit its lifetime and access. The runner verifies the pinned archive SHA-256, the 275 entry checksums and the V3 app identity. If the archive or the secret is absent, the workflow **fails closed**; it must never fall back to building the repository's V2 shell.

GitHub Actions workflow: `.github/workflows/q00-v3-m03-apk-smoke.yml`, triggered on pushes to this QA branch. A manual workflow_dispatch trigger may require the workflow to exist on the default branch before GitHub allows manual invocation.

All artifacts are QA evidence only: a debug APK is not proof of real Android device tests or approval of M03 integration. Continue with separate owner integration approval after a genuine successful APK build and remaining host checks.
