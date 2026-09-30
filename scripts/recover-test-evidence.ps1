param([Parameter(Mandatory=$true)][ValidatePattern('^\d{8}T\d{9}Z-[a-f0-9]{8}$')][string]$RunId)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
$work=Join-Path $project ".build/test-runs/$RunId"
if(Test-Path -LiteralPath (Join-Path $project '.build/test-run.lock')){throw 'Inspect the active/interrupted test lock before recovery'}
$active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($work,[StringComparison]::OrdinalIgnoreCase) -ge 0})
if($active.Count){throw 'This test sandbox still has an active process'}
$gate=[IO.File]::Open((Join-Path $project '.build/evidence-recording.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  $foundRuns=@(Get-EvidenceRecords $root | Where-Object {$_.relative -match ('^runs/[^/]+/'+[regex]::Escape($RunId)+'$')})
  $pending=Join-Path $work 'evidence'
  if($foundRuns.Count -gt 1 -or ($foundRuns.Count -and (Test-Path -LiteralPath $pending))){throw 'Ambiguous recovery evidence'}
  $src=if($foundRuns.Count){$foundRuns[0].source}else{$pending}
  $manifest=Get-Content -LiteralPath (Join-Path $src 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$' -or $manifest.runId -ne $RunId){throw 'Invalid recovery identity'}
  $relative="runs/$($manifest.version)/$RunId"
  $null=Test-EvidenceRecord $src $relative
  $catalog=Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $known=@($catalog.records | Where-Object {$_.path -eq $relative})
  if($known.Count -gt 1){throw 'Duplicate catalog entry'}
  $recoveryId='build-maintenance-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $audit=Join-Path $project ".build/evidence-staging/$recoveryId"
  & (Join-Path $PSScriptRoot 'test-storage.ps1') -Action Validate -Source $audit
  New-Item -ItemType Directory -Path $audit | Out-Null
  $saved=@()
  foreach($temp in Get-ChildItem -LiteralPath $root -File -Force | Where-Object {$_.Name -match '^catalog\.json\.[a-f0-9]{32}\.tmp$'}){
    if($temp.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked catalog candidate'}
    $candidate=Get-Content -LiteralPath $temp.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry=@($candidate.records | Where-Object {$_.path -eq $relative})
    if($candidate.schema -ne 1 -or $entry.Count -ne 1 -or $entry[0].checksumsSha256 -ne (Get-FileHash -LiteralPath (Join-Path $src 'SHA256SUMS.txt')).Hash){throw 'Unrelated catalog candidate; manual inspection required'}
    $destination=Join-Path $audit $temp.Name
    $hash=(Get-FileHash -LiteralPath $temp.FullName -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $temp.FullName -Destination $destination
    if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash){throw 'Recovery candidate copy mismatch'}
    $saved+=@{path=$temp.Name;sha256=$hash}
  }
  Write-EvidenceChecksums $audit
  $null=Test-EvidenceChecksums $audit
  # Only remove a newly generated candidate after its verified recovery copy exists.
  foreach($temp in $saved){
    $original=[IO.Path]::GetFullPath((Join-Path $root $temp.path))
    if((Split-Path -Parent $original) -ne $root -or (Get-FileHash -LiteralPath $original).Hash -ne $temp.sha256){throw 'Catalog candidate changed'}
    Remove-Item -LiteralPath $original
  }
  $dest=Join-Path $root $relative
  if(!$foundRuns.Count){
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Move-Item -LiteralPath $src -Destination $dest
  }
  if(!$known.Count){Add-EvidenceCatalogRecord $root @{source=$dest;relative=$relative}}
  $null=Test-EvidenceCatalog $root
  $note=@{schema=1;kind='build-maintenance';createdAtUtc=(Get-Date).ToUniversalTime().ToString('o');recoveredRun=$relative;catalogCandidates=$saved;note='Recovered an interrupted archive/catalog transaction. Original test evidence and its checksum file are unchanged; no product tests were rerun or counted by this maintenance operation.'}
  [IO.File]::WriteAllText((Join-Path $audit 'manifest.json'),($note | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $audit
  $null=Test-EvidenceChecksums $audit
  $auditDest=Join-Path $root $recoveryId
  Move-Item -LiteralPath $audit -Destination $auditDest
  Add-EvidenceCatalogRecord $root @{source=$auditDest;relative=$recoveryId}
  & (Join-Path $PSScriptRoot 'verify-test-evidence.ps1')
  if(Test-Path -LiteralPath $work){& (Join-Path $PSScriptRoot 'test-storage.ps1') -Action Clean -Source $work}
  Write-Output "Recovered and verified: $dest; maintenance audit: $auditDest"
}finally{$gate.Dispose()}
