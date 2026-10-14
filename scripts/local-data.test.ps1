$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$work=Join-Path $project ('test-work/build-policy-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $work 'scripts') -Force | Out-Null
function Assert($Value,$Message){if(!$Value){throw $Message}}
function Clean([switch]$Apply){
  $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $work 'scripts/local-data.ps1'),'-Action','Clean','-Category','Build')
  if($Apply){$args+='-Apply'}
  $ErrorActionPreference='Continue'
  $output=& powershell.exe @args 2>&1
  return @{code=$LASTEXITCODE;output=($output -join "`n")}
}
try{
  Copy-Item -LiteralPath (Join-Path $project 'local-data-policy.json') -Destination $work
  foreach($file in @('local-data.ps1','evidence-lib.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $work 'scripts')}
  $build=Join-Path $work '.build'
  New-Item -ItemType Directory -Path $build -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $build 'generated.txt') -Value 'rebuildable'
  New-Item -ItemType Directory -Path (Join-Path $work 'local-notes') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $work 'local-notes/note.json') -Value '{}'
  New-Item -ItemType Directory -Path (Join-Path $build 'github-archive-implementation') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $build 'github-archive-implementation/inventory.json') -Value '{"cache":true}'
  $platformFile=Join-Path $work 'github-archive/actions/123/original.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $platformFile) -Force | Out-Null
  Set-Content -LiteralPath $platformFile -Value '{"platform":"preserve"}'
  $platformHash=(Get-FileHash -LiteralPath $platformFile).Hash
  Assert ((Clean).code -eq 0) 'Preview failed'
  Assert (Test-Path -LiteralPath (Join-Path $build 'generated.txt')) 'Preview deleted files'
  New-Item -ItemType Directory -Path (Join-Path $build 'evidence-maintenance-old') | Out-Null
  Assert ((Clean).code -ne 0) 'Legacy recovery data accepted for cleanup'
  Remove-Item -LiteralPath (Join-Path $build 'evidence-maintenance-old')
  New-Item -ItemType Junction -Path (Join-Path $build 'linked') -Target (Join-Path $work 'github-archive') | Out-Null
  Assert ((Clean).code -ne 0) 'Linked cleanup target accepted'
  # Remove the junction itself, never its destination.
  [IO.Directory]::Delete((Join-Path $build 'linked'))
  New-Item -ItemType Directory -Path (Join-Path $work 'evidence-archive/pending') -Force | Out-Null
  $runLock=Join-Path $work 'evidence-archive/pending/test-run.lock'
  Set-Content -LiteralPath $runLock -Value 'interrupted task'
  Assert ((Clean -Apply).code -ne 0) 'Interrupted test run accepted for cleanup'
  Assert (Test-Path -LiteralPath (Join-Path $build 'generated.txt')) 'Interrupted test cleanup removed output'
  Remove-Item -LiteralPath $runLock
  $result=Clean -Apply
  Assert ($result.code -eq 0) $result.output
  Assert (!(Test-Path -LiteralPath $build)) 'Build directory remains after cleanup'
  Assert (Test-Path -LiteralPath (Join-Path $work 'local-notes/note.json')) 'Protected receipt deleted'
  Assert ((Get-FileHash -LiteralPath $platformFile).Hash -eq $platformHash) 'Cleanup changed platform archive content'
  Assert ((Clean).code -eq 0) 'Missing build directory should be harmless'
  foreach($item in @('analysis.mjs','siti.mjs','gpu','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')){
    Copy-Item -LiteralPath (Join-Path $project $item) -Destination $work -Recurse
  }
  foreach($file in @('package.ps1','deployment.ps1','manage.ps1','install-location.ps1','uninstall.ps1','check-environment.mjs','desktop.mjs','runtime-data.mjs','time.mjs','validate-launch.ps1')){
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $work 'scripts')
  }
  $version=(Get-Content -LiteralPath (Join-Path $work 'package.json') -Raw | ConvertFrom-Json).version
  $packageScript=Join-Path $work 'scripts/package.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -Version $version | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Packaging from missing build directory failed'
  $manifestPath=Join-Path $build "MediaScope-$version-win-x64/MANIFEST.json"
  $manifest=Get-Content -LiteralPath $manifestPath -Raw
  $zip=Join-Path $work "releases/MediaScope-$version-win-x64.zip"
  $zipHash=(Get-FileHash -LiteralPath $zip).Hash
  $result=Clean -Apply
  Assert ($result.code -eq 0) $result.output
  Assert ((Get-FileHash -LiteralPath $zip).Hash -eq $zipHash) 'Cleanup changed preserved release'
  # Only the isolated test's release is removed to allow the same version to rebuild.
  Remove-Item -LiteralPath $zip
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -Version $version | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Rebuilding after cleanup failed'
  Assert ((Get-Content -LiteralPath $manifestPath -Raw) -eq $manifest) 'Clean rebuild produced different application bytes'
  Assert ((Get-FileHash -LiteralPath $platformFile).Hash -eq $platformHash) 'Rebuild changed platform archive content'
  Write-Output 'PASS: cleanup preview, legacy/link/run protection, receipt/release/platform preservation and identical clean package rebuild'
}finally{
  if(!$work.StartsWith($project+'\test-work\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test cleanup escapes workspace'}
  $link=Join-Path $work '.build/linked'
  if(Test-Path -LiteralPath $link){[IO.Directory]::Delete($link)}
  Remove-Item -LiteralPath $work -Recurse -Force
}
