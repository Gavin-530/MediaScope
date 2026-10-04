param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repository='Gavin-530/MediaScope',
  [ValidatePattern('^[1-9]\d*$')][string]$RunId,
  [ValidatePattern('^[1-9]\d*$')][string]$Attempt,
  [ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
  [string]$Project
)
# Local-only import. Does not contact GitHub or execute anything from the ZIP.
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
$project=[IO.Path]::GetFullPath($Project)
if($project -notmatch '[\\/]test-work[\\/](github-evidence|independent-evidence)-[A-Za-z0-9]{6}([\\/]|$)'){
  $realProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  if($project -ne $realProject){throw 'Permanent import target is fixed to this project; isolated legacy import only supports owned protocol fixtures'}
  $node=Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $args=@((Join-Path $PSScriptRoot 'github-archive.mjs'),'import','--archive',[IO.Path]::GetFullPath($Archive),'--repository',$Repository)
  if($RunId){$args+=@('--run',$RunId)};if($Attempt){$args+=@('--attempt',$Attempt)};if($Commit){$args+=@('--commit',$Commit)}
  & $node.Source @args
  if($LASTEXITCODE -ne 0){throw 'Bound GitHub archive import failed; original retained'}
  return
}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
$path=Import-GitHubEvidence $project ([IO.Path]::GetFullPath($Archive)) $Repository $RunId $Attempt $Commit
Write-Output $path
