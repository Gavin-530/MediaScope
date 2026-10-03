# Transport validation only. Never execute downloaded code.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-GitHubEvidencePath($Project,$Value) {
  $root=[IO.Path]::GetFullPath($Project).TrimEnd('\')
  $full=[IO.Path]::GetFullPath($Value)
  if(!$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Outside workspace: $full"}
  $part=$full
  while($part -ne $root){
    if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Linked evidence path: $part"}
    $part=Split-Path -Parent $part
  }
  return $full
}

function Expand-GitHubEvidenceZip($Archive,$Destination) {
  if(Test-Path -LiteralPath $Destination){throw 'Extraction destination already exists'}
  $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $seen=@{};[long]$total=0
    foreach($entry in $zip.Entries){
      $name=$entry.FullName.Replace('\','/').TrimEnd('/')
      if(!$name -or $name -match '(^/|:|(^|/)\.\.?(/|$)|[<>"|?*]|[. ](/|$)|(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$))'){throw "Unsafe ZIP entry: $name"}
      $full=[IO.Path]::GetFullPath((Join-Path $Destination $name))
      if(!$full.StartsWith([IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw "ZIP escapes destination: $name"}
      if($seen.ContainsKey($name)){throw "Duplicate ZIP entry: $name"};$seen[$name]=$true
      if(($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000){throw 'ZIP links are forbidden'}
      $total+=$entry.Length
      if($total -gt 3GB){throw 'Evidence ZIP exceeds 3 GiB extraction limit'}
    }
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip,$Destination)
  } finally {$zip.Dispose()}
}

function Test-GitHubEvidenceBundle($Root) {
  $null=Test-EvidenceChecksums $Root
  $m=Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
  if($m.schema -notin @(1,2) -or $m.kind -ne 'github-actions-evidence' -or $m.bundleId -notmatch ('^'+(Get-EvidenceIdentifierPattern)+'$') -or
     $m.github.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $m.github.runId -notmatch '^[1-9]\d*$' -or
     $m.github.runAttempt -notmatch '^[1-9]\d*$' -or $m.github.sha -notmatch '^[a-f0-9]{40}$' -or
     $m.testStepOutcome -notin @('success','failure','cancelled','skipped')){throw 'Invalid GitHub evidence identity'}
  $null=Get-EvidenceRunTime $m.bundleId
  foreach($file in Get-EvidenceFiles $Root){
    if($file.path -notin @('manifest.json','SHA256SUMS.txt') -and $file.path -notmatch '^(records|diagnostics|pending)/'){throw "Unexpected bundle file: $($file.path)"}
  }
  $recordsRoot=Join-Path $Root 'records';$records=@()
  if(Test-Path -LiteralPath $recordsRoot){
    $null=Test-EvidenceCatalog $recordsRoot
    $records=@(Get-EvidenceRecords $recordsRoot)
    foreach($record in $records){
      if((Get-EvidencePayload $record).relative -notmatch '^runs/'){throw 'Cloud export cannot include local maintenance records'}
      $app=Get-Content -LiteralPath (Join-Path (Get-EvidencePayload $record).source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
      if($app.kind -ne 'App' -or $app.github.repository -ne $m.github.repository -or $app.github.runId -ne $m.github.runId -or
         $app.github.runAttempt -ne $m.github.runAttempt -or $app.github.sha -ne $m.github.sha){throw 'Application/cloud provenance mismatch'}
      if($app.harness.commit -and $app.harness.commit -ne $m.github.sha){throw 'Application harness commit mismatch'}
      if($app.source.commit -and $app.source.commit -ne $m.github.sha){throw 'Application source commit mismatch'}
    }
  }
  if($m.testStepOutcome -eq 'success'){
    if($records.Count -ne 1 -or (Test-Path -LiteralPath (Join-Path $Root 'pending'))){throw 'Successful CI requires exactly one complete record and no pending evidence'}
    $app=Get-Content -LiteralPath (Join-Path (Get-EvidencePayload $records[0]).source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    if($app.schema -ne 3 -or $app.outcome -ne 'passed' -or !$app.releaseCheck.requested -or !$app.releaseCheck.ready -or
       $app.harness.commit -ne $m.github.sha -or $app.source.commit -ne $m.github.sha){throw 'Successful CI is missing strict release evidence'}
  }
  if($m.schema -eq 2 -and ($records.Count -ne 1 -or $app.evidenceRevision -ne 2 -or (Test-Path -LiteralPath (Join-Path $Root 'pending')))) {throw 'Independent cloud bundle requires one revision 2 record'}
  return $m
}

function Get-ArchivedGitHubEvidence($Root,$Repository,$RunId,$Attempt) {
  foreach($record in Get-EvidenceRecords $Root){
    try{
      $payload=Get-EvidencePayload $record
      if($payload.relative -notmatch '^(github-actions-|runs/)'){continue}
      $m=Get-Content -LiteralPath (Join-Path $payload.source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    }catch{continue} # A damaged unrelated manifest cannot block another run's import.
    if($m.kind -in @('github-actions-evidence','App') -and $m.github.repository -eq $Repository -and $m.github.runId -eq $RunId -and $m.github.runAttempt -eq $Attempt){return $record}
  }
}

function Import-GitHubEvidence($Project,$Archive,$Repository,$RunId,$Attempt,[string]$Commit) {
  $root=Get-EvidenceRoot $Project
  $build=Get-EvidencePendingRoot $Project
  New-Item -ItemType Directory -Force -Path $build | Out-Null
  $gate=[IO.File]::Open((Get-EvidenceLockPath $Project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $staging=$null
  $outer=$null
  try {
    $root=Initialize-EvidenceArchive $Project

    $staging=Assert-GitHubEvidencePath $Project (Join-Path $build ('github-evidence-import/'+[guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staging) | Out-Null
    Expand-GitHubEvidenceZip $Archive $staging
    $transport=$Archive
    if(!(Test-Path -LiteralPath (Join-Path $staging 'manifest.json')) -and (Test-Path -LiteralPath (Join-Path $staging 'bundle.zip'))){
      $outer=$staging
      $transport=Join-Path $staging 'bundle.zip'
      $inner=$staging+'-inner'
      Expand-GitHubEvidenceZip $transport $inner
      $staging=$inner
    }
    $m=Test-GitHubEvidenceBundle $staging
    if($m.github.repository -ne $Repository -or ($RunId -and $m.github.runId -ne $RunId) -or ($Attempt -and $m.github.runAttempt -ne $Attempt) -or ($Commit -and $m.github.sha -ne $Commit)){throw 'Downloaded evidence does not match requested repository/run/attempt'}
    if($m.schema -eq 2){
      $incoming=@(Get-EvidenceRecords (Join-Path $staging 'records'))
      if($incoming.Count -ne 1){throw 'Independent cloud transport requires one run'}
      $payload=Get-EvidencePayload $incoming[0]
      $app=Get-Content -LiteralPath (Join-Path $payload.source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
      if($app.evidenceRevision -ne 2){throw 'Independent cloud transport contains legacy evidence'}
      $originalSum=(Get-FileHash -LiteralPath (Join-Path $payload.source 'SHA256SUMS.txt')).Hash
      $existing=Get-ArchivedGitHubEvidence $root $Repository $m.github.runId $m.github.runAttempt
      if($existing){
        $null=Test-EvidenceRecord $existing.source $existing.relative
        $savedPayload=(Get-EvidencePayload $existing).source
        $originPath=Join-Path $savedPayload 'origin.json'
        if(Test-Path -LiteralPath $originPath){
          $origin=Get-Content -LiteralPath $originPath -Raw|ConvertFrom-EvidenceJson
          $savedSum=$origin.originalChecksumsSha256
          if($origin.testStepOutcome -ne $m.testStepOutcome){throw 'Existing GitHub run differs; overwrite refused'}
        }else{$savedSum=(Get-FileHash (Join-Path $savedPayload 'SHA256SUMS.txt')).Hash}
        if($savedSum -ne $originalSum){throw 'Existing GitHub run differs; overwrite refused'}
        $null=Assert-GitHubEvidencePath $Project $staging
        Remove-Item -LiteralPath $staging -Recurse -Force
        if($outer){$null=Assert-GitHubEvidencePath $Project $outer;$null=Get-EvidenceFiles $outer;Remove-Item -LiteralPath $outer -Recurse -Force}
        return $existing.source
      }
      # Retain CI execution status and transport identity, not the transport bytes.
      $origin=@{schema=1;kind='github-actions';testStepOutcome=$m.testStepOutcome;originalChecksumsSha256=$originalSum;transportSha256=(Get-FileHash -LiteralPath $Archive).Hash}
      [IO.File]::WriteAllText((Join-Path $payload.source 'origin.json'),($origin|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
      Write-EvidenceChecksums $payload.source
      $destination=Publish-EvidenceRecord $Project $payload.source $payload.relative
      $null=Assert-GitHubEvidencePath $Project $staging
      Remove-Item -LiteralPath $staging -Recurse -Force
      if($outer){$null=Assert-GitHubEvidencePath $Project $outer;$null=Get-EvidenceFiles $outer;Remove-Item -LiteralPath $outer -Recurse -Force}
      return $destination
    }
    $existing=Get-ArchivedGitHubEvidence $root $Repository $m.github.runId $m.github.runAttempt
    if($existing){
      if((Get-FileHash -LiteralPath (Join-Path (Get-EvidencePayload $existing).source 'SHA256SUMS.txt')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $staging 'SHA256SUMS.txt')).Hash){throw 'Existing GitHub run differs; overwrite refused'}
      $null=Assert-GitHubEvidencePath $Project $staging
      Remove-Item -LiteralPath $staging -Recurse -Force
      return $existing.source
    }
    $relative='github-actions-'+$m.bundleId
    $destination=Publish-EvidenceRecord $Project $staging $relative $transport $Archive

    return $destination
  } catch {
    if($staging -and (Test-Path -LiteralPath $staging)){Write-Warning "Import failed; diagnostic copy retained: $staging"}
    throw
  } finally {$gate.Dispose()}
}
