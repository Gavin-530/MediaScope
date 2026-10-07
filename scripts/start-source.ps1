param(
  [string]$InstallRoot=$(if($env:MEDIASCOPE_HOME){$env:MEDIASCOPE_HOME}else{Join-Path $env:LOCALAPPDATA 'MediaScope'}),
  [switch]$CheckEnvironment
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
  Assert-NoLinks $InstallRoot -Shallow
  $gate=[IO.File]::Open((Join-Path $InstallRoot 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)

  if(!$env:MEDIASCOPE_DATA_DIR){$env:MEDIASCOPE_DATA_DIR=Join-Path $source '.mediascope'}
  $cached=Read-LaunchCache $source $InstallRoot -CheckChanges:$CheckEnvironment
  if($cached){
    Write-Host 'Using the saved runtime; automatic environment checks skipped.'
    Start-MediaScope $source $cached.paths $cached.mode $cached.validation $InstallRoot $InstallRoot $cached.needsValidation ($env:MEDIASCOPE_NO_BROWSER -ne '1')
    exit 0
  }
  $paths=$null;$mode='external'
  try {
    $paths=@{node=(Resolve-Program $null 'node');ffmpeg=(Resolve-Program $null 'ffmpeg');ffprobe=(Resolve-Program $null 'ffprobe')}
    $validation=Test-Environment $source $paths $InstallRoot 2>$null
    Write-Host 'Using verified local Node.js, FFmpeg and FFprobe.'
  } catch {
    $reason=if($paths){'Local programs did not pass the compatibility check.'}else{$_.Exception.Message}
    Write-Host "No compatible local environment: $reason"
    Write-Host 'Preparing the private runtime; first launch requires internet (about 230 MB).'
    $paths=Get-PrivateRuntime $source $InstallRoot
    $mode='private'
    $validation=Test-Environment $source $paths $InstallRoot
  }

  Save-LaunchCache $source $paths $mode $validation $InstallRoot
  Start-MediaScope $source $paths $mode $validation $InstallRoot $InstallRoot $false ($env:MEDIASCOPE_NO_BROWSER -ne '1')
} catch {
  Write-Host "[MediaScope] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if($gate){$gate.Dispose()}
}
