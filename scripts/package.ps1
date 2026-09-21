param(
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [switch]$Formal
)
$ErrorActionPreference = 'Stop'
if(-not $Formal){throw 'Full runtime packages are reserved for formal releases. Re-run with -Formal after the version is explicitly designated as formal.'}
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stage = Join-Path $project ".build/MediaScope-$Version-win-x64"
$archive = Join-Path $project "releases/MediaScope-$Version-win-x64.zip"
if(Test-Path -LiteralPath $archive){throw "Refusing to overwrite preserved release: $archive"}
if(Test-Path -LiteralPath $stage){throw "Staging directory already exists: $stage"}
New-Item -ItemType Directory -Force "$stage/runtime", "$stage/licenses", "$project/releases" | Out-Null
foreach($item in @('engine.mjs','server.mjs','package.json','README.md','start.cmd','public','test','scripts')){Copy-Item -LiteralPath (Join-Path $project $item) -Destination $stage -Recurse}
foreach($optional in @('analysis.mjs','siti.mjs','charts.mjs','public/charts.js')){if(Test-Path -LiteralPath (Join-Path $project $optional)){if($optional -notlike 'public/*'){Copy-Item -LiteralPath (Join-Path $project $optional) -Destination $stage}}}
$nodePath = (Get-Command node).Source
$ffmpegPath = (Get-Command ffmpeg).Source
$ffprobePath = (Get-Command ffprobe).Source
Copy-Item -LiteralPath $nodePath -Destination "$stage/runtime/node.exe"
Copy-Item -LiteralPath $ffmpegPath -Destination "$stage/runtime/ffmpeg.exe"
Copy-Item -LiteralPath $ffprobePath -Destination "$stage/runtime/ffprobe.exe"
Copy-Item -LiteralPath (Join-Path $project 'licenses/Node-LICENSE.txt') -Destination "$stage/licenses/Node-LICENSE.txt"
$ffRoot = Split-Path (Split-Path $ffmpegPath)
Copy-Item -LiteralPath "$ffRoot/LICENSE" -Destination "$stage/licenses/FFmpeg-LICENSE.txt"
Copy-Item -LiteralPath "$ffRoot/README.txt" -Destination "$stage/licenses/FFmpeg-build-README.txt"
@'
@echo off
cd /d "%~dp0"
set "PATH=%~dp0runtime;%PATH%"
set "FFMPEG_PATH=%~dp0runtime\ffmpeg.exe"
set "FFPROBE_PATH=%~dp0runtime\ffprobe.exe"
echo Open http://127.0.0.1:4317 in your browser. Keep this window open.
"%~dp0runtime\node.exe" server.mjs
pause
'@ | Set-Content -LiteralPath "$stage/Launch.cmd" -Encoding ascii
@"
MediaScope $Version / Windows x64 portable

Extract the entire ZIP into a writable folder. Double-click Launch.cmd.
Open http://127.0.0.1:4317 in a browser. No Node.js, FFmpeg installation or network is required.
If port 4317 is already in use, stop the other MediaScope instance first.
Media files are not included. Reports and private paths are not included.
Keep all runtime files together. Windows x64 only; this is not an ARM/macOS/Linux package.

The app source is included. Original source entry point: start.cmd.
Bundled runtimes:
$(& $nodePath --version)
$((& $ffmpegPath -version | Select-Object -First 1))
Node.js upstream source and licenses: https://nodejs.org/dist/v24.16.0/
FFmpeg build origin and source information: licenses/FFmpeg-build-README.txt
FFmpeg upstream: https://ffmpeg.org/ ; build vendor: https://www.gyan.dev/ffmpeg/builds/
"@ | Set-Content -LiteralPath "$stage/PORTABLE.txt" -Encoding utf8
$manifest = Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object { [pscustomobject]@{path=[System.IO.Path]::GetRelativePath($stage,$_.FullName);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$stage/MANIFEST.json" -Encoding utf8
Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Format-List
Write-Output "Staging preserved for verification: $stage"
