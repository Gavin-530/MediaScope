# Compatible with Windows PowerShell 5.1; no preinstalled Node.js is needed.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
# PowerShell 7 can pass its module path through cmd.exe to Windows PowerShell 5.1.
# Prefer the current host's built-in modules so commands such as Get-FileHash resolve.
$env:PSModulePath="$PSHOME\Modules;$env:PSModulePath"
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Json($Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json($Path,$Value) {
  $temp="$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temp -Encoding UTF8
    for($attempt=0;;$attempt++){
      try {
        if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temp,$Path,[NullString]::Value)}else{[IO.File]::Move($temp,$Path)}
        return
      } catch {
        $failure=$_.Exception
        while($failure.InnerException){$failure=$failure.InnerException}
        $code=$failure.HResult -band 0xffff
        # Keep atomic replacement; only transient sharing/delete errors may retry.
        if($failure -isnot [IO.IOException] -or $code -notin @(32,33,1175) -or $attempt -ge 7){
          throw "JSON update failed: $Path (Windows error $code). $($failure.Message)"
        }
        Start-Sleep -Milliseconds 125
      }
    }
  } finally {if(Test-Path -LiteralPath $temp){Remove-Item -LiteralPath $temp -Force}}
}
function Safe-Path($Root,[string]$Relative) {
  if(!$Relative -or $Relative -match '(^[/\\]|:|(^|[/\\])\.\.?([/\\]|$)|[<>"|?*]|[. ]([/\\]|$))'){throw "Unsafe path: $Relative"}
  $full=[IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if(!$full.StartsWith([IO.Path]::GetFullPath($Root).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Path escapes root: $Relative"}
  return $full
}
function Assert-Hash($Path,$Hash) {
  if($Hash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Hash){throw "SHA-256 mismatch: $Path"}
}
function Assert-NoLinks($Root,[switch]$Shallow) {
  $item=Get-Item -LiteralPath $Root -Force
  while($item){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked installation paths are unsupported: $($item.FullName)"}
    $item=if($item.PSIsContainer){$item.Parent}else{$item.Directory}
  }
  if(!$Shallow){foreach($item in Get-ChildItem -LiteralPath $Root -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked installation entry: $($item.FullName)"}}}
}
function Expand-SafeZip($Archive,$Destination) {
  $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $seen=@{};[long]$total=0
    foreach($entry in $zip.Entries){
      $name=$entry.FullName.Replace('\','/').TrimEnd('/')
      $null=Safe-Path $Destination $name
      if($seen.ContainsKey($name)){throw "Duplicate archive entry: $name"};$seen[$name]=$true
      $total+=$entry.Length
      if($total -gt 3GB){throw 'Archive exceeds 3.221225472 GB (3221225472 B) extraction limit'}
      if(($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000){throw 'Archive links are forbidden'}
    }
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip,$Destination)
  } finally {$zip.Dispose()}
}
function Test-App($App) {
  Assert-NoLinks $App
  $manifest=Read-Json (Join-Path $App 'MANIFEST.json')
  if($manifest.schema -ne 1 -or $manifest.platform -ne 'win32-x64' -or $manifest.version -notmatch '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(-(alpha|beta|rc)(\.(?:0|[1-9][0-9]*))?)?$'){throw 'Unsupported application manifest'}
  $seen=@{}
  foreach($file in $manifest.files){
    $p=Safe-Path $App $file.path
    if($seen.ContainsKey($file.path) -or $file.path -eq 'MANIFEST.json'){throw "Duplicate/reserved manifest path: $($file.path)"};$seen[$file.path]=$true
    if((Get-Item -LiteralPath $p).Length -ne $file.bytes){throw "File size mismatch: $p"};Assert-Hash $p $file.sha256
  }
  $all=@(Get-ChildItem -LiteralPath $App -File -Recurse -Force)
  if($all.Count -ne $seen.Count+1){throw 'Unlisted application files'}
  foreach($required in @('server.mjs','package.json','runtime-lock.json','scripts/check-environment.mjs','scripts/manage.ps1','scripts/deployment.ps1','start.cmd')){if(!$seen.ContainsKey($required)){throw "Missing required file: $required"}}
  if((Read-Json (Join-Path $App 'package.json')).version -ne $manifest.version){throw 'Package version mismatch'}
  $lock=Read-Json (Join-Path $App 'runtime-lock.json')
  if($lock.schema -ne 1 -or $lock.platform -ne 'win32-x64' -or $lock.compatibility -ne 'media-v1'){throw 'Unsupported runtime compatibility policy'}
  return $manifest
}
function Get-TreeRecords($Root) {
  @(Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
    @{path=$_.FullName.Substring($Root.TrimEnd('\').Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
  })
}
function Get-PrivateRuntime($App,$RuntimeRoot) {
  foreach($dir in @('runtimes','staging')){New-Item -ItemType Directory -Force (Join-Path $RuntimeRoot $dir) | Out-Null}
  $runtimeGate=[IO.File]::Open((Join-Path $RuntimeRoot 'runtime.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
  $lock=Read-Json (Join-Path $App 'runtime-lock.json');$paths=@{}
  foreach($component in $lock.components){
    if($component.name -notin @('node','ffmpeg') -or $component.sha256 -notmatch '^[a-f0-9]{64}$' -or $component.url -notmatch '^https://'){throw 'Invalid runtime lock'}
    $target=Join-Path $RuntimeRoot "runtimes/$($component.sha256)"
    $receipt=Join-Path $RuntimeRoot "runtimes/$($component.sha256).json"
    if(Test-Path -LiteralPath $target){
      $record=Read-Json $receipt
      foreach($f in $record){$p=Safe-Path $target $f.path;Assert-Hash $p $f.sha256}
      if(@(Get-ChildItem -LiteralPath $target -Recurse -File).Count -ne @($record).Count){throw "Private runtime changed: $target"}
      Write-Host "Reusing verified $($component.name)"
    } else {
      $download=Join-Path $RuntimeRoot "staging/$([guid]::NewGuid().ToString('N')).zip"
      Write-Host "Downloading $($component.name) (first installation requires internet)..."
      [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
      try{Invoke-WebRequest -UseBasicParsing -Uri $component.url -OutFile $download -TimeoutSec 300;Assert-Hash $download $component.sha256}catch{throw "Download failed; current installation is unchanged. $($_.Exception.Message)"}
      $expanded=Join-Path $RuntimeRoot "staging/$([guid]::NewGuid().ToString('N'))"
      Expand-SafeZip $download $expanded
      $record=Get-TreeRecords $expanded
      [IO.Directory]::Move($expanded,$target)
      Write-Json $receipt $record
      Remove-Item -LiteralPath $download
    }
    foreach($p in $component.executables.PSObject.Properties){$paths[$p.Name]=Safe-Path $target $p.Value}
  }
  return $paths
  } finally {$runtimeGate.Dispose()}
}
function Resolve-Program($Value,$Name) {
  if(!$Value){$Value=(Get-Command "$Name.exe" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source}
  $p=(Resolve-Path -LiteralPath $Value).Path
  if([IO.Path]::GetExtension($p) -ne '.exe'){throw "Expected executable: $p"}
  return $p
}
function Test-Environment($App,$Paths,$InstallRoot) {
  $before=Get-LaunchSnapshot $App $Paths
  $result=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N')).json"
  foreach($name in @('node','ffmpeg','ffprobe')){
    $p=$Paths[$name];if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "Missing executable: $name ($p)"}
    # Reject ARM64/x86 binaries before executing them, including on ARM64 Windows.
    $stream=[IO.File]::OpenRead($p);$reader=New-Object IO.BinaryReader($stream)
    try{$stream.Position=0x3c;$offset=$reader.ReadInt32();$stream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Invalid PE architecture'}}catch{throw "Invalid Windows x64 executable: $p. Select the recommended private environment when prompted."}finally{$reader.Dispose()}
  }
  & $Paths.node (Join-Path $App 'scripts/check-environment.mjs') $App $Paths.ffmpeg $Paths.ffprobe $result
  if($LASTEXITCODE -ne 0){throw 'Environment validation failed. Select the recommended private environment when prompted.'}
  $check=Read-Json $result
  $programs=@{}
  foreach($name in @('node','ffmpeg','ffprobe')){
    $p=$Paths[$name]
    $programs[$name]=@{path=$p;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash;version=$check.versions.$name}
  }
  # Include adjacent dynamic libraries in the audit (external shared builds).
  $libraries=@($Paths.Values | ForEach-Object {Get-ChildItem -LiteralPath (Split-Path $_) -Filter '*.dll' -File} | Sort-Object FullName -Unique | ForEach-Object {@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
  Remove-Item -LiteralPath $result
  if(!(Compare-LaunchSnapshot $before (Get-LaunchSnapshot $App $Paths))){throw 'Runtime changed during validation; restart MediaScope'}
  return @{programs=$programs;libraries=$libraries;checkedAt=$check.checkedAt;compatibility=$check.compatibility;launchSnapshot=$before}
}
function Get-SelectedPaths($Selection,$App,$InstallRoot) {
  if(!$Selection -or $Selection.mode -eq 'private'){return Get-PrivateRuntime $App $InstallRoot}
  if($Selection.mode -ne 'external'){throw 'Unknown environment selection'}
  $paths=@{};foreach($name in @('node','ffmpeg','ffprobe')){$paths[$name]=$Selection.validation.programs.$name.path}
  Write-Host 'Revalidating explicitly selected external environment; failures will not switch environments.'
  return $paths
}

# Launch receipts are scoped to one application directory. Normal launches read
# the saved selection only; change detection is explicitly requested by a check.
function Get-LaunchCachePath($App,$InstallRoot) {
  $digest=[Security.Cryptography.SHA256]::Create()
  try{$key=([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($App).ToLowerInvariant())))).Replace('-','').ToLowerInvariant()}finally{$digest.Dispose()}
  return Join-Path $InstallRoot "launch-cache/$key.json"
}
function Get-LaunchSnapshot($App,$Paths) {
  $policy=@{}
  foreach($name in @('runtime-lock.json','scripts/check-environment.mjs','scripts/deployment.ps1','scripts/validate-launch.ps1')){
    $policy[$name]=(Get-FileHash -LiteralPath (Join-Path $App $name) -Algorithm SHA256).Hash
  }
  $files=@{}
  $all=@($Paths.Values)+@($Paths.Values | ForEach-Object {Get-ChildItem -LiteralPath (Split-Path $_) -Filter '*.dll' -File | ForEach-Object FullName})
  foreach($file in ($all | Sort-Object -Unique)){
    Assert-NoLinks $file -Shallow
    $item=Get-Item -LiteralPath $file
    if($item.PSIsContainer){throw "Expected runtime file: $file"}
    $files[$item.FullName]=@{bytes=$item.Length;modified=$item.LastWriteTimeUtc.Ticks.ToString();created=$item.CreationTimeUtc.Ticks.ToString()}
  }
  return @{policy=$policy;files=$files}
}
function Compare-LaunchSnapshot($Before,$After) {
  foreach($group in @('policy','files')){
    $left=$Before.$group;$right=$After.$group
    $leftKeys=if($left -is [Collections.IDictionary]){@($left.Keys)}else{@($left.PSObject.Properties.Name)}
    $rightKeys=if($right -is [Collections.IDictionary]){@($right.Keys)}else{@($right.PSObject.Properties.Name)}
    if($leftKeys.Count -ne $rightKeys.Count){return $false}
    foreach($key in $leftKeys){
      if($key -notin $rightKeys){return $false}
      if($group -eq 'policy'){if($left.$key -ne $right.$key){return $false}}
      else {foreach($field in @('bytes','modified','created')){if($left.$key.$field -ne $right.$key.$field){return $false}}}
    }
  }
  return $true
}
function Save-LaunchCache($App,$Paths,$Mode,$Validation,$InstallRoot) {
  $snapshot=Get-LaunchSnapshot $App $Paths
  if($Validation.launchSnapshot -and !(Compare-LaunchSnapshot $Validation.launchSnapshot $snapshot)){throw 'Runtime changed after validation; restart MediaScope'}
  $cachePath=Get-LaunchCachePath $App $InstallRoot
  New-Item -ItemType Directory -Force (Split-Path $cachePath) | Out-Null
  Write-Json $cachePath @{schema=1;app=[IO.Path]::GetFullPath($App);mode=$Mode;validation=$Validation;snapshot=$snapshot}
  if(Test-Path -LiteralPath ($cachePath+'.failed')){Remove-Item -LiteralPath ($cachePath+'.failed')}
}
function Read-LaunchCache($App,$InstallRoot,$Selection=$null,[switch]$CheckChanges) {
  try {
    $cachePath=Get-LaunchCachePath $App $InstallRoot
    if($CheckChanges -and (Test-Path -LiteralPath ($cachePath+'.failed'))){return $null}
    $cached=Read-Json $cachePath
    if($cached.schema -ne 1 -or $cached.app -ne [IO.Path]::GetFullPath($App) -or $cached.mode -notin @('private','external')){return $null}
    if(!$cached.validation.checkedAt){return $null}
    $paths=@{};foreach($name in @('node','ffmpeg','ffprobe')){
      $paths[$name]=$cached.validation.programs.$name.path
      if($cached.validation.programs.$name.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or !$cached.validation.programs.$name.version){return $null}
      if($Selection -and ($cached.mode -ne $Selection.mode -or $paths[$name] -ne $Selection.validation.programs.$name.path)){return $null}
    }
    if(!$CheckChanges){return @{paths=$paths;mode=$cached.mode;validation=$cached.validation;needsValidation=$false}}
    if($cached.validation.compatibility -ne (Read-Json (Join-Path $App 'runtime-lock.json')).compatibility){return $null}
    $snapshot=Get-LaunchSnapshot $App $paths
    # A changed Node or compatibility policy must be validated before it can host
    # a page. Changed media tools can be checked behind the already-running UI.
    foreach($name in $snapshot.policy.Keys){if($snapshot.policy[$name] -ne $cached.snapshot.policy.$name){return $null}}
    $node=$paths.node
    foreach($field in @('bytes','modified','created')){if($snapshot.files[$node].$field -ne $cached.snapshot.files.$node.$field){return $null}}
    $nodeDir=Split-Path $node
    $priorDlls=@($cached.snapshot.files.PSObject.Properties.Name | Where-Object {(Split-Path $_) -eq $nodeDir -and [IO.Path]::GetExtension($_) -eq '.dll'})
    $currentDlls=@($snapshot.files.Keys | Where-Object {(Split-Path $_) -eq $nodeDir -and [IO.Path]::GetExtension($_) -eq '.dll'})
    if($priorDlls.Count -ne $currentDlls.Count){return $null}
    foreach($dll in $priorDlls){
      if($dll -notin $currentDlls){return $null}
      foreach($field in @('bytes','modified','created')){if($snapshot.files[$dll].$field -ne $cached.snapshot.files.$dll.$field){return $null}}
    }
    return @{paths=$paths;mode=$cached.mode;validation=$cached.validation;needsValidation=!(Compare-LaunchSnapshot $cached.snapshot $snapshot)}
  } catch {return $null}
}
function Start-MediaScope($App,$Paths,$Mode,$Validation,$InstallRoot,$RuntimeRoot,[bool]$NeedsValidation=$false,[bool]$Desktop=$true,[string]$StatePath) {
  $request=Join-Path $InstallRoot "staging/launch-$([guid]::NewGuid().ToString('N')).json"
  Write-Json $request @{app=$App;paths=$Paths;mode=$Mode;validation=$Validation;installRoot=$InstallRoot;runtimeRoot=$RuntimeRoot;statePath=$StatePath;needsValidation=$NeedsValidation;desktop=$Desktop}
  try {
    & $Paths.node (Join-Path $App 'scripts/desktop.mjs') $request
    if($LASTEXITCODE -ne 0){throw "Application exited with code $LASTEXITCODE"}
  } finally {if(Test-Path -LiteralPath $request){Remove-Item -LiteralPath $request}}
}
