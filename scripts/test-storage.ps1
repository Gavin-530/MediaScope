param([Parameter(Mandatory=$true)][ValidateSet('Validate','Lock','Zip','Commit','Clean')][string]$Action,[string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
. (Join-Path $PSScriptRoot 'evidence-lib.ps1')
$root=Get-EvidenceRoot $project
function Assert-Local([string]$Value) {
  $full=[IO.Path]::GetFullPath($Value)
  if(!$full.StartsWith($project+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Outside workspace: $full"}
  $part=$full
  while($part -ne $project){
    if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Linked path: $part"}
    $part=Split-Path -Parent $part
  }
  return $full
}
switch($Action){
  Validate {$null=Assert-Local $Source;$null=Assert-Local $root}
  Lock {
    $gate=$null
    try {
      $gate=[IO.File]::Open((Join-Path $project '.build/evidence-recording.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      if(Test-Path -LiteralPath (Join-Path $root 'catalog.json')){$null=Test-EvidenceCatalog $root}
      elseif(@(Get-EvidenceRecords $root).Count){throw 'Evidence catalog is missing'}
      Write-Output 'READY'
      $null=[Console]::In.ReadLine()
    } finally {if($gate){$gate.Dispose()}}
  }
  Zip {
    $src=Assert-Local $Source;$dest=Assert-Local $Destination
    $null=Get-EvidenceFiles $src
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($src,$dest,[IO.Compression.CompressionLevel]::Optimal,$false)
  }
  Commit {
    $src=Assert-Local $Source;$dest=Assert-Local $Destination
    if(!$dest.StartsWith($root+'\runs\',[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid archive destination'}
    Write-EvidenceChecksums $src
    $relative=$dest.Substring($root.Length+1).Replace('\','/')
    $null=Test-EvidenceRecord $src $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Move-Item -LiteralPath $src -Destination $dest
    try {Add-EvidenceCatalogRecord $root @{source=$dest;relative=$relative}}
    catch {
      $catalogPath=Join-Path $root 'catalog.json'
      $catalog=if(Test-Path -LiteralPath $catalogPath){Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
      if(!$catalog -or @($catalog.records | Where-Object {$_.path -eq $relative}).Count -eq 0){Move-Item -LiteralPath $dest -Destination $src}
      throw
    }
    $count=Test-EvidenceCatalog $root
    Write-Output "Verified $count evidence records"
  }
  Clean {
    $src=Assert-Local $Source
    $allowed=Join-Path $project '.build/test-runs'
    if((Split-Path -Parent $src) -ne $allowed -or (Split-Path -Leaf $src) -notmatch '^\d{8}T\d{9}Z-[a-f0-9]{8}$'){throw 'Invalid test sandbox'}
    foreach($item in Get-ChildItem -LiteralPath $src -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked sandbox entry'}}
    Remove-Item -LiteralPath $src -Recurse -Force
  }
}
