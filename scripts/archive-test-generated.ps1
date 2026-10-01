param()

$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
$testRoot=Join-Path $project 'test-work'
$buildRoot=Join-Path $project '.build'
if(!(Test-Path -LiteralPath $testRoot)){throw 'No test-work directory to archive'}
if((Get-Item -LiteralPath $testRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked test-work root is forbidden'}

function Is-GeneratedDirectory([string]$Name) {
  return ($Name -match '^(bitdepth|server-reports|trial|trial-libaom-av1|trial-libx265|trials-expanded)$' -or
    $Name -match '^(metrics-equivalence|reference-cache|siti-parallel|structure-equivalence|vfr-equivalence)-[A-Za-z0-9]{6}$')
}

function Is-GeneratedFile([string]$Name) {
  return ($Name -match '^(\u53C2\u8003 \u591A\u97F3\u8F68|av1|candidate|open-gop|http-fixture)\.mp4$' -or
    $Name -match '^hdr-pcm\.mov$' -or $Name -match '^http-depth-(8|10)\.mkv$' -or
    $Name -match '^(color-yuv|yuv)[A-Za-z0-9-]*\.mkv$' -or
    $Name -match '^(chart-ui-report\.json|psnr\.log|ssim\.log|vmaf\.log)$')
}

function Get-CheckedFiles([string]$Directory) {
  $files=New-Object 'System.Collections.Generic.List[object]'
  $stack=New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Directory)
  while($stack.Count){
    $current=$stack.Pop()
    $item=Get-Item -LiteralPath $current -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked test fixture entry is forbidden: $current"}
    if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $current -Force){$stack.Push($child.FullName)}}
    else{$files.Add($item)}
  }
  return @($files.ToArray())
}

$dirs=@(Get-ChildItem -LiteralPath $testRoot -Directory -Force | Where-Object {Is-GeneratedDirectory $_.Name} | Sort-Object Name)
$rootFiles=@(Get-ChildItem -LiteralPath $testRoot -File -Force | Where-Object {Is-GeneratedFile $_.Name} | Sort-Object Name)
$items=@($dirs)+@($rootFiles)
if(!$items.Count){Write-Output 'No generated test files or directories to archive.';exit 0}
New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
$gate=$null
try {
  try {$gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  catch {throw 'Evidence recording is active; archive refused'}
  $catalogPath=Join-Path $root 'catalog.json'
  if(Test-Path -LiteralPath $catalogPath){$null=Test-EvidenceCatalog $root}
  elseif(@(Get-EvidenceRecords $root).Count){throw "Evidence catalog missing: $catalogPath"}
  $node=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if($node -and @(Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.Equals($node.Source,[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Test Node process is running; archive refused'}
  if(@(Get-Process ffmpeg,ffprobe -ErrorAction SilentlyContinue).Count){throw 'FFmpeg or FFprobe is running; archive refused'}
  $entries=@()
  $prefix=$testRoot.TrimEnd('\')+'\'
  foreach($item in $items){
    foreach($file in Get-CheckedFiles $item.FullName){
      $relative=$file.FullName.Substring($prefix.Length).Replace('\','/')
      $entries+=@{path=$relative;full=$file.FullName;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash}
    }
  }
  $entries=@($entries | Sort-Object path)
  $runId=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
  $name="generated-fixtures-$runId"
  $destination=Join-Path $root $name
  $partial=Join-Path (Get-EvidencePendingRoot $project) ("staging/$name.partial-$([guid]::NewGuid().ToString('N'))")
  if(Test-Path -LiteralPath $destination){throw "Snapshot already exists: $destination"}
  New-Item -ItemType Directory -Force -Path $partial | Out-Null
  $zipPath=Join-Path $partial 'fixtures.zip'
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach($file in $entries){
      $item=$zip.CreateEntry($file.path,[IO.Compression.CompressionLevel]::Optimal)
      $inputStream=[IO.File]::OpenRead($file.full)
      try {$outputStream=$item.Open();try {$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose()}}
      finally {$inputStream.Dispose()}
    }
  } finally {$zip.Dispose()}
  $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if($zip.Entries.Count -ne $entries.Count){throw 'Fixture ZIP entry count mismatch'}
    $byPath=@{};foreach($file in $entries){$byPath[$file.path]=$file}
    $sha=[Security.Cryptography.SHA256]::Create()
    try {
      foreach($item in $zip.Entries){
        if(!$byPath.ContainsKey($item.FullName)){throw "Unexpected fixture ZIP entry: $($item.FullName)"}
        $file=$byPath[$item.FullName]
        if($item.Length -ne $file.bytes){throw "Fixture ZIP size mismatch: $($item.FullName)"}
        $stream=$item.Open()
        try {$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')}
        finally {$stream.Dispose()}
        if($hash -ne $file.sha256){throw "Fixture ZIP hash mismatch: $($item.FullName)"}
        $byPath.Remove($item.FullName)
      }
    } finally {$sha.Dispose()}
    if($byPath.Count){throw 'Fixture ZIP omitted files'}
  } finally {$zip.Dispose()}
  $manifest=[ordered]@{
    schema=1;kind='generated-fixture-snapshot';createdAtUtc=(Get-Date).ToUniversalTime().ToString('o')
    items=@($items | ForEach-Object {$_.Name})
    sourceRoot='test-work';directories=@($dirs | ForEach-Object {$_.Name})
    files=@($entries | ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=$_.sha256}})
    zipFile='fixtures.zip';zipSha256=(Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    note='Maintenance snapshot of regenerable test fixtures; not a test run or version claim'
  }
  [IO.File]::WriteAllText((Join-Path $partial 'manifest.json'),($manifest | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $partial 'report.md'),"# Generated test fixture snapshot`n`n$($dirs.Count) directories, $($rootFiles.Count) top-level files, and $($entries.Count) total files captured from test-work. This is a maintenance snapshot, not a test result. The historical acceptance directory and unclassified items were excluded.`n",(New-Object Text.UTF8Encoding($false)))
  Write-EvidenceChecksums $partial
  $null=Test-EvidenceRecord $partial $name
  $destination=Publish-EvidenceRecord $project $partial $name
  Write-Output "Archived $($dirs.Count) directories and $($rootFiles.Count) top-level files ($($entries.Count) total files): $destination"
  Write-Output "Verified ZIP and archive catalog: $destination"
}finally{if($gate){$gate.Dispose()}}
