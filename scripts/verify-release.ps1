param([Parameter(Mandatory=$true)][string]$Archive,[switch]$Deployment,[string]$ResultPath)
. (Join-Path $PSScriptRoot 'deployment.ps1')
$resolved=(Resolve-Path -LiteralPath $Archive).Path
$project=Split-Path $PSScriptRoot
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$temp=Join-Path $project "evidence-archive/pending/deployment-runs/verify-$([guid]::NewGuid().ToString('N').Substring(0,12))"
Expand-SafeZip $resolved $temp
$children=@(Get-ChildItem -LiteralPath $temp -Force)
if($children.Count -ne 1 -or !$children[0].PSIsContainer){throw 'Expected one package root'}
$app=$children[0].FullName
$manifest=Test-App $app
$launcher=Join-Path $app 'scripts/MediaScope.Launcher.exe'
$launcherAllowed=$false
if(Test-Path -LiteralPath $launcher){
  try{
    $build=Read-Json (Join-Path $app 'scripts/launcher-build.json')
    if($build.schema -ne 1 -or $build.fingerprint -notmatch '^[a-f0-9]{64}$'){throw 'Invalid launcher build metadata'}
    Assert-Hash $launcher $build.executableHash
    Assert-Hash (Join-Path $app 'scripts/fast-bootstrap.mjs') $build.bootstrapHash
    $reader=New-Object IO.BinaryReader([IO.File]::OpenRead($launcher))
    try{$reader.BaseStream.Position=0x3c;$offset=$reader.ReadInt32();$reader.BaseStream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Invalid launcher architecture'}}finally{$reader.Dispose()}
    $launcherAllowed=$true
  }catch{throw "Runtime, tests or local data included in release: invalid application launcher. $($_.Exception.Message)"}
}
if(Get-ChildItem $app -Recurse -File | Where-Object {($_.Extension -in @('.exe','.dll') -and !($launcherAllowed -and $_.FullName -eq $launcher)) -or $_.FullName.Substring($app.Length+1) -match '(^|[\\/])(test|testing-tools|test-work|local-notes|local-test-archive|evidence-archive|github-archive|\.mediascope|\.mediascope-saved-media|\.build|node_modules|\.git|releases)[\\/]'} ){throw 'Runtime, tests or local data included in release'}
Write-Output "Verified $($manifest.files.Count) files; $((Get-Item $resolved).Length) bytes"
Get-FileHash -LiteralPath $resolved -Algorithm SHA256 | Format-List
if($Deployment){& (Join-Path $PSScriptRoot 'test-deployment.ps1') -Archive $resolved -ResultPath $ResultPath -ManagedEvidence;if($LASTEXITCODE -ne 0){throw 'Deployment tests failed'}}
