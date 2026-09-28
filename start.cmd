@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0MANIFEST.json" goto package
where node >nul 2>nul
if errorlevel 1 (
  echo [MediaScope] Source checkout requires Node.js 22 or newer in PATH.
  pause
  exit /b 1
)
node server.mjs
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
:package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action Launch
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
