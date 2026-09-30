param([switch]$Apply)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$build=Join-Path $project '.build'
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project

function Safe-Files([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
  if(!$full.StartsWith($build+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Outside build directory: $full"}
  $ancestor=$full
  while($ancestor.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){
    if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked cleanup path: $ancestor"}
    $ancestor=Split-Path -Parent $ancestor
  }
  $entries=@(Get-ChildItem -LiteralPath $full -Recurse -Force)
  if(@($entries | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw "Linked entry in $full"}
  return @($entries | Where-Object {-not $_.PSIsContainer})
}

$candidates=@()
foreach($directory in Get-ChildItem -LiteralPath $build -Directory -Force){
  $kind=$null
  if($directory.Name -match '^deployment-test-[a-f0-9]{32}$'){
    $allowed=@('app','package','bad-lock','delta','external','external-first','home with spaces','separate-program-location','incompatible','next','same-version','corrupt.zip','incompatible.zip','launch-fixture.mkv','next.zip','node-revision.zip','same-version.zip','traversal.zip')
    $unknown=@(Get-ChildItem -LiteralPath $directory.FullName -Force | Where-Object {$_.Name -notin $allowed})
    if($unknown.Count){Write-Warning "Preserved unknown deployment entries: $($directory.Name)";continue}
    $kind='generated-deployment-sandbox'
  }elseif($directory.Name -match '^verify-[a-f0-9]{32}$'){
    $children=@(Get-ChildItem -LiteralPath $directory.FullName -Force)
    if($children.Count -ne 1 -or !$children[0].PSIsContainer -or $children[0].Name -notmatch '^MediaScope-\d+\.\d+\.\d+.*-win-x64$' -or !(Test-Path -LiteralPath (Join-Path $children[0].FullName 'MANIFEST.json'))){continue}
    $kind='extracted-package-verification'
  }elseif($directory.Name -match '^MediaScope-\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?-win-x64$' -and (Test-Path -LiteralPath (Join-Path $project ('releases/'+$directory.Name+'.zip')))){
    $kind='package-stage-with-preserved-zip'
  }elseif($directory.Name -match '^pr-\d+-review-[a-f0-9]{7}$' -and (Test-Path -LiteralPath (Join-Path $directory.FullName 'REVIEW.md'))){
    $kind='pr-review-with-reproducible-git-sources'
  }
  if(!$kind){continue}
  $files=@(Safe-Files $directory.FullName)
  $candidates+=@{path=$directory.FullName;name=$directory.Name;kind=$kind;files=$files;bytes=[long](($files | Measure-Object Length -Sum).Sum)}
}
foreach($candidate in $candidates){Write-Output "$(if($Apply){'Archiving before removal'}else{'Would archive and remove'}): $($candidate.path) ($([math]::Round($candidate.bytes/1MB,2)) MiB)"}
if(!$Apply -or !$candidates.Count){exit 0}

$gate=[IO.File]::Open((Join-Path $build 'evidence-recording.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  if(Test-Path -LiteralPath (Join-Path $build 'test-run.lock')){throw 'Test runner lock exists; cleanup refused'}
  $null=Test-EvidenceCatalog $root
  $active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe' OR Name='ffprobe.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($build,[StringComparison]::OrdinalIgnoreCase) -ge 0})
  if($active.Count){throw 'A build/test process is active; cleanup refused'}
  $name='build-maintenance-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $partial=Join-Path $root ($name+'.partial-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $partial | Out-Null
  $inventory=@()
  foreach($candidate in $candidates){
    $retained=@()
    foreach($file in $candidate.files){
      $relative=$file.FullName.Substring($candidate.path.Length+1).Replace('\','/')
      $isReview=$candidate.kind -eq 'pr-review-with-reproducible-git-sources'
      $keep=if($isReview){$relative -notmatch '/' -and $file.Extension -in @('.md','.log','.json','.png','.cjs')}else{
        $relative -notmatch '(^|/)(runtimes|node_modules|licenses)(/|$)' -and ($file.Extension -eq '.log' -or $file.Name -in @('MANIFEST.json','current.json','report.json','failure.json','job-input.json','selected-environment.json'))
      }
      if(!$keep){continue}
      $destination=Join-Path $partial ('diagnostics/'+$candidate.name+'/'+$relative)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destination
      $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
      if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $hash){throw "Diagnostic copy mismatch: $relative"}
      $retained+=@{path=$relative;bytes=$file.Length;sha256=$hash}
    }
    $inventory+=@{source=$candidate.path;kind=$candidate.kind;originalBytes=$candidate.bytes;originalFiles=$candidate.files.Count;retainedDiagnostics=$retained}
  }
  $manifest=@{schema=1;kind='build-maintenance';createdAtUtc=(Get-Date).ToUniversalTime().ToString('o');entries=$inventory;note='Maintenance record, not a product test result. Existing original run evidence is preserved; executable copies and generated archives are reconstructible.'}
  [IO.File]::WriteAllText((Join-Path $partial 'manifest.json'),($manifest | ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $partial
  $null=Test-EvidenceChecksums $partial
  $destination=Join-Path $root $name
  [IO.Directory]::Move($partial,$destination)
  Add-EvidenceCatalogRecord $root @{source=$destination;relative=$name}
  $null=Test-EvidenceCatalog $root
  foreach($candidate in $candidates){
    $current=@(Safe-Files $candidate.path)
    if($current.Count -ne $candidate.files.Count -or [long](($current | Measure-Object Length -Sum).Sum) -ne $candidate.bytes){throw "Build target changed: $($candidate.path)"}
    foreach($entry in @($inventory | Where-Object {$_.source -eq $candidate.path})[0].retainedDiagnostics){
      if((Get-FileHash -LiteralPath (Join-Path $candidate.path $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Diagnostics changed after archival'}
    }
    # The absolute path and every descendant have been checked inside this project's .build.
    Remove-Item -LiteralPath $candidate.path -Recurse -Force
    Write-Output "Removed: $($candidate.path)"
  }
  Write-Output "Preserved verified diagnostics: $destination"
  Write-Output "Reclaimed $([math]::Round(($candidates | ForEach-Object {$_.bytes} | Measure-Object -Sum).Sum/1MB,2)) MiB; downloads and unfinished evidence were preserved."
} finally {$gate.Dispose()}
