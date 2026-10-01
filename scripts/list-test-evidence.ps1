param([string]$Origin,[string]$Version,[string]$Outcome,[switch]$Json)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
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
    $product=($app -and $app.kind -in @('App','Package','OnlineDeployment','Custom'))
    $started=if($app.startedAt){$app.startedAt}elseif($app.startedAtUtc){$app.startedAtUtc}elseif($app.createdAtUtc){$app.createdAtUtc}elseif($app.createdUtc){$app.createdUtc}else{$null}
    $beijing=Format-EvidenceBeijingTime $started
    $precision=if($envelope.identifierTimePrecision){$envelope.identifierTimePrecision}else{'not-recorded'}
    $passed=$null;$failed=$null
    if($product -and $app.testSummary){$passed=$app.testSummary.passed;$failed=$app.testSummary.failed}
    elseif($product -and $app.summary){$passed=if($null -ne $app.summary.passed){$app.summary.passed}else{$app.summary.pass};$failed=if($null -ne $app.summary.failed){$app.summary.failed}else{$app.summary.fail}}
    [pscustomobject]@{Time=$beijing;IdentifierTime=$envelope.identifierTime;TimePrecision=$precision;TimeSource=$envelope.identifierTimeSource;Origin=$(if($app.github -or $cloud){'github-actions'}else{'local'});Version=$(if($product){$app.version}else{'n/a'});Kind=$(if($app){$app.kind}elseif($envelope){$envelope.kind}else{'legacy'});Outcome=$(if($product -and $app.outcome){$app.outcome}elseif($envelope){$envelope.outcome}else{'archived'});Passed=$passed;Failed=$failed;Scope=$app.scope;Run=$app.runId;GitHubRun=$app.github.runId;Attempt=$app.github.runAttempt;Path=$record.relative;Original=$inner.source}
  }
})
$rows=@($rows | Where-Object {(!$Origin -or $_.Origin -eq $Origin) -and (!$Version -or $_.Version -eq $Version) -and (!$Outcome -or $_.Outcome -eq $Outcome)} | Sort-Object Time,Path)
if($Json){ConvertTo-Json -InputObject $rows -Depth 5}else{
  $rows | Select-Object Time,TimePrecision,Origin,Version,Kind,Outcome,Passed,Failed,Scope,Path | Format-Table -AutoSize | Out-String -Width 300 | Write-Output
  Write-Output 'Run npm run evidence:verify to check integrity. pending/ is preserved separately.'
}
