$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"

# JSON time values are evidence strings, not normalized DateTime instances.
function ConvertFrom-EvidenceJson {
  param([Parameter(ValueFromPipeline=$true)][string]$Json)
  process {
    $command=Get-Command ConvertFrom-Json
    if($command.Parameters.ContainsKey('DateKind')){return (ConvertFrom-Json -InputObject $Json -DateKind String)}
    $probe=ConvertFrom-Json -InputObject '"2026-01-01T00:00:00.120Z"'
    if($probe -isnot [string]){throw 'JSON parser changes timestamp precision; use Windows PowerShell 5.1 or PowerShell with DateKind String support'}
    return (ConvertFrom-Json -InputObject $Json)
  }
}

function Get-EvidenceRoot($Project) {
  $projectRoot=[IO.Path]::GetFullPath($Project).TrimEnd('\')
  $local=[IO.Path]::GetFullPath((Join-Path $Project 'evidence-archive')).TrimEnd('\')
  if(!$local.StartsWith($projectRoot+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw "Test evidence must stay inside MediaScope: $local"
  }
  $part=$local
  while($part.StartsWith($projectRoot+'\',[StringComparison]::OrdinalIgnoreCase)){
    if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
      throw "Linked evidence directory is forbidden: $part"
    }
    $part=Split-Path -Parent $part
  }
  return $local
}

function Get-EvidenceRecords($Root) {
  if(!(Test-Path -LiteralPath $Root -PathType Container)){return @()}
  if((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence root: $Root"}
  $records=@()
  $catalogPath=Join-Path $Root 'catalog.json'
  $modern=(Split-Path -Leaf $Root) -eq 'evidence-archive'
  $modern=$modern -or (Test-Path -LiteralPath (Join-Path $Root 'records')) -or (Test-Path -LiteralPath (Join-Path $Root 'tests'))
  if($modern){
    foreach($path in @('records','tests/local','tests/github-actions','maintenance','fixtures')){
      $parent=Join-Path $Root $path
      if(!(Test-Path -LiteralPath $parent)){continue}
      if((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked record category'}
      foreach($directory in Get-ChildItem -LiteralPath $parent -Directory -Force){
        if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked evidence record'}
        $records+=@{source=$directory.FullName;relative=$path+'/'+$directory.Name}
      }
      if(@(Get-ChildItem -LiteralPath $parent -File -Force).Count){throw 'Unexpected file in record category'}
    }
    $legacyRoot=Join-Path $Root 'legacy/local-test-archive'
    if(Test-Path -LiteralPath $legacyRoot){
      foreach($record in Get-EvidenceRecords $legacyRoot){$records+=@{source=$record.source;relative='legacy/local-test-archive/'+$record.relative}}
    }
    return $records
  }
  foreach($legacy in Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object {$_.Name -ne 'runs' -and $_.Name -notmatch '\.partial-[a-f0-9]{32}$'}){
    if($legacy.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence record: $($legacy.FullName)"}
    $records+=@{source=$legacy.FullName;relative=$legacy.Name}
  }
  $runsRoot=Join-Path $Root 'runs'
  if(Test-Path -LiteralPath $runsRoot){
    if((Get-Item -LiteralPath $runsRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked runs root: $runsRoot"}
    foreach($version in Get-ChildItem -LiteralPath $runsRoot -Directory -Force){
      if($version.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked version directory: $($version.FullName)"}
      foreach($run in Get-ChildItem -LiteralPath $version.FullName -Directory -Force | Where-Object {$_.Name -notmatch '\.partial-[a-f0-9]{32}$'}){
        if($run.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence run: $($run.FullName)"}
        $records+=@{source=$run.FullName;relative="runs/$($version.Name)/$($run.Name)"}
      }
    }
  }
  return $records
}

function Get-EvidenceFiles($Root) {
  if(!(Test-Path -LiteralPath $Root -PathType Container)){throw "Evidence directory missing: $Root"}
  if((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence root is forbidden: $Root"}
  $base=[IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'
  $stack=New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Root)
  $items=New-Object Collections.ArrayList
  while($stack.Count){
    foreach($item in Get-ChildItem -LiteralPath $stack.Pop() -Force){
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence entry is forbidden: $($item.FullName)"}
      if($item.PSIsContainer){$stack.Push($item.FullName)}else{$null=$items.Add($item)}
    }
  }
  return @($items | ForEach-Object {
    @{path=$_.FullName.Substring($base.Length).Replace('\','/');full=$_.FullName;bytes=$_.Length}
  } | Sort-Object path)
}

function Write-EvidenceChecksums($Root) {
  $lines=@(Get-EvidenceFiles $Root | Where-Object {$_.path -ne 'SHA256SUMS.txt'} | ForEach-Object {
    "$( (Get-FileHash -LiteralPath $_.full -Algorithm SHA256).Hash )  $($_.path)"
  })
  [IO.File]::WriteAllLines((Join-Path $Root 'SHA256SUMS.txt'),$lines,(New-Object Text.UTF8Encoding($false)))
}

function Test-EvidenceChecksums($Root) {
  $sum=Join-Path $Root 'SHA256SUMS.txt'
  if(!(Test-Path -LiteralPath $sum -PathType Leaf)){throw "Missing checksums: $sum"}
  $files=@(Get-EvidenceFiles $Root | Where-Object {$_.path -ne 'SHA256SUMS.txt'})
  $lines=@(Get-Content -LiteralPath $sum -Encoding UTF8 | Where-Object {$_ -ne ''})
  if($files.Count -ne $lines.Count){throw "Checksum entry count mismatch: $Root"}
  $expected=@{};foreach($file in $files){$expected[$file.path]=$file}
  foreach($line in $lines){
    if($line -notmatch '^([A-Fa-f0-9]{64})  (.+)$'){throw "Malformed checksum line: $line"}
    $hash=$Matches[1];$name=$Matches[2]
    if(!$expected.ContainsKey($name)){throw "Unexpected checksum entry: $name"}
    if((Get-FileHash -LiteralPath $expected[$name].full -Algorithm SHA256).Hash -ne $hash){throw "Checksum mismatch: $name"}
    $expected.Remove($name)
  }
  if($expected.Count){throw "Files missing from checksums: $Root"}
  return $true
}

function Test-EvidenceRecord($Root,$Relative) {
  $null=Test-EvidenceChecksums $Root
  if(Test-Path -LiteralPath (Join-Path $Root 'record.json')){return (Test-EvidenceEnvelope $Root $Relative)}
  if(Test-Path -LiteralPath (Join-Path $Root 'manifest.json')){
    $direct=Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    if($direct.evidenceRevision -eq 2){
      if($direct.kind -notin @('App','Package','Deployment','OnlineDeployment','Custom')){throw 'Invalid independent record kind'}
      if(!$Relative.StartsWith('records/') -and !$Relative.StartsWith('runs/')){throw 'Invalid independent record location'}
      if($Relative.StartsWith('records/') -and $Relative -ne ('records/'+(Convert-EvidenceRunName $direct.runId))){throw 'Independent record location mismatch'}
      if($Relative.StartsWith('records/')){$Relative='runs/'+$direct.version+'/'+$direct.runId}
    }
  }
  $Relative=$Relative -replace '^legacy/local-test-archive/',''
  if(!$Relative.StartsWith('runs/',[StringComparison]::OrdinalIgnoreCase)){
    if($Relative -match '^github-actions-'){
      . (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
      $cloud=Test-GitHubEvidenceBundle $Root
      if($Relative -ne 'github-actions-'+$cloud.bundleId){throw 'Cloud bundle directory identity mismatch'}
    }
    return $true
  }
  $parts=$Relative.Split('/')
  if($parts.Count -ne 3 -or $parts[1] -notmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9][0-9]*))?)?$' -or $parts[2] -notmatch ('^'+(Get-EvidenceIdentifierPattern)+'$')){throw "Invalid run directory layout: $Relative"}
  $null=Get-EvidenceRunTime $parts[2]
  $manifestPath=Join-Path $Root 'manifest.json'
  if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw "Run manifest missing: $Relative"}
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
  if($manifest.schema -notin @(1,2,3) -or $manifest.version -ne $parts[1] -or $manifest.runId -ne $parts[2]){throw "Run identity mismatch: $Relative"}
  $outcomes=if($manifest.schema -eq 3){@('passed','failed','blocked')}else{@('passed','failed')}
  if($manifest.outcome -notin $outcomes -or ($manifest.outcome -eq 'passed') -ne ($manifest.exitCode -eq 0)){throw "Run outcome mismatch: $Relative"}
  if($manifest.schema -eq 3){
    if($manifest.scope -notin @('full','core','browser')){throw "Invalid test scope: $Relative"}
    if($manifest.outcome -eq 'blocked' -and $manifest.exitCode -ne 2){throw "Invalid blocked outcome: $Relative"}
    if($manifest.outcome -ne 'blocked' -and (!$manifest.testSummary -or $manifest.testSummary.tests -le 0)){throw "Missing structured test results: $Relative"}
    if($manifest.outcome -eq 'passed' -and ($manifest.testSummary.failed -ne 0 -or $manifest.testSummary.cancelled -ne 0 -or $manifest.testSummary.passed -le 0)){throw "Passed run contains failures or no executed passes: $Relative"}
    if($manifest.outcome -ne 'blocked'){
      $requiredFiles=if($manifest.evidenceRevision -eq 2){@('results.json','features.json')}else{@('results.json','source.zip','source-manifest.json')}
      if($manifest.evidenceRevision -eq 1){$requiredFiles+=@('features.json','events.jsonl.gz','artifact-manifest.json')}
      foreach($required in $requiredFiles){if(!(Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)){throw "Missing run evidence $required : $Relative"}}
      $results=Get-Content -LiteralPath (Join-Path $Root 'results.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
      foreach($field in @('tests','passed','failed','cancelled','skipped','todo')){if($results.counts.$field -ne $manifest.testSummary.$field){throw "Structured count mismatch ($field): $Relative"}}
      if($manifest.evidenceRevision -eq 2){
        $cases=@($results.cases)
        if($cases.Count -ne $results.counts.tests){throw 'Independent result count mismatch'}
        foreach($status in @('passed','failed','skipped','todo','cancelled')){
          if(@($cases | Where-Object {$_.status -eq $status}).Count -ne $results.counts.$status){throw "Independent case status mismatch: $status"}
        }
        if(@($cases | Where-Object {$_.status -notin @('passed','failed','skipped','todo','cancelled') -or !$_.name -or !$_.file}).Count){throw 'Invalid independent test case'}
        if(!$manifest.validation){throw 'Independent regression assessment missing'}
      }
      # Older records retain their original interpretation. New records explicitly
      # distinguish a complete regression from successful checks of a narrower scope.
      if($manifest.validation){
        $validation=$manifest.validation
        $mode=if($manifest.source.kind -eq 'git'){'historical-comparison'}elseif($manifest.scope -eq 'full'){'full-regression'}else{'partial-regression'}
        $features=Get-Content -LiteralPath (Join-Path $Root 'features.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
        $failed=($manifest.testSummary.passed -le 0 -or $manifest.testSummary.failed -gt 0 -or $manifest.testSummary.cancelled -gt 0 -or ($null -ne $validation.processExitCode -and $validation.processExitCode -ne 0))
        $incomplete=($manifest.testSummary.skipped -gt 0 -or $manifest.testSummary.todo -gt 0)
        $complete=(!$failed -and !$incomplete -and @($features.features).Count -gt 0 -and @($features.features | Where-Object {$_.status -ne 'passed'}).Count -eq 0)
        $expectedStatus=if($failed){'failed'}elseif($mode -eq 'full-regression'){if($complete){'complete'}else{'incomplete'}}elseif($incomplete){'incomplete'}else{'partial'}
        $accepted=(!$failed -and ($mode -ne 'full-regression' -or $complete))
        if($validation.schema -ne 1 -or $validation.mode -ne $mode -or $validation.status -ne $expectedStatus -or $validation.accepted -isnot [bool] -or $validation.accepted -ne $accepted -or ($manifest.outcome -eq 'passed' -and !$accepted)){throw "Invalid regression assessment: $Relative"}
        if($mode -ne 'full-regression' -and $manifest.releaseCheck.ready){throw "Narrow scope cannot claim release readiness: $Relative"}
      }
      if($manifest.releaseCheck.requested -and $manifest.outcome -eq 'passed'){
        $features=Get-Content -LiteralPath (Join-Path $Root 'features.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
        if(!$manifest.releaseCheck.ready -or $manifest.scope -ne 'full' -or $manifest.testSummary.skipped -or $manifest.testSummary.todo -or !$features.features -or @($features.features | Where-Object {$_.status -ne 'passed'}).Count -or @($manifest.harness.workingTree).Count -or $manifest.source.kind -ne 'working-tree' -or @($manifest.source.workingTree).Count){throw "Incomplete release checks: $Relative"}
      }
    }
  }
  if($manifest.evidenceRevision -eq 1 -and $manifest.kind -in @('Package','OnlineDeployment')){
    foreach($required in @('harness.zip','harness-manifest.json')){if(!(Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)){throw "Missing verifier snapshot $required : $Relative"}}
    if($manifest.outcome -eq 'passed'){
      $deployment=Get-Content -LiteralPath (Join-Path $Root 'deployment-results.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
      $passed=@($deployment.checks | Where-Object {$_.status -eq 'passed'}).Count
      if($deployment.schema -ne 1 -or $deployment.outcome -ne 'passed' -or $passed -le 0 -or @($deployment.checks | Where-Object {$_.status -ne 'passed'}).Count -or $passed -ne $manifest.summary.passed -or [bool]$deployment.online -ne ($manifest.kind -eq 'OnlineDeployment')){throw "Invalid deployment checks: $Relative"}
    }
  }
  if($manifest.evidenceRevision -eq 2 -and $manifest.kind -in @('Package','Deployment','OnlineDeployment')){
    $deployment=Get-Content -LiteralPath (Join-Path $Root 'deployment-results.json') -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    if($deployment.schema -ne 1 -or [bool]$deployment.online -ne ($manifest.kind -eq 'OnlineDeployment')){throw 'Invalid independent deployment results'}
    $passed=@($deployment.checks | Where-Object {$_.status -eq 'passed'}).Count
    if($manifest.outcome -eq 'passed' -and ($deployment.outcome -ne 'passed' -or $passed -le 0 -or @($deployment.checks | Where-Object {$_.status -ne 'passed'}).Count -or $manifest.summary.passed -ne $passed)){throw 'Invalid deployment checks'}
  }
  if($manifest.log.file -notin @('output.log','output.log.gz')){throw "Invalid run log path: $Relative"}
  $logPath=Join-Path $Root $manifest.log.file
  if(!(Test-Path -LiteralPath $logPath -PathType Leaf)){throw "Run log missing: $Relative"}
  if($manifest.schema -ge 2 -and (!$manifest.log.sha256 -or $null -eq $manifest.log.storedBytes)){throw "Run log metadata missing: $Relative"}
  if(($null -ne $manifest.log.storedBytes -and (Get-Item -LiteralPath $logPath).Length -ne $manifest.log.storedBytes) -or
     ($manifest.log.sha256 -and (Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash -ne $manifest.log.sha256)){throw "Run log metadata mismatch: $Relative"}
  if($manifest.package -and $manifest.package.manifestVersion -and $manifest.package.manifestVersion -ne $manifest.version){throw "Package version mismatch: $Relative"}
  $originPath=Join-Path $Root 'origin.json'
  if($manifest.evidenceRevision -eq 2 -and (Test-Path -LiteralPath $originPath)){
    $origin=Get-Content -LiteralPath $originPath -Raw|ConvertFrom-EvidenceJson
    if($origin.schema -ne 1 -or $origin.kind -ne 'github-actions' -or !$manifest.github -or $origin.testStepOutcome -notin @('success','failure','cancelled','skipped') -or $origin.originalChecksumsSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $origin.transportSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid cloud origin metadata'}
    if($origin.testStepOutcome -eq 'success' -and ($manifest.outcome -ne 'passed' -or !$manifest.releaseCheck.requested -or !$manifest.releaseCheck.ready -or $manifest.scope -ne 'full')){throw 'Successful CI origin lacks strict release evidence'}
  }
  return $true
}

function Get-EvidenceCatalogEntry($Record) {
  $null=Test-EvidenceRecord $Record.source $Record.relative
  return [ordered]@{
    path=$Record.relative
    checksumsSha256=(Get-FileHash -LiteralPath (Join-Path $Record.source 'SHA256SUMS.txt') -Algorithm SHA256).Hash
  }
}

function Test-EvidenceLegacyCatalog($Root,$Catalog) {
  if($Catalog.schema -ne 2){return}
  foreach($entry in @($Catalog.historicalCatalogs)){
    if(!$entry){continue}
    if($entry.path -notmatch '^(maintenance|records)/[A-Za-z0-9_.-]+/original/original-legacy-catalog.json$' -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid historical catalog reference'}
    $historical=Assert-EvidencePath (Split-Path -Parent $Root) (Join-Path $Root $entry.path)
    if(!(Test-Path -LiteralPath $historical -PathType Leaf) -or (Get-FileHash -LiteralPath $historical).Hash -ne $entry.sha256){throw 'Historical evidence catalog checksum mismatch'}
  }
  $legacy=Join-Path $Root 'legacy/local-test-archive'
  if(!(Test-Path -LiteralPath $legacy)){
    if($Catalog.legacyCatalogSha256){throw 'Legacy evidence catalog missing'}
    return
  }
  $path=Join-Path $legacy 'catalog.json'
  if($Catalog.legacyCatalogSha256 -notmatch '^[a-fA-F0-9]{64}$' -or !(Test-Path -LiteralPath $path -PathType Leaf)){
    throw 'Legacy evidence catalog missing or unregistered'
  }
  if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked legacy evidence catalog'}
  if((Get-FileHash -LiteralPath $path).Hash -ne $Catalog.legacyCatalogSha256){throw 'Legacy evidence catalog checksum mismatch'}
}

function Test-EvidenceCatalog($Root) {
  # Directories are authoritative; stale or missing caches do not invalidate records.
  $records=@(Get-EvidenceRecords $Root)
  foreach($record in $records){$null=Test-EvidenceRecord $record.source $record.relative}
  return $records.Count
}

function Test-EvidenceCatalogData($Root,$catalog) {
  if($catalog.schema -notin @(1,2) -or $null -eq $catalog.records){throw "Invalid evidence catalog: $catalogPath"}
  Test-EvidenceLegacyCatalog $Root $catalog
  if($catalog.schema -eq 2){
    foreach($item in Get-ChildItem -LiteralPath $Root -Force){
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked archive entry'}
      if(($item.PSIsContainer -and $item.Name -notin @('records','tests','maintenance','fixtures','pending','legacy','inbox','received','tools')) -or
         (!$item.PSIsContainer -and $item.Name -notin @('README.md','catalog.json'))){throw 'Unexpected archive root entry'}
    }
    foreach($parent in @('tests','legacy')){
      $allowed=if($parent -eq 'tests'){@('local','github-actions')}else{@('local-test-archive')}
      $categoryRoot=Join-Path $Root $parent
      if(!(Test-Path -LiteralPath $categoryRoot)){continue}
      foreach($item in Get-ChildItem -LiteralPath $categoryRoot -Force){
        if(!$item.PSIsContainer -or $item.Name -notin $allowed -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid archive category'}
      }
    }
  }
  $records=@(Get-EvidenceRecords $Root)
  $expected=@{}
  foreach($record in $records){
    if($expected.ContainsKey($record.relative)){throw "Duplicate evidence record: $($record.relative)"}
    $expected[$record.relative]=$record
  }
  if(@($catalog.records).Count -ne $records.Count){throw 'Evidence catalog record count mismatch'}
  foreach($entry in @($catalog.records)){
    if(!$entry.path -or $entry.checksumsSha256 -notmatch '^[a-fA-F0-9]{64}$' -or !$expected.ContainsKey($entry.path)){throw "Unexpected or missing evidence record: $($entry.path)"}
    $record=$expected[$entry.path]
    $actual=Get-EvidenceCatalogEntry $record
    if($actual.checksumsSha256 -ne $entry.checksumsSha256){throw "Evidence catalog checksum mismatch: $($entry.path)"}
    $expected.Remove($entry.path)
  }
  if($expected.Count){throw 'Evidence record missing from catalog'}
  return $records.Count
}

function Add-EvidenceCatalogRecord($Root,$Record) {
  $null=Get-EvidenceCatalogEntry $Record
  Update-EvidenceCatalogCache $Root
}
function Update-EvidenceCatalogCache($Root) {
  # Publishing never verifies unrelated history. The cache is disposable.
  try {
    $entries=@(foreach($record in Get-EvidenceRecords $Root){
      $sum=Join-Path $record.source 'SHA256SUMS.txt'
      if(Test-Path -LiteralPath $sum -PathType Leaf){
        if((Get-Item -LiteralPath $sum -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked checksum cache input'}
        @{path=$record.relative;checksumsSha256=(Get-FileHash -LiteralPath $sum).Hash}
      }
    })
    $catalogPath=Join-Path $Root 'catalog.json'
    $modern=(Split-Path -Leaf $Root) -eq 'evidence-archive' -or (Test-Path -LiteralPath (Join-Path $Root 'records'))
    $catalog=@{schema=$(if($modern){2}else{1});role='cache';records=$entries}
    if($modern){$catalog.layout='flat'}
    # Historical metadata is compatibility information, never a dependency.
    if(Test-Path -LiteralPath $catalogPath){
      if((Get-Item -LiteralPath $catalogPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked catalog cache'}
      try{$old=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
        if($old.historicalCatalogs){$catalog.historicalCatalogs=$old.historicalCatalogs}
        if($old.legacyCatalogSha256){$catalog.legacyCatalogSha256=$old.legacyCatalogSha256}
      }catch{}
    }
    $temp=Join-Path $Root ('catalog.json.'+[guid]::NewGuid().ToString('N')+'.tmp')
    [IO.File]::WriteAllText($temp,($catalog|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
    if(Test-Path -LiteralPath $catalogPath){[IO.File]::Replace($temp,$catalogPath,[NullString]::Value)}else{[IO.File]::Move($temp,$catalogPath)}
  } catch {Write-Warning "Record saved; optional catalog cache could not be rebuilt: $($_.Exception.Message)"}
  finally {if($temp -and (Test-Path -LiteralPath $temp)){Remove-Item -LiteralPath $temp -Force}}
}

# The storage envelope is independent of the original product evidence schema.
function Assert-EvidencePath($Project,$Value) {
  $base=[IO.Path]::GetFullPath($Project).TrimEnd('\')
  $full=[IO.Path]::GetFullPath($Value)
  if(!$full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Outside evidence workspace: $full"}
  $part=$full
  while($part -ne $base){
    if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Linked evidence path: $part"}
    $part=Split-Path -Parent $part
  }
  return $full
}
function Initialize-EvidenceArchive($Project) {
  $root=Get-EvidenceRoot $Project
  $catalog=Join-Path $root 'catalog.json'
  $directories=@('records','pending')
  foreach($directory in $directories){
    $path=Assert-EvidencePath $Project (Join-Path $root $directory)
    $null=New-Item -ItemType Directory -Path $path -Force
  }
  if(!(Test-Path -LiteralPath $catalog)){
    Update-EvidenceCatalogCache $root
  }
  return $root
}
function Get-EvidencePendingRoot($Project) {
  $path=Assert-EvidencePath $Project (Join-Path (Get-EvidenceRoot $Project) 'pending')
  $null=New-Item -ItemType Directory -Path $path -Force
  return $path
}
function Get-EvidenceLockPath($Project) {
  return (Join-Path (Get-EvidencePendingRoot $Project) 'recording.lock')
}
function Get-EvidencePayload($Record) {
  $envelope=Join-Path $Record.source 'record.json'
  if(Test-Path -LiteralPath $envelope){
    return @{source=(Join-Path $Record.source 'original');relative=(Get-Content -LiteralPath $envelope -Raw -Encoding UTF8| ConvertFrom-EvidenceJson).originalRelative}
  }
  $manifestPath=Join-Path $Record.source 'manifest.json'
  if(Test-Path -LiteralPath $manifestPath){
    $m=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson
    if($m.evidenceRevision -eq 2){return @{source=$Record.source;relative=('runs/'+$m.version+'/'+$m.runId)}}
  }
  $relative=$Record.relative -replace '^legacy/local-test-archive/',''
  return @{source=$Record.source;relative=$relative}
}
function Get-EvidenceIdentifierPattern {
  return '(?:[0-9]{8}(?:T[0-9]{6}(?:[0-9]{3})?Z)?|undated)-[a-f0-9]{8}'
}
function Get-EvidenceRunTime([string]$RunId) {
  if($RunId -notmatch ('^(?<stamp>[0-9]{8}(?:T[0-9]{6}(?:[0-9]{3})?Z)?|undated)-(?<nonce>[a-f0-9]{8})$')){throw 'Invalid evidence run identifier'}
  $stamp=$Matches.stamp;$nonce=$Matches.nonce
  if($stamp -eq 'undated'){return @{namePart='undated';nonce=$nonce;value=$null;precision='unknown';timeZone=$null;identifier=$RunId}}
  $format='yyyyMMdd';$display='yyyy-MM-dd';$valueFormat=$display;$precision='day';$zone=$null
  $styles=[Globalization.DateTimeStyles]::None
  if($stamp.Contains('T')){
    $styles=[Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $zone='UTC'
    if($stamp.Length -eq 19){$format='yyyyMMddTHHmmssfffZ';$display='yyyy-MM-ddTHH-mm-ss.fffZ';$valueFormat='yyyy-MM-ddTHH:mm:ss.fffZ';$precision='millisecond'}
    else{$format='yyyyMMddTHHmmssZ';$display='yyyy-MM-ddTHH-mm-ssZ';$valueFormat='yyyy-MM-ddTHH:mm:ssZ';$precision='second'}
  }
  $date=[DateTime]::ParseExact($stamp,$format,[Globalization.CultureInfo]::InvariantCulture,$styles)
  return @{namePart=$date.ToString($display);nonce=$nonce;value=$date.ToString($valueFormat);precision=$precision;timeZone=$zone;identifier=$RunId}
}
function Get-EvidenceOriginalTime([string]$OriginalRelative) {
  if($OriginalRelative -notmatch ('(?:^|[/-])(?<identifier>'+ (Get-EvidenceIdentifierPattern) +')$')){throw 'New records require a UTC run identifier, date-only identifier or explicit undated identifier'}
  return (Get-EvidenceRunTime $Matches.identifier)
}
function Convert-EvidenceRunName([string]$RunId) {
  $time=Get-EvidenceRunTime $RunId
  return $time.namePart+'-'+$time.nonce
}
function Get-EvidenceLocationTime([string]$Relative) {
  $leaf=$Relative.Split('/')[-1]
  $stamp='(?:[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[0-9]{3})?Z)?|undated)'
  if($leaf -notmatch ('^(?<stamp>'+ $stamp +')(?:(?:_[a-z][a-z0-9-]{0,31}_)|-)(?<nonce>[a-f0-9]{8})$')){throw 'Invalid evidence location time'}
  $identifier=($Matches.stamp -replace '[-:.]','')+'-'+$Matches.nonce
  return (Get-EvidenceRunTime $identifier)
}
function Format-EvidenceBeijingTime([string]$Value) {
  if(!$Value){return 'unknown'}
  if($Value -match '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'){
    try{$null=[DateTime]::ParseExact($Value,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None);return $Value+' (date only; timezone unspecified)'}
    catch{return 'unknown (original value retained)'}
  }
  if($Value -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.(?<fraction>[0-9]{1,7}))?(?:Z|[+-][0-9]{2}:[0-9]{2})$'){return 'unknown (original value retained)'}
  $fraction=$Matches.fraction
  $format='yyyy-MM-dd HH:mm:ss'
  if($fraction){$format+='.'+('f'*$fraction.Length)}
  try{return [DateTimeOffset]::Parse($Value,[Globalization.CultureInfo]::InvariantCulture).ToOffset([TimeSpan]::FromHours(8)).ToString($format+' zzz')}
  catch{return 'unknown (original value retained)'}
}
function Get-EvidenceCategory($OriginalRelative,$Manifest) {
  $category='maintenance'
  if($OriginalRelative -match '^runs/'){
    # Classification belongs to the original evidence, not the importing host.
    $category=if($Manifest.github){'tests/github-actions'}else{'tests/local'}
  }elseif($OriginalRelative -match '^github-actions-'){$category='tests/github-actions'}
  elseif($OriginalRelative -match '^generated-fixtures-'){$category='fixtures'}
  return $category
}
function Get-EvidenceFlatLocation([string]$Relative) {
  if($Relative -notmatch '^(records|tests/(local|github-actions)|maintenance|fixtures)/[^/]+$'){throw 'Invalid sealed record location'}
  return 'records/'+$Relative.Split('/')[-1]
}
function Get-EvidenceDestination($Project,$OriginalRelative,$Manifest) {
  $root=Get-EvidenceRoot $Project
  $category=Get-EvidenceCategory $OriginalRelative $Manifest
  $time=Get-EvidenceOriginalTime $OriginalRelative
  $name=$time.namePart+'-'+$time.nonce
  if($category -eq 'maintenance'){
    $label=$OriginalRelative.Substring(0,$OriginalRelative.Length-$time.identifier.Length-1)
    if($label -notmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' -or $label.Length -gt 32){throw 'Invalid maintenance label'}
    $name=$time.namePart+'_'+$label+'_'+$time.nonce
  }
  return (Assert-EvidencePath $Project (Join-Path $root ('records/'+$name)))
}
function Publish-EvidenceRecord($Project,$Source,$OriginalRelative,[string]$TransportArchive,[string]$ArtifactArchive) {
  $root=Initialize-EvidenceArchive $Project
  $src=Assert-EvidencePath $Project $Source
  $manifestPath=Join-Path $src 'manifest.json'
  $manifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-EvidenceJson}else{$null}
  $destination=Get-EvidenceDestination $Project $OriginalRelative $manifest
  if(Test-Path -LiteralPath $destination){throw "Evidence destination exists: $destination"}
  if(!(Test-Path -LiteralPath (Join-Path $src 'SHA256SUMS.txt'))){Write-EvidenceChecksums $src}
  $null=Test-EvidenceRecord $src $OriginalRelative
  if($manifest.evidenceRevision -eq 2){
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
    [IO.Directory]::Move($src,$destination)
    Update-EvidenceCatalogCache $root
    return $destination
  }
  $pending=Get-EvidencePendingRoot $Project
  $candidate=Join-Path $pending ('publish-'+[guid]::NewGuid().ToString('N'))
  $null=New-Item -ItemType Directory -Path $candidate
  $raw=Join-Path $candidate 'original'
  $relative=$destination.Substring($root.Length+1).Replace('\','/')
  try {
    [IO.Directory]::Move($src,$raw)
    if($TransportArchive){
      Copy-Item -LiteralPath $TransportArchive -Destination (Join-Path $candidate 'bundle.zip')
      if((Get-FileHash -LiteralPath $TransportArchive).Hash -ne (Get-FileHash -LiteralPath (Join-Path $candidate 'bundle.zip')).Hash){throw 'Transport copy mismatch'}
    }
    if($ArtifactArchive -and $ArtifactArchive -ne $TransportArchive){
      Copy-Item -LiteralPath $ArtifactArchive -Destination (Join-Path $candidate 'artifact.zip')
      if((Get-FileHash -LiteralPath $ArtifactArchive).Hash -ne (Get-FileHash -LiteralPath (Join-Path $candidate 'artifact.zip')).Hash){throw 'Artifact transport copy mismatch'}
    }
    Write-EvidenceEnvelope $candidate $relative $OriginalRelative
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
    [IO.Directory]::Move($candidate,$destination)
    Add-EvidenceCatalogRecord $root @{source=$destination;relative=$relative}
    return $destination
  } catch {
    # An unregistered final record or pending envelope is preserved for recovery.
    $recovery=if(Test-Path -LiteralPath $candidate){$candidate}else{$destination}
    Write-Warning "Evidence publication interrupted; preserve and recover: $recovery"
    throw
  }
}
function Write-EvidenceEnvelope($Root,$Relative,$OriginalRelative) {
  $raw=Join-Path $Root 'original'
  $manifestPath=Join-Path $raw 'manifest.json'
  $m=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8| ConvertFrom-EvidenceJson}else{$null}
  $github=$m.github
  $started=if($m.startedAt){$m.startedAt}elseif($m.startedAtUtc){$m.startedAtUtc}else{$null}
  $recorded=if($m.createdAtUtc){$m.createdAtUtc}elseif($m.createdUtc){$m.createdUtc}else{$null}
  $originalSum=(Get-FileHash -LiteralPath (Join-Path $raw 'SHA256SUMS.txt')).Hash
  $time=if($m){Get-EvidenceOriginalTime $OriginalRelative}else{Get-EvidenceRunTime ('undated-'+$originalSum.Substring(0,8).ToLowerInvariant())}
  $record=[ordered]@{
    schema=3;path=$Relative;category=$(if($Relative.StartsWith('records/')){if($m){(Get-EvidenceCategory $OriginalRelative $m).Split('/')[0]}else{'maintenance'}}else{$Relative.Split('/')[0]});origin=$(if($github){'github-actions'}else{'local'});
    kind=$(if($m){$m.kind}else{'historical-evidence-collection'});version=$m.version;runId=$m.runId;
    startedAtUtc=$started;recordedAtUtc=$recorded;timeBasis=$(if($time.precision -eq 'unknown'){'unknown'}else{'original-run-identifier'});
    identifierTime=$time.value;identifierTimePrecision=$time.precision;identifierTimeZone=$time.timeZone;
    identifierTimeSource=$(if($m){'original-run-identifier'}else{'original-checksums'});
    archivedAtUtc=[DateTime]::UtcNow.ToString('o');
    outcome=$(if(!$m){'unknown'}elseif($m.kind -eq 'github-actions-evidence'){$m.testStepOutcome}elseif($m.outcome){$m.outcome}else{'archived'});
    scope=$m.scope;github=$github;originalRelative=$OriginalRelative;archiveState='sealed';
    originalChecksumsSha256=$originalSum
  }
  [IO.File]::WriteAllText((Join-Path $Root 'record.json'),($record|ConvertTo-Json -Depth 15),(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceRecordReadme $Root $record $m
  Write-EvidenceChecksums $Root
  $null=Test-EvidenceRecord $Root $Relative
}
function Get-EvidenceCanonicalLocation([string]$Relative) {
  return ($Relative -replace '^(maintenance/(?:[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[0-9]{3})?Z)?|undated))_[a-z][a-z0-9-]{0,31}_([a-f0-9]{8})$','$1-$2')
}
function Write-EvidenceRecordReadme($Root,$Record,$Manifest) {
  $beijing=Format-EvidenceBeijingTime $Record.startedAtUtc
  $lines=@('# Evidence record / 检查记录','',
    "- 分类：$($Record.category) / $($Record.kind)",
    "- 来源：$($Record.origin)",
    "- 归档时间（UTC）：$($Record.archivedAtUtc)",
    "- 原始结果：$($Record.outcome)")
  if($Record.version){$lines+="- 版本：$($Record.version)"}
  if($Record.runId){$lines+="- 原始运行编号：$($Record.runId)"}
  if($Record.startedAtUtc){$lines+=@("- 运行开始（原始清单值）：$($Record.startedAtUtc)","- 运行开始（北京时间或精度说明）：$beijing")}
  if($Record.recordedAtUtc){$lines+="- 原清单创建时间（UTC）：$($Record.recordedAtUtc)"}
  if($Record.scope){$lines+="- 测试范围：$($Record.scope)"}
  if($Record.identifierTimePrecision){$lines+=@("- 编号时间原值：$($Record.identifierTime)","- 编号时间精度：$($Record.identifierTimePrecision)","- 编号时间来源：$($Record.identifierTimeSource)","- 编号时区：$($Record.identifierTimeZone)")}
  if($Record.kind -eq 'historical-evidence-collection'){$lines+='- 原始时间与整体测试结果未知；保留历史说明，不将混合资料认定为一次完整测试。'}
  elseif($Record.timeBasis -eq 'unknown'){$lines+='- 编号时间未知；不根据文件修改时间补造时间。'}
  $lines+=@('',"- 原位置：$($Record.originalRelative)",'',
    'original/ 保存未经改写的原始证据；目录和压缩文件内容各有用途，按原始清单或说明解读。','',
    'record.json 是统一索引信息；SHA256SUMS.txt 校验整份归档。封存不表示产品测试通过。',
    '本地和 GitHub 是独立执行；不合并计数。重跑和更正新增记录，不覆盖原始证据。')
  if($Record.github){$lines+=@('',"- GitHub：$($Record.github.repository) / run $($Record.github.runId) / attempt $($Record.github.runAttempt)","- Commit：$($Record.github.sha)")}
  [IO.File]::WriteAllLines((Join-Path $Root 'README.md'),$lines,(New-Object Text.UTF8Encoding($false)))
}
function Test-EvidenceEnvelope($Root,$Relative) {
  $r=Get-Content -LiteralPath (Join-Path $Root 'record.json') -Raw -Encoding UTF8| ConvertFrom-EvidenceJson
  $physical=$Relative
  if($Relative.StartsWith('records/')){
    if($Relative -notmatch '^records/[^/]+$' -or $r.category -notin @('tests','maintenance','fixtures')){throw 'Invalid evidence envelope identity'}
    # Old sealed bytes retain their original identity. Validate the same dated
    # name and source class while the catalog records the new physical location.
    $parent=if($r.category -eq 'tests'){'tests/'+$r.origin}else{$r.category}
    $Relative=$parent+'/'+$Relative.Split('/')[-1]
  }
  $samePath=($physical.StartsWith('records/') -and $r.path -eq $physical) -or $r.path -eq $Relative -or ($Relative.StartsWith('maintenance/') -and $r.path -eq (Get-EvidenceCanonicalLocation $Relative))
  $dated='(?:[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[0-9]{3})?Z)?|undated)'
  $validLocation=$Relative -match ('^(tests/(local|github-actions)|maintenance|fixtures)/'+$dated+'-[a-f0-9]{8}$') -or
    $Relative -match ('^maintenance/'+$dated+'_[a-z][a-z0-9-]{0,31}_[a-f0-9]{8}$') -or
    $Relative -match '^maintenance/undated_release-materials_[a-f0-9]{8}$'
  if($r.schema -notin @(1,2,3) -or !$samePath -or !$validLocation -or $r.archiveState -ne 'sealed' -or $r.origin -notin @('local','github-actions')){throw 'Invalid evidence envelope identity'}
  $locationTime=Get-EvidenceLocationTime $Relative
  if($r.category -ne $Relative.Split('/')[0] -or (Get-FileHash -LiteralPath (Join-Path $Root 'original/SHA256SUMS.txt')).Hash -ne $r.originalChecksumsSha256){throw 'Original evidence identity mismatch'}
  if(!(Test-Path -LiteralPath (Join-Path $Root 'README.md'))){throw 'Evidence explanation missing'}
  foreach($file in Get-EvidenceFiles $Root){
    if($file.path -notin @('README.md','record.json','SHA256SUMS.txt','bundle.zip','artifact.zip') -and !$file.path.StartsWith('original/')){throw 'Unexpected envelope file'}
  }
  $mp=Join-Path $Root 'original/manifest.json'
  if(Test-Path -LiteralPath $mp){
    $m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8| ConvertFrom-EvidenceJson
    foreach($field in @('kind','version','runId','scope')){
      if($r.$field -ne $m.$field){throw "Envelope/original mismatch: $field"}
    }
    $expectedOutcome=if($r.schema -eq 1){$m.outcome}elseif($m.kind -eq 'github-actions-evidence'){$m.testStepOutcome}elseif($m.outcome){$m.outcome}else{'archived'}
    if($r.outcome -ne $expectedOutcome){throw 'Envelope/original mismatch: outcome'}
    if($r.category -eq 'tests' -and $m.kind -notin @('App','Package','OnlineDeployment','Custom','github-actions-evidence')){throw 'Invalid product evidence kind'}
    if($r.category -eq 'fixtures' -and $m.kind -ne 'generated-fixture-snapshot'){throw 'Invalid fixture evidence kind'}
    if($r.category -eq 'maintenance' -and $m.kind -notin @('build-maintenance','pull-request-merge-audit','test-system-audit')){throw 'Invalid maintenance evidence kind'}
    if($m.github){
      if($r.origin -ne 'github-actions' -or ($r.github|ConvertTo-Json -Compress -Depth 8) -ne ($m.github|ConvertTo-Json -Compress -Depth 8)){throw 'Envelope/cloud provenance mismatch'}
    }elseif($r.origin -ne 'local'){throw 'Envelope/local provenance mismatch'}
  }else{
    if($r.kind -ne 'historical-evidence-collection' -or $r.category -ne 'maintenance' -or $r.origin -ne 'local' -or $r.outcome -ne 'unknown' -or $r.timeBasis -ne 'unknown' -or $r.version -or $r.runId -or $r.startedAtUtc -or $r.recordedAtUtc -or
       $Relative -ne ('maintenance/undated_release-materials_'+$r.originalChecksumsSha256.Substring(0,8).ToLowerInvariant())){throw 'Invalid unstructured historical evidence'}
  }
  if($Relative.StartsWith('tests/') -and $r.origin -ne $Relative.Split('/')[1]){throw 'Envelope origin directory mismatch'}
  if($r.schema -eq 3){
    $time=if(Test-Path -LiteralPath $mp){Get-EvidenceOriginalTime $r.originalRelative}else{Get-EvidenceRunTime ('undated-'+$r.originalChecksumsSha256.Substring(0,8).ToLowerInvariant())}
    $expectedSource=if(Test-Path -LiteralPath $mp){'original-run-identifier'}else{'original-checksums'}
    $expectedBasis=if($time.precision -eq 'unknown'){'unknown'}else{'original-run-identifier'}
    if(Test-Path -LiteralPath $mp){
      $expectedStart=if($m.startedAt){$m.startedAt}elseif($m.startedAtUtc){$m.startedAtUtc}else{$null}
      $expectedRecorded=if($m.createdAtUtc){$m.createdAtUtc}elseif($m.createdUtc){$m.createdUtc}else{$null}
      if($r.startedAtUtc -ne $expectedStart -or $r.recordedAtUtc -ne $expectedRecorded){throw 'Envelope time provenance mismatch'}
    }
    if($r.identifierTime -ne $time.value -or $r.identifierTimePrecision -ne $time.precision -or $r.identifierTimeZone -ne $time.timeZone -or $r.identifierTimeSource -ne $expectedSource -or $r.timeBasis -ne $expectedBasis -or
       $locationTime.namePart -ne $time.namePart -or $locationTime.nonce -ne $time.nonce){throw 'Envelope time provenance mismatch'}
  }
  $null=Test-EvidenceRecord (Join-Path $Root 'original') $r.originalRelative
  return $true
}
