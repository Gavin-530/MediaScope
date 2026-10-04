param([switch]$Apply,[string]$ResumeDirectory)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=Get-EvidenceRoot $project
$pending=Get-EvidencePendingRoot $project
$records=@(Get-EvidenceRecords $root)
$legacy=@($records|Where-Object {Test-Path -LiteralPath (Join-Path $_.source 'record.json')})
$pendingRuns=if(Test-Path -LiteralPath (Join-Path $pending 'test-runs')){@(Get-ChildItem -LiteralPath (Join-Path $pending 'test-runs') -Directory)}else{@()}
Write-Output "Plan: compact $($legacy.Count) historical records; review $($pendingRuns.Count) pending tests and old download/import/deployment copies."
if(!$Apply){exit 0}
$emptyCategories=@('test-runs','deployment-runs','downloads','github-downloads','github-evidence-import','staging')
$unfinished=@(Get-ChildItem -LiteralPath $pending -Force|Where-Object {$_.Name -ne 'recording.lock' -and (!$_.PSIsContainer -or @(Get-EvidenceFiles $_.FullName).Count -gt 0)})
if(!$ResumeDirectory -and !$legacy.Count -and !$unfinished.Count){
  foreach($dir in Get-ChildItem -LiteralPath $pending -Directory){if($dir.Name -in $emptyCategories -and @(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -eq 0){[IO.Directory]::Delete($dir.FullName)}}
  Write-Output 'No unfinished evidence or historical envelopes; records unchanged.';exit 0
}
if(Test-Path -LiteralPath (Join-Path $pending 'test-run.lock')){throw 'Inspect active/interrupted test-run.lock first'}
$active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'"|Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.IndexOf((Join-Path $pending 'test-runs'),[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine -match '[\\/]scripts[\\/](test\.mjs|record-test\.ps1|sync-github-test-evidence\.mjs)\b')
})
if($active.Count){throw 'A relevant test/recording process is still active'}
$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$id=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$tx=Assert-EvidencePath $project (Join-Path $project ('.build/evidence-maintenance-'+$id))
if($ResumeDirectory){
  $tx=Assert-EvidencePath $project $ResumeDirectory
  if((Split-Path -Parent $tx) -ne (Join-Path $project '.build') -or (Split-Path -Leaf $tx) -notmatch '^evidence-maintenance-(\d{8}T\d{9}Z-[a-f0-9]{8})$'){throw 'Invalid maintenance resume directory'}
  $id=$Matches[1]
}
$null=New-Item -ItemType Directory -Path $tx -Force
$journal=New-Object Collections.ArrayList
$receipt=@{schema=1;kind='test-system-audit';createdAtUtc=[DateTime]::UtcNow.ToString('o');note='Explicit historical compaction and pending finalization; no product tests rerun; original outcomes and time precision retained';records=@();pending=@()}
if($ResumeDirectory){
  foreach($entry in (Get-Content -LiteralPath (Join-Path $tx 'journal.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson)){
    if($entry.phase -ne 'installed' -or (Test-Path -LiteralPath $entry.backup)){throw 'An unfinished directory swap requires manual recovery'}
    $null=$journal.Add($entry)
  }
  $receipt=Get-Content -LiteralPath (Join-Path $tx 'receipt.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
}
$utf8=New-Object Text.UTF8Encoding($false)
function Save-Json($Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 60),$utf8)}
function Save-Gzip($Path,[byte[]]$Bytes){
  $stream=[IO.File]::Create($Path)
  try{$gzip=New-Object IO.Compression.GzipStream($stream,[IO.Compression.CompressionMode]::Compress);try{$gzip.Write($Bytes,0,$Bytes.Length)}finally{$gzip.Dispose()}}finally{$stream.Dispose()}
}
function Digest([byte[]]$Bytes){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Obsolete-Generated([string]$Name){
  return $Name -match '(^|/)(archive-layout|local-import|github-evidence|independent-evidence|test-system)-[A-Za-z0-9]{6}(/|$)' -or
    $Name -match '(^|/)(desktop-profile|node_modules|runtimes|evidence-archive|github-archive)/(?!pending/(test-runs|deployment-runs)/)' -or
    $Name -match '\.(mkv|mp4|webm|avi|mov|yuv|y4m|wav|exe|dll|mjs|js|css|html|ps1|cmd|bat|zip)(\.gz)?$' -or
    $Name -match '(^|/)(README\.md|package(-lock)?\.json|harness-package-lock\.json|runtime-lock\.json|MANIFEST\.json|source-manifest\.json|artifact-manifest\.json|catalog\.json|SHA256SUMS\.txt)(\.gz)?$'
}
function Safe-Relative([string]$Name){
  if(!$Name -or $Name -match '[\\:]' -or $Name.StartsWith('/') -or @($Name.Split('/')|Where-Object {$_ -in @('..','.','')}).Count){throw "Unsafe archived path: $Name"}
}
function Pack-Data($Raw,$Stage){
  $entries=New-Object Collections.ArrayList
  $remove=New-Object Collections.ArrayList
  $stats=@{discardedFiles=0;discardedBytes=0;retainedDataFiles=0}
  foreach($file in Get-EvidenceFiles $Raw){
    $n=$file.path
    if($n -match '^(source|before-source)/' -or $n -in @('source.zip','harness.zip','artifact-manifest.json','source-inventory.json.gz','protocol-fixtures.zip')){
      $null=$remove.Add($n);$stats.discardedFiles++;$stats.discardedBytes+=$file.bytes;continue
    }
    if($n -in @('fixtures.zip','diagnostics.zip')){
      $zip=[IO.Compression.ZipFile]::OpenRead($file.full)
      try{
        $names=@{}
        foreach($entry in $zip.Entries){
          if($entry.FullName.EndsWith('/')){continue}
          Safe-Relative $entry.FullName
          if($names.ContainsKey($entry.FullName.ToLowerInvariant())){throw 'Duplicate ZIP path'};$names[$entry.FullName.ToLowerInvariant()]=$true
          if(Obsolete-Generated $entry.FullName){$stats.discardedFiles++;$stats.discardedBytes+=$entry.Length;continue}
          $input=$entry.Open();$memory=New-Object IO.MemoryStream
          try{$input.CopyTo($memory);$bytes=$memory.ToArray()}finally{$input.Dispose();$memory.Dispose()}
          $null=$entries.Add(@{path=$n+'/'+$entry.FullName;bytes=$bytes.Length;sha256=(Digest $bytes);base64=[Convert]::ToBase64String($bytes)})
        }
      }finally{$zip.Dispose()}
      $null=$remove.Add($n);continue
    }
    if($n -match '^(artifacts|sandbox-diagnostics|diagnostics|retained|interrupted-app-evidence)/'){
      $null=$remove.Add($n)
      if(Obsolete-Generated $n){$stats.discardedFiles++;$stats.discardedBytes+=$file.bytes;continue}
      $bytes=[IO.File]::ReadAllBytes($file.full)
      $null=$entries.Add(@{path=$n;bytes=$bytes.Length;sha256=(Digest $bytes);base64=[Convert]::ToBase64String($bytes)})
    }
  }
  if($entries.Count){
    $pack=@{schema=1;encoding='base64';note='Lossless historical attachments. Paths identify the original file or ZIP entry. No new measurements or test passes.';entries=@($entries)}
    Save-Gzip (Join-Path $Stage 'historical-data.json.gz') ($utf8.GetBytes(($pack|ConvertTo-Json -Depth 8 -Compress)))
    # Verify every packed byte by decoding the actual saved gzip, before any source removal.
    $stream=[IO.File]::OpenRead((Join-Path $Stage 'historical-data.json.gz'));$gzip=New-Object IO.Compression.GzipStream($stream,[IO.Compression.CompressionMode]::Decompress);$reader=New-Object IO.StreamReader($gzip,$utf8)
    try{$saved=$reader.ReadToEnd()|ConvertFrom-EvidenceJson}finally{$reader.Dispose();$gzip.Dispose();$stream.Dispose()}
    if(@($saved.entries).Count -ne $entries.Count){throw 'Packed data count changed'}
    foreach($entry in $saved.entries){$bytes=[Convert]::FromBase64String($entry.base64);if($bytes.Length -ne $entry.bytes -or (Digest $bytes) -ne $entry.sha256){throw 'Packed historical data mismatch'}}
    $stats.retainedDataFiles=$entries.Count
  }
  return @{remove=@($remove);stats=$stats}
}
function Checked-Delete($Path,$Inventory){
  $target=Assert-EvidencePath $project $Path
  if($target -ne $tx -and !$target.StartsWith($tx+'\',[StringComparison]::OrdinalIgnoreCase) -and !$target.StartsWith($pending+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid maintenance deletion target'}
  $actual=@(Get-EvidenceFiles $target)
  $expected=@($Inventory)
  if($actual.Count -ne $expected.Count){throw 'Cleanup file count changed'}
  foreach($f in $expected){if((Get-FileHash -LiteralPath (Join-Path $target $f.path)).Hash -ne $f.sha256){throw 'Cleanup source changed'}}
  Remove-Item -LiteralPath $target -Recurse -Force
}
function Inventory($Path){return @(Get-EvidenceFiles $Path|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash -LiteralPath $_.full).Hash}})}
function Install-Record($Source,$Stage,$Name,$Inventory){
  $dest=Assert-EvidencePath $project (Join-Path $root ('records/'+$Name))
  if($dest -ne $Source -and (Test-Path -LiteralPath $dest)){throw 'Maintenance destination exists'}
  $null=Test-EvidenceRecord $Stage ('records/'+$Name)
  $backup=Join-Path $tx ('backup-'+[guid]::NewGuid().ToString('N'))
  $null=$journal.Add(@{source=$Source;destination=$dest;backup=$backup;phase='planned'})
  Save-Json (Join-Path $tx 'journal.json') @($journal)
  [IO.Directory]::Move($Source,$backup)
  try{[IO.Directory]::Move($Stage,$dest);$null=Test-EvidenceRecord $dest ('records/'+$Name)}catch{if(Test-Path -LiteralPath $dest){[IO.Directory]::Move($dest,$Stage)};[IO.Directory]::Move($backup,$Source);throw}
  $journal[$journal.Count-1].phase='installed';Save-Json (Join-Path $tx 'journal.json') @($journal)
  Checked-Delete $backup $Inventory
}
function Compact-Record($item){
    $null=Test-EvidenceRecord $item.source $item.relative
    $before=Inventory $item.source
    $r=Get-Content -LiteralPath (Join-Path $item.source 'record.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    $raw=Join-Path $item.source 'original'
    $mp=Join-Path $raw 'manifest.json'
    $m=if(Test-Path -LiteralPath $mp){Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson}else{[pscustomobject]@{schema=1;kind='historical-evidence-collection';outcome='unknown'}}
    $identifier=if(Test-Path -LiteralPath $mp){(Get-EvidenceOriginalTime $r.originalRelative).identifier}else{'undated-'+$r.originalChecksumsSha256.Substring(0,8).ToLowerInvariant()}
    $name=Convert-EvidenceRunName $identifier
    $stage=Join-Path $tx ('stage-'+$name+'-'+[guid]::NewGuid().ToString('N'));$null=New-Item -ItemType Directory -Path $stage
    $pack=Pack-Data $raw $stage
    $oldFiles=@(Get-EvidenceFiles $raw)
    foreach($file in $oldFiles){
      if($file.path -in @('manifest.json','SHA256SUMS.txt') -or $file.path -in $pack.remove){continue}
      $target=Join-Path $stage $file.path;$null=New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force
      [IO.File]::Copy($file.full,$target)
      if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.full).Hash){throw 'Retained original bytes changed'}
    }
    $archive=@{schema=1;operation='historical-compaction';originalPath=$item.relative;originalRelative=$r.originalRelative;identifier=$identifier;previousChecksumsSha256=(Get-FileHash -LiteralPath (Join-Path $item.source 'SHA256SUMS.txt')).Hash;originalManifestSha256=$(if(Test-Path -LiteralPath $mp){(Get-FileHash -LiteralPath $mp).Hash}else{$null});compactedAtUtc=[DateTime]::UtcNow.ToString('o');rerun=$false;originalOutcome=$(if($m.outcome){$m.outcome}else{'archived'});originalEnvelopeOutcome=$r.outcome;originalTimePrecision=$r.identifierTimePrecision;sourceSnapshotsRetained=$false;retention=$pack.stats}
    $m|Add-Member -NotePropertyName archiveRevision -NotePropertyValue 1 -Force
    $m|Add-Member -NotePropertyName archive -NotePropertyValue $archive -Force
    if($m.kind -eq 'generated-fixture-snapshot'){
      $removed=@();foreach($key in @('items','files')){if($m.PSObject.Properties.Name -contains $key){$removed+=$key;$m.PSObject.Properties.Remove($key)}}
      $m.archive.discardedManifestFields=$removed
    }
    Save-Json (Join-Path $stage 'manifest.json') $m
    Write-EvidenceChecksums $stage
    Install-Record $item.source $stage $name $before
    $receipt.records+=@{from=$item.relative;to='records/'+$name;originalChecksumsSha256=$archive.previousChecksumsSha256;retention=$pack.stats}
    Write-Output "Compacted: $name"
}
try{
  $completed=Join-Path $root ('records/'+(Convert-EvidenceRunName $id))
  if($ResumeDirectory -and (Test-Path -LiteralPath (Join-Path $completed 'manifest.json'))){
    $m=Get-Content -LiteralPath (Join-Path $completed 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    if($m.archive.originalRelative -ne ('evidence-maintenance-'+$id)){throw 'Unexpected completed maintenance identity'}
    $count=Test-EvidenceCatalog $root
    Checked-Delete $tx (Inventory $tx)
    Write-Output "Finalized $count verified records; maintenance transaction reclaimed."
    return
  }
  foreach($item in $legacy){Compact-Record $item}
  foreach($run in $pendingRuns){
    $before=Inventory $run.FullName
    $raw=Join-Path $run.FullName 'evidence';$mp=Join-Path $raw 'manifest.json'
    if(Test-Path -LiteralPath $mp){
      $m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
      if($m.runId -ne $run.Name -or !$m.endedAt -or $m.outcome -ne 'blocked' -or $m.exitCode -ne 2){throw 'Unknown pending test state; preserve'}
      Write-EvidenceChecksums $raw
      $null=Test-EvidenceRecord $raw ('runs/'+$m.version+'/'+$m.runId)
      $dest=Publish-EvidenceRecord $project $raw ('runs/'+$m.version+'/'+$m.runId)
      $remaining=Inventory $run.FullName
      Checked-Delete $run.FullName $remaining
      $receipt.pending+=@{run=$run.Name;state='blocked';record=$dest;reason=$m.blockedReason}
    }else{
      $stage=Join-Path $tx ('interrupted-'+$run.Name);$null=New-Item -ItemType Directory -Path $stage
      foreach($file in Get-EvidenceFiles $raw){[IO.File]::Copy($file.full,(Join-Path $stage $file.path))}
      & node (Join-Path $PSScriptRoot 'recover-interrupted-data.mjs') (Join-Path $run.FullName 'source/test-work') $stage
      if($LASTEXITCODE -ne 0){throw 'Interrupted measurements could not be retained'}
      Save-Json (Join-Path $stage 'manifest.json') @{schema=1;kind='build-maintenance';createdAtUtc=[DateTime]::UtcNow.ToString('o');interruptedRun=$run.Name;executionState='interrupted';note='No final run manifest or suite summary. Original events/logs and available measurements retained; no complete regression or product pass claimed.'}
      $dest=Publish-EvidenceRecord $project $stage ('interrupted-test-'+$run.Name)
      Compact-Record @{source=$dest;relative='records/'+(Split-Path -Leaf $dest)}
      $dest=Join-Path $root ('records/'+(Convert-EvidenceRunName $run.Name))
      Checked-Delete $run.FullName $before
      $receipt.pending+=@{run=$run.Name;state='interrupted';record=$dest}
    }
  }
  # Old downloads are removed only when identical bytes exist in the permanent platform archive.
  $platform=@(Get-EvidenceFiles (Join-Path $project 'github-archive')|Where-Object {$_.path -match '/(original|files|payload)/|\.(zip|json)$'})
  $sizes=@{};foreach($f in $platform){$key=[string]$f.bytes;if(!$sizes.ContainsKey($key)){$sizes[$key]=@()};$sizes[$key]+=$f}
  foreach($category in @('downloads','github-evidence-import')){
    $parent=Join-Path $pending $category
    if(!(Test-Path -LiteralPath $parent)){continue}
    foreach($dir in Get-ChildItem -LiteralPath $parent -Directory){
      $before=Inventory $dir.FullName;$zip=@($before|Where-Object {$_.path -in @('artifact.zip','bundle.zip')})
      if($zip.Count -ne 1 -or @($before|Where-Object {$_.path -notin @('artifact.zip','bundle.zip','github-metadata.json')}).Count){throw 'Unknown download/import leftovers'}
      $transport=$zip[0];$sizeKey=[string]$transport.bytes
      $copies=if($sizes.ContainsKey($sizeKey)){@($sizes[$sizeKey]|Where-Object {$_ -and (Get-FileHash -LiteralPath $_.full).Hash -eq $transport.sha256})}else{@()}
      if(!$copies.Count){
        # Revision 2 imports intentionally discard transport ZIPs. Verify the transport,
        # then compare every original product byte with the independently sealed copy.
        $origins=@($platform|Where-Object {$_.path.EndsWith('/origin.json')}|Where-Object {(Get-Content -LiteralPath $_.full -Raw -Encoding UTF8|ConvertFrom-EvidenceJson).transportSha256 -eq $transport.sha256})
        if(!$origins.Count){throw "No permanent transport or validated product for $($dir.Name); preserve"}
        $unpacked=Join-Path $tx ('transport-'+[guid]::NewGuid().ToString('N'))
        Expand-GitHubEvidenceZip (Join-Path $dir.FullName $transport.path) $unpacked
        if(Test-Path -LiteralPath (Join-Path $unpacked 'bundle.zip')){Expand-GitHubEvidenceZip (Join-Path $unpacked 'bundle.zip') ($unpacked+'-inner');$unpacked=$unpacked+'-inner'}
        $bundle=Test-GitHubEvidenceBundle $unpacked
        if($bundle.schema -ne 2){throw 'Only revision 2 transport may be deduplicated by product contents'}
        $incoming=@(Get-EvidenceRecords (Join-Path $unpacked 'records'))
        if($incoming.Count -ne 1){throw 'Ambiguous transport product'}
        $payload=(Get-EvidencePayload $incoming[0]).source
        $origin=Get-Content -LiteralPath $origins[0].full -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
        $saved=Split-Path -Parent $origins[0].full
        if((Get-FileHash -LiteralPath (Join-Path $payload 'SHA256SUMS.txt')).Hash -ne $origin.originalChecksumsSha256 -or $bundle.testStepOutcome -ne $origin.testStepOutcome){throw 'Transport/product identity mismatch'}
        $incomingFiles=@(Get-EvidenceFiles $payload|Where-Object {$_.path -ne 'SHA256SUMS.txt'})
        if(@(Get-EvidenceFiles $saved).Count -ne $incomingFiles.Count+2){throw 'Permanent product file set differs'}
        foreach($f in $incomingFiles){if((Get-FileHash -LiteralPath (Join-Path $saved $f.path)).Hash -ne (Get-FileHash -LiteralPath $f.full).Hash){throw 'Permanent product bytes differ'}}
        $m=Get-Content -LiteralPath (Join-Path $saved 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
        $null=Test-EvidenceRecord $saved ('runs/'+$m.version+'/'+$m.runId)
        $copies=@($origins[0])
      }
      # Verify the containing platform snapshot, including its manifest and all bytes.
      $copyPath=($copies|Select-Object -First 1).full
      if(!$copyPath){throw 'Permanent copy path was not resolved'}
      & node (Join-Path $PSScriptRoot 'verify-maintenance-copy.mjs') $copyPath
      if($LASTEXITCODE -ne 0){throw 'Permanent platform copy failed verification'}
      $receipt.pending+=@{path=$dir.FullName;state='duplicate-transport';retainedCopy=$copyPath;sha256=$transport.sha256}
      Checked-Delete $dir.FullName $before
    }
  }
  $deployments=if(Test-Path -LiteralPath (Join-Path $pending 'deployment-runs')){@(Get-ChildItem -LiteralPath (Join-Path $pending 'deployment-runs') -Directory)}else{@()}
  foreach($dir in $deployments){
    if($dir.Name -notmatch '^verify-[a-f0-9]{32}$'){throw 'Unknown deployment leftovers'}
    $before=Inventory $dir.FullName
    $receipt.pending+=@{path=$dir.FullName;state='unfinished-deployment-sandbox';files=$before.Count;note='No completed deployment result present; no pass claimed';manifests=@(Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -Filter MANIFEST.json|ForEach-Object {Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8|ConvertFrom-EvidenceJson})}
    # Save the recovery receipt before discarding this rebuildable package sandbox.
    Save-Json (Join-Path $tx 'receipt.json') $receipt
    Checked-Delete $dir.FullName $before
  }
  $sync=Join-Path $pending 'sync-state.json'
  if(Test-Path -LiteralPath $sync){$receipt|Add-Member -NotePropertyName legacySyncState -NotePropertyValue (Get-Content -LiteralPath $sync -Raw -Encoding UTF8|ConvertFrom-EvidenceJson) -Force}
  $audit=Join-Path $tx 'audit';$null=New-Item -ItemType Directory -Path $audit
  Save-Json (Join-Path $audit 'manifest.json') $receipt
  $auditDest=Publish-EvidenceRecord $project $audit ('evidence-maintenance-'+$id)
  Compact-Record @{source=$auditDest;relative='records/'+(Split-Path -Leaf $auditDest)}
  $auditDest=Join-Path $root ('records/'+(Convert-EvidenceRunName $id))
  if(Test-Path -LiteralPath $sync){Remove-Item -LiteralPath (Assert-EvidencePath $project $sync) -Force}
  foreach($dir in Get-ChildItem -LiteralPath $pending -Directory){if($dir.Name -in $emptyCategories -and @(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -eq 0){[IO.Directory]::Delete($dir.FullName)}}
  # Optional cache loses obsolete historical-path references after flattening.
  $cache=Join-Path $root 'catalog.json';if(Test-Path -LiteralPath $cache){Save-Json $cache @{schema=2;layout='flat';role='cache';records=@()}}
  Update-EvidenceCatalogCache $root
  $count=Test-EvidenceCatalog $root
  Write-Output "Verified $count records. Receipt: $auditDest"
  Checked-Delete $tx (Inventory $tx)
}catch{Save-Json (Join-Path $tx 'receipt.json') $receipt;Write-Warning "Maintenance interrupted; completed records remain valid. Inspect $tx";throw}
finally{$gate.Dispose()}
