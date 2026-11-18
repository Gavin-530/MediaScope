param(
  [Parameter(Mandatory=$true)][string]$Record,
  [switch]$Stage
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$source=(Resolve-Path -LiteralPath $Record).ProviderPath
$manifest=Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
$identity='runs/'+$manifest.version+'/'+$manifest.runId
$null=Test-EvidenceRecord $source $identity
$preview=Join-Path $PSScriptRoot 'preview-measurement-compaction.mjs'
if(!$Stage){
  & node $preview $source
  exit $LASTEXITCODE
}

$work=Join-Path (Join-Path $PSScriptRoot '../.build') ('measurement-stage-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $work
$candidate=Join-Path $work 'candidate.gz'
$result=& node $preview $source $candidate
if($LASTEXITCODE -ne 0){throw 'Measurement compaction preview failed'}
$report=($result -join [Environment]::NewLine)|ConvertFrom-EvidenceJson
if(!$report.staged){$result;exit 0}

$copy=Join-Path $work 'record'
Copy-Item -LiteralPath $source -Destination $copy -Recurse
$null=Test-EvidenceRecord $copy $identity
$oldHash=(Get-FileHash -LiteralPath (Join-Path $source 'SHA256SUMS.txt')).Hash
if($oldHash -ne (Get-FileHash -LiteralPath (Join-Path $copy 'SHA256SUMS.txt')).Hash){throw 'Source changed during staging'}
$attachment=Join-Path $copy 'measurements.json.gz'
if((Get-FileHash -LiteralPath $attachment).Hash -ne $report.originalMeasurementSha256 -or
   (Get-FileHash -LiteralPath $candidate).Hash -ne $report.candidateMeasurementSha256){throw 'Measurement bytes changed during staging'}
Copy-Item -LiteralPath $candidate -Destination $attachment -Force
if((Get-FileHash -LiteralPath $attachment).Hash -ne $report.candidateMeasurementSha256){throw 'Staged measurement copy mismatch'}
& node (Join-Path $PSScriptRoot 'read-measurements.mjs') (Join-Path $copy 'measurements.json.gz') --check
if($LASTEXITCODE -ne 0){throw 'Candidate measurement verification failed'}
Write-EvidenceChecksums $copy
$null=Test-EvidenceRecord $copy $identity
[ordered]@{
  schema=1
  runId=$manifest.runId
  source=$source
  stagedRecord=[IO.Path]::GetFullPath($copy)
  originalChecksumsSha256=$oldHash
  checksumsSha256=(Get-FileHash -LiteralPath (Join-Path $copy 'SHA256SUMS.txt')).Hash
  measurementBytes=$report
}|ConvertTo-Json -Depth 6|Tee-Object -FilePath (Join-Path $work 'receipt.json')
