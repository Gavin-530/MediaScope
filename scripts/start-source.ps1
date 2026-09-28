param(
  [string]$InstallRoot=$(if($env:MEDIASCOPE_HOME){$env:MEDIASCOPE_HOME}else{Join-Path $env:LOCALAPPDATA 'MediaScope'})
)

$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'deployment.ps1')

$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
$gate=$null
try {
  if(![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){
    throw 'MediaScope supports Windows x64 only'
  }
  if($InstallRoot.TrimEnd('\') -eq $source.TrimEnd('\')){
    throw 'MEDIASCOPE_HOME must not point to the source checkout'
  }
  foreach($dir in @('runtimes','staging')){
    New-Item -ItemType Directory -Force (Join-Path $InstallRoot $dir) | Out-Null
  }
  Assert-NoLinks $InstallRoot
  $gate=[IO.File]::Open((Join-Path $InstallRoot 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)

  $paths=$null
  try {
    $paths=@{node=(Resolve-Program $null 'node');ffmpeg=(Resolve-Program $null 'ffmpeg');ffprobe=(Resolve-Program $null 'ffprobe')}
    $null=Test-Environment $source $paths $InstallRoot 2>$null
    Write-Host 'Using verified local Node.js, FFmpeg and FFprobe.'
  } catch {
    $reason=if($paths){'Local programs did not pass the compatibility check.'}else{$_.Exception.Message}
    Write-Host "No compatible local environment: $reason"
    Write-Host 'Preparing the private runtime; first launch requires internet (about 219 MiB).'
    $paths=Get-PrivateRuntime $source $InstallRoot
    $null=Test-Environment $source $paths $InstallRoot
  }

  $env:FFMPEG_PATH=$paths.ffmpeg
  $env:FFPROBE_PATH=$paths.ffprobe
  if(!$env:MEDIASCOPE_DATA_DIR){$env:MEDIASCOPE_DATA_DIR=Join-Path $source '.mediascope'}
  & $paths.node (Join-Path $source 'server.mjs')
  if($LASTEXITCODE -ne 0){throw "Application exited with code $LASTEXITCODE"}
} catch {
  Write-Host "[MediaScope] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if($gate){$gate.Dispose()}
}
