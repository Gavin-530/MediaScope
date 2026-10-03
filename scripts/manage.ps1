param(
  [ValidateSet('Install','Launch','Update','External','Recommended','Rollback','Check')][string]$Action='Launch',
  [string]$Archive,
  [string]$InstallRoot,
  [string]$RuntimeRoot=$(if($env:MEDIASCOPE_RUNTIME_HOME){$env:MEDIASCOPE_RUNTIME_HOME}else{Join-Path $env:LOCALAPPDATA 'MediaScope'}),
  [string]$NodePath,[string]$FFmpegPath,[string]$FFprobePath,
  [switch]$NonInteractive
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'deployment.ps1')
. (Join-Path $PSScriptRoot 'install-location.ps1')
if(!$NonInteractive){Add-Type -AssemblyName System.Windows.Forms}
$source=Split-Path $PSScriptRoot
$InstallRoot=Resolve-InstallRoot $source $InstallRoot $PSBoundParameters.ContainsKey('InstallRoot') $Action ([bool]$NonInteractive)
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
if(!$PSBoundParameters.ContainsKey('RuntimeRoot') -and !$env:MEDIASCOPE_RUNTIME_HOME){
  $marker=Join-Path $InstallRoot 'install.json'
  if(Test-Path -LiteralPath $marker){
    $savedRuntime=(Read-Json $marker).runtimeRoot
    if($savedRuntime){$RuntimeRoot=[IO.Path]::GetFullPath($savedRuntime)}
  } elseif(Test-Path -LiteralPath (Join-Path $InstallRoot 'current.json')){
    $prior=Read-Json (Join-Path $InstallRoot 'current.json')
    $nodePath=$prior.current.environment.validation.programs.node.path
    $privatePrefix=[IO.Path]::GetFullPath((Join-Path $InstallRoot 'runtimes')).TrimEnd('\')+'\'
    if($prior.current.environment.mode -eq 'private' -and $nodePath -and $nodePath.StartsWith($privatePrefix,[StringComparison]::OrdinalIgnoreCase)){$RuntimeRoot=$InstallRoot}
  }
}
function Show-EnvironmentPrompt($Message,$Buttons,$DefaultButton=[Windows.Forms.MessageBoxDefaultButton]::Button2) {
  return [Windows.Forms.MessageBox]::Show($Message,'MediaScope 运行环境',$Buttons,[Windows.Forms.MessageBoxIcon]::Information,$DefaultButton)
}
function Save-InstallMarker {
  $path=Join-Path $InstallRoot 'install.json'
  $created=if(Test-Path -LiteralPath $path){(Read-Json $path).createdAt}else{(Get-Date).ToUniversalTime().ToString('o')}
  Write-Json $path @{schema=1;product='MediaScope';runtimeRoot=$RuntimeRoot;createdAt=$created}
  $retained=Join-Path $InstallRoot 'retained.json'
  if(Test-Path -LiteralPath $retained){Remove-Item -LiteralPath $retained -Force}
}
function Select-ExplicitEnvironment($App) {
  try {
    return @{mode='external';paths=@{node=(Resolve-Program $NodePath 'node');ffmpeg=(Resolve-Program $FFmpegPath 'ffmpeg');ffprobe=(Resolve-Program $FFprobePath 'ffprobe')}}
  } catch {
    if(!(Confirm-ExternalFallback $_.Exception.Message)){throw}
    return @{mode='private';paths=(Get-PrivateRuntime $App $RuntimeRoot)}
  }
}
function Select-FirstEnvironment($App) {
  $localPaths=$null;$reason=$null
  try {
    $localPaths=@{node=(Resolve-Program $NodePath 'node');ffmpeg=(Resolve-Program $FFmpegPath 'ffmpeg');ffprobe=(Resolve-Program $FFprobePath 'ffprobe')}
    $null=Test-Environment $App $localPaths $InstallRoot
  } catch {$reason=$_.Exception.Message}
  if($localPaths -and !$reason) {
    Write-Host 'Compatible local Node.js, FFmpeg and FFprobe were found.'
    if(!$NonInteractive) {
      $choice=Show-EnvironmentPrompt "已检测并验证电脑中的 Node.js、FFmpeg 和 FFprobe。`n`n是：使用电脑已有环境（不下载）`n否：下载 MediaScope 推荐的私有环境`n取消：暂不安装" ([Windows.Forms.MessageBoxButtons]::YesNoCancel)
      if($choice -eq [Windows.Forms.DialogResult]::Yes){return @{mode='external';paths=$localPaths}}
      if($choice -eq [Windows.Forms.DialogResult]::Cancel){throw 'Installation cancelled; no environment was selected'}
    }
  } else {
    $detail=if($reason){$reason}else{'未找到全部三个程序'}
    Write-Host "No compatible local environment: $detail"
    if(!$NonInteractive) {
      $choice=Show-EnvironmentPrompt "电脑中没有通过验证的完整运行环境。`n原因：$detail`n`n确定：首次联网下载推荐的私有 Node.js、FFmpeg 和 FFprobe（约 219 MiB）`n取消：暂不安装。不会改动电脑已有环境。" ([Windows.Forms.MessageBoxButtons]::OKCancel) ([Windows.Forms.MessageBoxDefaultButton]::Button1)
      if($choice -ne [Windows.Forms.DialogResult]::OK){throw 'Installation cancelled; no environment was selected'}
    }
  }
  return @{mode='private';paths=(Get-PrivateRuntime $App $RuntimeRoot)}
}
function Confirm-ExternalFallback($Reason) {
  if($NonInteractive -or $Action -notin @('Launch','Install','External','Update','Rollback')){return $false}
  $choice=Show-EnvironmentPrompt "电脑已有环境验证失败：`n$Reason`n`n是否改用 MediaScope 推荐的私有环境？若尚未安装，将先联网下载并校验。`n点击否：保留原选择并停止。" ([Windows.Forms.MessageBoxButtons]::YesNo)
  return $choice -eq [Windows.Forms.DialogResult]::Yes
}
function Validate-SelectedEnvironment($App,$Paths,$Mode) {
  try {$validation=Test-Environment $App $Paths $InstallRoot}
  catch {
    if($Mode -ne 'external' -or !(Confirm-ExternalFallback $_.Exception.Message)){throw}
    Write-Host 'Switching to the recommended private environment by user choice.'
    $Paths=Get-PrivateRuntime $App $RuntimeRoot
    $Mode='private'
    $validation=Test-Environment $App $Paths $InstallRoot
  }
  return @{mode=$Mode;paths=$Paths;validation=$validation}
}
$gate=$null
try {
  if(![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){throw 'MediaScope supports Windows x64 only'}
  New-Item -ItemType Directory -Force $InstallRoot,$RuntimeRoot | Out-Null
  Assert-NoLinks $InstallRoot -Shallow:($Action -eq 'Launch')
  if($RuntimeRoot -ne $InstallRoot){Assert-NoLinks $RuntimeRoot -Shallow:($Action -eq 'Launch')}
  foreach($dir in @('apps','data','staging')){New-Item -ItemType Directory -Force (Join-Path $InstallRoot $dir) | Out-Null}
  foreach($dir in @('runtimes','staging')){New-Item -ItemType Directory -Force (Join-Path $RuntimeRoot $dir) | Out-Null}
  # Process lifetime lock: prevents upgrades or competing launches while this app is running.
  $gate=[IO.File]::Open((Join-Path $InstallRoot 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $statePath=Join-Path $InstallRoot 'current.json'
  $state=if(Test-Path -LiteralPath $statePath){Read-Json $statePath}else{$null}
  if($Action -eq 'Update'){
    if(!$Archive){throw 'Update requires -Archive <new package.zip>'}
    $expanded=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N'))"
    Expand-SafeZip (Resolve-Path -LiteralPath $Archive).Path $expanded
    $children=@(Get-ChildItem -LiteralPath $expanded -Force)
    if($children.Count -ne 1 -or !$children[0].PSIsContainer){throw 'Expected one package root directory'}
    $source=$children[0].FullName
  }
  $sourceManifest=$null
  $installPackage=$Action -in @('Install','Update') -or !$state
  if($Action -eq 'Launch' -and $state -and !(Get-SourceInstallRoot $source)){
    # A newly extracted ZIP is an explicit version choice. An installed copy of
    # start.cmd always launches the currently selected version instead.
    $sourceManifest=Test-App $source
    $activeManifest=Join-Path $InstallRoot "apps/$($state.current.version)/MANIFEST.json"
    if($sourceManifest.version -ne $state.current.version -or
       !(Test-Path -LiteralPath $activeManifest) -or
       (Get-FileHash -LiteralPath (Join-Path $source 'MANIFEST.json')).Hash -ne (Get-FileHash -LiteralPath $activeManifest).Hash){
      $installPackage=$true
    }
  }
  if($installPackage){
    $manifest=if($sourceManifest){$sourceManifest}else{Test-App $source}
    $app=Join-Path $InstallRoot "apps/$($manifest.version)"
    if(Test-Path -LiteralPath $app){
      $null=Test-App $app
      if((Get-FileHash (Join-Path $source 'MANIFEST.json')).Hash -ne (Get-FileHash (Join-Path $app 'MANIFEST.json')).Hash){throw 'Refusing to overwrite an installed version; increment the version'}
    } else {
      $stage=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N'))"
      Copy-Item -LiteralPath $source -Destination $stage -Recurse
      $null=Test-App $stage
      # This directory is immutable; current.json is not changed until all tests pass.
      [IO.Directory]::Move($stage,$app)
    }
    $selection=if($state){$state.current.environment}else{$null}
    if($Action -eq 'External'){
      $explicit=Select-ExplicitEnvironment $app;$paths=$explicit.paths;$mode=$explicit.mode
    } elseif(!$state) {
      $first=Select-FirstEnvironment $app;$paths=$first.paths;$mode=$first.mode
    } else {$paths=Get-SelectedPaths $selection $app $RuntimeRoot;$mode=$selection.mode}
    $selected=Validate-SelectedEnvironment $app $paths $mode
    $next=@{version=$manifest.version;environment=@{mode=$selected.mode;validation=$selected.validation}}
    $previous=if($state -and $state.current.version -ne $next.version){$state.current}elseif($state){$state.previous}else{$null}
    Write-Json $statePath @{current=$next;previous=$previous}
    Save-LaunchCache $app $selected.paths $selected.mode $selected.validation $InstallRoot
    Save-InstallMarker
    $state=Read-Json $statePath
    if(!$NonInteractive){Register-MediaScopeInstall $InstallRoot $manifest.version}
    Write-Host "Installed and verified MediaScope $($manifest.version). Data: $(Join-Path $InstallRoot 'data')"
    if($Action -in @('Install','Update','External')){exit 0}
  }
  if($Action -eq 'Rollback'){
    if(!$state.previous){throw 'No previous installation'}
    $candidate=$state.previous
  } else {$candidate=$state.current}
  $app=Safe-Path (Join-Path $InstallRoot 'apps') $candidate.version
  if($Action -ne 'Launch'){$null=Test-App $app}
  if($Action -eq 'Launch'){
    $cached=Read-LaunchCache $app $InstallRoot $candidate.environment
    if($cached){
      $env:MEDIASCOPE_DATA_DIR=Join-Path $InstallRoot 'data'
      Write-Host 'Using the saved runtime; automatic environment checks skipped.'
      Start-MediaScope $app $cached.paths $cached.mode $cached.validation $InstallRoot $RuntimeRoot $cached.needsValidation (!$NonInteractive -and $env:MEDIASCOPE_NO_BROWSER -ne '1') $statePath
      exit 0
    }
  }
  if($Action -eq 'Launch'){$null=Test-App $app}
  if($Action -eq 'External'){
    $explicit=Select-ExplicitEnvironment $app;$paths=$explicit.paths;$mode=$explicit.mode
  } elseif($Action -eq 'Recommended'){$paths=Get-PrivateRuntime $app $RuntimeRoot;$mode='private'}
  else {$paths=Get-SelectedPaths $candidate.environment $app $RuntimeRoot;$mode=$candidate.environment.mode}
  $selected=Validate-SelectedEnvironment $app $paths $mode
  $paths=$selected.paths;$mode=$selected.mode
  $next=@{version=$candidate.version;environment=@{mode=$mode;validation=$selected.validation}}
  $previous=if($Action -eq 'Rollback'){$state.current}else{$state.previous}
  Write-Json $statePath @{current=$next;previous=$previous}
  Save-LaunchCache $app $paths $mode $selected.validation $InstallRoot
  Save-InstallMarker
  if(!$NonInteractive -and $Action -in @('Launch','Rollback')){Register-MediaScopeInstall $InstallRoot $candidate.version}
  Write-Host "Verified $mode environment. Audit: $statePath"
  if($Action -eq 'Launch'){
    $env:FFMPEG_PATH=$paths.ffmpeg;$env:FFPROBE_PATH=$paths.ffprobe;$env:MEDIASCOPE_DATA_DIR=Join-Path $InstallRoot 'data'
    Start-MediaScope $app $paths $mode $selected.validation $InstallRoot $RuntimeRoot $false (!$NonInteractive -and $env:MEDIASCOPE_NO_BROWSER -ne '1') $statePath
  }
} catch {Write-Host "[MediaScope] $($_.Exception.Message)" -ForegroundColor Red;exit 1}
finally {if($gate){$gate.Dispose()}}
