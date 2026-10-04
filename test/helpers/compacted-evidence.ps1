param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../scripts/evidence-lib.ps1')
$utf8=New-Object Text.UTF8Encoding($false)
$dir=Join-Path $Work 'records/2026-01-01-abcdef12'
$null=New-Item -ItemType Directory -Path $dir -Force
function Save($Name,$Value){[IO.File]::WriteAllText((Join-Path $dir $Name),($Value|ConvertTo-Json -Depth 15),$utf8)}
function Check-Fails($Relative){try{$null=Test-EvidenceRecord $dir $Relative}catch{return};throw 'Malformed compacted record was accepted'}
[IO.File]::WriteAllText((Join-Path $dir 'output.log'),'Protocol fixture only.',$utf8)
[IO.File]::WriteAllText((Join-Path $dir 'events.jsonl.gz'),'Protocol fixture only.',$utf8)
Save 'source-manifest.json' @{schema=1;files=@()}
Save 'features.json' @{features=@()}
$counts=@{tests=1;passed=1;failed=0;cancelled=0;skipped=0;todo=0}
Save 'results.json' @{counts=$counts;cases=@(@{name='protocol';file='test/protocol.test.mjs';status='passed'})}
$m=@{schema=3;evidenceRevision=1;archiveRevision=1;kind='App';version='0.2.0';runId='20260101-abcdef12';scope='full';outcome='passed';exitCode=0;testSummary=$counts;log=@{file='output.log';storedBytes=(Get-Item (Join-Path $dir 'output.log')).Length;sha256=(Get-FileHash (Join-Path $dir 'output.log')).Hash};archive=@{schema=1;operation='historical-compaction';identifier='20260101-abcdef12';originalRelative='runs/0.2.0/20260101-abcdef12';previousChecksumsSha256=('a'*64);originalOutcome='passed';rerun=$false;retention=@{retainedDataFiles=0}}}
Save 'manifest.json' $m;Write-EvidenceChecksums $dir
$null=Test-EvidenceRecord $dir 'records/2026-01-01-abcdef12'
if(Test-Path -LiteralPath (Join-Path $dir 'source.zip')){throw 'Source ZIP was required'}
if((Get-EvidencePayload @{source=$dir;relative='records/2026-01-01-abcdef12'}).relative -ne $m.archive.originalRelative){throw 'Logical identity lost'}
Check-Fails 'records/2026-01-01T00-00-00.000Z-abcdef12'
$m.archive.originalOutcome='failed';Save 'manifest.json' $m;Write-EvidenceChecksums $dir;Check-Fails 'records/2026-01-01-abcdef12'
$m.archive.originalOutcome='passed';$m.archive.retention.retainedDataFiles=1;Save 'manifest.json' $m;Write-EvidenceChecksums $dir;Check-Fails 'records/2026-01-01-abcdef12'
function Save-Pack($Entry){
  $bytes=$utf8.GetBytes((@{schema=1;encoding='base64';entries=@($Entry)}|ConvertTo-Json -Depth 6))
  $stream=[IO.File]::Create((Join-Path $dir 'historical-data.json.gz'));$gzip=New-Object IO.Compression.GzipStream($stream,[IO.Compression.CompressionMode]::Compress)
  try{$gzip.Write($bytes,0,$bytes.Length)}finally{$gzip.Dispose();$stream.Dispose()}
}
$payload=$utf8.GetBytes('actual retained protocol bytes');$hash=[Security.Cryptography.SHA256]::Create()
try{$digest=([BitConverter]::ToString($hash.ComputeHash($payload))).Replace('-','')}finally{$hash.Dispose()}
$entry=@{path='artifacts/metrics/value.log';bytes=$payload.Length;sha256=$digest;base64=[Convert]::ToBase64String($payload)}
Save-Pack $entry;Write-EvidenceChecksums $dir;$null=Test-EvidenceRecord $dir 'records/2026-01-01-abcdef12'
$entry.base64=[Convert]::ToBase64String($utf8.GetBytes('changed bytes'));Save-Pack $entry;Write-EvidenceChecksums $dir;Check-Fails 'records/2026-01-01-abcdef12'
Remove-Item -LiteralPath (Join-Path $dir 'historical-data.json.gz')
$m.archive.retention.retainedDataFiles=0;Save 'manifest.json' $m
Save 'results.json' @{counts=@{tests=1;passed=0;failed=1;cancelled=0;skipped=0;todo=0}}
Write-EvidenceChecksums $dir;Check-Fails 'records/2026-01-01-abcdef12'
Write-Output 'PASS: compacted historical identity, precision, original outcomes and structured results remain independently checked'
