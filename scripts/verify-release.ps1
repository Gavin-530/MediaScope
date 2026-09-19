param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
$resolved=(Resolve-Path -LiteralPath $Archive).Path
$zip=[System.IO.Compression.ZipFile]::OpenRead($resolved)
try{
  $entries=@{}
  foreach($entry in $zip.Entries){$key=$entry.FullName.Replace('\','/');if($entries.ContainsKey($key)){throw "Duplicate ZIP entry: $key"};$entries[$key]=$entry}
  $manifestKey=@($entries.Keys | Where-Object {$_ -like '*/MANIFEST.json'})
  if($manifestKey.Count -ne 1){throw 'Expected exactly one manifest'}
  $reader=[System.IO.StreamReader]::new($entries[$manifestKey[0]].Open())
  try{$manifest=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
  $prefix=$manifestKey[0].Substring(0,$manifestKey[0].LastIndexOf('/')+1)
  foreach($file in $manifest){
    $key=$prefix+$file.path.Replace('\','/')
    if(-not $entries.ContainsKey($key)){throw "Missing file: $key"}
    $entry=$entries[$key];if($entry.Length -ne $file.bytes){throw "Size mismatch: $key"}
    $stream=$entry.Open();try{$hash=[System.Security.Cryptography.SHA256]::HashData($stream);$actual=[System.Convert]::ToHexString($hash)}finally{$stream.Dispose()}
    if($actual -ne $file.sha256){throw "Checksum mismatch: $key"}
  }
  if($entries.Keys | Where-Object {$_ -match '/(test-work|\.mediascope)/'}){throw 'Private or generated data included in release'}
  Write-Output "Verified $($manifest.Count) files in $resolved"
  Get-FileHash -LiteralPath $resolved -Algorithm SHA256 | Format-List
}finally{$zip.Dispose()}
