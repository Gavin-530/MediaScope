param([string]$Plan,[switch]$Apply,[string]$RestoreSource)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
if(($Apply -or $RestoreSource) -and !$Plan){throw 'An explicit verified removal plan is required'}
if($Apply -and $RestoreSource){throw 'Removal and restoration are separate operations'}
if($Plan -and !$Apply -and !$RestoreSource){throw 'Use -Apply or -RestoreSource with an existing plan'}
$lockPath=Get-EvidenceLockPath $project
try{$gate=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Evidence recording/import lock is active or unavailable; no source removal started'}
try{
  $command=if($RestoreSource){'restore'}elseif($Apply){'apply'}else{'prepare'}
  $arguments=@((Join-Path $PSScriptRoot 'github-archive-prune.mjs'),$command)
  if($Plan){$arguments+=@([IO.Path]::GetFullPath($Plan))}
  if($RestoreSource){$arguments+=@($RestoreSource)}
  $priorParent=$env:MEDIASCOPE_PRUNE_LOCK_PARENT_PID
  try{
    $env:MEDIASCOPE_PRUNE_LOCK_PARENT_PID=[string]$PID
    & node @arguments
    if($LASTEXITCODE -ne 0){throw 'Exact-source operation stopped; journal and any detached original retained for recovery'}
  }finally{$env:MEDIASCOPE_PRUNE_LOCK_PARENT_PID=$priorParent}
  if($Apply -or $RestoreSource){Update-EvidenceCatalogCache (Get-EvidenceRoot $project)}
}finally{$gate.Dispose()}
