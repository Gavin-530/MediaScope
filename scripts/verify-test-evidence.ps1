param([switch]$RequireComplete)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
if(!(Test-Path -LiteralPath $root -PathType Container)){throw "Evidence archive missing: $root"}
$count=Test-EvidenceCatalog $root
$pending=Join-Path $root 'pending'
$unfinished=@(Get-ChildItem -LiteralPath $pending -Force | Where-Object {
  $_.Name -notin @('recording.lock','sync-state.json') -and (!$_.PSIsContainer -or @(Get-EvidenceFiles $_.FullName).Count -gt 0)
})
Write-Output "Verified $count sealed records and the archive catalog: $root"
Write-Output "Pending entries: $($unfinished.Count) (preserved, not counted as product passes)"
if($RequireComplete -and $unfinished.Count){throw 'Unfinished evidence exists'}
