param(
  [Parameter(Mandatory=$true)][ValidatePattern('^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(-(alpha|beta|rc)(\.(?:0|[1-9][0-9]*))?)?$')][string]$Version
)
. (Join-Path $PSScriptRoot 'deployment.ps1')
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if((Read-Json (Join-Path $project 'package.json')).version -ne $Version){throw 'Version must match package.json'}
$name="MediaScope-$Version-win-x64"
$stage=Join-Path $project ".build/$name"
$archive=Join-Path $project "releases/$name.zip"
if(Test-Path -LiteralPath $archive){throw "Refusing to overwrite preserved release: $archive"}
if(Test-Path -LiteralPath $stage){throw "Staging directory already exists: $stage"}
New-Item -ItemType Directory -Force $stage,(Join-Path $stage 'scripts'),(Join-Path $project 'releases') | Out-Null
foreach($item in @('analysis.mjs','siti.mjs','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')){
  Copy-Item -LiteralPath (Join-Path $project $item) -Destination $stage -Recurse
}
foreach($item in @('deployment.ps1','manage.ps1','install-location.ps1','uninstall.ps1','check-environment.mjs','desktop.mjs','runtime-data.mjs','validate-launch.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item) -Destination (Join-Path $stage 'scripts')}
Write-Json (Join-Path $stage 'MANIFEST.json') @{schema=1;version=$Version;platform='win32-x64';files=@(Get-TreeRecords $stage)}
$null=Test-App $stage
Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal
Write-Output "Package bytes: $((Get-Item -LiteralPath $archive).Length)"
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Format-List
Write-Output "Staging preserved: $stage"
