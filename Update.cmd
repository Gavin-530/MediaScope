@echo off
setlocal
set "PACKAGE=%~1"
if not defined PACKAGE set /p "PACKAGE=New package ZIP path (or drag ZIP onto this file): "
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage.ps1" -Action Update -Archive "%PACKAGE%"
pause
