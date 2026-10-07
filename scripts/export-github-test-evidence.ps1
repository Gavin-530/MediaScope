param([Parameter(Mandatory=$true)][ValidateSet('success','failure','cancelled','skipped')][string]$TestStepOutcome,[string]$Project)
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
$project=[IO.Path]::GetFullPath($Project)
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Export requires an isolated GitHub-hosted runner'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
$root=Initialize-EvidenceArchive $project
$pending=Get-EvidencePendingRoot $project
$identity=@{repository=$env:GITHUB_REPOSITORY;runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;sha=$env:GITHUB_SHA;job=$env:GITHUB_JOB;ref=$env:GITHUB_REF;event=$env:GITHUB_EVENT_NAME}
$id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$bundle=Join-Path $pending ('cloud-export/'+$id)
$recordsRoot=Join-Path $bundle 'records'
$null=New-Item -ItemType Directory -Path $bundle -Force
function Save-Gzip($Source,$Destination){
  $inputStream=[IO.File]::OpenRead($Source);$outputStream=[IO.File]::Create($Destination)
  try{$gzip=New-Object IO.Compression.GzipStream($outputStream,[IO.Compression.CompressionMode]::Compress);try{$inputStream.CopyTo($gzip)}finally{$gzip.Dispose()}}finally{$inputStream.Dispose();$outputStream.Dispose()}
}
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
  $diagnostics=Join-Path $pending 'ci-diagnostics'
  $work=Join-Path $pending 'test-runs'
  $unfinished=@(Get-ChildItem -LiteralPath $work -Directory -ErrorAction SilentlyContinue)
  if($entries.Count -gt 1 -or ($entries.Count -and $unfinished.Count) -or $unfinished.Count -gt 1){throw 'Ambiguous runner records; export refused'}
  if(!$entries.Count){
    if($TestStepOutcome -eq 'success'){throw 'Successful CI has no completed record'}
    if($unfinished.Count){
      $raw=Join-Path $unfinished[0].FullName 'evidence'
      $null=Get-EvidenceFiles $raw
      $mp=Join-Path $raw 'manifest.json'
      if(!(Test-Path -LiteralPath $mp)){throw 'Unidentified unfinished test sandbox; export refused'}
      $m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
      if($m.github.repository -ne $identity.repository -or $m.github.runId -ne $identity.runId -or $m.github.runAttempt -ne $identity.runAttempt -or $m.github.sha -ne $identity.sha){throw 'Unfinished evidence identity mismatch'}
    }else{
      $version=(Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw|ConvertFrom-Json).version
      $diagnosticRunId=New-EvidenceRunId $project
      $m=[pscustomobject]@{schema=3;evidenceRevision=2;kind='App';version=$version;runId=$diagnosticRunId;scope='full';outcome='blocked';exitCode=2;startedAt=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture);github=$identity;source=@{kind='working-tree';commit=$identity.sha};harness=@{commit=$identity.sha}}
      $raw=$null
    }
    # A forced interruption or bootstrap failure is blocked, never a fabricated pass.
    $m.outcome='blocked';$m.exitCode=2;$m.evidenceRevision=2
    $m | Add-Member -Force NoteProperty blockedReason 'CI did not publish a completed test record'
    $m | Add-Member -Force NoteProperty endedAt ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture))
    $m | Add-Member -Force NoteProperty releaseCheck @{requested=$true;ready=$false;reasons=@('Execution or publication did not complete')}
    $destination=Join-Path $recordsRoot ('runs/'+$m.version+'/'+$m.runId)
    $null=New-Item -ItemType Directory -Path $destination -Force
    if($raw){
      foreach($name in @('results.json','features.json','measurements.json.gz','compatibility.json')){
        $file=Join-Path $raw $name
        if(Test-Path -LiteralPath $file -PathType Leaf){Copy-Item -LiteralPath $file -Destination $destination}
      }
    }
    $log=Join-Path $destination 'output.log.gz'
    if($raw -and (Test-Path -LiteralPath (Join-Path $raw 'output.log.gz'))){Copy-Item -LiteralPath (Join-Path $raw 'output.log.gz') -Destination $log}
    elseif($raw -and (Test-Path -LiteralPath (Join-Path $raw 'output.log'))){Save-Gzip (Join-Path $raw 'output.log') $log}
    else{
      $note=Join-Path $destination 'output.log'
      [IO.File]::WriteAllText($note,'No completed test log; see blocked reason.',(New-Object Text.UTF8Encoding($false)))
      Save-Gzip $note $log;Remove-Item -LiteralPath $note
    }
    $bootstrap=Join-Path $diagnostics 'bootstrap.log'
    if(Test-Path -LiteralPath $bootstrap -PathType Leaf){
      $null=Get-EvidenceFiles $diagnostics
      Save-Gzip $bootstrap (Join-Path $destination 'bootstrap.log.gz')
    }
    $m | Add-Member -Force NoteProperty log @{file='output.log.gz';compression='gzip';storedBytes=(Get-Item -LiteralPath $log).Length;sha256=(Get-FileHash -LiteralPath $log).Hash}
    [IO.File]::WriteAllText((Join-Path $destination 'manifest.json'),($m|ConvertTo-Json -Depth 20),(New-Object Text.UTF8Encoding($false)))
    Write-EvidenceChecksums $destination
    $entries+=@(Get-EvidenceCatalogEntry @{source=$destination;relative=('runs/'+$m.version+'/'+$m.runId)})
  }
  [IO.File]::WriteAllText((Join-Path $recordsRoot 'catalog.json'),(@{schema=1;records=$entries}|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $independent=($entries.Count -eq 1 -and $m.evidenceRevision -eq 2)
  $manifest=@{schema=$(if($independent){2}else{1});kind='github-actions-evidence';bundleId=$id;createdAtUtc=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture);github=$identity;testStepOutcome=$TestStepOutcome;retention=@{remoteDays=90;local='user-managed independent records'}}
  [IO.File]::WriteAllText((Join-Path $bundle 'manifest.json'),($manifest|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $bundle
  $null=Test-GitHubEvidenceBundle $bundle
  $transport=Join-Path $pending 'cloud-export/bundle.zip'
  if(Test-Path -LiteralPath $transport){throw 'Export transport already exists'}
  [IO.Compression.ZipFile]::CreateFromDirectory($bundle,$transport,[IO.Compression.CompressionLevel]::Optimal,$false)
  Write-Output "Validated evidence transport: $transport"
} finally {$gate.Dispose()}
