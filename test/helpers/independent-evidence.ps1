param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $source 'scripts/evidence-lib.ps1')
. (Join-Path $source 'scripts/github-evidence-lib.ps1')
$project=Assert-EvidencePath $source $Work
if(!$project.StartsWith((Join-Path $source 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Protocol fixture outside test-work'}
$utf8=New-Object Text.UTF8Encoding($false)
function Save($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 15),$utf8)}
function New-Run($Id,[string]$Kind='Custom'){
  $stage=Join-Path (Get-EvidencePendingRoot $project) ('fixture-'+$Id)
  $null=New-Item -ItemType Directory -Path $stage -Force
  $log=Join-Path $stage 'output.log';[IO.File]::WriteAllText($log,'Filesystem protocol only; no product/media execution.',$utf8)
  $m=@{schema=2;evidenceRevision=2;kind=$Kind;version='0.2.3';runId=$Id;outcome='failed';exitCode=1;log=@{file='output.log';storedBytes=(Get-Item $log).Length;sha256=(Get-FileHash $log).Hash}}
  if($Kind -eq 'App'){$m.schema=3;$m.outcome='blocked';$m.exitCode=2;$m.scope='full';$m.github=@{repository='protocol/example';runId='456';runAttempt='1';sha=('a'*40)};$m.source=@{commit=('a'*40)};$m.harness=@{commit=('a'*40)}}
  Save (Join-Path $stage 'manifest.json') $m
  return $stage
}
function Publish($Stage){$m=Get-Content (Join-Path $Stage 'manifest.json') -Raw|ConvertFrom-EvidenceJson;Publish-EvidenceRecord $project $Stage ('runs/'+$m.version+'/'+$m.runId)}
function Remove-Fixture($Path){
  $target=Assert-EvidencePath $project $Path
  $null=Get-EvidenceFiles $target
  Remove-Item -LiteralPath $target -Recurse -Force
}
$a=Publish (New-Run '20261002T010203000Z-1234ab01')
if(@(Get-EvidenceFiles $a).Count -ne 3 -or (Test-Path (Join-Path $a 'original'))){throw 'Independent record still contains snapshots or envelopes'}
$root=Get-EvidenceRoot $project
Remove-Fixture $a
[IO.File]::WriteAllText((Join-Path $root 'catalog.json'),'broken optional cache',$utf8)
$b=Publish (New-Run '20261002T010203000Z-1234ab02')
$cache=Assert-EvidencePath $project (Join-Path $root 'catalog.json')
Remove-Item -LiteralPath $cache
if((Test-EvidenceCatalog $root) -ne 1){throw 'Missing cache or deleted predecessor prevented verification'}
Write-Output 'PASS: deletion, corrupt cache and missing cache do not block a new independent record'

$copy=Join-Path $project 'isolated-copy';Copy-Item -LiteralPath $b -Destination $copy -Recurse
Remove-Fixture $b
$null=Test-EvidenceRecord $copy 'records/2026-10-02T01-02-03.000Z-1234ab02'
$null=& (Join-Path $source 'scripts/verify-test-evidence.ps1') -Record $copy
Write-Output 'PASS: a copied record verifies without its original archive or predecessor'

$legacy=New-Run '20261002T010203000Z-1234ab03'
$m=Get-Content (Join-Path $legacy 'manifest.json') -Raw|ConvertFrom-EvidenceJson;$m.evidenceRevision=0
Save (Join-Path $legacy 'manifest.json') $m
$old=Publish $legacy
$oldLog=Join-Path $old 'original/output.log';[IO.File]::AppendAllText($oldLog,'corrupted protocol input')
$new=Publish (New-Run '20261002T010203000Z-1234ab04')
$rejected=$false;try{$null=Test-EvidenceRecord $old ('records/'+(Split-Path -Leaf $old))}catch{$rejected=$_.Exception.Message -match 'Checksum mismatch'}
if(!$rejected -or !(Test-Path $new)){throw 'Historical corruption was hidden or blocked unrelated publication'}
Write-Output 'PASS: legacy records remain readable and corruption is detected without blocking unrelated tests'

$receiver=Join-Path $project 'receiver';$drop=Join-Path (Get-EvidenceRoot $receiver) 'inbox/standalone'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $drop) -Force
Copy-Item -LiteralPath $copy -Destination $drop -Recurse
& (Join-Path $source 'evidence-archive/tools/import-local-test-evidence.ps1') -Project $receiver -Folder standalone -Contributor 'Protocol test' -Apply | Out-Null
$imported=@(Get-EvidenceRecords (Get-EvidenceRoot $receiver)|Where-Object {$_.relative -match '1234ab02$'})[0]
if(!(Test-Path (Join-Path $imported.source 'manifest.json')) -or (Get-FileHash (Join-Path $imported.source 'SHA256SUMS.txt')).Hash -ne (Get-FileHash (Join-Path $copy 'SHA256SUMS.txt')).Hash){throw 'Standalone import changed bytes or added an envelope'}
Write-Output 'PASS: actual collaborator import accepts one independent folder without a sender catalog'

$cloudProject=Join-Path $project 'cloud';$previousProject=$project;$project=$cloudProject
$app=Publish (New-Run '20261002T010203000Z-1234ab05' 'App')
$project=$previousProject
$prior=@{}
foreach($name in @('GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA')){$prior[$name]=[Environment]::GetEnvironmentVariable($name)}
try{
  $env:GITHUB_ACTIONS='true';$env:RUNNER_ENVIRONMENT='github-hosted';$env:GITHUB_REPOSITORY='protocol/example';$env:GITHUB_RUN_ID='456';$env:GITHUB_RUN_ATTEMPT='1';$env:GITHUB_SHA='a'*40
  & (Join-Path $source 'scripts/export-github-test-evidence.ps1') -Project $cloudProject -TestStepOutcome failure | Out-Null
}finally{foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name])}}
$zip=Join-Path (Get-EvidencePendingRoot $cloudProject) 'cloud-export/bundle.zip'
$cloudReceiver=Join-Path $project 'cloud-receiver'
$saved=Import-GitHubEvidence $cloudReceiver $zip 'protocol/example' '456' '1' ('a'*40)
$outerFolder=Join-Path $project 'outer-transport';$null=New-Item -ItemType Directory -Path $outerFolder
Copy-Item -LiteralPath $zip -Destination (Join-Path $outerFolder 'bundle.zip')
$outerZip=Join-Path $project 'artifact.zip';[IO.Compression.ZipFile]::CreateFromDirectory($outerFolder,$outerZip)
$again=Import-GitHubEvidence $cloudReceiver $outerZip 'protocol/example' '456' '1' ('a'*40)
$origin=Get-Content (Join-Path $saved 'origin.json') -Raw|ConvertFrom-EvidenceJson
if($saved -ne $again -or @(Get-EvidenceFiles $saved).Count -ne 4 -or $origin.testStepOutcome -ne 'failure' -or $origin.originalChecksumsSha256 -ne (Get-FileHash (Join-Path $app 'SHA256SUMS.txt')).Hash -or (Get-FileHash (Join-Path $saved 'manifest.json')).Hash -ne (Get-FileHash (Join-Path $app 'manifest.json')).Hash){throw 'Cloud round-trip duplicated transports, changed results or lost identity'}
if(@(Get-ChildItem -LiteralPath (Join-Path (Get-EvidencePendingRoot $cloudReceiver) 'github-evidence-import') -Recurse -File).Count){throw 'Successful cloud import retained extracted transport copies'}
$brokenOther=Join-Path (Get-EvidenceRoot $cloudReceiver) 'records/2026-10-02T01-02-03.000Z-1234ab07'
$null=New-Item -ItemType Directory -Path $brokenOther
[IO.File]::WriteAllText((Join-Path $brokenOther 'manifest.json'),'damaged unrelated record',$utf8)
Write-Output 'PASS: actual cloud export/import preserves one independent record and deduplicates repeat imports'

foreach($mode in @('bootstrap','interrupted')){
  $failedCloud=Join-Path $project ('cloud-'+$mode);$failedReceiver=$cloudReceiver
  $null=Initialize-EvidenceArchive $failedCloud
  Save (Join-Path $failedCloud 'package.json') @{version='0.2.3'}
  $diag=Join-Path (Get-EvidencePendingRoot $failedCloud) 'ci-diagnostics';$null=New-Item -ItemType Directory -Path $diag
  [IO.File]::WriteAllText((Join-Path $diag 'bootstrap.log'),'Protocol-only bootstrap diagnostic; no product tests ran.',$utf8)
  try{
    $env:GITHUB_ACTIONS='true';$env:RUNNER_ENVIRONMENT='github-hosted';$env:GITHUB_REPOSITORY='protocol/example';$env:GITHUB_RUN_ID=if($mode -eq 'bootstrap'){'457'}else{'458'};$env:GITHUB_RUN_ATTEMPT='1';$env:GITHUB_SHA='a'*40
    if($mode -eq 'interrupted'){
      $temp=Join-Path (Get-EvidencePendingRoot $failedCloud) 'test-runs/20261002T010203000Z-1234ab06'
      $raw=Join-Path $temp 'evidence';$null=New-Item -ItemType Directory -Path $raw -Force
      Save (Join-Path $raw 'manifest.json') @{schema=3;evidenceRevision=2;kind='App';version='0.2.3';runId='20261002T010203000Z-1234ab06';outcome='blocked';exitCode=2;scope='full';github=@{repository='protocol/example';runId='458';runAttempt='1';sha=('a'*40)}}
      [IO.File]::WriteAllText((Join-Path $raw 'output.log'),'Interrupted protocol-only log.',$utf8)
      [IO.File]::WriteAllText((Join-Path $raw 'events.jsonl'),'Raw protocol fixture events must not be archived.',$utf8)
      $copySource=Join-Path $temp 'source';$null=New-Item -ItemType Directory -Path $copySource
      [IO.File]::WriteAllText((Join-Path $copySource 'README.md'),'Temporary source copy must not be exported.',$utf8)
    }
    & (Join-Path $source 'scripts/export-github-test-evidence.ps1') -Project $failedCloud -TestStepOutcome failure | Out-Null
    $transport=Join-Path (Get-EvidencePendingRoot $failedCloud) 'cloud-export/bundle.zip'
    $blocked=Import-GitHubEvidence $failedReceiver $transport 'protocol/example' $env:GITHUB_RUN_ID '1' ('a'*40)
  }finally{foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name])}}
  $record=Get-Content (Join-Path $blocked 'manifest.json') -Raw|ConvertFrom-EvidenceJson
  if($record.outcome -ne 'blocked' -or $record.releaseCheck.ready -or $record.testSummary.passed -gt 0 -or @(Get-EvidenceFiles $blocked).Count -ne 5){throw 'Incomplete CI fabricated passes or retained unnecessary files'}
  if(!(Test-Path (Join-Path $blocked 'bootstrap.log.gz')) -or (Test-Path (Join-Path $blocked 'README.md'))){throw 'Incomplete CI lost diagnostics or retained source'}
  Write-Output "PASS: actual $mode CI export/import retains only blocked results and compressed diagnostics"
}
