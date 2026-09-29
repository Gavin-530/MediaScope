param(
  [string]$InstallRoot,
  [switch]$Execute,
  [switch]$RemoveData,
  [switch]$RemoveRuntime,
  [switch]$NonInteractive
)
$ErrorActionPreference='Stop'
$rootProvided=$PSBoundParameters.ContainsKey('InstallRoot')
. (Join-Path $PSScriptRoot 'deployment.ps1')
. (Join-Path $PSScriptRoot 'install-location.ps1')
if(!$NonInteractive){Add-Type -AssemblyName System.Windows.Forms}
$source=Split-Path $PSScriptRoot

function Find-TargetRoot {
  if($rootProvided){return [IO.Path]::GetFullPath($InstallRoot)}
  if($env:MEDIASCOPE_HOME){return [IO.Path]::GetFullPath($env:MEDIASCOPE_HOME)}
  $local=Get-SourceInstallRoot $source
  if($local){return $local}
  $registered=Get-RegisteredInstallRoot
  if($registered){return $registered}
  $default=Join-Path $env:LOCALAPPDATA 'MediaScope'
  if(Test-Path -LiteralPath (Join-Path $default 'current.json')){return $default}
  throw 'No MediaScope installation was found'
}
function Assert-UninstallTarget($Root) {
  if(!(Test-Path -LiteralPath (Join-Path $Root 'current.json'))){throw "Installation record missing: $Root"}
  Assert-NoLinks $Root
  $recordPath=Join-Path $Root 'install.json'
  if(Test-Path -LiteralPath $recordPath){
    $record=Read-Json $recordPath
    if($record.schema -ne 1 -or $record.product -ne 'MediaScope'){throw 'Installation marker is invalid'}
  }
  $apps=Join-Path $Root 'apps'
  $versions=@(Get-ChildItem -LiteralPath $apps -Directory -Force)
  if(!$versions.Count){throw 'No installed application versions were found'}
  foreach($app in $versions){$null=Test-App $app.FullName}
  $state=Read-Json (Join-Path $Root 'current.json')
  if($state.current.version -notin @($versions | ForEach-Object Name)){throw 'Active version is missing'}
  return $versions
}
function Open-UninstallGate($Root) {
  $path=Join-Path $Root 'deployment.lock'
  for($attempt=0;$attempt -lt 20;$attempt++){
    try {return [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch {
      if($attempt -eq 19){throw 'MediaScope is still running. Close it before uninstalling.'}
      Start-Sleep -Milliseconds 500
    }
  }
}
function Show-Result($Message,$Failed) {
  Write-Host $Message
  if(!$NonInteractive){
    $icon=if($Failed){[Windows.Forms.MessageBoxIcon]::Error}else{[Windows.Forms.MessageBoxIcon]::Information}
    [Windows.Forms.MessageBox]::Show($Message,'MediaScope 卸载',[Windows.Forms.MessageBoxButtons]::OK,$icon) | Out-Null
  }
}

$root=$null;$gate=$null
try {
  if($Execute -and !$NonInteractive){Start-Sleep -Milliseconds 750}
  $root=Find-TargetRoot
  $root=[IO.Path]::GetFullPath($root).TrimEnd('\')
  if($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')){throw 'A drive root cannot be an installation directory'}
  $gate=Open-UninstallGate $root
  $versions=Assert-UninstallTarget $root
  $markerPath=Join-Path $root 'install.json'
  $marker=if(Test-Path -LiteralPath $markerPath){Read-Json $markerPath}else{$null}
  $runtimeRoot=if($marker -and $marker.runtimeRoot){[IO.Path]::GetFullPath($marker.runtimeRoot)}else{$root}
  if($runtimeRoot -eq [IO.Path]::GetPathRoot($runtimeRoot)){throw 'Runtime root is unsafe'}
  if($Execute){
    if($RemoveRuntime){
      if($runtimeRoot -ne $root -and (Test-Path -LiteralPath (Join-Path $runtimeRoot 'current.json'))){throw 'Shared runtime is used by another installation; leave its cache in place'}
      Assert-NoLinks $runtimeRoot
      $active=@(Get-Process node,ffmpeg,ffprobe -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.StartsWith($runtimeRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)})
      if($active.Count){throw 'A process is still using the shared runtime; close it before removing the cache'}
    }
    Remove-Item -LiteralPath (Join-Path $root 'apps') -Recurse -Force
    foreach($name in @('current.json','install.json')){
      $path=Join-Path $root $name
      if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}
    }
    if($RemoveRuntime){
      $path=Join-Path $runtimeRoot 'runtimes'
      if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}
      if($runtimeRoot -eq $root){
        $runtimeLock=Join-Path $root 'runtime.lock'
        if(Test-Path -LiteralPath $runtimeLock){Remove-Item -LiteralPath $runtimeLock -Force}
      }
    }
    if($RemoveData){
      $path=Join-Path $root 'data'
      if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}
    } else {
      $path=Join-Path $root 'data'
      if((Test-Path -LiteralPath $path) -and @(Get-ChildItem -LiteralPath $path -Force).Count -eq 0){Remove-Item -LiteralPath $path}
    }
    $stagePath=Join-Path $root 'staging'
    if(Test-Path -LiteralPath $stagePath){Remove-Item -LiteralPath $stagePath -Recurse -Force}
    if((Test-Path -LiteralPath (Join-Path $root 'data')) -or (Test-Path -LiteralPath (Join-Path $root 'runtimes'))){
      Write-Json (Join-Path $root 'retained.json') @{schema=1;product='MediaScope';reason='Uninstall retained reports or runtime cache'}
    }
    Unregister-MediaScopeInstall $root
    $gate.Dispose();$gate=$null
    $lockPath=Join-Path $root 'deployment.lock'
    if(Test-Path -LiteralPath $lockPath){Remove-Item -LiteralPath $lockPath -Force}
    if(@(Get-ChildItem -LiteralPath $root -Force).Count -eq 0){Remove-Item -LiteralPath $root}
    $message=if(Test-Path -LiteralPath $root){"MediaScope 已卸载。保留的文件位于：$root"}else{'MediaScope 已卸载。'}
    Show-Result $message $false
    $tempRoot=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'
    if(!$NonInteractive -and $PSScriptRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $PSScriptRoot -Leaf) -match '^MediaScope-Uninstall-[a-f0-9]{32}$'){
      try {Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force}catch {Write-Warning "Temporary uninstall helper remains at $PSScriptRoot"}
    }
  } else {
    if($NonInteractive){throw 'Use -Execute for unattended uninstall'}
    $summary="安装位置：$root`n组件位置：$runtimeRoot`n程序版本：$(@($versions | ForEach-Object Name) -join ', ')`n`n将删除程序。报告和私有组件缓存默认保留。是否继续？"
    if([Windows.Forms.MessageBox]::Show($summary,'MediaScope 卸载',[Windows.Forms.MessageBoxButtons]::OKCancel,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button2) -ne [Windows.Forms.DialogResult]::OK){exit 0}
    $RemoveData=[Windows.Forms.MessageBox]::Show('是否同时删除所有报告和任务文件？默认保留。','MediaScope 卸载',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question,[Windows.Forms.MessageBoxDefaultButton]::Button2) -eq [Windows.Forms.DialogResult]::Yes
    $RemoveRuntime=[Windows.Forms.MessageBox]::Show('是否删除 MediaScope 私有 Node.js 和 FFmpeg 缓存？开发源码若使用它们，下次启动可能需要重新下载。默认保留。','MediaScope 卸载',[Windows.Forms.MessageBoxButtons]::YesNo,[Windows.Forms.MessageBoxIcon]::Question,[Windows.Forms.MessageBoxDefaultButton]::Button2) -eq [Windows.Forms.DialogResult]::Yes
    $helperDir=Join-Path $env:TEMP ('MediaScope-Uninstall-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $helperDir | Out-Null
    foreach($file in @('uninstall.ps1','deployment.ps1','install-location.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $helperDir $file)}
    $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $helperDir 'uninstall.ps1')+'"'),'-Execute','-InstallRoot',('"'+$root+'"'))
    if($RemoveData){$args+='-RemoveData'}
    if($RemoveRuntime){$args+='-RemoveRuntime'}
    $gate.Dispose();$gate=$null
    Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
    Write-Host 'MediaScope 卸载程序已启动；请关闭此窗口，卸载将在窗口关闭后完成。'
  }
} catch {
  Show-Result "[MediaScope] 卸载失败：$($_.Exception.Message)" $true
  exit 1
} finally {if($gate){$gate.Dispose()}}
