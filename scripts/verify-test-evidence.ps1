param([switch]$RequireComplete,[string]$Record,[ValidateSet('local','github','all')][string]$Scope='local')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
if($Record){
  $selected=if([IO.Path]::IsPathRooted($Record)){[IO.Path]::GetFullPath($Record)}else{Join-Path $root $Record}
  if(!(Test-Path -LiteralPath $selected) -and $selected.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){
    $relative=$selected.Substring($root.Length+1).Replace('\','/')
    if($relative -match '^records/[^/]+$'){$selected=Resolve-EvidenceLocation $root $relative}
  }
  $null=Get-EvidenceFiles $selected
  $mp=Join-Path $selected 'manifest.json';$rp=Join-Path $selected 'record.json'
  if(Test-Path -LiteralPath $rp){$identity=(Get-Content -LiteralPath $rp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson).path}
  elseif(Test-Path -LiteralPath $mp){$m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson;$identity='runs/'+$m.version+'/'+$m.runId}
  else{throw 'Record manifest missing'}
  if($selected.StartsWith($root+'\records\',[StringComparison]::OrdinalIgnoreCase)){$identity=$selected.Substring($root.Length+1).Replace('\','/')}
  $null=Test-EvidenceRecord $selected $identity
  Write-Output "Verified independent record: $selected"
  exit 0
}
if($Scope -ne 'local'){
  & node (Join-Path $PSScriptRoot 'github-archive.mjs') verify
  if($LASTEXITCODE -ne 0){throw 'GitHub platform verification failed'}
  if($Scope -eq 'github'){exit 0}
}
if(!(Test-Path -LiteralPath $root -PathType Container)){throw "Evidence archive missing: $root"}
$count=0
foreach($item in Get-EvidenceRecords $root){
  $payload=Get-EvidencePayload $item
  $manifestPath=Join-Path $payload.source 'manifest.json'
  $manifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-EvidenceJson}else{$null}
  if($manifest.github -and $manifest.kind -in @('App','github-actions-evidence')){continue}
  $null=Test-EvidenceRecord $item.source $item.relative
  $count++
}
$pending=Join-Path $root 'pending'
$unfinished=@(Get-ChildItem -LiteralPath $pending -Force | Where-Object {
  if($_.Name -eq 'record-name-migration.json'){
    $journal=Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8|ConvertFrom-EvidenceJson
    return !($journal.schema -eq 1 -and $journal.operation -eq 'readable-record-names' -and $journal.state -in @('completed','rolled-back'))
  }
  $_.Name -notin @('recording.lock','sync-state.json') -and (!$_.PSIsContainer -or @(Get-EvidenceFiles $_.FullName).Count -gt 0)
})
Write-Output "Verified $count local records independently (catalog is optional): $root"
Write-Output "Pending entries: $($unfinished.Count) (preserved, not counted as product passes)"
if($RequireComplete -and $unfinished.Count){throw 'Unfinished evidence exists'}
