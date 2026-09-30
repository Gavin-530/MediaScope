param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repository='Gavin-530/MediaScope',
  [ValidatePattern('^[1-9]\d*$')][string]$RunId,
  [ValidatePattern('^[1-9]\d*$')][string]$Attempt
)
# Local-only import. Does not contact GitHub or execute anything from the ZIP.
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
$path=Import-GitHubEvidence $project ([IO.Path]::GetFullPath($Archive)) $Repository $RunId $Attempt
Write-Output "Permanently archived and verified: $path"
