param([switch]$Apply,[string]$Project,[switch]$KeepLegacyLayout)
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Project).TrimEnd('\')
$old=Assert-EvidencePath $project (Join-Path $project 'local-test-archive')
$root=Get-EvidenceRoot $project
$destination=Assert-EvidencePath $project (Join-Path $root 'legacy/local-test-archive')
if(!(Test-Path -LiteralPath $old)){
  if(Test-Path -LiteralPath $destination){& (Join-Path $PSScriptRoot 'organize-test-evidence.ps1') -Project $project -Apply:$Apply}
  else{Write-Output 'No unmigrated legacy archive exists.'}
  exit 0
}
$count=Test-EvidenceCatalog $old
Write-Output "Legacy records: $count; destination: $destination"
if(Test-Path -LiteralPath $destination){throw 'Migration destination already exists; no overwrite allowed'}
foreach($path in @('.build/test-run.lock','evidence-archive/pending/test-run.lock')){
  if(Test-Path -LiteralPath (Join-Path $project $path)){throw 'Active/interrupted test lock; migration refused'}
}
foreach($path in @('.build/evidence-staging','.build/test-runs','.build/github-evidence-import')){
  $full=Assert-EvidencePath $project (Join-Path $project $path)
  if((Test-Path -LiteralPath $full) -and @(Get-ChildItem -LiteralPath $full -Force).Count){throw "Unfinished legacy evidence must be recovered before migration: $full"}
}
if(!$Apply){Write-Output 'Preview only. Use -Apply after reviewing the destination.';exit 0}
$null=Initialize-EvidenceArchive $project
$pending=Get-EvidencePendingRoot $project
$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$legacyLockPath=Assert-EvidencePath $project (Join-Path $project '.build/evidence-recording.lock')
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $legacyLockPath) -Force
$legacyGate=$null
try {
  $legacyGate=[IO.File]::Open($legacyLockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $before=Test-EvidenceCatalog $root
  $inventory=@(Get-EvidenceFiles $old|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full).Hash}})
  $oldCatalog=Get-Content -LiteralPath (Join-Path $old 'catalog.json') -Raw -Encoding UTF8
  $catalog=Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8|ConvertFrom-Json
  [IO.Directory]::Move($old,$destination)
  try {
    $null=Test-EvidenceCatalog $destination
    $copied=@(Get-EvidenceFiles $destination)
    if($copied.Count -ne $inventory.Count){throw 'Migration file count changed'}
    foreach($file in $inventory){
      $actual=Join-Path $destination $file.path
      if((Get-Item -LiteralPath $actual).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $actual).Hash -ne $file.sha256){throw "Migration byte mismatch: $($file.path)"}
    }
    $entries=@($catalog.records)+@(Get-EvidenceRecords $destination|ForEach-Object {Get-EvidenceCatalogEntry @{source=$_.source;relative=('legacy/local-test-archive/'+$_.relative)}})
    $updated=@{schema=2;records=$entries;legacyCatalogSha256=($inventory|Where-Object {$_.path -eq 'catalog.json'}).sha256}|ConvertTo-Json -Depth 8
    $candidate=Join-Path $pending ('catalog.json.'+[guid]::NewGuid().ToString('N')+'.tmp')
    [IO.File]::WriteAllText($candidate,$updated,(New-Object Text.UTF8Encoding($false)))
    [IO.File]::Replace($candidate,(Join-Path $root 'catalog.json'),[NullString]::Value)
    $verified=Test-EvidenceCatalog $root
    if($verified -ne $before+$count){throw 'Migration record count mismatch'}
  }catch{
    # Original bytes survive even a failed transaction. Roll back the directory
    # only before its new catalog has committed.
    $current=Get-Content -LiteralPath (Join-Path $root 'catalog.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if(!@($current.records|Where-Object {$_.path -like 'legacy/local-test-archive/*'}).Count){[IO.Directory]::Move($destination,$old)}
    throw
  }
  $id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $audit=Join-Path $pending ('staging/migration-'+$id)
  $null=New-Item -ItemType Directory -Path $audit -Force
  $map=@{schema=1;kind='build-maintenance';createdAtUtc=[DateTime]::UtcNow.ToString('o');note='Archive layout migration; no product tests rerun';records=$count;files=$inventory.Count;oldRoot='local-test-archive';newRoot='evidence-archive/legacy/local-test-archive';inventory=$inventory}
  [IO.File]::WriteAllText((Join-Path $audit 'manifest.json'),($map|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $audit 'original-catalog.json'),$oldCatalog,(New-Object Text.UTF8Encoding($false)))
  $auditDestination=Publish-EvidenceRecord $project $audit ('archive-migration-'+$id)
  Write-Output "Migrated $count records / $($inventory.Count) files without changing their bytes."
  Write-Output "Migration audit: $auditDestination"
  Write-Output "Verified $(Test-EvidenceCatalog $root) records."
}finally{if($legacyGate){$legacyGate.Dispose()};$gate.Dispose()}
foreach($path in @('.build/evidence-staging','.build/test-runs','.build/github-evidence-import')){
  $full=Assert-EvidencePath $project (Join-Path $project $path)
  if((Test-Path -LiteralPath $full) -and !(Get-ChildItem -LiteralPath $full -Force)){Remove-Item -LiteralPath $full}
}

# The retired legacy lock has no contents. Remove only this checked, empty file
# after both recording handles were released; no recursive cache deletion.
if((Test-Path -LiteralPath $legacyLockPath) -and (Get-Item -LiteralPath $legacyLockPath).Length -eq 0){
  Remove-Item -LiteralPath $legacyLockPath
}
if(!$KeepLegacyLayout){& (Join-Path $PSScriptRoot 'organize-test-evidence.ps1') -Project $project -Apply}
