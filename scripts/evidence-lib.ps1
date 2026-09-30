$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"

function Get-EvidenceRoot($Project) {
  $projectRoot=[IO.Path]::GetFullPath($Project).TrimEnd('\')
  $local=[IO.Path]::GetFullPath((Join-Path $Project 'local-test-archive')).TrimEnd('\')
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
  $items=@(Get-ChildItem -LiteralPath $Root -Recurse -Force)
  foreach($item in $items){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence entry is forbidden: $($item.FullName)"}
  }
  return @($items | Where-Object {-not $_.PSIsContainer} | ForEach-Object {
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
  if(!$Relative.StartsWith('runs/',[StringComparison]::OrdinalIgnoreCase)){
    if($Relative -match '^github-actions-'){
      . (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
      $cloud=Test-GitHubEvidenceBundle $Root
      if($Relative -ne 'github-actions-'+$cloud.bundleId){throw 'Cloud bundle directory identity mismatch'}
    }
    return $true
  }
  $parts=$Relative.Split('/')
  if($parts.Count -ne 3 -or $parts[1] -notmatch '^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$' -or $parts[2] -notmatch '^\d{8}T\d{9}Z-[a-f0-9]{8}$'){throw "Invalid run directory layout: $Relative"}
  $manifestPath=Join-Path $Root 'manifest.json'
  if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw "Run manifest missing: $Relative"}
  $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($manifest.schema -notin @(1,2,3) -or $manifest.version -ne $parts[1] -or $manifest.runId -ne $parts[2]){throw "Run identity mismatch: $Relative"}
  $outcomes=if($manifest.schema -eq 3){@('passed','failed','blocked')}else{@('passed','failed')}
  if($manifest.outcome -notin $outcomes -or ($manifest.outcome -eq 'passed') -ne ($manifest.exitCode -eq 0)){throw "Run outcome mismatch: $Relative"}
  if($manifest.schema -eq 3){
    if($manifest.scope -notin @('full','core','browser')){throw "Invalid test scope: $Relative"}
    if($manifest.outcome -eq 'blocked' -and $manifest.exitCode -ne 2){throw "Invalid blocked outcome: $Relative"}
    if($manifest.outcome -ne 'blocked' -and (!$manifest.testSummary -or $manifest.testSummary.tests -le 0)){throw "Missing structured test results: $Relative"}
    if($manifest.outcome -eq 'passed' -and ($manifest.testSummary.failed -ne 0 -or $manifest.testSummary.cancelled -ne 0 -or $manifest.testSummary.passed -le 0)){throw "Passed run contains failures or no executed passes: $Relative"}
    if($manifest.outcome -ne 'blocked'){
      $requiredFiles=@('results.json','source.zip','source-manifest.json')
      if($manifest.evidenceRevision -eq 1){$requiredFiles+=@('features.json','events.jsonl.gz','artifact-manifest.json')}
      foreach($required in $requiredFiles){if(!(Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)){throw "Missing run evidence $required : $Relative"}}
      $results=Get-Content -LiteralPath (Join-Path $Root 'results.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach($field in @('tests','passed','failed','cancelled','skipped','todo')){if($results.counts.$field -ne $manifest.testSummary.$field){throw "Structured count mismatch ($field): $Relative"}}
      if($manifest.releaseCheck.requested -and $manifest.outcome -eq 'passed'){
        $features=Get-Content -LiteralPath (Join-Path $Root 'features.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if(!$manifest.releaseCheck.ready -or $manifest.scope -ne 'full' -or $manifest.testSummary.skipped -or $manifest.testSummary.todo -or !$features.features -or @($features.features | Where-Object {$_.status -ne 'passed'}).Count -or @($manifest.harness.workingTree).Count -or $manifest.source.kind -ne 'working-tree' -or @($manifest.source.workingTree).Count){throw "Incomplete release checks: $Relative"}
      }
    }
  }
  if($manifest.evidenceRevision -eq 1 -and $manifest.kind -in @('Package','OnlineDeployment')){
    foreach($required in @('harness.zip','harness-manifest.json')){if(!(Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)){throw "Missing verifier snapshot $required : $Relative"}}
    if($manifest.outcome -eq 'passed'){
      $deployment=Get-Content -LiteralPath (Join-Path $Root 'deployment-results.json') -Raw -Encoding UTF8 | ConvertFrom-Json
      $passed=@($deployment.checks | Where-Object {$_.status -eq 'passed'}).Count
      if($deployment.schema -ne 1 -or $deployment.outcome -ne 'passed' -or $passed -le 0 -or @($deployment.checks | Where-Object {$_.status -ne 'passed'}).Count -or $passed -ne $manifest.summary.passed -or [bool]$deployment.online -ne ($manifest.kind -eq 'OnlineDeployment')){throw "Invalid deployment checks: $Relative"}
    }
  }
  if($manifest.log.file -notin @('output.log','output.log.gz')){throw "Invalid run log path: $Relative"}
  $logPath=Join-Path $Root $manifest.log.file
  if(!(Test-Path -LiteralPath $logPath -PathType Leaf)){throw "Run log missing: $Relative"}
  if($manifest.schema -ge 2 -and (!$manifest.log.sha256 -or $null -eq $manifest.log.storedBytes)){throw "Run log metadata missing: $Relative"}
  if(($null -ne $manifest.log.storedBytes -and (Get-Item -LiteralPath $logPath).Length -ne $manifest.log.storedBytes) -or
     ($manifest.log.sha256 -and (Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash -ne $manifest.log.sha256)){throw "Run log metadata mismatch: $Relative"}
  if($manifest.package -and $manifest.package.manifestVersion -and $manifest.package.manifestVersion -ne $manifest.version){throw "Package version mismatch: $Relative"}
  return $true
}

function Get-EvidenceCatalogEntry($Record) {
  $null=Test-EvidenceRecord $Record.source $Record.relative
  return [ordered]@{
    path=$Record.relative
    checksumsSha256=(Get-FileHash -LiteralPath (Join-Path $Record.source 'SHA256SUMS.txt') -Algorithm SHA256).Hash
  }
}

function Test-EvidenceCatalog($Root) {
  $catalogPath=Join-Path $Root 'catalog.json'
  if(!(Test-Path -LiteralPath $catalogPath -PathType Leaf)){throw "Evidence catalog missing: $catalogPath"}
  if((Get-Item -LiteralPath $catalogPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked evidence catalog: $catalogPath"}
  $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if($catalog.schema -ne 1 -or $null -eq $catalog.records){throw "Invalid evidence catalog: $catalogPath"}
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
  $catalogPath=Join-Path $Root 'catalog.json'
  if(Test-Path -LiteralPath $catalogPath -PathType Leaf){
    $catalog=Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($catalog.schema -ne 1 -or $null -eq $catalog.records){throw 'Invalid evidence catalog'}
    $known=@($catalog.records)
    $actual=@(Get-EvidenceRecords $Root)
    if($actual.Count -ne $known.Count+1 -or @($actual | Where-Object {$_.relative -eq $Record.relative}).Count -ne 1){throw 'Unexpected evidence records; catalog update refused'}
    $existing=@($actual | Where-Object {$_.relative -ne $Record.relative})
    if($existing.Count -ne $known.Count){throw 'Evidence catalog drift; update refused'}
    foreach($entry in $known){
      $matched=@($existing | Where-Object {$_.relative -eq $entry.path})
      if($matched.Count -ne 1 -or (Get-EvidenceCatalogEntry $matched[0]).checksumsSha256 -ne $entry.checksumsSha256){throw "Evidence catalog drift: $($entry.path)"}
    }
  } else {
    $known=@()
    if(@(Get-EvidenceRecords $Root).Count -ne 1){throw 'Evidence catalog missing while existing records are present'}
  }
  $newEntry=Get-EvidenceCatalogEntry $Record
  $updated=[ordered]@{schema=1;records=@($known)+@($newEntry)}
  $temp="$catalogPath.$([guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($temp,($updated | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
  try {
    if(Test-Path -LiteralPath $catalogPath){
      # Keep the atomic replacement; scanners can briefly hold a Windows file.
      for($attempt=0;$attempt -lt 4;$attempt++){
        try {[IO.File]::Replace($temp,$catalogPath,[NullString]::Value);break}
        catch {if($attempt -eq 3){throw};Start-Sleep -Milliseconds (150*($attempt+1))}
      }
    }else{[IO.File]::Move($temp,$catalogPath)}
  } finally {
    # This is only our uncommitted catalog candidate, never an original record.
    if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}
  }
}
