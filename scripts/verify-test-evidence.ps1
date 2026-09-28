param()

$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
if(!(Test-Path -LiteralPath $root -PathType Container)){throw "Evidence archive missing: $root"}
if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked evidence archive is forbidden'}
$loose=@(Get-ChildItem -LiteralPath $root -File -Force | Where-Object {$_.Name -ne 'catalog.json'})
if($loose.Count){throw "Unexpected files in evidence archive root: $($loose.Name -join ', ')"}
$partials=@(Get-ChildItem -LiteralPath $root -Directory -Recurse -Force | Where-Object {$_.Name -match '\.partial-[a-f0-9]{32}$'})
if($partials.Count){throw "Unfinished evidence records found: $($partials.FullName -join ', ')"}
$count=Test-EvidenceCatalog $root
if(!$count){throw 'No evidence records found'}
Write-Host "Verified $count records and the archive catalog: $root"
