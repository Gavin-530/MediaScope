param([string]$Archive,[switch]$Online,[string]$ResultPath)
. (Join-Path $PSScriptRoot 'deployment.ps1')
$script:checks=@()
function Save-DeploymentResult([string]$Outcome,[string]$Failure) {
  if($ResultPath){Write-Json $ResultPath @{schema=1;outcome=$Outcome;online=[bool]$Online;checks=@($script:checks);failure=$Failure;finishedAtUtc=(Get-Date).ToUniversalTime().ToString('o')}}
}
trap {Save-DeploymentResult 'failed' $_.Exception.Message;throw $_}
$project=Split-Path $PSScriptRoot
$work=Join-Path $project ('.build/deployment-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
$homeDir=Join-Path $work 'home with spaces'
$script:passed=0
function Assert($Value,$Message){$script:checks+=@{name=$Message;status=$(if($Value){'passed'}else{'failed'})};if(!$Value){throw "FAIL: $Message"};$script:passed++;Write-Host "PASS: $Message"}
function Manifest($App,$Version){
  $pkg=Read-Json (Join-Path $App 'package.json');$pkg.version=$Version;Write-Json (Join-Path $App 'package.json') $pkg
  $existing=Join-Path $App 'MANIFEST.json';if(Test-Path $existing){Remove-Item -LiteralPath $existing}
  Write-Json $existing @{schema=1;platform='win32-x64';version=$Version;files=@(Get-TreeRecords $App)}
}
function Invoke-Manager($App,$Action,$Extra=@(),$Expected=0){
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $App 'scripts/manage.ps1') -InstallRoot $homeDir -RuntimeRoot $homeDir -Action $Action -NonInteractive @Extra
  Assert ($LASTEXITCODE -eq $Expected) "$Action exit=$Expected"
}
if($Archive){
  Expand-SafeZip (Resolve-Path $Archive).Path (Join-Path $work 'package')
  $app=(Get-ChildItem (Join-Path $work 'package') -Directory)[0].FullName
} else {
  $app=Join-Path $work 'app';New-Item -ItemType Directory -Force $app,(Join-Path $app 'scripts') | Out-Null
  foreach($item in @('analysis.mjs','siti.mjs','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')){Copy-Item (Join-Path $project $item) $app -Recurse}
  foreach($item in @('deployment.ps1','manage.ps1','install-location.ps1','uninstall.ps1','check-environment.mjs')){Copy-Item (Join-Path $PSScriptRoot $item) (Join-Path $app 'scripts')}
  Manifest $app (Read-Json (Join-Path $project 'package.json')).version
}
$null=Test-App $app
Assert ((@(Get-ChildItem -LiteralPath $app -Filter '*.cmd' -File | ForEach-Object Name | Sort-Object) -join ',') -eq 'start.cmd,Uninstall.cmd') 'package exposes only launch and uninstall CMD files'
$baseVersion=(Read-Json (Join-Path $app 'package.json')).version
$parts=$baseVersion.Split('-')[0].Split('.')
$suffix=if($baseVersion -match '-'){ '-beta' }else{ '' }
$nextVersion="$($parts[0]).$($parts[1]).$([int]$parts[2]+1)$suffix"
$incompatibleVersion="$($parts[0]).$($parts[1]).$([int]$parts[2]+2)$suffix"
if(!$Online){
  # Transport fixture copies the REAL pinned upstream archives; no fake executable or bypassed hash.
  foreach($dir in @('runtimes','staging')){New-Item -ItemType Directory -Force (Join-Path $homeDir $dir) | Out-Null}
  $script:downloads=0
  function Invoke-WebRequest($Uri,$OutFile,$TimeoutSec,[switch]$UseBasicParsing){
    $script:downloads++;$name=if($Uri -match 'nodejs'){'node'}else{'ffmpeg'}
    $fixture=if($Uri -match '\?revision=2$'){Join-Path $work 'node-revision.zip'}else{Join-Path $project ".build/downloads/$name.zip"}
    Copy-Item -LiteralPath $fixture -Destination $OutFile
  }
  $null=Get-PrivateRuntime $app $homeDir
  Assert ($script:downloads -eq 2) 'first deployment downloads exactly two locked components'
  $null=Get-PrivateRuntime $app $homeDir
  Assert ($script:downloads -eq 2) 'compatible runtime reuse performs zero downloads'
  $delta=Join-Path $work 'delta';Copy-Item $app $delta -Recurse
  $revised=Join-Path $work 'node-revision.zip';Copy-Item (Join-Path $project '.build/downloads/node.zip') $revised
  $stream=[IO.File]::Open($revised,[IO.FileMode]::Append);try{$stream.WriteByte(0)}finally{$stream.Dispose()}
  $lock=Read-Json (Join-Path $delta 'runtime-lock.json');$lock.components[0].sha256=(Get-FileHash $revised).Hash.ToLowerInvariant();$lock.components[0].url+='?revision=2';Write-Json (Join-Path $delta 'runtime-lock.json') $lock
  $null=Get-PrivateRuntime $delta $homeDir
  Assert ($script:downloads -eq 3) 'a changed Node archive downloads only Node; FFmpeg is reused'
  $bad=Join-Path $work 'bad-lock';Copy-Item $app $bad -Recurse
  $lock=Read-Json (Join-Path $bad 'runtime-lock.json');$lock.components[0].sha256='0'*64;Write-Json (Join-Path $bad 'runtime-lock.json') $lock
  $failed=$false;try{$null=Get-PrivateRuntime $bad $homeDir}catch{$failed=$_.Exception.Message -match 'SHA-256'}
  Assert $failed 'corrupt download rejected before activation'
  Assert (!(Test-Path (Join-Path $homeDir ('runtimes/'+('0'*64))))) 'corrupt download never becomes an installed runtime'
  Remove-Item Function:Invoke-WebRequest
}
$savedPath=$env:PATH
try {
  $env:PATH="$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  Invoke-Manager $app Install
} finally {$env:PATH=$savedPath}
Assert $true 'bootstrap installs without Node or FFmpeg on PATH'
$stateFile=Join-Path $homeDir 'current.json'
$state=Read-Json $stateFile
Assert ($state.current.environment.mode -eq 'private') 'private environment is default'
$data=Join-Path $homeDir 'data/user-report.json';'user report: preserve' | Set-Content $data
$original=(Get-FileHash $stateFile).Hash
Invoke-Manager $app Check
$state=Read-Json $stateFile
$node=$state.current.environment.validation.programs.node.path
$ffmpeg=$state.current.environment.validation.programs.ffmpeg.path
$ffprobe=$state.current.environment.validation.programs.ffprobe.path
$external=Join-Path $work 'external';New-Item -ItemType Directory $external | Out-Null
Copy-Item $node,$ffmpeg,$ffprobe $external
$externalArgs=@('-NodePath',(Join-Path $external 'node.exe'),'-FFmpegPath',(Join-Path $external 'ffmpeg.exe'),'-FFprobePath',(Join-Path $external 'ffprobe.exe'))
Invoke-Manager $app External $externalArgs
Assert ((Read-Json $stateFile).current.environment.validation.programs.node.sha256.Length -eq 64) 'external paths, versions and hashes audited'
$primaryHome=$homeDir
try {
  $homeDir=Join-Path $work 'external-first'
  Invoke-Manager $app External $externalArgs
  Assert (@(Get-ChildItem (Join-Path $homeDir 'runtimes') -Force).Count -eq 0) 'first external installation downloads no private runtime'
  'keep report' | Set-Content (Join-Path $homeDir 'data/report.txt')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts/uninstall.ps1') -InstallRoot $homeDir -Execute -NonInteractive
  Assert ($LASTEXITCODE -eq 0) 'dedicated uninstaller exits successfully'
  Assert (!(Test-Path (Join-Path $homeDir 'apps')) -and !(Test-Path (Join-Path $homeDir 'current.json'))) 'uninstaller removes application and installation state'
  Assert ((Get-Content (Join-Path $homeDir 'data/report.txt')) -eq 'keep report') 'uninstaller preserves reports by default'
} finally {$homeDir=$primaryHome}
$separateHome=Join-Path $work 'separate-program-location'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts/manage.ps1') -InstallRoot $separateHome -RuntimeRoot $primaryHome -Action Install -NonInteractive
Assert ($LASTEXITCODE -eq 0) 'custom program location installs with shared runtime root'
Assert (!(Test-Path (Join-Path $separateHome 'runtimes'))) 'custom program location does not duplicate private components'
$sharedState=Read-Json (Join-Path $separateHome 'current.json')
Assert ($sharedState.current.environment.validation.programs.node.path.StartsWith((Join-Path $primaryHome 'runtimes'),[StringComparison]::OrdinalIgnoreCase)) 'custom installation records shared component path'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $separateHome "apps/$baseVersion/scripts/manage.ps1") -RuntimeRoot $primaryHome -Action Check -NonInteractive
Assert ($LASTEXITCODE -eq 0) 'installed launcher rediscovers custom program location'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts/uninstall.ps1') -InstallRoot $separateHome -Execute -RemoveRuntime -NonInteractive
Assert ($LASTEXITCODE -eq 1 -and (Test-Path (Join-Path $separateHome 'current.json'))) 'uninstaller refuses to remove shared runtime used by another installation without removing the app'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts/uninstall.ps1') -InstallRoot $separateHome -Execute -NonInteractive
Assert ($LASTEXITCODE -eq 0 -and !(Test-Path (Join-Path $separateHome 'apps'))) 'uninstaller removes custom program and retains shared runtime'
$before=(Get-FileHash $stateFile).Hash
[IO.File]::WriteAllText((Join-Path $external 'ffprobe.exe'),'damaged')
Invoke-Manager $app Check @() 1
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'external failure keeps selection; no silent fallback'
Invoke-Manager $app Recommended
Assert ((Read-Json $stateFile).current.environment.mode -eq 'private') 'explicit switch back to recommended runtime'
$before=(Get-FileHash $stateFile).Hash
Invoke-Manager $app External @('-NodePath',$node,'-FFmpegPath',$ffprobe,'-FFprobePath',$ffprobe) 1
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'external executable without required FFmpeg capabilities rejected without changing selection'
$next=Join-Path $work 'next';Copy-Item $app $next -Recurse;Manifest $next $nextVersion
$zip=Join-Path $work 'next.zip';Compress-Archive -LiteralPath $next -DestinationPath $zip
Invoke-Manager $app Update @('-Archive',$zip)
Assert ((Read-Json $stateFile).current.version -eq $nextVersion) 'upgrade activates verified application'
Assert ((Get-Content $data) -eq 'user report: preserve') 'upgrade preserves user report'
Assert (Test-Path (Join-Path $homeDir "apps/$baseVersion/server.mjs")) 'old version preserved'
Invoke-Manager $app Rollback
Assert ((Read-Json $stateFile).current.version -eq $baseVersion) 'rollback revalidates and restores old version'
$media=Join-Path $work 'launch-fixture.mkv'
& $ffmpeg -v error -nostdin -f lavfi -i 'testsrc2=size=64x64:rate=4:duration=0.5' -c:v libx264 $media
if($LASTEXITCODE -ne 0){throw 'Could not generate launch fixture'}
& $node (Join-Path $PSScriptRoot 'test-launch.mjs') $next $homeDir $media $nextVersion
Assert ($LASTEXITCODE -eq 0) 'launching a newly extracted package activates that version'
& $node (Join-Path $PSScriptRoot 'test-launch.mjs') (Join-Path $homeDir "apps/$baseVersion") $homeDir $media $nextVersion
Assert ($LASTEXITCODE -eq 0) 'installed launcher starts the selected version'
Invoke-Manager $app Rollback
Assert ((Read-Json $stateFile).current.version -eq $baseVersion) 'rollback remains available internally'
$before=(Get-FileHash $stateFile).Hash
$incompatible=Join-Path $work 'incompatible';Copy-Item $app $incompatible -Recurse
$lock=Read-Json (Join-Path $incompatible 'runtime-lock.json');$lock.nodeMajors=@(99);Write-Json (Join-Path $incompatible 'runtime-lock.json') $lock;Manifest $incompatible $incompatibleVersion
$zip=Join-Path $work 'incompatible.zip';Compress-Archive -LiteralPath $incompatible -DestinationPath $zip
Invoke-Manager $app Update @('-Archive',$zip) 1
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'incompatible upgrade leaves old pointer intact'
'broken' | Add-Content (Join-Path $next 'server.mjs')
$zip=Join-Path $work 'corrupt.zip';Compress-Archive -LiteralPath $next -DestinationPath $zip
Invoke-Manager $app Update @('-Archive',$zip) 1
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'corrupt application archive leaves old pointer intact'
$same=Join-Path $work 'same-version';Copy-Item $app $same -Recurse
'different content' | Add-Content (Join-Path $same 'README.md');Manifest $same $baseVersion
$zip=Join-Path $work 'same-version.zip';Compress-Archive -LiteralPath $same -DestinationPath $zip
Invoke-Manager $app Update @('-Archive',$zip) 1
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'same version cannot overwrite installed content'
$failed=$false;try{$null=Safe-Path $work '../escape'}catch{$failed=$true};Assert $failed 'path traversal rejected'
$failed=$false;try{$null=Safe-Path $work 'C:/escape'}catch{$failed=$true};Assert $failed 'absolute archive paths rejected'
$zip=Join-Path $work 'traversal.zip'
$z=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try{$null=$z.CreateEntry('../escaped.txt')}finally{$z.Dispose()}
Invoke-Manager $app Update @('-Archive',$zip) 1
Assert (!(Test-Path (Join-Path $homeDir 'escaped.txt'))) 'ZIP traversal cannot write outside staging'
$lockHandle=[IO.File]::Open((Join-Path $homeDir 'deployment.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{Invoke-Manager $app Check @() 1}finally{$lockHandle.Dispose()}
Assert ((Get-FileHash $stateFile).Hash -eq $before) 'concurrent deployment refused without changing current version'
Invoke-Manager $app Check
 $beforeDamage=(Get-FileHash $stateFile).Hash
 $stream=[IO.File]::Open($node,[IO.FileMode]::Append);try{$stream.WriteByte(0)}finally{$stream.Dispose()}
 try {
   Invoke-Manager $app Check @() 1
   Assert ((Get-FileHash $stateFile).Hash -eq $beforeDamage) 'private runtime corruption is rejected without changing current version'
 } finally {Copy-Item -LiteralPath (Join-Path $external 'node.exe') -Destination $node -Force}
 Invoke-Manager $app Check
 & $node (Join-Path $PSScriptRoot 'test-launch.mjs') $app $homeDir $media
 Assert ($LASTEXITCODE -eq 0) 'packaged launcher HTTP and separate report storage'
Write-Host "Deployment verification: $script:passed passed. Evidence preserved: $work"
Save-DeploymentResult 'passed' $null
