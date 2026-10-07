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
    $r=Get-Content -LiteralPath (Join-Path $full 'record.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    $null=Test-EvidenceRecord $full ([string]$r.path)
    return @{source=$full;relative=[string]$r.path}
  }
  if(Test-Path -LiteralPath (Join-Path $full 'manifest.json') -PathType Leaf){
    Assert-ReceivedTree $full
    $m=Get-Content -LiteralPath (Join-Path $full 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    if($m.evidenceRevision -ne 2 -and $m.archiveRevision -ne 1){throw 'Received legacy records need sealed envelopes or explicit compaction metadata before import'}
    $identifier=if($m.archiveRevision -eq 1){$m.archive.identifier}else{$m.runId}
    $relative='records/'+(Convert-EvidenceRunName $identifier)
    $null=Test-EvidenceRecord $full $relative
    return @{source=$full;relative=$relative}
  }
  # Cache presence, missing entries and old history references are not dependencies.
  $catalogFile=Join-Path $full 'catalog.json'
  if(Test-Path -LiteralPath $catalogFile -PathType Leaf){
    $null=Assert-EvidencePath $project $catalogFile
    $script:receivedCatalogs.Add(@{path=$full.Substring($records.Length).TrimStart('\');sha256=(Get-FileHash -LiteralPath $catalogFile).Hash})
  }
  foreach($file in Get-ChildItem -LiteralPath $full -File -Force){
    if($file.Name -notin @('README.md','catalog.json')){throw 'Put complete record or archive directories inside records; loose files are not accepted'}
  }
  foreach($directory in Get-ChildItem -LiteralPath $full -Directory -Force | Sort-Object Name){
    if($directory.Name -in @('inbox','received','pending','tools','receipts','evidence-inbox')){
      $script:receivedSkips.Add($directory.FullName.Substring($records.Length+1).Replace('\','/'))
      continue
    }
    Find-ReceivedRecords $directory.FullName ($Depth+1)
  }
}
function Get-ImportIdentity($Source) {
  if(Test-Path -LiteralPath (Join-Path $Source 'record.json')){return (Get-Content -LiteralPath (Join-Path $Source 'record.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson)}
  $m=Get-Content -LiteralPath (Join-Path $Source 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
  if($m.archiveRevision -eq 1){return @{category=$(if($m.archive.originalRelative.StartsWith('runs/')){'tests'}elseif($m.kind -eq 'generated-fixture-snapshot'){'fixtures'}else{'maintenance'});origin=$(if($m.github){'github-actions'}else{'local'});originalRelative=$m.archive.originalRelative;github=$m.github}}
  return @{category='tests';origin=$(if($m.github){'github-actions'}else{'local'});originalRelative=('runs/'+$m.version+'/'+$m.runId);github=$m.github}
}

function Get-ReceivedPlan([string]$Records) {
  $seen=@{}
  $seenTargets=@{}
  $locations=@{}
  $existing=@{}
  foreach($local in Get-EvidenceRecords $root){
    if($local.relative.StartsWith('legacy/')){continue}
    try{$envelope=Get-ImportIdentity $local.source}catch{continue}
    $identity=$envelope.category+'|'+$envelope.origin+'|'+$envelope.originalRelative
    if($existing.ContainsKey($identity)){throw "Conflicting local sealed identity: $identity"}
    $existing[$identity]=$local
  }
  foreach($item in @(Find-ReceivedRecords $Records)){
    $recordFile=Join-Path $item.source 'record.json'
    $record=Get-ImportIdentity $item.source
    if($record.github -and $project -eq [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')){throw 'Received cloud evidence needs repository-bound github:import or reviewed archive merge; original retained, old cloud destination refused'}
    $relative='records/'+(Get-EvidenceRecordReadableName $item.source)
    $identity=$record.category+'|'+$record.origin+'|'+$record.originalRelative
    $destination=Assert-EvidencePath $project (Join-Path $root $relative)
    $sum=(Get-FileHash -LiteralPath (Join-Path $item.source 'SHA256SUMS.txt') -Algorithm SHA256).Hash
    $action='import'
    if($seen.ContainsKey($identity)){
      if($seen[$identity] -ne $sum){throw "Conflicting received identity: $relative"}
      $action='duplicate'
      $relative=$seenTargets[$identity]
      $destination=Join-Path $root $relative
    }elseif($existing.ContainsKey($identity)){
      $local=$existing[$identity]
      $null=Test-EvidenceRecord $local.source $local.relative
      if((Get-FileHash -LiteralPath (Join-Path $local.source 'SHA256SUMS.txt') -Algorithm SHA256).Hash -ne $sum){throw "Existing evidence conflicts: $relative"}
      $action='duplicate'
      $relative=$local.relative
      $destination=$local.source
    }
    if($action -eq 'import' -and ((Test-Path -LiteralPath $destination) -or ($locations.ContainsKey($relative) -and $locations[$relative] -ne $identity))){throw "Conflicting received destination: $relative"}
    $seen[$identity]=$sum
    $seenTargets[$identity]=$relative
    $locations[$relative]=$identity
    $manifestPath=Join-Path (Get-EvidencePayload $item).source 'manifest.json'
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

  $plan=@(Get-ReceivedPlan $records)
  foreach($skipped in $script:receivedSkips){Write-Output "Skipped received subtree (original retained): $skipped"}
  if(!$plan.Count){throw 'No sealed records in the selected batch; expected a modern sealed archive or independent record'}
  $plan | Select-Object action,relative | Format-Table -AutoSize
  $new=@($plan | Where-Object {$_.action -eq 'import'})
  if(!$Apply){Write-Output "Preview only: $($new.Count) new record(s). Use -Contributor <name> -Apply to import.";return}
  if(!$new.Count -and !$Folder){Write-Output 'All records already exist with identical checksums; nothing changed.';return}

  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $transaction=Assert-EvidencePath $project (Join-Path (Get-EvidencePendingRoot $project) ('local-import-'+$id))
  $null=New-Item -ItemType Directory -Path $transaction
  $receipt=[ordered]@{schema=1;operation='local-evidence-import';batch=$inputName;intakeFolder=$inputName;contributor=$Contributor;receivedFrom='user-supplied; not independently authenticated';importedAtUtc=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture);skippedSubtrees=@($script:receivedSkips.ToArray());sourceCatalogs=@($script:receivedCatalogs.ToArray());records=@($plan | ForEach-Object {[ordered]@{folder=$_.folder;path=$_.relative;checksumsSha256=$_.checksumsSha256;action=$_.action;sourceCommit=$_.sourceCommit;github=$_.github}})}
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
  $known=@(foreach($existingRecord in Get-EvidenceRecords $root){
    $existingSum=Join-Path $existingRecord.source 'SHA256SUMS.txt'
    if(Test-Path -LiteralPath $existingSum -PathType Leaf){@{path=$existingRecord.relative;checksumsSha256=(Get-FileHash -LiteralPath $existingSum).Hash}}
  })
  $catalog=@{schema=2;layout='flat';role='cache';records=@($known)+@($entries)}
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
  foreach($item in $staged){$null=Test-EvidenceRecord $item.destination $item.relative}
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
