param()

$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
function Get-ListedEvidenceRecords($Root){
  foreach($record in Get-EvidenceRecords $Root){
    $record
    if($record.relative -match '^github-actions-'){
      foreach($inner in Get-EvidenceRecords (Join-Path $record.source 'records')){
        @{source=$inner.source;relative=($record.relative+'/records/'+$inner.relative)}
      }
    }
  }
}
$rows=foreach($record in Get-ListedEvidenceRecords $root){
  $manifestPath=Join-Path $record.source 'manifest.json'
  $manifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
  $fixtureSnapshot=($manifest -and $manifest.kind -eq 'generated-fixture-snapshot')
  $maintenance=($fixtureSnapshot -or ($manifest -and $manifest.kind -in @('build-maintenance','pull-request-merge-audit','test-system-audit','github-actions-evidence')))
  $legacyVersion=if($record.relative -match '-v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$'){$Matches[1]}else{'unknown'}
  $passCount=$null;$failCount=$null
  if($manifest -and $manifest.summary){
    if($null -ne $manifest.summary.pass){$passCount=$manifest.summary.pass;$failCount=$manifest.summary.fail}
    elseif($null -ne $manifest.summary.passed){$passCount=$manifest.summary.passed;$failCount=$manifest.summary.failed}
  }
  if($manifest -and $manifest.schema -eq 3 -and $manifest.testSummary){$passCount=$manifest.testSummary.passed;$failCount=$manifest.testSummary.failed}
  if($manifest -and $manifest.kind -in @('Package','OnlineDeployment') -and $null -eq $passCount -and $manifest.log.compression -eq 'none'){
    $text=Get-Content -LiteralPath (Join-Path $record.source $manifest.log.file) -Raw -Encoding UTF8
    $totals=[regex]::Matches($text,'(?m)^Deployment verification:\s+(\d+) passed')
    if($totals.Count){$passCount=[int]$totals[$totals.Count-1].Groups[1].Value;$failCount=if($manifest.exitCode -eq 0){0}else{$null}}
  }
  $bytes=(Get-EvidenceFiles $record.source | ForEach-Object {$_.bytes} | Measure-Object -Sum).Sum
  [pscustomobject]@{
    Version=if($maintenance){'n/a'}elseif($manifest){$manifest.version}else{$legacyVersion}
    Run=if($maintenance){$record.relative}elseif($manifest){$manifest.runId}else{$record.relative}
    Kind=if($fixtureSnapshot){'Fixture snapshot'}elseif($manifest){$manifest.kind}else{'Legacy archive'}
    Outcome=if($maintenance){'archived'}elseif($manifest){$manifest.outcome}else{'see report.md'}
    Passed=$passCount
    Failed=$failCount
    Skipped=if($manifest -and $manifest.schema -eq 3 -and $manifest.testSummary){$manifest.testSummary.skipped}else{$null}
    Scope=if($manifest -and $manifest.schema -eq 3){$manifest.scope}else{$null}
    Release=if($manifest -and $manifest.releaseCheck -and $manifest.releaseCheck.requested){$manifest.releaseCheck.ready}else{$null}
    Source=if($manifest.github){'GitHub'}else{'Local'}
    GitHubRun=if($manifest.github){$manifest.github.runId+'/'+$manifest.github.runAttempt}else{$null}
    KiB=[math]::Round($bytes/1KB,1)
  }
}
$rows | Sort-Object Version,Run | Format-Table -AutoSize | Out-String -Width 240 | Write-Output
Write-Host "Integrity check: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-test-evidence.ps1"
