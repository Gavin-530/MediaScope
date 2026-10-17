param([Parameter(Mandatory=$true)][string]$Scripts)
. (Join-Path $Scripts 'deployment.ps1')
$owned=Join-Path ([IO.Path]::GetTempPath()) ('MediaScope-release-boundary-'+[guid]::NewGuid().ToString('N'))
$root=[IO.Path]::GetFullPath($owned)
$allowed=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(!$root.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected test root'}
New-Item -ItemType Directory -Path (Join-Path $root 'scripts') -Force | Out-Null
try {
  foreach($name in @('verify-release.ps1','deployment.ps1','evidence-lib.ps1')){Copy-Item -LiteralPath (Join-Path $Scripts $name) -Destination (Join-Path $root 'scripts')}
  $cases=@('', 'local-notes/README.md', '.mediascope-saved-media/synthetic.mp4', 'public/local-notes/synthetic.json', 'testing-tools/synthetic.mjs')
  for($i=0;$i -lt $cases.Count;$i++){
    $app=Join-Path $root "case-$i/MediaScope"
    New-Item -ItemType Directory -Path (Join-Path $app 'scripts') -Force | Out-Null
    foreach($name in @('server.mjs','scripts/check-environment.mjs','scripts/manage.ps1','scripts/deployment.ps1','start.cmd')){[IO.File]::WriteAllText((Join-Path $app $name),'synthetic package boundary fixture')}
    Write-Json (Join-Path $app 'package.json') @{version='0.0.1'}
    Write-Json (Join-Path $app 'runtime-lock.json') @{schema=1;platform='win32-x64';compatibility='media-v1'}
    if($cases[$i]){
      $extra=Join-Path $app $cases[$i]
      New-Item -ItemType Directory -Path (Split-Path $extra) -Force | Out-Null
      [IO.File]::WriteAllText($extra,'synthetic sentinel; no user data')
    }
    Write-Json (Join-Path $app 'MANIFEST.json') @{schema=1;platform='win32-x64';version='0.0.1';files=@(Get-TreeRecords $app)}
    $archive=Join-Path $root "case-$i.zip"
    Compress-Archive -LiteralPath $app -DestinationPath $archive
    $previousPreference=$ErrorActionPreference
    $ErrorActionPreference='Continue'
    $output=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts/verify-release.ps1') -Archive $archive 2>&1 | Out-String
    $exitCode=$LASTEXITCODE
    $ErrorActionPreference=$previousPreference
    if($i -eq 0){if($exitCode -ne 0){throw "Valid package rejected: $output"}}
    elseif($exitCode -eq 0 -or $output -notmatch 'Runtime, tests or local data included in release'){throw "Private package was not rejected by boundary validation: $output"}
  }
  @{validPackage='passed';privatePathsRejected=4;syntheticInputsOnly=$true} | ConvertTo-Json -Compress
} finally {
  if([IO.Path]::GetFullPath($root).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $root -Recurse -Force}
}
