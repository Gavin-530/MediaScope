param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
. (Join-Path $sourceProject 'scripts/github-evidence-lib.ps1')
$project=Assert-GitHubEvidencePath $sourceProject $Work
if(!$project.StartsWith((Join-Path $sourceProject 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Protocol fixture outside test sandbox'}
New-Item -ItemType Directory -Force -Path $project | Out-Null
function Write-ProtocolJson($Path,$Value){[IO.File]::WriteAllText($Path,($Value | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))}
function Assert-Rejected($Body,$Pattern){
  $message=$null;try {& $Body | Out-Null}catch{$message=$_.Exception.Message}
  if(!$message -or $message -notmatch $Pattern){throw "Expected $Pattern; received $message"}
}

# Filesystem protocol inputs only: no fake media, product measurements or passes.
$bundle=Join-Path $project 'bundle'
$records=Join-Path $bundle 'records'
$relative='runs/0.2.1/20260930T000000000Z-1234abcd'
$record=Join-Path $records $relative
New-Item -ItemType Directory -Force -Path $record | Out-Null
$identity=@{repository='protocol/example';runId='123';runAttempt='1';sha=('a'*40)}
$log=Join-Path $record 'output.log';[IO.File]::WriteAllText($log,'Filesystem protocol: deliberately blocked before media execution.')
$app=@{schema=3;evidenceRevision=1;kind='App';runId='20260930T000000000Z-1234abcd';version='0.2.1';scope='full';outcome='blocked';exitCode=2;github=$identity;harness=@{commit=$identity.sha};source=@{commit=$identity.sha};log=@{file='output.log';storedBytes=(Get-Item $log).Length;sha256=(Get-FileHash $log).Hash}}
Write-ProtocolJson (Join-Path $record 'manifest.json') $app
Write-EvidenceChecksums $record
Add-EvidenceCatalogRecord $records @{source=$record;relative=$relative}
$manifest=@{schema=1;kind='github-actions-evidence';bundleId='20260930T000000000Z-abcdef12';github=$identity;testStepOutcome='failure';retention=@{remoteDays=90;local='permanent after verified import'}}
Write-ProtocolJson (Join-Path $bundle 'manifest.json') $manifest
Write-EvidenceChecksums $bundle
$null=Test-GitHubEvidenceBundle $bundle
$zip=Join-Path $project 'evidence.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($bundle,$zip)
$saved=Import-GitHubEvidence $project $zip 'protocol/example' '123' '1'
$hash=(Get-FileHash (Join-Path $saved 'SHA256SUMS.txt')).Hash
$null=Test-EvidenceCatalog (Get-EvidenceRoot $project)
Write-Output 'PASS: blocked remote evidence imports with catalog and inner record validation'
$again=Import-GitHubEvidence $project $zip 'protocol/example' '123' '1'
if($again -ne $saved -or @(Get-EvidenceRecords (Get-EvidenceRoot $project)).Count -ne 1){throw 'Repeated import duplicated the record'}
Write-Output 'PASS: repeated identical imports are idempotent'
Assert-Rejected {Import-GitHubEvidence $project $zip 'protocol/other' '123' '1'} 'does not match'
Write-Output 'PASS: repository mismatches cannot enter the archive'
$manifest.testStepOutcome='success';Write-ProtocolJson (Join-Path $bundle 'manifest.json') $manifest;Write-EvidenceChecksums $bundle
Assert-Rejected {Test-GitHubEvidenceBundle $bundle} 'strict release evidence'
Write-Output 'PASS: a green step cannot promote blocked evidence to success'
$manifest.testStepOutcome='failure';Write-ProtocolJson (Join-Path $bundle 'manifest.json') $manifest;Write-EvidenceChecksums $bundle
[IO.File]::AppendAllText($log,' changed')
Assert-Rejected {Test-GitHubEvidenceBundle $bundle} 'Checksum mismatch'
Write-Output 'PASS: altered evidence is rejected'
[IO.File]::WriteAllText($log,'Filesystem protocol: deliberately blocked before media execution.')
$manifest.github.ref='changed identity';Write-ProtocolJson (Join-Path $bundle 'manifest.json') $manifest;Write-EvidenceChecksums $bundle
$changed=Join-Path $project 'changed.zip';[IO.Compression.ZipFile]::CreateFromDirectory($bundle,$changed)
Assert-Rejected {Import-GitHubEvidence $project $changed 'protocol/example' '123' '1'} 'overwrite refused'
if((Get-FileHash (Join-Path $saved 'SHA256SUMS.txt')).Hash -ne $hash){throw 'Original archive was changed'}
Write-Output 'PASS: different content for an existing run cannot overwrite history'
$unsafe=Join-Path $project 'unsafe.zip'
$bad=[IO.Compression.ZipFile]::Open($unsafe,[IO.Compression.ZipArchiveMode]::Create)
try {$null=$bad.CreateEntry('../outside.txt')}finally{$bad.Dispose()}
Assert-Rejected {Expand-GitHubEvidenceZip $unsafe (Join-Path $project 'unsafe-extract')} 'Unsafe ZIP entry'
if(Test-Path -LiteralPath (Join-Path $project 'outside.txt')){throw 'ZIP escaped extraction root'}
Write-Output 'PASS: ZIP path traversal is rejected before extraction'

# Round-trip the real exporter with a blocked, explicitly synthetic protocol record.
$exportProject=Join-Path $project 'export-project'
$null=Initialize-EvidenceArchive $exportProject
$staging=Join-Path (Get-EvidencePendingRoot $exportProject) 'staging/app'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $staging) -Force
Copy-Item -LiteralPath $record -Destination $staging -Recurse
$prior=@{}
foreach($name in @('GITHUB_ACTIONS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA','GITHUB_JOB')){$prior[$name]=[Environment]::GetEnvironmentVariable($name)}
try {
  $env:GITHUB_ACTIONS='true';$env:RUNNER_ENVIRONMENT='github-hosted'
  $env:GITHUB_REPOSITORY=$identity.repository;$env:GITHUB_RUN_ID=$identity.runId
  $env:GITHUB_RUN_ATTEMPT=$identity.runAttempt;$env:GITHUB_SHA=$identity.sha;$env:GITHUB_JOB='protocol'
  $null=Publish-EvidenceRecord $exportProject $staging $relative
  & (Join-Path $sourceProject 'scripts/export-github-test-evidence.ps1') -Project $exportProject -TestStepOutcome failure | Out-Null
} finally {foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name])}}
$transport=Join-Path (Get-EvidencePendingRoot $exportProject) 'cloud-export/bundle.zip'
$outerRoot=Join-Path $project 'artifact-wrapper'
$null=New-Item -ItemType Directory -Path $outerRoot
Copy-Item -LiteralPath $transport -Destination (Join-Path $outerRoot 'bundle.zip')
$outer=Join-Path $project 'artifact.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($outerRoot,$outer)
$receiver=Join-Path $project 'receiver'
$received=Import-GitHubEvidence $receiver $outer $identity.repository $identity.runId $identity.runAttempt $identity.sha
if((Get-FileHash (Join-Path $received 'bundle.zip')).Hash -ne (Get-FileHash $transport).Hash -or
   (Get-FileHash (Join-Path $received 'artifact.zip')).Hash -ne (Get-FileHash $outer).Hash){throw 'Original transport bytes were not retained'}
$null=Test-EvidenceCatalog (Get-EvidenceRoot $receiver)
Write-Output 'PASS: actual exporter plus nested artifact import retain both original ZIP transports'

$cliReceiver=Join-Path $project 'cli-receiver'
$cliOutput=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sourceProject 'scripts/import-github-test-evidence.ps1') -Project $cliReceiver -Archive $outer -Repository $identity.repository -RunId $identity.runId -Attempt $identity.runAttempt -Commit $identity.sha
if($LASTEXITCODE -ne 0){throw 'Actual import CLI failed'}
$cliPath=($cliOutput -join [Environment]::NewLine).Trim()
if(!(Test-Path (Join-Path $cliPath 'record.json')) -or (Test-EvidenceCatalog (Get-EvidenceRoot $cliReceiver)) -ne 1){throw 'CLI did not create a valid isolated archive'}
Write-Output 'PASS: actual import command validates arguments and returns its registered archive path'

# Source identity must also survive publishing a cloud record on a local host.
$localHostProject=Join-Path $project 'cloud-on-local'
$localStage=Join-Path (Get-EvidencePendingRoot $localHostProject) 'staging/app'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $localStage) -Force
Copy-Item -LiteralPath $record -Destination $localStage -Recurse
$priorActions=[Environment]::GetEnvironmentVariable('GITHUB_ACTIONS')
try {
  [Environment]::SetEnvironmentVariable('GITHUB_ACTIONS',$null)
  $localCloud=Publish-EvidenceRecord $localHostProject $localStage $relative
} finally {[Environment]::SetEnvironmentVariable('GITHUB_ACTIONS',$priorActions)}
if(!$localCloud.StartsWith((Join-Path (Get-EvidenceRoot $localHostProject) 'records')+'\',[StringComparison]::OrdinalIgnoreCase) -or
   (Test-EvidenceCatalog (Get-EvidenceRoot $localHostProject)) -ne 1){throw 'Local host changed cloud evidence provenance'}
Write-Output 'PASS: cloud-origin evidence stays cloud when published on a local host'

# Exercise omitted Project through real Windows PowerShell -File processes.
$defaultProject=Join-Path $project 'default-project'
$defaultScripts=Join-Path $defaultProject 'scripts'
$defaultDocs=Join-Path $defaultProject 'docs'
$null=New-Item -ItemType Directory -Path $defaultScripts,$defaultDocs -Force
foreach($script in @('evidence-lib.ps1','github-evidence-lib.ps1','import-github-test-evidence.ps1','export-github-test-evidence.ps1','migrate-test-evidence.ps1','organize-test-evidence.ps1')){
  Copy-Item -LiteralPath (Join-Path $sourceProject ('scripts/'+$script)) -Destination $defaultScripts
}
Copy-Item -LiteralPath (Join-Path $sourceProject 'docs/evidence-archive.md') -Destination $defaultDocs
$defaultOutput=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $defaultScripts 'import-github-test-evidence.ps1') -Archive $outer -Repository $identity.repository -RunId $identity.runId -Attempt $identity.runAttempt -Commit $identity.sha
if($LASTEXITCODE -ne 0){throw 'Import CLI without Project failed'}
$defaultPath=($defaultOutput -join [Environment]::NewLine).Trim()
if(!$defaultPath.StartsWith((Get-EvidenceRoot $defaultProject)+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-EvidenceCatalog (Get-EvidenceRoot $defaultProject)) -ne 1){throw 'Default CLI used current directory instead of script project'}
foreach($script in @('migrate-test-evidence.ps1','organize-test-evidence.ps1')){
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $defaultScripts $script) | Out-Null
  if($LASTEXITCODE -ne 0){throw "Default project failed for $script"}
}
Write-Output 'PASS: omitted Project resolves the script project in real import, migration and organization CLI processes'

$defaultExport=Join-Path $project 'default-export'
$null=New-Item -ItemType Directory -Path (Join-Path $defaultExport 'scripts'),(Join-Path $defaultExport 'docs') -Force
foreach($script in @('evidence-lib.ps1','github-evidence-lib.ps1','export-github-test-evidence.ps1')){
  Copy-Item -LiteralPath (Join-Path $sourceProject ('scripts/'+$script)) -Destination (Join-Path $defaultExport 'scripts')
}
Copy-Item -LiteralPath (Join-Path $sourceProject 'docs/evidence-archive.md') -Destination (Join-Path $defaultExport 'docs')
$defaultStage=Join-Path (Get-EvidencePendingRoot $defaultExport) 'staging/app'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $defaultStage) -Force
Copy-Item -LiteralPath $record -Destination $defaultStage -Recurse
$null=Publish-EvidenceRecord $defaultExport $defaultStage $relative
foreach($name in @($prior.Keys)){$prior[$name]=[Environment]::GetEnvironmentVariable($name)}
try {
  $env:GITHUB_ACTIONS='true';$env:RUNNER_ENVIRONMENT='github-hosted'
  $env:GITHUB_REPOSITORY=$identity.repository;$env:GITHUB_RUN_ID=$identity.runId
  $env:GITHUB_RUN_ATTEMPT=$identity.runAttempt;$env:GITHUB_SHA=$identity.sha;$env:GITHUB_JOB='protocol'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $defaultExport 'scripts/export-github-test-evidence.ps1') -TestStepOutcome failure | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Export CLI without Project failed'}
} finally {foreach($name in $prior.Keys){[Environment]::SetEnvironmentVariable($name,$prior[$name])}}
$exportRoot=Join-Path (Get-EvidencePendingRoot $defaultExport) 'cloud-export'
$exportDirectory=@(Get-ChildItem -LiteralPath $exportRoot -Directory)
if($exportDirectory.Count -ne 1 -or !(Test-Path (Join-Path $exportRoot 'bundle.zip')) -or (Test-GitHubEvidenceBundle $exportDirectory[0].FullName).github.sha -ne $identity.sha){throw 'Default export did not retain the expected cloud identity'}
Write-Output 'PASS: omitted Project works for the real hosted-runner export CLI with strict bundle validation'
