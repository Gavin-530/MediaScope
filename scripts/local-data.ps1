param(
  [ValidateSet('Status','Verify','Clean')][string]$Action='Status',
  [ValidateSet('BuildStages','TestGenerated','Downloads')][string]$Category,
  [switch]$Apply
)

$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$policy=Get-Content -LiteralPath (Join-Path $project 'local-data-policy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($policy.schema -ne 1 -or !$policy.rules){throw 'Unsupported local data policy'}
$rules=@{}
foreach($rule in $policy.rules){
  if(!$rule.path -or [IO.Path]::IsPathRooted($rule.path) -or $rule.path -match '(^|[\\/])\.\.([\\/]|$)' -or
     $rule.class -notin @('protected','mixed','cache','pending')){throw "Invalid local data rule: $($rule.path)"}
  $name=$rule.path.Replace('/','\').TrimEnd('\')
  $full=[IO.Path]::GetFullPath((Join-Path $project $name))
  if(!$full.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase) -or $rules.ContainsKey($name)){throw "Invalid local data rule: $name"}
  $rules[$name]=@{path=$full;class=$rule.class;reason=$rule.reason}
}
foreach($name in @('evidence-archive','.mediascope','releases','test-work\acceptance-20260921')){
  if(!$rules.ContainsKey($name) -or $rules[$name].class -ne 'protected'){throw "Required protected rule missing: $name"}
}
foreach($name in @('test-work','.build','.build\downloads','evidence-archive\pending')){
  if(!$rules.ContainsKey($name)){throw "Required local data rule missing: $name"}
}

. (Join-Path $PSScriptRoot 'evidence-lib.ps1')

function Assert-Contained([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
  if(!$full.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Outside MediaScope: $full"}
  $part=$full
  while($part.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){
    if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
      throw "Linked data path forbidden: $part"
    }
    $part=Split-Path -Parent $part
  }
  return $full
}

function Get-SafeFiles([string]$Path) {
  $full=Assert-Contained $Path
  if(!(Test-Path -LiteralPath $full)){return @()}
  $stack=New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($full)
  $files=New-Object 'System.Collections.Generic.List[object]'
  while($stack.Count){
    $current=$stack.Pop()
    $item=Get-Item -LiteralPath $current -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked data entry forbidden: $current"}
    if($item.PSIsContainer){
      foreach($child in Get-ChildItem -LiteralPath $current -Force){$stack.Push($child.FullName)}
    }else{$files.Add($item)}
  }
  return @($files.ToArray())
}

function Get-Size([string]$Path) {
  $files=@(Get-SafeFiles $Path)
  $bytes=($files | Measure-Object Length -Sum).Sum
  return @{count=$files.Count;bytes=[long]$bytes}
}

function Assert-CleanTarget([string]$Path) {
  $full=Assert-Contained $Path
  foreach($rule in $rules.Values){
    if($rule.class -eq 'protected' -and ($full.Equals($rule.path,[StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($rule.path+'\',[StringComparison]::OrdinalIgnoreCase) -or
      $rule.path.StartsWith($full+'\',[StringComparison]::OrdinalIgnoreCase))){
      throw "Protected data overlaps cleanup target: $full"
    }
  }
  $null=Get-SafeFiles $full
  return $full
}

function Test-GeneratedName([string]$Name) {
  return ($Name -match '^(bitdepth|server-reports|trial|trial-libaom-av1|trial-libx265|trials-expanded)$' -or
    $Name -match '^(metrics-equivalence|reference-cache|siti-parallel|structure-equivalence|vfr-equivalence)-[A-Za-z0-9]{6}$')
}

function Test-GeneratedFileName([string]$Name) {
  return ($Name -match '^(\u53C2\u8003 \u591A\u97F3\u8F68|av1|candidate|open-gop|http-fixture)\.mp4$' -or
    $Name -match '^hdr-pcm\.mov$' -or $Name -match '^http-depth-(8|10)\.mkv$' -or
    $Name -match '^(color-yuv|yuv)[A-Za-z0-9-]*\.mkv$' -or
    $Name -match '^(chart-ui-report\.json|psnr\.log|ssim\.log|vmaf\.log)$')
}

function Verify-Evidence {
  $local=$rules['evidence-archive'].path
  if(Test-Path -LiteralPath $local){
    & (Join-Path $PSScriptRoot 'verify-test-evidence.ps1')
  }else{Write-Output 'No local test evidence to verify.'}
}

function Verify-Acceptance {
  $root=$rules['test-work\acceptance-20260921'].path
  if(!(Test-Path -LiteralPath $root)){return}
  $sumPath=Join-Path $root 'SHA256SUMS.txt'
  if(!(Test-Path -LiteralPath $sumPath -PathType Leaf)){throw "Acceptance checksums missing: $sumPath"}
  $files=@(Get-SafeFiles $root | Where-Object {$_.FullName -ne $sumPath})
  $lines=@(Get-Content -LiteralPath $sumPath -Encoding UTF8 | Where-Object {$_ -ne ''})
  if($files.Count -ne $lines.Count){throw "Acceptance checksum entry count mismatch: $root"}
  $expected=@{}
  $prefix=$root.TrimEnd('\')+'\'
  foreach($file in $files){$expected[$file.FullName.Substring($prefix.Length).Replace('\','/')]=$file.FullName}
  foreach($line in $lines){
    if($line -notmatch '^([A-Fa-f0-9]{64})  (.+)$'){throw "Malformed acceptance checksum: $line"}
    $hash=$Matches[1];$relative=$Matches[2]
    if(!$expected.ContainsKey($relative)){throw "Unexpected acceptance checksum entry: $relative"}
    if((Get-FileHash -LiteralPath $expected[$relative] -Algorithm SHA256).Hash -ne $hash){throw "Acceptance checksum mismatch: $relative"}
    $expected.Remove($relative)
  }
  if($expected.Count){throw "Unlisted acceptance files: $root"}
  Write-Output "Acceptance checksums verified: $($files.Count) files"
}

function Verify-ProtectedData {
  Verify-Evidence
  Verify-Acceptance
}

function Assert-NoActiveTests {
  $nodePaths=@()
  $pathNode=Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if($pathNode){$nodePaths+=@($pathNode.Source)}
  if($env:MEDIASCOPE_NODE_PATH){$nodePaths+=@($env:MEDIASCOPE_NODE_PATH)}
  $privateRoot=if($env:LOCALAPPDATA){Join-Path $env:LOCALAPPDATA 'MediaScope\runtimes'}else{$null}
  foreach($process in @(Get-Process node -ErrorAction SilentlyContinue)){
    $executable=$process.Path
    if(!$executable){throw "Cannot identify Node process $($process.Id); test cleanup refused"}
    if(@($nodePaths | Where-Object {$executable.Equals($_,[StringComparison]::OrdinalIgnoreCase)}).Count -or
      ($privateRoot -and $executable.StartsWith($privateRoot+'\',[StringComparison]::OrdinalIgnoreCase))){
      throw "A possible test Node process is running ($($process.Id)); test cleanup refused"
    }
  }
  if(@(Get-Process ffmpeg,ffprobe -ErrorAction SilentlyContinue).Count){throw 'FFmpeg or FFprobe is running; test cleanup refused'}
}

function Get-Candidates([string]$Kind) {
  $found=@()
  if($Kind -eq 'Downloads'){
    $target=$rules['.build\downloads'].path
    if(Test-Path -LiteralPath $target){$found+=@{path=$target;why='Explicitly selected runtime download cache'}}
  }elseif($Kind -eq 'TestGenerated'){
    $root=Assert-Contained $rules['test-work'].path
    if(Test-Path -LiteralPath $root){
      foreach($dir in Get-ChildItem -LiteralPath $root -Directory -Force){
        if(Test-GeneratedName $dir.Name){$found+=@{path=$dir.FullName;why='Known generated test directory'}}
      }
      foreach($file in Get-ChildItem -LiteralPath $root -File -Force){
        if(Test-GeneratedFileName $file.Name){$found+=@{path=$file.FullName;why='Known generated test file'}}
      }
    }
  }else{
    $root=Assert-Contained $rules['.build'].path
    if(Test-Path -LiteralPath $root){
      foreach($dir in Get-ChildItem -LiteralPath $root -Directory -Force){
        if($dir.Name -match '^deployment-test-[a-f0-9]{32}$'){
          $logs=@(Get-ChildItem -LiteralPath $rules['evidence-archive'].path -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue)
          $referenced=$false
          foreach($log in $logs){if(Select-String -LiteralPath $log.FullName -Pattern $dir.Name -SimpleMatch -Quiet){$referenced=$true;break}}
          if($referenced){$found+=@{path=$dir.FullName;why='Deployment sandbox referenced by archived test log'}}
        }elseif($dir.Name -match '^MediaScope-\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?-win-x64$'){
          $zip=Join-Path $rules['releases'].path ($dir.Name+'.zip')
          if(Test-Path -LiteralPath $zip -PathType Leaf){$found+=@{path=$dir.FullName;why='Build stage with preserved release ZIP'}}
        }
      }
    }
  }
  return $found
}

function Assert-TestGeneratedArchived($Candidates) {
  $root=$rules['test-work'].path.TrimEnd('\')+'\'
  $snapshots=@(Get-EvidenceRecords $rules['evidence-archive'].path | ForEach-Object {Get-EvidencePayload $_})
  $records=@()
  foreach($snapshot in $snapshots){
    $manifestPath=Join-Path $snapshot.source 'manifest.json'
    if(!(Test-Path -LiteralPath $manifestPath)){continue}
    $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($manifest.kind -ne 'generated-fixture-snapshot' -or $manifest.schema -ne 1){continue}
    $records+=@{name=$snapshot.relative;manifest=$manifest}
  }
  # Old directory and top-level-file snapshots can jointly cover cleanup.
  # Each individual candidate must still match one complete snapshot exactly.
  foreach($candidate in $Candidates){
    $name=[IO.Path]::GetFileName($candidate.path)
    $current=@(Get-SafeFiles $candidate.path | ForEach-Object {@{path=$_.FullName.Substring($root.Length).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
    $matched=$false
    foreach($record in $records){
      $manifest=$record.manifest
      $names=if($manifest.items){@($manifest.items)}else{@($manifest.directories)}
      if($name -notin $names){continue}
      $expected=@{}
      foreach($file in $manifest.files | Where-Object {$_.path -eq $name -or $_.path.StartsWith($name+'/',[StringComparison]::Ordinal)}){
        if($expected.ContainsKey($file.path)){throw 'Duplicate fixture snapshot path'}
        $expected[$file.path]=$file
      }
      if($current.Count -ne $expected.Count){continue}
      $match=$true
      foreach($file in $current){
        if(!$expected.ContainsKey($file.path) -or $expected[$file.path].bytes -ne $file.bytes -or $expected[$file.path].sha256 -ne $file.sha256){$match=$false;break}
      }
      if($match){$matched=$true;Write-Output "Generated candidate $name matched verified snapshot: $($record.name)";break}
    }
    if(!$matched){throw "Generated candidate $name is not covered by an identical verified snapshot. Run scripts/archive-test-generated.ps1 first."}
  }
}

if($Action -eq 'Status'){
  if($Category -or $Apply){throw 'Status does not accept -Category or -Apply'}
  $rows=foreach($name in @($rules.Keys | Sort-Object)){
    $rule=$rules[$name]
    $size=Get-Size $rule.path
    [pscustomobject]@{Path=$name;Class=$rule.class;Files=$size.count;MiB=[math]::Round($size.bytes/1MB,2);Exists=(Test-Path -LiteralPath $rule.path)}
  }
  $rows | Format-Table -AutoSize
  foreach($rootName in @('test-work','.build')){
    $root=$rules[$rootName].path
    if(!(Test-Path -LiteralPath $root)){continue}
    $unknown=@(Get-ChildItem -LiteralPath $root -Force | Where-Object {
      if($rootName -eq 'test-work'){$_.Name -ne 'acceptance-20260921' -and !($_.PSIsContainer -and (Test-GeneratedName $_.Name)) -and !(!$_.PSIsContainer -and (Test-GeneratedFileName $_.Name))}
      else {$_.Name -notin @('downloads','evidence-staging','test-runs','test-run.lock','evidence-recording.lock') -and $_.Name -notmatch '^deployment-test-[a-f0-9]{32}$' -and $_.Name -notmatch '^MediaScope-\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?-win-x64$'}
    })
    Write-Output "$rootName unclassified entries: $($unknown.Count) (preserved)"
    $unknown | Select-Object -First 10 -ExpandProperty Name
  }
  exit 0
}

if($Action -eq 'Verify'){
  if($Category -or $Apply){throw 'Verify does not accept -Category or -Apply'}
  Verify-ProtectedData
  foreach($name in @('evidence-archive','.mediascope','releases','test-work\acceptance-20260921')){
    if(Test-Path -LiteralPath $rules[$name].path){$size=Get-Size $rules[$name].path;Write-Output "Protected path scanned: $name ($($size.count) files)"}
  }
  exit 0
}

if(!$Category){throw 'Clean requires -Category BuildStages, TestGenerated, or Downloads'}
$gate=$null
try {
  if($Apply){
    $build=Assert-Contained $rules['.build'].path
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $lock=Get-EvidenceLockPath $project
    try {$gate=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch {throw 'Evidence recording is active; cleanup refused'}
    if($Category -eq 'TestGenerated'){Assert-NoActiveTests}
    Verify-ProtectedData
  }
  $candidates=@(Get-Candidates $Category)
  if(!$candidates.Count){Write-Output "No eligible $Category directories.";exit 0}
  $checked=@()
  foreach($candidate in $candidates){
    $target=Assert-CleanTarget $candidate.path
    $size=Get-Size $target
    $checked+=@{path=$target;why=$candidate.why;bytes=$size.bytes}
  }
  if($Apply -and $Category -eq 'TestGenerated'){Assert-TestGeneratedArchived $candidates}
  foreach($candidate in $checked){
    $mib=[math]::Round($candidate.bytes/1MB,2)
    if($Apply){
      if(Test-Path -LiteralPath $candidate.path -PathType Container){Remove-Item -LiteralPath $candidate.path -Recurse -Force}
      else{Remove-Item -LiteralPath $candidate.path -Force}
      Write-Output "Removed: $($candidate.path) ($mib MiB)"
    }
    else{Write-Output "Would remove: $($candidate.path) ($mib MiB) - $($candidate.why)"}
  }
}finally{if($gate){$gate.Dispose()}}
