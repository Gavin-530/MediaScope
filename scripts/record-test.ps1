param(
  [Parameter(Mandatory=$true)][ValidateSet('App','Package','OnlineDeployment','Custom')][string]$Kind,
  [string]$Archive,
  [string]$Executable,
  [string[]]$Arguments=@(),
  [string]$Label,
  [ValidateRange(1,256)][int]$MaxLogMiB=16,
  [ValidateRange(1,1048576)][int]$WarnTotalMiB=1024,
  [switch]$RequireClean,
  [switch]$Release
)

$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($Release -and $Kind -ne 'App'){throw '-Release is only valid for App; package/deployment checks use -RequireClean'}
if($Kind -eq 'App'){
  if($Archive -or $Executable -or $Arguments.Count -or $Label){throw 'App uses scripts/test.mjs; custom commands must use -Kind Custom'}
  $node=if($env:MEDIASCOPE_NODE_PATH){$env:MEDIASCOPE_NODE_PATH}else{'node'}
  $testArgs=@((Join-Path $PSScriptRoot 'test.mjs'),'--max-log-mib',"$MaxLogMiB",'--warn-total-mib',"$WarnTotalMiB")
  if($RequireClean){$testArgs+='--require-clean'}
  if($Release){$testArgs+='--release'}
  & $node @testArgs
  exit $LASTEXITCODE
}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
New-Item -ItemType Directory -Force -Path (Join-Path $project '.build') | Out-Null
try {$gate=[IO.File]::Open((Join-Path $project '.build/evidence-recording.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
catch {throw 'Another evidence recording is already running'}
try {
$catalogPath=Join-Path $root 'catalog.json'
if(Test-Path -LiteralPath $catalogPath){$null=Test-EvidenceCatalog $root}
elseif(@(Get-EvidenceRecords $root).Count){throw "Evidence catalog missing: $catalogPath"}
$version=(Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if($version -notmatch '^\d+\.\d+\.\d+(-(alpha|beta|rc)(\.\d+)?)?$'){throw 'Invalid package version'}
$package=$null
if($Kind -in @('Package','OnlineDeployment')){
  if(!$Archive){throw '-Archive is required for package and deployment tests'}
  $archivePath=(Resolve-Path -LiteralPath $Archive).Path
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip=[IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entries=@($zip.Entries | Where-Object {$_.FullName.Replace('\','/') -match '(^|/)MANIFEST\.json$'})
    if($entries.Count -ne 1){throw 'Package must contain exactly one MANIFEST.json'}
    $reader=[IO.StreamReader]::new($entries[0].Open(),[Text.Encoding]::UTF8)
    try {$packageManifest=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
  } finally {$zip.Dispose()}
  if($packageManifest.version -notmatch '^\d+\.\d+\.\d+(-(alpha|beta|rc)(\.\d+)?)?$'){throw 'Invalid package manifest version'}
  $version=$packageManifest.version
  $package=@{path=$archivePath;bytes=(Get-Item -LiteralPath $archivePath).Length;sha256=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash;manifestVersion=$version}
}
$gitCommit=(& git -C $project rev-parse HEAD).Trim()
$gitStatus=@(& git -C $project status --porcelain=v1 --untracked-files=normal)
if($RequireClean -and $gitStatus.Count){throw 'The source tree is not clean'}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$staging=Join-Path $project ".build/evidence-staging/$runId"
$localRun=Join-Path $root "runs/$version/$runId"
$log=Join-Path $staging 'output.log'
$runtime=$null
$start=(Get-Date).ToUniversalTime()
switch($Kind){
  'Package' {$Executable=(Get-Command powershell.exe -CommandType Application).Source;$Arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $project 'scripts/verify-release.ps1'),'-Archive',$archivePath,'-Deployment')}
  'OnlineDeployment' {$Executable=(Get-Command powershell.exe -CommandType Application).Source;$Arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $project 'scripts/test-deployment.ps1'),'-Archive',$archivePath,'-Online')}
  'Custom' {
    if(!$Executable){throw '-Executable is required for custom tests'}
    $Executable=(Resolve-Path -LiteralPath $Executable).Path
    if([IO.Path]::GetExtension($Executable) -notin @('.exe','.cmd','.bat')){throw 'Custom tests require an executable or CMD file; run PowerShell scripts through powershell.exe -File'}
    if(!$Label){throw '-Label is required for custom tests'}
  }
}

New-Item -ItemType Directory -Force -Path $staging | Out-Null
$harness=$null
if($Kind -in @('Package','OnlineDeployment')){
  # Preserve the exact verifier sources even for a dirty checkout.
  $harnessRoot=Join-Path $staging 'harness'
  New-Item -ItemType Directory -Path $harnessRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $project 'scripts') -Destination $harnessRoot -Recurse
  Copy-Item -LiteralPath (Join-Path $project 'runtime-lock.json') -Destination $harnessRoot
  $harnessFiles=@(Get-EvidenceFiles $harnessRoot | ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full -Algorithm SHA256).Hash}})
  [IO.File]::WriteAllText((Join-Path $staging 'harness-manifest.json'),($harnessFiles | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
  [IO.Compression.ZipFile]::CreateFromDirectory($harnessRoot,(Join-Path $staging 'harness.zip'),[IO.Compression.CompressionLevel]::Optimal,$false)
  Remove-Item -LiteralPath $harnessRoot -Recurse -Force
  $harness=@{archive='harness.zip';files='harness-manifest.json';commit=$gitCommit;workingTree=$gitStatus}
  $Arguments+=@('-ResultPath',(Join-Path $staging 'deployment-results.json'))
}
$buildRoot=[IO.Path]::GetFullPath((Join-Path $project '.build')).TrimEnd('\')
$buildBefore=@(Get-ChildItem -LiteralPath $buildRoot -Directory -Force | ForEach-Object {$_.FullName})
$originalLocation=Get-Location;$previousPreference=$ErrorActionPreference
$exitCode=1
try {
  Set-Location -LiteralPath $project
  $ErrorActionPreference='Continue'
  & $Executable @Arguments 2>&1 | Out-File -LiteralPath $log -Encoding UTF8 -Width 4096
  $exitCode=[int]$LASTEXITCODE
} catch {
  $_ | Out-String | Out-File -LiteralPath $log -Append -Encoding UTF8
} finally {
  $ErrorActionPreference=$previousPreference
  Set-Location -LiteralPath $originalLocation
}
$finish=(Get-Date).ToUniversalTime()
if($harness){
  foreach($file in $harnessFiles){
    if((Get-FileHash -LiteralPath (Join-Path $project $file.path) -Algorithm SHA256).Hash -ne $file.sha256){throw 'Test harness changed during execution; staging and sandboxes preserved'}
  }
}
$sandboxEvidence=@()
if($Kind -in @('Package','OnlineDeployment')){
  foreach($dir in Get-ChildItem -LiteralPath $buildRoot -Directory -Force | Where-Object {$_.FullName -notin $buildBefore -and $_.Name -match '^(deployment-test|verify)-[a-f0-9]{32}$'}){
    $full=[IO.Path]::GetFullPath($dir.FullName)
    if((Split-Path -Parent $full) -ne $buildRoot){throw 'Sandbox outside build root'}
    $all=@(Get-EvidenceFiles $full) # Rejects links, including every descendant.
    $kept=@()
    foreach($file in $all){
      if($file.path -match '(^|/)(runtimes|node_modules|licenses)(/|$)'){continue}
      if([IO.Path]::GetExtension($file.path) -ne '.log' -and [IO.Path]::GetFileName($file.path) -notin @('MANIFEST.json','current.json','report.json','failure.json','job-input.json','selected-environment.json')){continue}
      $dest=Join-Path $staging ('sandbox-diagnostics/'+$dir.Name+'/'+$file.path)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Copy-Item -LiteralPath $file.full -Destination $dest
      $hash=(Get-FileHash -LiteralPath $file.full -Algorithm SHA256).Hash
      if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -ne $hash){throw 'Sandbox diagnostic copy mismatch'}
      $kept+=@{path=$file.path;sha256=$hash;bytes=$file.bytes}
    }
    $sandboxEvidence+=@{path=$full;originalFiles=$all.Count;originalBytes=($all | ForEach-Object {$_.bytes} | Measure-Object -Sum).Sum;retained=$kept}
  }
}
$rawBytes=(Get-Item -LiteralPath $log).Length
$logText=(Get-Content -LiteralPath $log -Tail 100 -Encoding UTF8) -join "`n"
$logName='output.log';$compression='none'
if($rawBytes -gt $MaxLogMiB*1MB){
  $gzip=Join-Path $staging 'output.log.gz'
  $inputStream=[IO.File]::OpenRead($log);$outputStream=[IO.File]::Create($gzip)
  try {$zipStream=New-Object IO.Compression.GzipStream($outputStream,[IO.Compression.CompressionMode]::Compress);try{$inputStream.CopyTo($zipStream)}finally{$zipStream.Dispose()}}finally{$inputStream.Dispose();$outputStream.Dispose()}
  if((Get-Item -LiteralPath $gzip).Length -gt $MaxLogMiB*1MB){throw "Test log exceeds $MaxLogMiB MiB even when compressed. Full output remains at $log"}
  Remove-Item -LiteralPath $log
  $logName='output.log.gz';$compression='gzip'
}
$summary=$null
if($Kind -in @('Package','OnlineDeployment')){
  $resultPath=Join-Path $staging 'deployment-results.json'
  if(Test-Path -LiteralPath $resultPath){
    $deployment=Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $passed=@($deployment.checks | Where-Object {$_.status -eq 'passed'}).Count
    $failed=@($deployment.checks | Where-Object {$_.status -eq 'failed'}).Count
    if($deployment.schema -ne 1 -or ($exitCode -eq 0 -and ($deployment.outcome -ne 'passed' -or $passed -le 0 -or $failed))){throw 'Invalid structured deployment results; evidence staging preserved'}
    $summary=@{method='structured deployment checks';passed=$passed;failed=$failed;file='deployment-results.json'}
  }elseif($exitCode -eq 0){throw 'No structured deployment results; successful exit cannot pass'}
}
if(!$summary -and $Kind -in @('Package','OnlineDeployment') -and $logText){
  $totals=[regex]::Matches($logText,'(?m)^Deployment verification:\s+(\d+) passed')
  if($totals.Count){
    $summary=@{method='deployment verifier summary';passed=[int]$totals[$totals.Count-1].Groups[1].Value;failed=$(if($exitCode -eq 0){0}else{$null});passLogLines=[regex]::Matches($logText,'(?m)^PASS:').Count}
  } else {
    $summary=@{method='PASS/FAIL log lines only';passLogLines=[regex]::Matches($logText,'(?m)^PASS:').Count;failLogLines=[regex]::Matches($logText,'(?m)^FAIL:').Count}
  }
}

$manifest=[ordered]@{
  schema=2;kind=$Kind;label=$Label;runId=$runId;version=$version
  git=@{commit=$gitCommit;dirty=($gitStatus.Count -gt 0);status=$gitStatus;role=$(if($Kind -eq 'App'){'source-under-test'}else{'test-harness-checkout'})}
  startedAtUtc=$start.ToString('o');finishedAtUtc=$finish.ToString('o');durationSeconds=[math]::Round(($finish-$start).TotalSeconds,3)
  outcome=$(if($exitCode -eq 0){'passed'}else{'failed'});exitCode=$exitCode
  command=@{executable=$Executable;arguments=$Arguments;workingDirectory=$project}
  host=@{os=[Environment]::OSVersion.VersionString;processorArchitecture=$env:PROCESSOR_ARCHITECTURE;process64Bit=[Environment]::Is64BitProcess;powershell=$PSVersionTable.PSVersion.ToString()}
  runtime=$runtime;runtimeLockSha256=(Get-FileHash -LiteralPath (Join-Path $project 'runtime-lock.json') -Algorithm SHA256).Hash;package=$package
  evidenceRevision=$(if($harness){1}else{0});harness=$harness
  summary=$summary
  sandboxes=$sandboxEvidence
  log=@{file=$logName;compression=$compression;originalBytes=$rawBytes;storedBytes=(Get-Item -LiteralPath (Join-Path $staging $logName)).Length;sha256=(Get-FileHash -LiteralPath (Join-Path $staging $logName) -Algorithm SHA256).Hash;maximumStoredMiB=$MaxLogMiB}
  retention='permanent-local-evidence; no automatic deletion'
}
[IO.File]::WriteAllText((Join-Path $staging 'manifest.json'),($manifest | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
& (Join-Path $PSScriptRoot 'test-storage.ps1') -Action Commit -Source $staging -Destination $localRun
foreach($sandbox in $sandboxEvidence){
  $target=[IO.Path]::GetFullPath($sandbox.path)
  if((Split-Path -Parent $target) -ne $buildRoot -or (Split-Path -Leaf $target) -notmatch '^(deployment-test|verify)-[a-f0-9]{32}$'){throw 'Invalid sandbox cleanup target'}
  $current=@(Get-EvidenceFiles $target)
  if($current.Count -ne $sandbox.originalFiles -or ($current | ForEach-Object {$_.bytes} | Measure-Object -Sum).Sum -ne $sandbox.originalBytes){throw 'Sandbox changed after archival; preserved'}
  foreach($file in $sandbox.retained){if((Get-FileHash -LiteralPath (Join-Path $target $file.path) -Algorithm SHA256).Hash -ne $file.sha256){throw 'Sandbox diagnostic changed; preserved'}}
  Remove-Item -LiteralPath $target -Recurse -Force
}
Write-Host "Test outcome: $($manifest.outcome); exit=$exitCode"
Write-Host "Evidence: $localRun"
$totalBytes=(Get-ChildItem -LiteralPath $root -File -Recurse | Measure-Object Length -Sum).Sum
if($totalBytes -gt $WarnTotalMiB*1MB){Write-Warning "Local evidence exceeds $WarnTotalMiB MiB. Review it and expand storage; records are never deleted automatically."}
$resultCode=$exitCode
} finally {$gate.Dispose()}
if($resultCode -ne 0){exit $resultCode}
