@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"
if exist "%~dp0runtime\ffmpeg.exe" set "FFMPEG_PATH=%~dp0runtime\ffmpeg.exe"
if exist "%~dp0runtime\ffprobe.exe" set "FFPROBE_PATH=%~dp0runtime\ffprobe.exe"
where node >nul 2>nul
if errorlevel 1 (
  echo [MediaScope] Node.js 22 or newer was not found in PATH.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
if not defined FFMPEG_PATH (
  where ffmpeg >nul 2>nul
  if errorlevel 1 (
    echo [MediaScope] FFmpeg was not found in PATH.
    echo Install FFmpeg or set FFMPEG_PATH, then run this file again.
    pause
    exit /b 1
  )
)
if not defined FFPROBE_PATH (
  where ffprobe >nul 2>nul
  if errorlevel 1 (
    echo [MediaScope] FFprobe was not found in PATH.
    echo Install FFmpeg or set FFPROBE_PATH, then run this file again.
    pause
    exit /b 1
  )
)
node server.mjs
pause
