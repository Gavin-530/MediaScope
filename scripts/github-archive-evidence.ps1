param(
  [Parameter(Mandatory=$true)][ValidateSet('Inventory','Verify','Prepare')][string]$Action,
  [string]$Project,[string]$Record,[string]$Relative,[string]$Archive,
  [string]$RunId,[string]$Attempt,[string]$Commit
)
$ErrorActionPreference='Stop'
if(!$Project){$Project=Join-Path $PSScriptRoot '..'}
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
. (Join-Path $PSScriptRoot 'github-evidence-lib.ps1')
$projectRoot=[IO.Path]::GetFullPath($Project)
if($Action -eq 'Inventory'){
  $root=Get-EvidenceRoot $projectRoot
  $rows=@(foreach($item in Get-EvidenceRecords $root){
    $payload=Get-EvidencePayload $item
    $manifestPath=Join-Path $payload.source 'manifest.json'
    $m=if(Test-Path -LiteralPath $manifestPath){Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-EvidenceJson}else{$null}
    $validation='not-checked';$errorMessage=$null
    try{$null=Test-EvidenceRecord $item.source $item.relative;$validation='verified'}catch{$validation='failed';$errorMessage=$_.Exception.Message}
    $cloud=($m -and $m.github -and $m.kind -in @('App','github-actions-evidence'))
    [pscustomobject]@{path=$item.relative;payloadPath=$payload.relative;github=$(if($cloud){$m.github}else{$null});kind=$m.kind;validation=$validation;error=$errorMessage;classification=$(if($cloud){'github-confirmed-in-local-manifest'}else{'local-or-unconfirmed'});originalChecksum=$(if(Test-Path -LiteralPath (Join-Path $payload.source 'SHA256SUMS.txt')){(Get-FileHash -LiteralPath (Join-Path $payload.source 'SHA256SUMS.txt')).Hash}else{$null})}
  })
  ConvertTo-Json -InputObject $rows -Depth 12
}elseif($Action -eq 'Verify'){
  if(!$Record -or !$Relative){throw 'Verify requires explicit record and original relative identity'}
  $null=Test-EvidenceRecord ([IO.Path]::GetFullPath($Record)) $Relative
  Write-Output 'Verified original product evidence and checksums'
}else{
  $ownerRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../github-archive/pending')).TrimEnd('\')
  $full=[IO.Path]::GetFullPath($projectRoot).TrimEnd('\')
  if(!$full.StartsWith($ownerRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Transport receiver must be inside archive-owned pending'}
  $null=Assert-GitHubEvidencePath (Split-Path -Parent $ownerRoot) $full
  if(!$RunId -or !$Attempt){throw 'Transport import requires verified run and attempt'}
  $destination=Import-GitHubEvidence $full ([IO.Path]::GetFullPath($Archive)) 'Gavin-530/MediaScope' $RunId $Attempt $Commit
  Write-Output $destination
}
