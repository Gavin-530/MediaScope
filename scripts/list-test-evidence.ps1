param([string]$Origin,[string]$Version,[string]$Outcome,[switch]$Json,[ValidateSet('local','github','all')][string]$Scope='local')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
if($Origin -eq 'github-actions'){$Scope='github'}
$rows=@(foreach($record in Get-EvidenceRecords $root){
  $payload=Get-EvidencePayload $record
  $rp=Join-Path $record.source 'record.json'
  $envelope=if(Test-Path -LiteralPath $rp){Get-Content -LiteralPath $rp -Raw -Encoding UTF8| ConvertFrom-EvidenceJson}else{$null}
  $path=Join-Path $payload.source 'manifest.json'
  $m=if(Test-Path -LiteralPath $path){Get-Content -LiteralPath $path -Raw -Encoding UTF8| ConvertFrom-EvidenceJson}else{$null}
  $cloud=($m -and $m.kind -eq 'github-actions-evidence')
  $entries=if($cloud){@(Get-EvidenceRecords (Join-Path $payload.source 'records'))}else{@($payload)}
  if(!$entries.Count){$entries=@($payload)}
  foreach($entry in $entries){
    $inner=Get-EvidencePayload $entry
    $mp=Join-Path $inner.source 'manifest.json'
    $app=if(Test-Path -LiteralPath $mp){Get-Content -LiteralPath $mp -Raw -Encoding UTF8| ConvertFrom-EvidenceJson}else{$null}
    $product=($app -and $app.kind -in @('App','Package','Deployment','OnlineDeployment','Custom'))
    $cloudProduct=($cloud -or ($app.github -and $app.kind -eq 'App'))
    $archiveClass=if($cloudProduct){'github-product-evidence'}elseif($app.github){'maintenance-with-github-association'}else{'local'}
    $originPath=Join-Path $inner.source 'origin.json'
    $ciStep=if($cloud){$m.testStepOutcome}elseif($app.github -and (Test-Path -LiteralPath $originPath)){(Get-Content -LiteralPath $originPath -Raw|ConvertFrom-EvidenceJson).testStepOutcome}else{$null}
    $started=if($app.startedAt){$app.startedAt}elseif($app.startedAtUtc){$app.startedAtUtc}elseif($app.createdAtUtc){$app.createdAtUtc}elseif($app.createdUtc){$app.createdUtc}else{$null}
    $utc=Format-EvidenceUtcTime $started
    $identifier=if($app.archiveRevision -eq 1){Get-EvidenceRunTime $app.archive.identifier}elseif($app.evidenceRevision -eq 2){Get-EvidenceRunTime $app.runId}else{$null}
    $precision=if($envelope.identifierTimePrecision){$envelope.identifierTimePrecision}elseif($identifier){$identifier.precision}else{'not-recorded'}
    $passed=$null;$failed=$null
    if($product -and $app.testSummary){$passed=$app.testSummary.passed;$failed=$app.testSummary.failed}
    elseif($product -and $app.summary){$passed=if($null -ne $app.summary.passed){$app.summary.passed}else{$app.summary.pass};$failed=if($null -ne $app.summary.failed){$app.summary.failed}else{$app.summary.fail}}
    [pscustomobject]@{Time=$utc;IdentifierTime=$(if($identifier){$identifier.value}else{$envelope.identifierTime});TimePrecision=$precision;TimeSource=$(if($identifier){'run-identifier'}else{$envelope.identifierTimeSource});Origin=$(if($app.github -or $cloud){'github-actions'}else{'local'});ArchiveClass=$archiveClass;Version=$(if($product){$app.version}else{'n/a'});Kind=$(if($app){$app.kind}elseif($envelope){$envelope.kind}else{'legacy'});Outcome=$(if($product -and $app.outcome){$app.outcome}elseif($envelope){$envelope.outcome}else{'archived'});CIStep=$ciStep;Passed=$passed;Failed=$failed;Scope=$app.scope;Validation=$app.validation.status;ValidationMode=$app.validation.mode;Run=$app.runId;GitHubRun=$app.github.runId;Attempt=$app.github.runAttempt;Path=$record.relative;Original=$inner.source}
  }
})
if($Scope -ne 'local'){
  $cloudRows=@()
  if(Test-Path -LiteralPath (Join-Path $project 'github-archive/repository.json')){
    $cloudText=& node (Join-Path $PSScriptRoot 'github-archive.mjs') list --evidence
    if($LASTEXITCODE -ne 0){throw 'GitHub archive listing failed'}
    $cloudRows=@(($cloudText -join [Environment]::NewLine)|ConvertFrom-EvidenceJson)
  }
  $cloudKeys=@{};foreach($r in $cloudRows){$cloudKeys[($r.GitHubRun+'/'+$r.Attempt)]=$true}
  $rows=@($rows|Where-Object {$_.ArchiveClass -ne 'github-product-evidence' -or !$cloudKeys.ContainsKey($_.GitHubRun+'/'+$_.Attempt)})+$cloudRows
}
$rows=@($rows|Where-Object {$Scope -eq 'all' -or ($Scope -eq 'github' -and $_.Origin -eq 'github-actions' -and $_.ArchiveClass -ne 'maintenance-with-github-association') -or ($Scope -eq 'local' -and $_.ArchiveClass -ne 'github-product-evidence')})
$rows=@($rows | Where-Object {(!$Origin -or $_.Origin -eq $Origin) -and (!$Version -or $_.Version -eq $Version) -and (!$Outcome -or $_.Outcome -eq $Outcome)} | Sort-Object Time,Path)
if($Json){ConvertTo-Json -InputObject $rows -Depth 5}else{
  $rows | Select-Object Time,TimePrecision,Origin,ArchiveClass,Version,Kind,Outcome,CIStep,Passed,Failed,Scope,Validation,ValidationMode,Path | Format-Table -AutoSize | Out-String -Width 300 | Write-Output
  Write-Output "Scope: $Scope. Use -Scope all for a combined view, github:verify for platform records. pending/ is preserved separately."
}
