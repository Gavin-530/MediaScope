param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^\d+\.\d+\.\d+-(alpha|beta|rc)(\.\d+)?$')]
  [string]$Version
)
$ErrorActionPreference='Stop'
$project=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$declaredVersion=(Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
if($declaredVersion -ne $Version){throw "Requested version $Version does not match package.json version $declaredVersion"}
$stage=Join-Path $project ".build/MediaScope-$Version"
$archive=Join-Path $project "releases/MediaScope-$Version.zip"
if(Test-Path -LiteralPath $archive){throw "Refusing to overwrite preserved release: $archive"}
if(Test-Path -LiteralPath $stage){throw "Staging directory already exists: $stage"}
New-Item -ItemType Directory -Force $stage,(Join-Path $project 'releases') | Out-Null
foreach($item in @('analysis.mjs','siti.mjs','engine.mjs','server.mjs','package.json','README.md','start.cmd','public')){
  Copy-Item -LiteralPath (Join-Path $project $item) -Destination $stage -Recurse
}
@"
MediaScope $Version / lightweight prerelease build

This package intentionally does not include Node.js, FFmpeg or FFprobe.
Requirements:
- Windows with Node.js 22 or newer available as node in PATH
- FFmpeg and FFprobe available in PATH, or set FFMPEG_PATH and FFPROBE_PATH
- The FFmpeg build should include libvmaf, siti, trace_headers, libx264, libx265 and libaom for all analysis and trial-encode features

Extract the entire ZIP into a writable folder, then double-click start.cmd.
Open http://127.0.0.1:4317 in a browser and keep the command window open.
Media files, reports, private paths and runtime binaries are not included.
This is a prerelease build. A self-contained package is created only for a designated formal release.
"@ | Set-Content -LiteralPath (Join-Path $stage 'TEST-BUILD.txt') -Encoding utf8
$manifest=Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
  [pscustomobject]@{
    path=[System.IO.Path]::GetRelativePath($stage,$_.FullName)
    bytes=$_.Length
    sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'MANIFEST.json') -Encoding utf8
Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Format-List
Write-Output "Staging preserved for verification: $stage"
