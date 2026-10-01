param([Parameter(Mandatory=$true)][ValidateSet('success','failure','cancelled','skipped')][string]$TestStepOutcome,[string]$Project=(Join-Path $PSScriptRoot '..'))
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath($Project)
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Export requires an isolated GitHub-hosted runner'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
$root=Initialize-EvidenceArchive $project
$pending=Get-EvidencePendingRoot $project
$identity=@{repository=$env:GITHUB_REPOSITORY;runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;sha=$env:GITHUB_SHA;job=$env:GITHUB_JOB;ref=$env:GITHUB_REF;event=$env:GITHUB_EVENT_NAME}
$id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$bundle=Join-Path $pending ('cloud-export/'+$id)
$recordsRoot=Join-Path $bundle 'records'
$null=New-Item -ItemType Directory -Path $bundle -Force
$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  $entries=@()
  foreach($record in Get-EvidenceRecords $root){
    $payload=Get-EvidencePayload $record
    $m=Get-Content -LiteralPath (Join-Path $payload.source 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($m.kind -ne 'App' -or $m.github.repository -ne $identity.repository -or $m.github.runId -ne $identity.runId -or $m.github.runAttempt -ne $identity.runAttempt -or $m.github.sha -ne $identity.sha){throw 'Exporter refuses unrelated runner records'}
    $null=Test-EvidenceRecord $record.source $record.relative
    # Preserve original product evidence and its existing schema without rewriting.
    $destination=Join-Path $recordsRoot $payload.relative
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
    Copy-Item -LiteralPath $payload.source -Destination $destination -Recurse
    $entries+=@(Get-EvidenceCatalogEntry @{source=$destination;relative=$payload.relative})
  }
  if($entries.Count){
    [IO.File]::WriteAllText((Join-Path $recordsRoot 'catalog.json'),(@{schema=1;records=$entries}|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  }
  $diagnostics=Join-Path $pending 'ci-diagnostics'
  if(Test-Path -LiteralPath $diagnostics){
    $null=Get-EvidenceFiles $diagnostics
    Copy-Item -LiteralPath $diagnostics -Destination (Join-Path $bundle 'diagnostics') -Recurse
  }
  $work=Join-Path $pending 'test-runs'
  foreach($directory in @(Get-ChildItem -LiteralPath $work -Directory -ErrorAction SilentlyContinue)){
    $mp=Join-Path $directory.FullName 'evidence/manifest.json'
    if(!(Test-Path -LiteralPath $mp)){throw 'Unidentified unfinished test sandbox; export refused'}
    $m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-Json
    if($m.github.runId -ne $identity.runId -or $m.github.runAttempt -ne $identity.runAttempt -or $m.github.sha -ne $identity.sha){throw 'Unfinished evidence identity mismatch'}
    $null=Get-EvidenceFiles $directory.FullName
    $destination=Join-Path $bundle ('pending/'+$directory.Name)
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
    Copy-Item -LiteralPath $directory.FullName -Destination $destination -Recurse
  }
  $manifest=@{schema=1;kind='github-actions-evidence';bundleId=$id;createdAtUtc=[DateTime]::UtcNow.ToString('o');github=$identity;testStepOutcome=$TestStepOutcome;retention=@{remoteDays=90;local='permanent after verified import'}}
  [IO.File]::WriteAllText((Join-Path $bundle 'manifest.json'),($manifest|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $bundle
  $null=Test-GitHubEvidenceBundle $bundle
  $transport=Join-Path $pending 'cloud-export/bundle.zip'
  if(Test-Path -LiteralPath $transport){throw 'Export transport already exists'}
  [IO.Compression.ZipFile]::CreateFromDirectory($bundle,$transport,[IO.Compression.CompressionLevel]::Optimal,$false)
  Write-Output "Validated evidence transport: $transport"
} finally {$gate.Dispose()}
