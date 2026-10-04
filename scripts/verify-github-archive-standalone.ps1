param([Parameter(Mandatory=$true)][string]$Root)
# Standalone format 1 integrity verification. No project, network, Git or executable archive content.
$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"
$base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
$checkedDirectories=@{}
function Assert-PlainPath([string]$Path){
  $full=[IO.Path]::GetFullPath($Path)
  if($full -ne $base -and !$full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path escapes archive'}
  $part=$full
  while($part -and $part -ne [IO.Path]::GetPathRoot($part)){
    if($checkedDirectories.ContainsKey($part)){break}
    if(Test-Path -LiteralPath $part){$entry=Get-Item -LiteralPath $part -Force;if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked archive path forbidden'};if($entry.PSIsContainer){$checkedDirectories[$part]=$true}}
    $part=Split-Path -Parent $part
  }
  return $full
}
function Get-PlainFiles([string]$Directory){
  $null=Assert-PlainPath $Directory
  foreach($item in Get-ChildItem -LiteralPath $Directory -Force){
    if($Directory -eq $base -and $item.PSIsContainer -and $item.Name -in @('pending','index')){continue}
    $null=Assert-PlainPath $item.FullName
    if($item.PSIsContainer){Get-PlainFiles $item.FullName}else{$item}
  }
}
$null=Assert-PlainPath $base
$repository=Get-Content -LiteralPath (Join-Path $base 'repository.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($repository.format -ne 1 -or $repository.host -ne 'github.com' -or $repository.repository -ne 'Gavin-530/MediaScope' -or [string]$repository.repositoryId -ne '1377031380'){throw 'Archive repository identity/format mismatch'}
$all=@(Get-PlainFiles $base);$count=0
foreach($file in @($all|Where-Object {$_.Name -eq 'archive-manifest.json'})){
  $dir=$file.DirectoryName
  $m=Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
  if($m.format -ne 1 -or $m.comparisonVersion -ne 1 -or $m.kind -ne 'github-platform-snapshot' -or $m.host -ne $repository.host -or $m.repository -ne $repository.repository -or [string]$m.repositoryId -ne [string]$repository.repositoryId){throw 'Snapshot identity mismatch'}
  $archiveAncestor=Split-Path -Parent $dir;$outerSnapshotFound=$false
  while($archiveAncestor -and $archiveAncestor.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){
    if(Test-Path -LiteralPath (Join-Path $archiveAncestor 'archive-manifest.json')){$outerSnapshotFound=$true;break}
    $archiveAncestor=Split-Path -Parent $archiveAncestor
  }
  if(!$outerSnapshotFound){
    if($m.object -notmatch '^(releases|actions|issues|pull-requests|discussions|repository|supplements|migration-reports|sync-reports)/.+$'){throw 'Object outside original archive categories'}
    if($m.object.StartsWith('actions/') -and $m.object -notmatch '^actions/[1-9]\d*(/attempts/[1-9]\d*/(jobs/[1-9]\d*|artifacts/[1-9]\d*|evidence/[a-f0-9]{20,64}))?$'){throw 'Actions layout differs from original plan'}
    $relativeDirectory=$dir.Substring($base.Length+1).Replace('\','/');$objectPrefix=$m.object+'/revisions/'
    if(!$relativeDirectory.StartsWith($objectPrefix,[StringComparison]::Ordinal) -or !$relativeDirectory.Substring($objectPrefix.Length) -or $relativeDirectory.Substring($objectPrefix.Length).Contains('/')){throw 'Snapshot directory does not match declared object path'}
  }
  $actual=@(Get-PlainFiles $dir);$expected=@{};$observedDigests=@{}
  foreach($line in Get-Content -LiteralPath (Join-Path $dir 'SHA256SUMS.txt') -Encoding UTF8){
    if($line -notmatch '^([a-f0-9]{64})  (.+)$'){throw 'Malformed checksum'}
    $digest=$Matches[1];$relative=$Matches[2]
    if(!$relative -or $relative -match '(^[/\\]|:|(^|[/\\])\.\.?([/\\]|$)|[<>"|?*]|[. ]([/\\]|$)|(^|[/\\])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|[/\\]|$))' -or $expected.ContainsKey($relative)){throw 'Unsafe or duplicate checksum path'}
    $full=Assert-PlainPath (Join-Path $dir $relative)
    if(!$full.StartsWith($dir+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Checksum escapes record'}
    $observed=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    if($observed -ne $digest){throw "Checksum mismatch: $relative"}
    $expected[$relative]=$full
    $observedDigests[$relative]=$observed
  }
  $content=@($actual|Where-Object {$_.FullName -ne (Join-Path $dir 'SHA256SUMS.txt')})
  if($content.Count -ne $expected.Count){throw 'Undeclared or missing snapshot file'}
  $manifestFiles=@{}
  foreach($entry in $m.files){
    if($manifestFiles.ContainsKey($entry.path) -or !$expected.ContainsKey($entry.path)){throw 'Manifest coverage mismatch'}
    $item=Get-Item -LiteralPath $expected[$entry.path]
    if($item.Length -ne $entry.bytes -or $observedDigests[$entry.path] -ne $entry.sha256){throw 'Manifest size/hash mismatch'}
    $manifestFiles[$entry.path]=$true
  }
  if($manifestFiles.Count+1 -ne $expected.Count){throw 'Manifest undeclared content'}
  $count++
}
Write-Output "Verified $count sealed manifests offline; SHA-256 checks integrity, not platform authorship or test success."
