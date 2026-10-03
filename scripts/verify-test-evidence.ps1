param([switch]$RequireComplete,[string]$Record)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
if($Record){
  $selected=if([IO.Path]::IsPathRooted($Record)){[IO.Path]::GetFullPath($Record)}else{Join-Path $root $Record}
  $null=Get-EvidenceFiles $selected
  $mp=Join-Path $selected 'manifest.json';$rp=Join-Path $selected 'record.json'
  if(Test-Path -LiteralPath $rp){$identity=(Get-Content -LiteralPath $rp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson).path}
  elseif(Test-Path -LiteralPath $mp){$m=Get-Content -LiteralPath $mp -Raw -Encoding UTF8|ConvertFrom-EvidenceJson;$identity='runs/'+$m.version+'/'+$m.runId}
  else{throw 'Record manifest missing'}
  $null=Test-EvidenceRecord $selected $identity
  Write-Output "Verified independent record: $selected"
  exit 0
}
if(!(Test-Path -LiteralPath $root -PathType Container)){throw "Evidence archive missing: $root"}
$count=Test-EvidenceCatalog $root
$pending=Join-Path $root 'pending'
$unfinished=@(Get-ChildItem -LiteralPath $pending -Force | Where-Object {
  $_.Name -notin @('recording.lock','sync-state.json') -and (!$_.PSIsContainer -or @(Get-EvidenceFiles $_.FullName).Count -gt 0)
})
Write-Output "Verified $count records independently (catalog is optional): $root"
Write-Output "Pending entries: $($unfinished.Count) (preserved, not counted as product passes)"
if($RequireComplete -and $unfinished.Count){throw 'Unfinished evidence exists'}
