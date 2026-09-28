@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0MANIFEST.json" goto package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-source.ps1"
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
:package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action Launch
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
