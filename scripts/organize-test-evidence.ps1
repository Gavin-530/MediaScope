param([switch]$Apply,[string]$Project,[string]$VerificationDirectory)
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Project).TrimEnd('\')
$root=Get-EvidenceRoot $project
if(Test-Path -LiteralPath (Join-Path $root 'pending/test-run.lock')){throw 'Active/interrupted product test; organization refused'}
$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$tx=$null;$committed=$false;$moves=New-Object Collections.ArrayList
try {
  $before=Test-EvidenceCatalog $root
  $catalogPath=Join-Path $root 'catalog.json'
  $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8| ConvertFrom-EvidenceJson
  $records=@(Get-EvidenceRecords $root)
  $legacyRoot=Join-Path $root 'legacy/local-test-archive'
  $plans=@()
  foreach($item in $records){
    if($item.relative -like 'legacy/local-test-archive/*'){
      $payload=Get-EvidencePayload $item
      $mp=Join-Path $payload.source 'manifest.json'
      $m=if(Test-Path -LiteralPath $mp){Get-Content -LiteralPath $mp -Raw -Encoding UTF8| ConvertFrom-EvidenceJson}else{$null}
      if($m){
        if($m.kind -notin @('App','Package','OnlineDeployment','Custom','generated-fixture-snapshot','build-maintenance','pull-request-merge-audit','test-system-audit')){throw 'Unclassified legacy kind'}
        if(($payload.relative -match '^runs/') -ne ($m.kind -in @('App','Package','OnlineDeployment','Custom'))){throw 'Original type/path conflict'}
        $dest=Get-EvidenceDestination $project $payload.relative $m
      }else{
        # This is a mixed collection, not a fabricated test manifest/run.
        if($payload.relative -ne 'release-verification-2026-09-29-v0.2.0'){throw 'Unknown historical collection; inspect before organization'}
        $digest=(Get-FileHash -LiteralPath (Join-Path $payload.source 'SHA256SUMS.txt')).Hash
        $dest=Join-Path $root ('records/undated_release-materials_'+$digest.Substring(0,8).ToLowerInvariant())
      }
      $dest=Join-Path $root (Get-EvidenceFlatLocation ($dest.Substring($root.Length+1).Replace('\','/')))
      $plans+=@{from=$item.relative;to=$dest.Substring($root.Length+1).Replace('\','/');source=$item.source;originalRelative=$payload.relative;operation='wrap';kind=$(if($m){$m.kind}else{'historical-evidence-collection'})}
    }elseif($item.relative.StartsWith('maintenance/') -and $item.relative.Split('/')[-1] -notmatch '_'){
      $r=Get-Content -LiteralPath (Join-Path $item.source 'record.json') -Raw -Encoding UTF8| ConvertFrom-EvidenceJson
      $logical=$r.originalRelative
      $m=Get-Content -LiteralPath (Join-Path $item.source 'original/manifest.json') -Raw -Encoding UTF8| ConvertFrom-EvidenceJson
      if($m.note -eq 'Archive layout migration; no product tests rerun'){$logical=$logical -replace '^build-maintenance-','archive-migration-'}
      if($m.note -like 'Unified archive implementation*'){$logical=$logical -replace '^test-system-audit-','archive-implementation-'}
      $dest=Get-EvidenceDestination $project $logical
      $dest=Join-Path $root (Get-EvidenceFlatLocation ($dest.Substring($root.Length+1).Replace('\','/')))
      $plans+=@{from=$item.relative;to=$dest.Substring($root.Length+1).Replace('\','/');source=$item.source;originalRelative=$r.originalRelative;operation='rename';kind=$r.kind}
    }elseif(!$item.relative.StartsWith('records/')){
      $r=Get-Content -LiteralPath (Join-Path $item.source 'record.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
      $plans+=@{from=$item.relative;to=(Get-EvidenceFlatLocation $item.relative);source=$item.source;originalRelative=$r.originalRelative;operation='rename';kind=$r.kind}
    }
  }
  if(!$plans.Count){Write-Output 'No records need organization; archive unchanged.';exit 0}
  $seen=@{}
  foreach($plan in $plans){
    $dest=Assert-EvidencePath $project (Join-Path $root $plan.to)
    if($seen.ContainsKey($plan.to) -or (Test-Path -LiteralPath $dest)){throw "Organization destination exists: $($plan.to)"}
    $seen[$plan.to]=$true
  }
  Write-Output "Organization plan: $(@($plans|Where-Object {$_.operation -eq 'wrap'}).Count) historical wraps; $(@($plans|Where-Object {$_.operation -eq 'rename'}).Count) sealed records moved into records/."
  if(!$Apply){$plans|ForEach-Object {[pscustomobject]@{operation=$_.operation;from=$_.from;to=$_.to}}|Format-Table -AutoSize|Out-String -Width 240|Write-Output;exit 0}
  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $tx=Assert-EvidencePath $project (Join-Path (Get-EvidencePendingRoot $project) ('org-'+[guid]::NewGuid().ToString('N').Substring(0,8)))
  $null=New-Item -ItemType Directory -Path $tx
  $auditRaw=Join-Path $tx 'audit/original'
  $null=New-Item -ItemType Directory -Path $auditRaw -Force
  Copy-Item -LiteralPath $catalogPath -Destination (Join-Path $auditRaw 'catalog-before.json')
  $legacyInventory=@()
  if(Test-Path -LiteralPath $legacyRoot){
    $legacyInventory=@(Get-EvidenceFiles $legacyRoot|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full).Hash}})
    Copy-Item -LiteralPath (Join-Path $legacyRoot 'catalog.json') -Destination (Join-Path $auditRaw 'original-legacy-catalog.json')
  }
  if($VerificationDirectory){
    $verification=Assert-EvidencePath $project $VerificationDirectory
    $pending=Get-EvidencePendingRoot $project
    if(!$verification.StartsWith($pending+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Verification inputs must be in pending'}
    foreach($file in Get-EvidenceFiles $verification){
      $target=Assert-EvidencePath $project (Join-Path $auditRaw ('verification/'+$file.path))
      $null=New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
      Copy-Item -LiteralPath $file.full -Destination $target
      if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.full).Hash){throw 'Verification copy mismatch'}
    }
  }
  $maxPath=0;$originalFiles=0;$extendsLongPath=$false
  for($index=0;$index -lt $plans.Count;$index++){
    $plan=$plans[$index]
    $plan.inventory=@(Get-EvidenceFiles $plan.source|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full).Hash}})
    $originalFiles+=$plan.inventory.Count
    $stage=Join-Path $tx ('r'+$index)
    $plan.stage=$stage
    if($plan.operation -eq 'wrap'){
      $raw=Join-Path $stage 'original'
      $null=New-Item -ItemType Directory -Path $raw -Force
      foreach($file in $plan.inventory){
        $target=Assert-EvidencePath $project (Join-Path $raw $file.path)
        $null=New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
        [IO.File]::Copy((Join-Path $plan.source $file.path),$target,$false)
        if((Get-FileHash -LiteralPath $target).Hash -ne $file.sha256 -or (Get-Item -LiteralPath $target).Length -ne $file.bytes){throw 'Original evidence copy mismatch'}
        $length=(Join-Path (Join-Path $root $plan.to) ('original/'+$file.path)).Length
        if($length -gt $maxPath){$maxPath=$length}
        if($length -ge 260){$extendsLongPath=$true}
      }
      Write-EvidenceEnvelope $stage $plan.to $plan.originalRelative
    }else{
      foreach($file in $plan.inventory){
        $length=(Join-Path (Join-Path $root $plan.to) $file.path).Length
        if($length -gt $maxPath){$maxPath=$length}
        if($length -ge 260 -and $length -gt (Join-Path $plan.source $file.path).Length){$extendsLongPath=$true}
      }
      $null=Test-EvidenceRecord $plan.source $plan.to
    }
  }
  # Do not introduce or lengthen nonportable paths. Existing sealed records can
  # already contain long paths; moving them to a shorter parent preserves bytes.
  if($extendsLongPath){throw "Organization would introduce or lengthen a path beyond the portable Windows limit: $maxPath"}
  $auditLogical='archive-organization-'+$id
  $auditDest=Get-EvidenceDestination $project $auditLogical
  $auditDest=Join-Path $root (Get-EvidenceFlatLocation ($auditDest.Substring($root.Length+1).Replace('\','/')))
  $auditRelative=$auditDest.Substring($root.Length+1).Replace('\','/')
  $mapping=@($plans|ForEach-Object @{oldPath=$_.from;newPath=$_.to;originalRelative=$_.originalRelative;operation=$_.operation;kind=$_.kind;inventory=$_.inventory})
  $manifest=@{schema=1;kind='test-system-audit';createdAtUtc=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture);note='Archive organization; original evidence bytes and existing sealed record bytes preserved; no product tests rerun';recordsBefore=$before;wrapped=@($plans|Where-Object {$_.operation -eq 'wrap'}).Count;renamed=@($plans|Where-Object {$_.operation -eq 'rename'}).Count;originalFilesVerified=$originalFiles;maximumOrganizedPathLength=$maxPath;mapping=$mapping;legacyInventory=$legacyInventory}
  [IO.File]::WriteAllText((Join-Path $auditRaw 'manifest.json'),($manifest|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
  $report=@('# Archive organization receipt','',
    "Original records: $before; historical wraps: $($manifest.wrapped); sealed record moves: $($manifest.renamed).",
    "Every original file was verified by size and SHA-256; unsealed legacy files were copied before wrapping. Maximum organized original path: $maxPath characters.",
    'Existing sealed envelopes are moved without changing any file bytes. Their old record.json path remains a sealed identity; the catalog records the current location.',
    'Mixed release materials have unknown overall result and timestamp. Existing report/log claims remain original; they are not converted into new product pass counts.',
    'manifest.json maps old paths to current locations. Historical catalogs are byte-exact snapshots, not active registries.',
    'Final catalog is validated against staged records before atomic commit. Failure before commit rolls back directory moves; interrupted copies remain in protected pending.',
    '', '| Old path | Current path |','| --- | --- |')
  foreach($plan in $plans){$report+="| $($plan.from) | $($plan.to) |"}
  [IO.File]::WriteAllLines((Join-Path $auditRaw 'report.md'),$report,(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $auditRaw
  Write-EvidenceEnvelope (Join-Path $tx 'audit') $auditRelative $auditLogical
  function Move-OrganizationPath($From,$To){
    $fromPath=Assert-EvidencePath $project $From;$toPath=Assert-EvidencePath $project $To
    if(Test-Path -LiteralPath $toPath){throw 'Transaction target exists'}
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $toPath) -Force
    $null=$moves.Add(@{from=$fromPath;to=$toPath})
    [IO.File]::WriteAllText((Join-Path $tx 'journal.json'),(@{phase='moving';moves=@($moves)}|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
    [IO.Directory]::Move($fromPath,$toPath)
  }
  if(Test-Path -LiteralPath $legacyRoot){Move-OrganizationPath $legacyRoot (Join-Path $tx 'legacy-backup')}
  foreach($plan in $plans){
    $source=if($plan.operation -eq 'wrap'){$plan.stage}else{$plan.source}
    Move-OrganizationPath $source (Join-Path $root $plan.to)
    $raw=if($plan.operation -eq 'wrap'){Join-Path (Join-Path $root $plan.to) 'original'}else{Join-Path $root $plan.to}
    if(@(Get-EvidenceFiles $raw).Count -ne $plan.inventory.Count){throw 'Published original file count changed'}
    foreach($file in $plan.inventory){
      $actual=Join-Path $raw $file.path
      if((Get-FileHash -LiteralPath $actual).Hash -ne $file.sha256 -or (Get-Item -LiteralPath $actual).Length -ne $file.bytes){throw 'Published original bytes changed'}
    }
  }
  Move-OrganizationPath (Join-Path $tx 'audit') $auditDest
  $new=@{schema=2;layout='flat';records=@(Get-EvidenceRecords $root|ForEach-Object {Get-EvidenceCatalogEntry $_})}
  $history=@($catalog.historicalCatalogs|Where-Object {$_})
  foreach($entry in $history){
    foreach($plan in $plans){
      if($entry.path.StartsWith($plan.from+'/')){$entry.path=$plan.to+$entry.path.Substring($plan.from.Length);break}
    }
  }
  if($legacyInventory.Count){$history+=@{path=$auditRelative+'/original/original-legacy-catalog.json';sha256=($legacyInventory|Where-Object {$_.path -eq 'catalog.json'}).sha256}}
  if($history.Count){$new.historicalCatalogs=$history}
  $verified=Test-EvidenceCatalogData $root $new
  if($verified -ne $before+1){throw 'Organization changed product record count'}
  $candidate=Join-Path $tx 'catalog-new.json'
  [IO.File]::WriteAllText($candidate,($new|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  [IO.File]::Replace($candidate,$catalogPath,(Join-Path $tx 'catalog-old.json'))
  $committed=$true
  if((Test-EvidenceCatalog $root) -ne $before+1){throw 'Final catalog verification failed'}
  # Delete only checked redundant copies; every byte has a registered destination.
  if($legacyInventory.Count){
    $backup=Join-Path $tx 'legacy-backup'
    if(@(Get-EvidenceFiles $backup).Count -ne $legacyInventory.Count){throw 'Unexpected rollback backup files; preserve transaction'}
    foreach($file in $legacyInventory){
      if((Get-FileHash -LiteralPath (Join-Path $backup $file.path)).Hash -ne $file.sha256){throw 'Rollback backup changed; preserve transaction'}
    }
  }
  $checked=Assert-EvidencePath $project $tx
  if(!$checked.StartsWith((Get-EvidencePendingRoot $project)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid transaction cleanup target'}
  Remove-Item -LiteralPath $checked -Recurse -Force
  # Remove only known empty former category directories; no recursive deletion.
  foreach($relative in @('tests/local','tests/github-actions','tests','maintenance','fixtures','legacy/local-test-archive','legacy')){
    $empty=Assert-EvidencePath $project (Join-Path $root $relative)
    if((Test-Path -LiteralPath $empty -PathType Container) -and @(Get-ChildItem -LiteralPath $empty -Force).Count -eq 0){[IO.Directory]::Delete($empty)}
  }
  Write-Output "Organized $($manifest.wrapped) historical records; renamed $($manifest.renamed) sealed record directories; original bytes verified."
  Write-Output "Audit: $auditDest"
  Write-Output "Verified $verified records; maximum organized original path length: $maxPath."
}catch{
  if(!$committed){
    for($index=$moves.Count-1;$index -ge 0;$index--){
      $move=$moves[$index]
      $null=Assert-EvidencePath $project $move.from;$null=Assert-EvidencePath $project $move.to
      if((Test-Path -LiteralPath $move.to) -and !(Test-Path -LiteralPath $move.from)){[IO.Directory]::Move($move.to,$move.from)}
    }
  }
  if($tx){Write-Warning "Preserve transaction for inspection: $tx; catalog committed: $committed"}
  throw
}finally{$gate.Dispose()}
