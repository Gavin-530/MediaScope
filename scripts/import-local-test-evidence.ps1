param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')][string]$Batch,
  [string]$Contributor,
  [switch]$Apply,
  [string]$Project
)

# Import sealed directories only. Never execute received code or rewrite evidence.
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Project).TrimEnd('\')
$inbox=Assert-EvidencePath $project (Join-Path $project 'evidence-inbox')
$root=Get-EvidenceRoot $project

function Assert-ReceivedTree([string]$Path) {
  $full=Assert-EvidencePath $project $Path
  if(!(Test-Path -LiteralPath $full -PathType Container)){throw "Received directory missing: $full"}
  # Check links before descending; recursive enumeration could follow a junction.
  $stack=New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($full)
  while($stack.Count){
    $current=$stack.Pop()
    foreach($item in Get-ChildItem -LiteralPath $current -Force){
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked received entry: $($item.FullName)"}
      if($item.PSIsContainer){$stack.Push($item.FullName)}
    }
  }
}

function Move-ImportReceipt([string]$Source,[string]$Destination) {
  $null=Assert-EvidencePath $project $Source
  $null=Assert-EvidencePath $project $Destination
  # Windows scanners may briefly hold the catalog backup after File.Replace.
  # Retry only receipt relocation; never repeat a catalog commit or an import.
  for($attempt=0;$attempt -lt 10;$attempt++){
    try{[IO.Directory]::Move($Source,$Destination);return}
    catch [IO.IOException]{if($attempt -eq 9){throw};Start-Sleep -Milliseconds 100}
    catch [UnauthorizedAccessException]{if($attempt -eq 9){throw};Start-Sleep -Milliseconds 100}
  }
}

function Get-ReceivedPlan([string]$Records) {
  Assert-ReceivedTree $Records
  if(@(Get-ChildItem -LiteralPath $Records -File -Force).Count){throw 'Put complete record directories inside records; loose files are not accepted'}
  $seen=@{}
  foreach($directory in Get-ChildItem -LiteralPath $Records -Directory -Force | Sort-Object Name){
    $recordFile=Join-Path $directory.FullName 'record.json'
    if(!(Test-Path -LiteralPath $recordFile -PathType Leaf)){throw "Sealed record.json missing: $($directory.FullName)"}
    $record=Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    $relative=[string]$record.path
    $null=Test-EvidenceRecord $directory.FullName $relative
    $destination=Assert-EvidencePath $project (Join-Path $root $relative)
    $sum=(Get-FileHash -LiteralPath (Join-Path $directory.FullName 'SHA256SUMS.txt') -Algorithm SHA256).Hash
    $action='import'
    if($seen.ContainsKey($relative)){
      if($seen[$relative] -ne $sum){throw "Conflicting received identity: $relative"}
      $action='duplicate'
    }elseif(Test-Path -LiteralPath $destination){
      $null=Test-EvidenceRecord $destination $relative
      if((Get-FileHash -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Algorithm SHA256).Hash -ne $sum){throw "Existing evidence conflicts: $relative"}
      $action='duplicate'
    }
    $seen[$relative]=$sum
    $manifestPath=Join-Path $directory.FullName 'original/manifest.json'
    $manifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson}else{$null}
    [pscustomobject]@{source=$directory.FullName;folder=$directory.Name;relative=$relative;destination=$destination;checksumsSha256=$sum;action=$action;sourceCommit=$manifest.source.commit;github=$record.github}
  }
}

if(!$Batch){
  if($Apply){throw 'Apply requires -Batch and -Contributor'}
  $null=New-Item -ItemType Directory -Path $inbox -Force
  Write-Output "Inbox: $inbox"
  Write-Output 'Place sealed record folders in evidence-inbox/<batch>/records/. Extract ZIPs yourself; do not copy a sender catalog over your own.'
  Write-Output 'Preview: npm run evidence:import -- -Batch alice-20261001'
  Write-Output 'Import:  npm run evidence:import -- -Batch alice-20261001 -Contributor Alice -Apply'
  Get-ChildItem -LiteralPath $inbox -Directory -Force | Select-Object -ExpandProperty Name
  return
}
if($Apply -and ([string]::IsNullOrWhiteSpace($Contributor) -or $Contributor.Length -gt 200)){throw 'Apply requires a contributor name (1-200 characters)'}
$batchRoot=Assert-EvidencePath $project (Join-Path $inbox $Batch)
$records=Assert-EvidencePath $project (Join-Path $batchRoot 'records')
$gate=$null;$transaction=$null;$committed=$false;$moved=@()
try {
  if($Apply){
    # Share the same lock as tests, imports and archive maintenance.
    $lock=Get-EvidenceLockPath $project
    try{$gate=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch{throw 'Evidence recording is active; import refused'}
    $null=Initialize-EvidenceArchive $project
  }
  if(Test-Path -LiteralPath $root){$null=Test-EvidenceCatalog $root}
  $plan=@(Get-ReceivedPlan $records)
  if(!$plan.Count){throw 'No sealed records in the selected batch'}
  $plan | Select-Object action,relative | Format-Table -AutoSize
  $new=@($plan | Where-Object {$_.action -eq 'import'})
  if(!$Apply){Write-Output "Preview only: $($new.Count) new record(s). Use -Contributor <name> -Apply to import.";return}
  if(!$new.Count){Write-Output 'All records already exist with identical checksums; nothing changed.';return}

  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $transaction=Assert-EvidencePath $project (Join-Path (Get-EvidencePendingRoot $project) ('local-import-'+$id))
  $null=New-Item -ItemType Directory -Path $transaction
  $receipt=[ordered]@{schema=1;operation='local-evidence-import';batch=$Batch;contributor=$Contributor;receivedFrom='user-supplied; not independently authenticated';importedAtUtc=[DateTime]::UtcNow.ToString('o');records=@($plan | ForEach-Object {[ordered]@{folder=$_.folder;path=$_.relative;checksumsSha256=$_.checksumsSha256;action=$_.action;sourceCommit=$_.sourceCommit;github=$_.github}})}
  $utf8=New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $transaction 'receipt.json'),($receipt | ConvertTo-Json -Depth 20),$utf8)
  $entries=@();$staged=@();$index=0
  foreach($item in $new){
    $candidate=Assert-EvidencePath $project (Join-Path $transaction ('record-'+$index))
    Copy-Item -LiteralPath $item.source -Destination $candidate -Recurse
    Assert-ReceivedTree $candidate
    $null=Test-EvidenceRecord $candidate $item.relative
    if((Get-FileHash -LiteralPath (Join-Path $candidate 'SHA256SUMS.txt') -Algorithm SHA256).Hash -ne $item.checksumsSha256){throw 'Received record changed during copy'}
    $entries+=@(Get-EvidenceCatalogEntry @{source=$candidate;relative=$item.relative})
    $staged+=@{candidate=$candidate;destination=$item.destination;relative=$item.relative}
    $index++
  }

  # Source attribution is a separate maintenance record; original envelopes stay byte-exact.
  $audit=Join-Path $transaction 'audit'
  $raw=Join-Path $audit 'original'
  $null=New-Item -ItemType Directory -Path $raw -Force
  Copy-Item -LiteralPath (Join-Path $transaction 'receipt.json') -Destination $raw
  $manifest=@{schema=1;kind='build-maintenance';operation='local-evidence-import';createdAtUtc=$receipt.importedAtUtc;note='Import audit only; no product tests rerun';batch=$Batch;contributor=$Contributor;records=$new.Count}
  [IO.File]::WriteAllText((Join-Path $raw 'manifest.json'),($manifest | ConvertTo-Json -Depth 8),$utf8)
  Write-EvidenceChecksums $raw
  $auditDestination=Get-EvidenceDestination $project ('local-evidence-import-'+$id) $manifest
  $auditRelative=$auditDestination.Substring($root.Length+1).Replace('\','/')
  Write-EvidenceEnvelope $audit $auditRelative ('local-evidence-import-'+$id)
  $entries+=@(Get-EvidenceCatalogEntry @{source=$audit;relative=$auditRelative})
  $staged+=@{candidate=$audit;destination=$auditDestination;relative=$auditRelative}
  [IO.File]::WriteAllText((Join-Path $transaction 'plan.json'),(@($staged) | ConvertTo-Json -Depth 8),$utf8)

  $catalogPath=Join-Path $root 'catalog.json'
  $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
  $catalog.records=@($catalog.records)+@($entries)
  $catalogNew=Join-Path $transaction 'catalog-new.json'
  [IO.File]::WriteAllText($catalogNew,($catalog | ConvertTo-Json -Depth 20),$utf8)
  $receipts=Assert-EvidencePath $project (Join-Path $batchRoot 'receipts')
  $null=New-Item -ItemType Directory -Path $receipts -Force
  $receiptDestination=Assert-EvidencePath $project (Join-Path $receipts $id)
  foreach($item in $staged){
    $null=Assert-EvidencePath $project $item.destination
    if(Test-Path -LiteralPath $item.destination){throw "Destination appeared during import: $($item.relative)"}
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $item.destination) -Force
    [IO.Directory]::Move($item.candidate,$item.destination)
    $moved+=@($item)
  }
  # Validate the complete proposed ledger before its atomic replacement.
  $null=Test-EvidenceCatalogData $root $catalog
  [IO.File]::Replace($catalogNew,$catalogPath,(Join-Path $transaction 'catalog-before.json'))
  $committed=$true
  Move-ImportReceipt $transaction $receiptDestination
  $transaction=$null
  Write-Output "Imported $($new.Count) record(s); audit: $auditRelative"
  Write-Output "Original received files retained: $records"
  Write-Output "Receipt: $receiptDestination"
} catch {
  if(!$committed){
    # Only move this transaction's new directories back; never delete existing archives.
    foreach($item in @($moved | Sort-Object relative -Descending)){
      $null=Assert-EvidencePath $project $item.destination
      $null=Assert-EvidencePath $project $item.candidate
      [IO.Directory]::Move($item.destination,$item.candidate)
    }
  }
  if($transaction){Write-Warning "Import interrupted (catalog committed: $committed); received originals and transaction retained: $transaction"}
  throw
} finally {if($gate){$gate.Dispose()}}
