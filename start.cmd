@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if exist "%~dp0MANIFEST.json" goto fastpackage
set "LAUNCHER=%~dp0.build\launcher\MediaScope.Launcher.exe"
goto fast
:fastpackage
set "LAUNCHER=%~dp0scripts\MediaScope.Launcher.exe"
:fast
if not exist "%LAUNCHER%" goto legacy
"%LAUNCHER%" --app "%~dp0."
set "EXIT_CODE=%errorlevel%"
if "%EXIT_CODE%"=="75" goto legacy
rem These are loader failures. The launcher normalizes application failures to 1.
if "%EXIT_CODE%"=="9009" goto legacy
if "%EXIT_CODE%"=="193" goto legacy
if "%EXIT_CODE%"=="216" goto legacy
if "%EXIT_CODE%"=="-1073741515" goto legacy
if "%EXIT_CODE%"=="-2146232576" goto legacy
goto finish
:legacy
if exist "%~dp0MANIFEST.json" goto package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-source.ps1"
set "EXIT_CODE=%errorlevel%"
goto finish
:package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action Launch
set "EXIT_CODE=%errorlevel%"
:finish
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
