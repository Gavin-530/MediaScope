$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..')).TrimEnd('\')
$scriptsRoot=Join-Path $project 'scripts'
$work=Join-Path $project ('.build/testing-work/build-policy-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $work 'scripts') -Force | Out-Null
$reportDirectory=Join-Path $project '.build/tool-checks';New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$reportPath=Join-Path $reportDirectory ('local-data-'+[guid]::NewGuid().ToString('N')+'.json')
$report=@{schema=1;scope='cleanup-tool-verification';outcome='running';scriptSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash;startedAtUtc=[DateTime]::UtcNow.ToString('o')}
$script:checks=@()
function Assert($Value,$Message){$script:checks+=@{name=$Message;status=$(if($Value){'passed'}else{'failed'})};if(!$Value){throw $Message}}
function Clean([switch]$Apply){
  $args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $work 'scripts/local-data.ps1'),'-Action','Clean','-Category','Build')
  if($Apply){$args+='-Apply'}
  $ErrorActionPreference='Continue'
  $output=& powershell.exe @args 2>&1
  return @{code=$LASTEXITCODE;output=($output -join "`n")}
}
try{
  Copy-Item -LiteralPath (Join-Path $project 'local-data-policy.json') -Destination $work
  foreach($file in @('local-data.ps1','evidence-lib.ps1')){Copy-Item -LiteralPath (Join-Path $scriptsRoot $file) -Destination (Join-Path $work 'scripts')}
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
  foreach($name in @('test-runs','deployment-runs')){
    $runs=Join-Path $build $name
    New-Item -ItemType Directory -Path $runs -Force | Out-Null
    Assert ((Clean).code -eq 0) 'Empty execution container should be disposable'
    $interrupted=Join-Path $runs 'interrupted'
    New-Item -ItemType Directory -Path $interrupted | Out-Null
    Assert ((Clean).code -ne 0) 'Interrupted execution workspace accepted for cleanup'
    Assert (Test-Path -LiteralPath $interrupted) 'Preview removed interrupted execution workspace'
    Remove-Item -LiteralPath $interrupted
  }
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
  # Capture all maintained runtime modules and scripts instead of an aging helper whitelist.
  foreach($item in @((Get-ChildItem -LiteralPath $project -File -Filter '*.mjs' | ForEach-Object Name))+@('gpu','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')){
    Copy-Item -LiteralPath (Join-Path $project $item) -Destination $work -Recurse
  }
  Copy-Item -Path (Join-Path $scriptsRoot '*') -Destination (Join-Path $work 'scripts') -Recurse
  $version=(Get-Content -LiteralPath (Join-Path $work 'package.json') -Raw | ConvertFrom-Json).version
  $packageScript=Join-Path $work 'scripts/package.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -Version $version | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Packaging from missing build directory failed'
  $manifestPath=Join-Path $build "MediaScope-$version-win-x64/MANIFEST.json"
  $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $launcherMetadataPath=Join-Path $build "MediaScope-$version-win-x64/scripts/launcher-build.json"
  $firstLauncher=Get-Content -LiteralPath $launcherMetadataPath -Raw | ConvertFrom-Json
  Assert ((Get-FileHash -LiteralPath (Join-Path $build "MediaScope-$version-win-x64/scripts/MediaScope.Launcher.exe")).Hash -eq $firstLauncher.executableHash) 'First generated launcher matches its build metadata'
  $zip=Join-Path $work "releases/MediaScope-$version-win-x64.zip"
  $zipHash=(Get-FileHash -LiteralPath $zip).Hash
  $result=Clean -Apply
  Assert ($result.code -eq 0) $result.output
  Assert ((Get-FileHash -LiteralPath $zip).Hash -eq $zipHash) 'Cleanup changed preserved release'
  # Only the isolated test's release is removed to allow the same version to rebuild.
  Remove-Item -LiteralPath $zip
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -Version $version | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Rebuilding after cleanup failed'
  $rebuilt=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $secondLauncher=Get-Content -LiteralPath $launcherMetadataPath -Raw | ConvertFrom-Json
  $report.firstManifest=$manifest;$report.rebuiltManifest=$rebuilt
  $report.firstLauncher=$firstLauncher;$report.rebuiltLauncher=$secondLauncher
  Assert ($rebuilt.schema -eq $manifest.schema -and $rebuilt.version -eq $manifest.version -and $rebuilt.platform -eq $manifest.platform) 'Clean rebuild retains package identity'
  $before=@{};foreach($file in $manifest.files){$before[$file.path]=$file}
  Assert (@($rebuilt.files).Count -eq $before.Count) 'Clean rebuild retains the exact package file set'
  foreach($file in $rebuilt.files){
    Assert ($before.ContainsKey($file.path)) 'Clean rebuild contains only original file paths'
    if($file.path -in @('scripts/MediaScope.Launcher.exe','scripts/launcher-build.json')){continue}
    Assert ($file.bytes -eq $before[$file.path].bytes -and $file.sha256 -eq $before[$file.path].sha256) ('Clean rebuild preserves source bytes: '+$file.path)
  }
  Assert ($secondLauncher.schema -eq $firstLauncher.schema -and $secondLauncher.fingerprint -eq $firstLauncher.fingerprint -and $secondLauncher.bootstrapHash -eq $firstLauncher.bootstrapHash) 'Clean rebuild retains launcher source and bootstrap identities'
  Assert ((Get-FileHash -LiteralPath (Join-Path $build "MediaScope-$version-win-x64/scripts/MediaScope.Launcher.exe")).Hash -eq $secondLauncher.executableHash) 'Rebuilt launcher matches its own build metadata'
  Assert ((Get-FileHash -LiteralPath $platformFile).Hash -eq $platformHash) 'Rebuild changed platform archive content'
  $report.outcome='passed'
  Write-Output 'PASS: cleanup boundaries and preserved package sources/build identities; generated launcher bytes are independently verified, not claimed reproducible'
}catch{$report.outcome='failed';$report.failure=$_.Exception.Message;throw}finally{
  try{
    if(!$work.StartsWith($project+'\.build\testing-work\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test cleanup escapes workspace'}
    $link=Join-Path $work '.build/linked'
    if(Test-Path -LiteralPath $link){[IO.Directory]::Delete($link)}
    Remove-Item -LiteralPath $work -Recurse -Force
  }catch{$report.outcome='failed';$report.cleanupFailure=$_.Exception.Message;throw}finally{
    $report.checks=@($script:checks);$report.finishedAtUtc=[DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($reportPath,($report|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
    Write-Output "Cleanup verification: $reportPath"
  }
}
