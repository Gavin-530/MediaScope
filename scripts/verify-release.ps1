param([Parameter(Mandatory=$true)][string]$Archive,[switch]$Deployment)
. (Join-Path $PSScriptRoot 'deployment.ps1')
$resolved=(Resolve-Path -LiteralPath $Archive).Path
$project=Split-Path $PSScriptRoot
$temp=Join-Path $project ".build/verify-$([guid]::NewGuid().ToString('N'))"
Expand-SafeZip $resolved $temp
$children=@(Get-ChildItem -LiteralPath $temp -Force)
if($children.Count -ne 1 -or !$children[0].PSIsContainer){throw 'Expected one package root'}
$app=$children[0].FullName
$manifest=Test-App $app
if(Get-ChildItem $app -Recurse -File | Where-Object {$_.Extension -in @('.exe','.dll') -or $_.FullName -match '[\\/](test-work|\.mediascope)[\\/]'} ){throw 'Runtime or user data included in release'}
Write-Output "Verified $($manifest.files.Count) files; $((Get-Item $resolved).Length) bytes"
Get-FileHash -LiteralPath $resolved -Algorithm SHA256 | Format-List
if($Deployment){& (Join-Path $PSScriptRoot 'test-deployment.ps1') -Archive $resolved;if($LASTEXITCODE -ne 0){throw 'Deployment tests failed'}}
