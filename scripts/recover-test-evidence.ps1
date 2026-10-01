param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$')][string]$RunId)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Initialize-EvidenceArchive $project
$pending=Get-EvidencePendingRoot $project
$work=Join-Path $pending "test-runs/$RunId"
if(Test-Path -LiteralPath (Join-Path $pending 'test-run.lock')){throw 'Inspect the active/interrupted test lock before recovery'}
$active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($work,[StringComparison]::OrdinalIgnoreCase) -ge 0})
if($active.Count){throw 'This test sandbox still has an active process'}
$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  $found=@(Get-EvidenceRecords $root | Where-Object {
    $p=Get-EvidencePayload $_
    $p.relative -match ('^runs/[^/]+/'+[regex]::Escape($RunId)+'$')
  })
  $candidates=@(Get-ChildItem -LiteralPath $pending -Directory -Filter 'publish-*' | Where-Object {
    $rp=Join-Path $_.FullName 'record.json'
    (Test-Path -LiteralPath $rp) -and (Get-Content -LiteralPath $rp -Raw -Encoding UTF8|ConvertFrom-Json).originalRelative -match ('^runs/[^/]+/'+[regex]::Escape($RunId)+'$')
  })
  $raw=Join-Path $work 'evidence'
  if($found.Count+$candidates.Count+[int](Test-Path -LiteralPath $raw) -ne 1){throw 'Ambiguous or missing recovery evidence'}
  if($found.Count -or $candidates.Count){
    $src=if($found.Count){$found[0].source}else{$candidates[0].FullName}
    $r=Get-Content -LiteralPath (Join-Path $src 'record.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $relative=$r.path
    $null=Test-EvidenceRecord $src $relative
    $dest=Assert-EvidencePath $project (Join-Path $root $relative)
    if($src -ne $dest){[IO.Directory]::Move($src,$dest)}
    $catalog=Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if(!@($catalog.records | Where-Object {$_.path -eq $relative}).Count){Add-EvidenceCatalogRecord $root @{source=$dest;relative=$relative}}
  }else{
    $m=Get-Content -LiteralPath (Join-Path $raw 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($m.runId -ne $RunId){throw 'Recovery identity mismatch'}
    $relative="runs/$($m.version)/$RunId"
    # Missing checksums denote unfinished data, not a completed run.
    $null=Test-EvidenceRecord $raw $relative
    $dest=Publish-EvidenceRecord $project $raw $relative
  }
  $null=Test-EvidenceCatalog $root
  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $audit=Join-Path $pending ('staging/recovery-'+$id)
  $null=New-Item -ItemType Directory -Path $audit -Force
  $saved=@()
  foreach($temp in Get-ChildItem -LiteralPath $pending -File -Filter 'catalog.json.*.tmp'){
    $candidate=Get-Content -LiteralPath $temp.FullName -Raw -Encoding UTF8|ConvertFrom-Json
    $entry=@($candidate.records|Where-Object {$_.path -eq $relative})
    if($entry.Count -ne 1 -or $entry[0].checksumsSha256 -ne (Get-FileHash -LiteralPath (Join-Path $dest 'SHA256SUMS.txt')).Hash){throw 'Unrelated catalog candidate; inspect manually'}
    Copy-Item -LiteralPath $temp.FullName -Destination $audit
    $saved+=@{path=$temp.FullName;sha256=(Get-FileHash -LiteralPath $temp.FullName).Hash}
  }
  $note=@{schema=1;kind='build-maintenance';createdAtUtc=[DateTime]::UtcNow.ToString('o');recoveredRun=$relative;catalogCandidates=$saved;note='Recovery only; no product tests rerun or added to pass counts'}
  [IO.File]::WriteAllText((Join-Path $audit 'manifest.json'),($note|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $auditDest=Publish-EvidenceRecord $project $audit ('build-maintenance-'+$id)
  foreach($file in $saved){
    $original=Assert-EvidencePath $project $file.path
    if((Split-Path -Parent $original) -ne $pending -or (Get-FileHash -LiteralPath $original).Hash -ne $file.sha256){throw 'Catalog candidate changed'}
    Remove-Item -LiteralPath $original
  }
  if(Test-Path -LiteralPath $work){& (Join-Path $PSScriptRoot 'test-storage.ps1') -Action Clean -Source $work}
  Write-Output "Recovered and verified: $dest; maintenance: $auditDest"
} finally {$gate.Dispose()}
