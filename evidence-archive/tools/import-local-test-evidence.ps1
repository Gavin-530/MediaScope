param(
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')][string]$Batch,
  [ValidateScript({$_ -notin @('.','..') -and [IO.Path]::GetFileName($_) -eq $_})][string]$Folder,
  [string]$Contributor,
  [switch]$Apply,
  [string]$Project
)

# Import sealed directories only. Never execute received code or rewrite evidence.
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '../..'}
. (Join-Path $PSScriptRoot '../../scripts/evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Project).TrimEnd('\')
$root=Get-EvidenceRoot $project
$inbox=Assert-EvidencePath $project (Join-Path $root 'inbox')
$receivedRoot=Assert-EvidencePath $project (Join-Path $root 'received')
$script:receivedSkips=New-Object 'System.Collections.Generic.List[string]'
$script:receivedCatalogs=New-Object 'System.Collections.Generic.List[object]'

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

function Save-ImportFiles([string]$Transaction,[string]$Id) {
  # Legacy -Batch calls retain their layout. Direct inbox imports move completed
  # originals outside intake, without copying or descending into foreign trees.
  $receiptRoot=if($Folder){Join-Path $receivedRoot $Id}else{$batchRoot}
  $receipts=Assert-EvidencePath $project (Join-Path $receiptRoot 'receipts')
  $null=New-Item -ItemType Directory -Path $receipts -Force
  $script:receiptDestination=Assert-EvidencePath $project (Join-Path $receipts $Id)
  Move-ImportReceipt $Transaction $script:receiptDestination
  if($Folder){
    $originals=Assert-EvidencePath $project (Join-Path $receiptRoot 'records')
    $null=New-Item -ItemType Directory -Path $originals -Force
    $retained=Assert-EvidencePath $project (Join-Path $originals $Folder)
    Move-ImportReceipt $batchRoot $retained
    Write-Output "Original received folder retained: $retained"
  }else{Write-Output "Original received files retained: $records"}
  Write-Output "Receipt: $script:receiptDestination"
}

function Find-ReceivedRecords([string]$Path,[int]$Depth=0) {
  $full=Assert-EvidencePath $project $Path
  if($Depth -gt 24){throw 'Received wrappers are too deeply nested; no records imported'}
  if(!(Test-Path -LiteralPath $full -PathType Container)){throw "Received directory missing: $full"}
  if(Test-Path -LiteralPath (Join-Path $full 'record.json') -PathType Leaf){
    Assert-ReceivedTree $full
    $record=Get-Content -LiteralPath (Join-Path $full 'record.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    $null=Test-EvidenceRecord $full ([string]$record.path)
    return @{source=$full;relative=[string]$record.path}
  }
  $catalogFile=Join-Path $full 'catalog.json'
  if(Test-Path -LiteralPath $catalogFile -PathType Leaf){
    $null=Assert-EvidencePath $project $catalogFile
    $catalog=Get-Content -LiteralPath $catalogFile -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    if($catalog.schema -ne 2 -or $null -eq $catalog.records){throw 'Received catalog must describe a modern sealed archive'}
    Test-EvidenceLegacyCatalog $full $catalog
    $sourceRecords=@(Get-EvidenceRecords $full)
    $registered=@{}
    foreach($entry in @($catalog.records)){
      if(!$entry.path -or $registered.ContainsKey($entry.path)){throw 'Duplicate or invalid received catalog entry'}
      $registered[$entry.path]=$entry.checksumsSha256
    }
    if($sourceRecords.Count -ne $registered.Count){throw 'Received catalog record count mismatch'}
    foreach($item in $sourceRecords){
      if(!(Test-Path -LiteralPath (Join-Path $item.source 'record.json') -PathType Leaf)){throw 'Received legacy records need sealed envelopes before import'}
      Assert-ReceivedTree $item.source
      $entry=Get-EvidenceCatalogEntry $item
      if(!$registered.ContainsKey($item.relative) -or $registered[$item.relative] -ne $entry.checksumsSha256){throw "Received catalog checksum mismatch: $($item.relative)"}
      $registered.Remove($item.relative)
      $item
    }
    if($registered.Count){throw 'Received catalog contains missing records'}
    $sourceRelative=$full.Substring($records.Length).TrimStart('\').Replace('\','/')
    $script:receivedCatalogs.Add(@{path=$(if($sourceRelative){$sourceRelative}else{'.'});sha256=(Get-FileHash -LiteralPath $catalogFile).Hash})
    foreach($directory in Get-ChildItem -LiteralPath $full -Directory -Force){
      if($directory.Name -in @('inbox','received','pending','tools','receipts','evidence-inbox')){
        # Do not enumerate these trees: they may contain further received archives or links.
        $script:receivedSkips.Add($directory.FullName.Substring($records.Length+1).Replace('\','/'))
      }elseif($directory.Name -eq 'evidence-archive'){
        Find-ReceivedRecords $directory.FullName ($Depth+1)
      }elseif($directory.Name -notin @('tests','maintenance','fixtures','legacy')){throw "Unexpected directory in received archive: $($directory.Name)"}
    }
    if(@(Get-ChildItem -LiteralPath $full -File -Force | Where-Object {$_.Name -notin @('README.md','catalog.json')}).Count){throw 'Unexpected file in received archive'}
    return
  }
  if((Split-Path -Leaf $full) -eq 'evidence-archive' -and @(Get-ChildItem -LiteralPath $full -Directory -Force | Where-Object {$_.Name -in @('tests','maintenance','fixtures')}).Count){throw 'Received archive catalog missing'}
  if(@(Get-ChildItem -LiteralPath $full -File -Force).Count){throw 'Put complete record or archive directories inside records; loose files are not accepted'}
  foreach($directory in Get-ChildItem -LiteralPath $full -Directory -Force | Sort-Object Name){
    if($directory.Name -in @('inbox','received','pending','tools','receipts','evidence-inbox')){
      $script:receivedSkips.Add($directory.FullName.Substring($records.Length+1).Replace('\','/'))
      continue
    }
    Find-ReceivedRecords $directory.FullName ($Depth+1)
  }
}

function Get-ReceivedPlan([string]$Records) {
  $seen=@{}
  foreach($item in @(Find-ReceivedRecords $Records)){
    $recordFile=Join-Path $item.source 'record.json'
    $record=Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    $relative=[string]$item.relative
    $destination=Assert-EvidencePath $project (Join-Path $root $relative)
    $sum=(Get-FileHash -LiteralPath (Join-Path $item.source 'SHA256SUMS.txt') -Algorithm SHA256).Hash
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
    $manifestPath=Join-Path $item.source 'original/manifest.json'
    $manifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson}else{$null}
    $sourceRelative=$item.source.Substring($Records.Length).TrimStart('\').Replace('\','/')
    [pscustomobject]@{source=$item.source;folder=$(if($sourceRelative){$sourceRelative}else{'.'});relative=$relative;destination=$destination;checksumsSha256=$sum;action=$action;sourceCommit=$manifest.source.commit;github=$record.github}
  }
}

if($Batch -and $Folder){throw 'Choose either -Batch (legacy layout) or -Folder'}
if($Apply -and ([string]::IsNullOrWhiteSpace($Contributor) -or $Contributor.Length -gt 200)){throw 'Apply requires a contributor name (1-200 characters)'}
if(!$Batch -and !$Folder){
  $null=New-Item -ItemType Directory -Path $inbox -Force
  Write-Output "Inbox: $inbox"
  Write-Output 'Drop entire evidence-archive folders directly into inbox. Extract ZIPs yourself; never overwrite your own catalog.'
  Write-Output 'Foreign inbox, received, pending and tools trees are skipped; only sealed records are merged.'
  Write-Output 'Preview: npm run evidence:import'
  Write-Output 'Import:  npm run evidence:import -- -Contributor Alice -Apply'
  foreach($file in Get-ChildItem -LiteralPath $inbox -File -Force){Write-Output "Unprocessed inbox file (extract ZIPs first): $($file.Name)"}
  $folders=@(Get-ChildItem -LiteralPath $inbox -Directory -Force | Sort-Object Name)
  if(!$folders.Count){Write-Output 'Inbox is empty; no archives to import.';return}
  foreach($item in $folders){
    Write-Output "Received folder: $($item.Name)"
    & $PSCommandPath -Project $project -Folder $item.Name -Contributor $Contributor -Apply:$Apply
  }
  return
}
$inputName=if($Folder){$Folder}else{$Batch}
$batchRoot=Assert-EvidencePath $project (Join-Path $inbox $inputName)
$records=if($Folder){$batchRoot}else{Assert-EvidencePath $project (Join-Path $batchRoot 'records')}
# Automatic intake also understands previously created batch wrappers.
if($Folder -and !(Test-Path (Join-Path $batchRoot 'catalog.json')) -and !(Test-Path (Join-Path $batchRoot 'record.json')) -and (Test-Path (Join-Path $batchRoot 'records') -PathType Container)){
  $records=Assert-EvidencePath $project (Join-Path $batchRoot 'records')
}
$script:receiptDestination=$null
$gate=$null;$transaction=$null;$committed=$false;$moved=@()
try {
  if($Apply){
    # Share the same lock as tests, imports and archive maintenance.
    $lock=Get-EvidenceLockPath $project
    try{$gate=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch{throw 'Evidence recording is active; import refused'}
    $null=Initialize-EvidenceArchive $project
  }
  if(Test-Path -LiteralPath (Join-Path $root 'catalog.json')){$null=Test-EvidenceCatalog $root}
  elseif(@(Get-EvidenceRecords $root).Count){throw 'Local archive catalog missing'}
  $plan=@(Get-ReceivedPlan $records)
  foreach($skipped in $script:receivedSkips){Write-Output "Skipped received subtree (original retained): $skipped"}
  if(!$plan.Count){throw 'No sealed records in the selected batch'}
  $plan | Select-Object action,relative | Format-Table -AutoSize
  $new=@($plan | Where-Object {$_.action -eq 'import'})
  if(!$Apply){Write-Output "Preview only: $($new.Count) new record(s). Use -Contributor <name> -Apply to import.";return}
  if(!$new.Count -and !$Folder){Write-Output 'All records already exist with identical checksums; nothing changed.';return}

  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $transaction=Assert-EvidencePath $project (Join-Path (Get-EvidencePendingRoot $project) ('local-import-'+$id))
  $null=New-Item -ItemType Directory -Path $transaction
  $receipt=[ordered]@{schema=1;operation='local-evidence-import';batch=$inputName;intakeFolder=$inputName;contributor=$Contributor;receivedFrom='user-supplied; not independently authenticated';importedAtUtc=[DateTime]::UtcNow.ToString('o');skippedSubtrees=@($script:receivedSkips.ToArray());sourceCatalogs=@($script:receivedCatalogs.ToArray());records=@($plan | ForEach-Object {[ordered]@{folder=$_.folder;path=$_.relative;checksumsSha256=$_.checksumsSha256;action=$_.action;sourceCommit=$_.sourceCommit;github=$_.github}})}
  $utf8=New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $transaction 'receipt.json'),($receipt | ConvertTo-Json -Depth 20),$utf8)
  if(!$new.Count){
    Save-ImportFiles $transaction $id
    $transaction=$null
    Write-Output 'All records already exist with identical checksums; catalog unchanged, received original retained outside inbox.'
    return
  }
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
  $manifest=@{schema=1;kind='build-maintenance';operation='local-evidence-import';createdAtUtc=$receipt.importedAtUtc;note='Import audit only; no product tests rerun';batch=$inputName;contributor=$Contributor;records=$new.Count}
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
  Save-ImportFiles $transaction $id
  $transaction=$null
  Write-Output "Imported $($new.Count) record(s); audit: $auditRelative"
} catch {
  if(!$committed){
    # Only move this transaction's new directories back; never delete existing archives.
    foreach($item in @($moved | Sort-Object relative -Descending)){
      $null=Assert-EvidencePath $project $item.destination
      $null=Assert-EvidencePath $project $item.candidate
      [IO.Directory]::Move($item.destination,$item.candidate)
    }
  }
  if($transaction){Write-Warning "Import interrupted (catalog committed: $committed); inspect inbox, transaction $transaction and receipt $script:receiptDestination; originals are preserved"}
  throw
} finally {if($gate){$gate.Dispose()}}
