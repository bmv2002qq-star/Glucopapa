@echo off
where gradle >nul 2>nul
if errorlevel 1 (
 echo Gradle 8.13 not found. Open this project in Android Studio or use GitHub Actions.
 echo See docs\ИНСТРУКЦИЯ_ANDROID.md in the full archive.
 pause
 exit /b 1
)
gradle :app:assembleDebug
pause
