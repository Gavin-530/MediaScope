param([switch]$Apply,[switch]$Rollback,[string]$Project)
$ErrorActionPreference='Stop'
if($Apply -and $Rollback){throw 'Choose Apply or Rollback'}
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Project).TrimEnd('\')
$root=Get-EvidenceRoot $project
$pending=Get-EvidencePendingRoot $project
$journalPath=Assert-EvidencePath $project (Join-Path $pending 'record-name-migration.json')
$utf8=New-Object Text.UTF8Encoding($false)
$gate=$null
function Save-Journal($Journal){
  $temp=$journalPath+'.tmp'
  $null=Assert-EvidencePath $project $temp
  [IO.File]::WriteAllText($temp,($Journal|ConvertTo-Json -Depth 30),$utf8)
  if(Test-Path -LiteralPath $journalPath){[IO.File]::Replace($temp,$journalPath,[NullString]::Value)}else{[IO.File]::Move($temp,$journalPath)}
}
function Inventory([string]$Path){
  return @(Get-EvidenceFiles $Path|Sort-Object path|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full -Algorithm SHA256).Hash}})
}
function Assert-Inventory([string]$Path,$Files){
  $actual=@(Inventory $Path)
  if($actual.Count -ne @($Files).Count){throw 'Migration file count mismatch'}
  for($i=0;$i -lt $actual.Count;$i++){
    if($actual[$i].path -ne $Files[$i].path -or $actual[$i].bytes -ne $Files[$i].bytes -or $actual[$i].sha256 -ne $Files[$i].sha256){throw "Migration bytes changed: $Path"}
  }
}
function Assert-Journal($Journal){
  if($Journal.schema -ne 1 -or $Journal.operation -ne 'readable-record-names' -or $Journal.project -ne $project -or $Journal.id -notmatch ('^'+(Get-EvidenceIdentifierPattern)+'$')){throw 'Invalid name migration journal'}
  $seen=@{}
  foreach($row in $Journal.mapping){
    if($row.from -notmatch '^records/[A-Za-z0-9_.-]+$' -or $row.to -notmatch '^records/[A-Za-z0-9_.-]+$' -or $row.from -eq $row.to -or $seen.ContainsKey($row.to)){throw 'Invalid migration paths'}
    $seen[$row.to]=$true
    $old=Assert-EvidencePath $project (Join-Path $root $row.from)
    $new=Assert-EvidencePath $project (Join-Path $root $row.to)
    if((Test-Path -LiteralPath $old) -eq (Test-Path -LiteralPath $new)){throw 'Missing or ambiguous migration record'}
    $source=if(Test-Path -LiteralPath $old){$old}else{$new}
    if($row.to -notin @(('records/'+(Get-EvidenceRecordReadableName $source)),('records/'+(Get-EvidenceRecordReadableName $source -Generic)))){throw 'Migration description or identity mismatch'}
    Assert-Inventory $source $row.files
    $null=Test-EvidenceRecord $source $row.from
    $null=Test-EvidenceRecord $source $row.to
  }
}
function Restore-Journal($Journal){
  Assert-Journal $Journal
  $auditName=Get-EvidenceReadableName @{kind='test-system-audit'} $Journal.id
  if(Test-Path -LiteralPath (Join-Path $root ('records/'+$auditName))){throw 'Sealed migration receipt exists; resume with -Apply instead of rolling it back'}
  # Inspect paths and all bytes, not a saved move counter: a process may die
  # between a directory rename and the atomic journal replacement.
  foreach($row in @($Journal.mapping|Sort-Object from -Descending)){
    $old=Assert-EvidencePath $project (Join-Path $root $row.from)
    $new=Assert-EvidencePath $project (Join-Path $root $row.to)
    if(Test-Path -LiteralPath $new){[IO.Directory]::Move($new,$old)}
  }
  $catalog=Join-Path $root 'catalog.json'
  if($Journal.catalogExisted){[IO.File]::WriteAllBytes($catalog,[Convert]::FromBase64String($Journal.catalogBefore))}
  elseif(Test-Path -LiteralPath $catalog){Remove-Item -LiteralPath $catalog}
  $Journal.state='rolled-back';Save-Journal $Journal
}
function Finish-Migration($Journal){
  Assert-Journal $Journal
  foreach($row in $Journal.mapping){if(!(Test-Path -LiteralPath (Join-Path $root $row.to))){throw 'Verified migration has an uncommitted move'}}
  $audit=Assert-EvidencePath $project (Join-Path $pending ('name-audit-'+$Journal.id))
  $auditRelative='records/'+(Get-EvidenceReadableName @{kind='test-system-audit'} $Journal.id)
  $auditDest=Assert-EvidencePath $project (Join-Path $root $auditRelative)
  if(!(Test-Path -LiteralPath $auditDest)){
    if(Test-Path -LiteralPath $audit){foreach($file in Get-EvidenceFiles $audit){if($file.path -notin @('manifest.json','mapping.json','catalog-before.json','SHA256SUMS.txt')){throw 'Unexpected interrupted audit content'}}}
    $null=New-Item -ItemType Directory -Path $audit -Force
    $report=@{schema=1;operation='readable-record-names';mapping=$Journal.mapping;recordCount=@($Journal.mapping).Count;originalBytesUnchanged=$true;independentCopiesVerified=$true;oldPathVerificationPassed=$true}
    [IO.File]::WriteAllText((Join-Path $audit 'mapping.json'),($report|ConvertTo-Json -Depth 30),$utf8)
    if($Journal.catalogExisted){[IO.File]::WriteAllBytes((Join-Path $audit 'catalog-before.json'),[Convert]::FromBase64String($Journal.catalogBefore))}
    $manifest=@{schema=1;kind='test-system-audit';operation='readable-record-names';createdAtUtc=$Journal.startedAtUtc;note='Directory naming migration only; all original sealed bytes and source identity retained; no product tests rerun'}
    [IO.File]::WriteAllText((Join-Path $audit 'manifest.json'),($manifest|ConvertTo-Json -Depth 8),$utf8)
    Write-EvidenceChecksums $audit
    $auditDest=Publish-EvidenceRecord $project $audit ('test-system-audit-'+$Journal.id)
  }
  $null=Test-EvidenceRecord $auditDest $auditRelative
  $saved=Get-Content -LiteralPath (Join-Path $auditDest 'original/mapping.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
  if($saved.operation -ne 'readable-record-names' -or @($saved.mapping).Count -ne @($Journal.mapping).Count){throw 'Migration receipt mismatch'}
  for($i=0;$i -lt @($Journal.mapping).Count;$i++){
    if($saved.mapping[$i].from -ne $Journal.mapping[$i].from -or $saved.mapping[$i].to -ne $Journal.mapping[$i].to){throw 'Migration receipt mapping mismatch'}
    Assert-Inventory (Join-Path $root $saved.mapping[$i].to) $saved.mapping[$i].files
  }
  Update-EvidenceCatalogCache $root
  $cache=Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
  $null=Test-EvidenceCatalogData $root $cache
  $Journal.state='completed'
  if($Journal -is [Collections.IDictionary]){$Journal.auditPath=$auditRelative}else{$Journal|Add-Member -MemberType NoteProperty -Name auditPath -Value $auditRelative -Force}
  Save-Journal $Journal
  Write-Output "Migrated $(@($Journal.mapping).Count) records; every original byte and independent copy verified. Audit: $auditRelative"
}
try {
  if(Test-Path -LiteralPath (Join-Path $pending 'test-run.lock')){throw 'Active/interrupted product test; naming migration refused'}
  $gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  if(Test-Path -LiteralPath $journalPath){
    $previous=Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    if($previous.state -notin @('completed','rolled-back')){
      if($previous.state -eq 'verified' -and $Apply){Finish-Migration $previous;return}
      if(!$Rollback){throw 'Interrupted name migration: use -Rollback after inspecting the preserved journal'}
      Restore-Journal $previous;Write-Output 'Restored original names, bytes and catalog.';return
    }
  }
  if($Rollback){throw 'No interrupted naming transaction to roll back'}
  $plans=@();$seen=@{}
  foreach($record in Get-EvidenceRecords $root){
    if($record.relative -notmatch '^records/[^/]+$'){throw 'Organize legacy categories before migrating display names'}
    $null=Test-EvidenceRecord $record.source $record.relative
    $to='records/'+(Get-EvidenceRecordReadableName $record.source)
    if($seen.ContainsKey($to)){throw "Short-name collision; no records changed: $to"}
    $seen[$to]=$true
    if($to -eq $record.relative){continue}
    $target=Assert-EvidencePath $project (Join-Path $root $to)
    if(Test-Path -LiteralPath $target){throw "Migration destination exists: $to"}
    foreach($file in Get-EvidenceFiles $record.source){
      $length=(Join-Path $target $file.path).Length
      if($length -ge 260 -and $length -gt $file.full.Length){throw "Migration would introduce or lengthen a nonportable path: $to"}
    }
    $null=Test-EvidenceRecord $record.source $to
    $plans+=@{from=$record.relative;to=$to;files=@(Inventory $record.source)}
  }
  if(!$plans.Count){Write-Output 'All record names are current; nothing changed.';return}
  $plans|ForEach-Object {[pscustomobject]@{from=$_.from;to=$_.to}}|Format-Table -AutoSize|Out-String -Width 240|Write-Output
  if(!$Apply){Write-Output "Preview only: $($plans.Count) records. Use -Apply to migrate.";return}
  $id=New-EvidenceRunId $project
  $catalogPath=Join-Path $root 'catalog.json'
  $journal=@{schema=1;operation='readable-record-names';project=$project;id=$id;state='moving';startedAtUtc=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");catalogExisted=(Test-Path -LiteralPath $catalogPath);catalogBefore=$null;mapping=$plans}
  if($journal.catalogExisted){$journal.catalogBefore=[Convert]::ToBase64String([IO.File]::ReadAllBytes($catalogPath))}
  Save-Journal $journal
  try {
    foreach($row in $plans){
      $old=Assert-EvidencePath $project (Join-Path $root $row.from)
      $new=Assert-EvidencePath $project (Join-Path $root $row.to)
      Assert-Inventory $old $row.files
      [IO.Directory]::Move($old,$new)
      $null=Test-EvidenceRecord $new $row.to;Assert-Inventory $new $row.files
    }
    # Real independent copy, verified at both the new and historical path.
    $proof=Assert-EvidencePath $project (Join-Path $pending ('name-proof-'+$id))
    if(Test-Path -LiteralPath $proof){throw 'Proof destination exists'}
    foreach($row in $plans){
      $new=Assert-EvidencePath $project (Join-Path $root $row.to)
      $null=New-Item -ItemType Directory -Path $proof
      $copy=Join-Path $proof 'copy'
      Copy-Item -LiteralPath $new -Destination $copy -Recurse
      $null=Test-EvidenceRecord $copy $row.to
      $null=Test-EvidenceRecord $copy $row.from
      Assert-Inventory $copy $row.files
      $null=Assert-EvidencePath $project $proof
      if((Split-Path -Parent $proof) -ne $pending -or (Split-Path -Leaf $proof) -ne ('name-proof-'+$id)){throw 'Invalid proof cleanup path'}
      Remove-Item -LiteralPath $proof -Recurse -Force
    }
    Update-EvidenceCatalogCache $root
    $null=Test-EvidenceCatalog $root
    $cache=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    if($cache.historicalCatalogs){
      foreach($entry in $cache.historicalCatalogs){
        foreach($row in $plans){if($entry.path.StartsWith($row.from+'/')){$entry.path=$row.to+$entry.path.Substring($row.from.Length)}}
      }
      $cacheNew=$catalogPath+'.naming.tmp';$null=Assert-EvidencePath $project $cacheNew
      [IO.File]::WriteAllText($cacheNew,($cache|ConvertTo-Json -Depth 30),$utf8)
      [IO.File]::Replace($cacheNew,$catalogPath,[NullString]::Value)
    }
    $null=Test-EvidenceCatalogData $root $cache
    $journal.state='verified';Save-Journal $journal
  }catch{
    $failure=$_
    Restore-Journal $journal
    throw $failure
  }
  Finish-Migration $journal
}finally{if($gate){$gate.Dispose()}}
