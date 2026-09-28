param(
  [Parameter(Mandatory=$true)][ValidateSet('App','Package','OnlineDeployment','Custom')][string]$Kind,
  [string]$Archive,
  [string]$Executable,
  [string[]]$Arguments=@(),
  [string]$Label,
  [ValidateRange(1,256)][int]$MaxLogMiB=16,
  [ValidateRange(1,1048576)][int]$WarnTotalMiB=1024,
  [switch]$RequireClean
)

$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
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
  'App' {
    . (Join-Path $PSScriptRoot 'deployment.ps1')
    try {
      $paths=@{node=(Resolve-Program $env:MEDIASCOPE_NODE_PATH 'node');ffmpeg=(Resolve-Program $env:FFMPEG_PATH 'ffmpeg');ffprobe=(Resolve-Program $env:FFPROBE_PATH 'ffprobe')}
      foreach($name in @('node','ffmpeg','ffprobe')){
        $versionArg=if($name -eq 'node'){'--version'}else{'-version'}
        & $paths[$name] $versionArg *> $null
        if($LASTEXITCODE -ne 0){throw "Unusable $name"}
      }
      Write-Host 'Using local programs for the test run.'
    } catch {
      $installRoot=if($env:MEDIASCOPE_HOME){$env:MEDIASCOPE_HOME}else{Join-Path $env:LOCALAPPDATA 'MediaScope'}
      foreach($dir in @('runtimes','staging')){New-Item -ItemType Directory -Force -Path (Join-Path $installRoot $dir) | Out-Null}
      $paths=Get-PrivateRuntime $project $installRoot
      Write-Host 'Using verified private programs for the test run.'
    }
    $runtime=@{}
    foreach($name in @('node','ffmpeg','ffprobe')){
      $versionArg=if($name -eq 'node'){'--version'}else{'-version'}
      $runtime[$name]=@{path=$paths[$name];sha256=(Get-FileHash -LiteralPath $paths[$name] -Algorithm SHA256).Hash;version=((& $paths[$name] $versionArg | Select-Object -First 1) -join '')}
    }
    $env:FFMPEG_PATH=$paths.ffmpeg;$env:FFPROBE_PATH=$paths.ffprobe
    $Executable=$paths.node
    $Arguments=@('--test')+@(Get-ChildItem -LiteralPath (Join-Path $project 'test') -Filter '*.test.mjs' -File | Sort-Object Name | ForEach-Object {$_.FullName})
  }
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
if($Kind -eq 'App' -and $logText){
  $summary=@{method='Node test summary'}
  foreach($key in @('tests','pass','fail','skipped','cancelled')){
    $matches=[regex]::Matches($logText,"(?m)^[^A-Za-z0-9\r\n]*$key[ \t]+(\d+)[ \t\r]*$")
    if($matches.Count){$summary[$key]=[int]$matches[$matches.Count-1].Groups[1].Value}
  }
} elseif($Kind -in @('Package','OnlineDeployment') -and $logText){
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
  summary=$summary
  log=@{file=$logName;compression=$compression;originalBytes=$rawBytes;storedBytes=(Get-Item -LiteralPath (Join-Path $staging $logName)).Length;sha256=(Get-FileHash -LiteralPath (Join-Path $staging $logName) -Algorithm SHA256).Hash;maximumStoredMiB=$MaxLogMiB}
  retention='permanent-local-evidence; no automatic deletion'
}
[IO.File]::WriteAllText((Join-Path $staging 'manifest.json'),($manifest | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
Write-EvidenceChecksums $staging
$null=Test-EvidenceRecord $staging "runs/$version/$runId"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $localRun) | Out-Null
[IO.Directory]::Move($staging,$localRun)
Add-EvidenceCatalogRecord $root @{source=$localRun;relative="runs/$version/$runId"}
Write-Host "Test outcome: $($manifest.outcome); exit=$exitCode"
Write-Host "Evidence: $localRun"
$totalBytes=(Get-ChildItem -LiteralPath $root -File -Recurse | Measure-Object Length -Sum).Sum
if($totalBytes -gt $WarnTotalMiB*1MB){Write-Warning "Local evidence exceeds $WarnTotalMiB MiB. Review it and expand storage; records are never deleted automatically."}
$resultCode=$exitCode
} finally {$gate.Dispose()}
if($resultCode -ne 0){exit $resultCode}
