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
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $temp -Encoding UTF8
  if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temp,$Path,[NullString]::Value)}else{[IO.File]::Move($temp,$Path)}
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
function Assert-NoLinks($Root) {
  $item=Get-Item -LiteralPath $Root -Force
  while($item){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked installation paths are unsupported: $($item.FullName)"}
    $item=$item.Parent
  }
  foreach($item in Get-ChildItem -LiteralPath $Root -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Linked installation entry: $($item.FullName)"}}
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
      if($total -gt 3GB){throw 'Archive exceeds 3 GiB extraction limit'}
      if(($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000){throw 'Archive links are forbidden'}
    }
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip,$Destination)
  } finally {$zip.Dispose()}
}
function Test-App($App) {
  Assert-NoLinks $App
  $manifest=Read-Json (Join-Path $App 'MANIFEST.json')
  if($manifest.schema -ne 1 -or $manifest.platform -ne 'win32-x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(-(alpha|beta|rc)(\.\d+)?)?$'){throw 'Unsupported application manifest'}
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
function Get-PrivateRuntime($App,$InstallRoot) {
  $lock=Read-Json (Join-Path $App 'runtime-lock.json');$paths=@{}
  foreach($component in $lock.components){
    if($component.name -notin @('node','ffmpeg') -or $component.sha256 -notmatch '^[a-f0-9]{64}$' -or $component.url -notmatch '^https://'){throw 'Invalid runtime lock'}
    $target=Join-Path $InstallRoot "runtimes/$($component.sha256)"
    $receipt=Join-Path $InstallRoot "runtimes/$($component.sha256).json"
    if(Test-Path -LiteralPath $target){
      $record=Read-Json $receipt
      foreach($f in $record){$p=Safe-Path $target $f.path;Assert-Hash $p $f.sha256}
      if(@(Get-ChildItem -LiteralPath $target -Recurse -File).Count -ne @($record).Count){throw "Private runtime changed: $target"}
      Write-Host "Reusing verified $($component.name)"
    } else {
      $download=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N')).zip"
      Write-Host "Downloading $($component.name) (first installation requires internet)..."
      [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
      try{Invoke-WebRequest -UseBasicParsing -Uri $component.url -OutFile $download -TimeoutSec 300;Assert-Hash $download $component.sha256}catch{throw "Download failed; current installation is unchanged. $($_.Exception.Message)"}
      $expanded=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N'))"
      Expand-SafeZip $download $expanded
      $record=Get-TreeRecords $expanded
      [IO.Directory]::Move($expanded,$target)
      Write-Json $receipt $record
      Remove-Item -LiteralPath $download
    }
    foreach($p in $component.executables.PSObject.Properties){$paths[$p.Name]=Safe-Path $target $p.Value}
  }
  return $paths
}
function Resolve-Program($Value,$Name) {
  if(!$Value){$Value=(Get-Command "$Name.exe" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source}
  $p=(Resolve-Path -LiteralPath $Value).Path
  if([IO.Path]::GetExtension($p) -ne '.exe'){throw "Expected executable: $p"}
  return $p
}
function Test-Environment($App,$Paths,$InstallRoot) {
  $result=Join-Path $InstallRoot "staging/$([guid]::NewGuid().ToString('N')).json"
  foreach($name in @('node','ffmpeg','ffprobe')){
    $p=$Paths[$name];if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "Missing executable: $name ($p)"}
    # Reject ARM64/x86 binaries before executing them, including on ARM64 Windows.
    $stream=[IO.File]::OpenRead($p);$reader=New-Object IO.BinaryReader($stream)
    try{$stream.Position=0x3c;$offset=$reader.ReadInt32();$stream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664){throw 'Invalid PE architecture'}}catch{throw "Invalid Windows x64 executable: $p. No automatic fallback; select Recommended.cmd to switch environments."}finally{$reader.Dispose()}
  }
  & $Paths.node (Join-Path $App 'scripts/check-environment.mjs') $App $Paths.ffmpeg $Paths.ffprobe $result
  if($LASTEXITCODE -ne 0){throw 'Environment validation failed. No automatic fallback. Use Recommended.cmd to select the private environment.'}
  $check=Read-Json $result
  $programs=@{}
  foreach($name in @('node','ffmpeg','ffprobe')){
    $p=$Paths[$name]
    $programs[$name]=@{path=$p;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash;version=$check.versions.$name}
  }
  # Include adjacent dynamic libraries in the audit (external shared builds).
  $libraries=@($Paths.Values | ForEach-Object {Get-ChildItem -LiteralPath (Split-Path $_) -Filter '*.dll' -File} | Sort-Object FullName -Unique | ForEach-Object {@{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
  Remove-Item -LiteralPath $result
  return @{programs=$programs;libraries=$libraries;checkedAt=$check.checkedAt;compatibility=$check.compatibility}
}
function Get-SelectedPaths($Selection,$App,$InstallRoot) {
  if(!$Selection -or $Selection.mode -eq 'private'){return Get-PrivateRuntime $App $InstallRoot}
  if($Selection.mode -ne 'external'){throw 'Unknown environment selection'}
  $paths=@{};foreach($name in @('node','ffmpeg','ffprobe')){$paths[$name]=$Selection.validation.programs.$name.path}
  Write-Host 'Revalidating explicitly selected external environment; failures will not switch environments.'
  return $paths
}
