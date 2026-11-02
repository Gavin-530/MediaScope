param([ValidateSet('Prepare','Refresh','PackageVersion','Update','Rollback','Lock','UnlockCheck')][string]$Action,[string]$App,[string]$Work,[string]$HomeRoot,[string]$RuntimeRoot,[string]$NodePath,[string]$FFmpegPath,[string]$FFprobePath,[string]$File,[string]$Version)
$ErrorActionPreference='Stop'
. (Join-Path $App 'scripts/deployment.ps1')
if($Action -eq 'Lock'){
  $gate=[IO.File]::Open($File,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{[Console]::WriteLine('LOCKED');[Console]::ReadLine() | Out-Null}finally{$gate.Dispose()}
  exit 0
}
if($Action -eq 'UnlockCheck'){$gate=[IO.File]::Open($File,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$gate.Dispose();exit 0}
if($Action -eq 'Refresh'){
  $gate=[IO.File]::Open((Join-Path $HomeRoot 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try{Update-FastLaunchHint $App $HomeRoot $RuntimeRoot $(if(Test-Path -LiteralPath (Join-Path $App 'MANIFEST.json')){Join-Path $HomeRoot 'current.json'}else{$null})}finally{$gate.Dispose()}
  exit 0
}
if($Action -in @('Update','Rollback')){
  $extra=if($Action -eq 'Update'){@('-Archive',$File)}else{@()}
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $App 'scripts/manage.ps1') -Action $Action -InstallRoot $HomeRoot -RuntimeRoot $RuntimeRoot -NonInteractive @extra
  exit $LASTEXITCODE
}
function Save-TestManifest($Directory){
  $manifest=Join-Path $Directory 'MANIFEST.json'
  if(Test-Path -LiteralPath $manifest){[IO.File]::Delete($manifest)}
  Write-Json $manifest @{schema=1;version=(Read-Json (Join-Path $Directory 'package.json')).version;platform='win32-x64';files=@(Get-TreeRecords $Directory)}
  $null=Test-App $Directory
}
if($Action -eq 'PackageVersion'){
  $pkg=Read-Json (Join-Path $App 'package.json');$pkg.version=$Version;Write-Json (Join-Path $App 'package.json') $pkg
  Save-TestManifest $App
  Compress-Archive -LiteralPath $App -DestinationPath $File
  exit 0
}
$source=Join-Path $Work "源 [x] & ! % '"
$package=Join-Path $source '.build/package'
foreach($directory in @($source,(Join-Path $source 'scripts'),(Join-Path $HomeRoot 'staging'))){[IO.Directory]::CreateDirectory($directory) | Out-Null}
$items=@('analysis.mjs','repeat.mjs','repeat-samples.mjs','bd-measure.mjs','siti.mjs','gpu','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')
foreach($item in $items){Copy-Item -LiteralPath (Join-Path $App $item) -Destination $source -Recurse}
$scripts=@('deployment.ps1','manage.ps1','install-location.ps1','uninstall.ps1','check-environment.mjs','desktop.mjs','runtime-data.mjs','time.mjs','validate-launch.ps1','start-source.ps1','fast-launch.ps1','fast-bootstrap.mjs','build-launcher.ps1','launcher')
foreach($item in $scripts){Copy-Item -LiteralPath (Join-Path $App "scripts/$item") -Destination (Join-Path $source 'scripts') -Recurse}
$nodeCopy=Join-Path $Work "components/Node 中文 [x] & ! % '/node.exe"
[IO.Directory]::CreateDirectory((Split-Path $nodeCopy)) | Out-Null
Copy-Item -LiteralPath $NodePath -Destination $nodeCopy
$paths=@{node=$nodeCopy;ffmpeg=(Resolve-Program $FFmpegPath 'ffmpeg');ffprobe=(Resolve-Program $FFprobePath 'ffprobe')}
$validation=Test-Environment $source $paths $HomeRoot
Save-LaunchCache $source $paths 'external' $validation $HomeRoot
$gate=[IO.File]::Open((Join-Path $HomeRoot 'deployment.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{Update-FastLaunchHint $source $HomeRoot $HomeRoot $null}finally{$gate.Dispose()}
$cache=Get-LaunchCachePath $source $HomeRoot
if(!(Test-Path -LiteralPath ([IO.Path]::ChangeExtension($cache,'.fast')))){throw 'Source fast hint was not created'}
[IO.Directory]::CreateDirectory((Join-Path $package 'scripts')) | Out-Null
foreach($item in $items){Copy-Item -LiteralPath (Join-Path $source $item) -Destination $package -Recurse}
foreach($item in $scripts | Where-Object {$_ -notin @('start-source.ps1','build-launcher.ps1','launcher')}){Copy-Item -LiteralPath (Join-Path $source "scripts/$item") -Destination (Join-Path $package 'scripts')}
$null=& (Join-Path $source 'scripts/build-launcher.ps1') -OutputDirectory (Join-Path $package 'scripts')
Save-TestManifest $package
$client=Join-Path $Work "client 中文 [x] & ! % '"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'scripts/manage.ps1') -Action External -InstallRoot $client -RuntimeRoot $RuntimeRoot -NodePath $nodeCopy -FFmpegPath $paths.ffmpeg -FFprobePath $paths.ffprobe -NonInteractive
if($LASTEXITCODE -ne 0){throw 'Isolated external installation failed'}
$version=(Read-Json (Join-Path $source 'package.json')).version
$result=@{source=$source;sourceHome=$HomeRoot;sourceCache=$cache;node=$nodeCopy;ffmpeg=$paths.ffmpeg;ffprobe=$paths.ffprobe;package=$package;client=$client;installed=(Join-Path $client "apps/$version");runtime=$RuntimeRoot;version=$version}
Write-Json (Join-Path $Work 'fixture.json') $result
