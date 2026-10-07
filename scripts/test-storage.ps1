param([Parameter(Mandatory=$true)][ValidateSet('Validate','Lock','Allocate','Zip','Commit','Clean')][string]$Action,[string]$Source,[string]$Destination)
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
  Allocate {New-EvidenceRunId $project}
  Validate {$null=Assert-Local $Source;$null=Assert-Local $root}
  Lock {
    $gate=$null
    try {
      $gate=[IO.File]::Open((Get-EvidenceLockPath $project),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $null=Initialize-EvidenceArchive $project

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
    $published=Publish-EvidenceRecord $project $src $relative

    Write-Output $published
  }
  Clean {
    $src=Assert-Local $Source
    $allowed=Join-Path (Get-EvidencePendingRoot $project) 'test-runs'
    if((Split-Path -Parent $src) -ne $allowed -or (Split-Path -Leaf $src) -notmatch '^\d{8}T\d{6}(?:\d{3}|\.[0-9]+)?Z-(?:[a-f0-9]{4}|[a-f0-9]{8})$'){throw 'Invalid test sandbox'}
    foreach($item in Get-ChildItem -LiteralPath $src -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked sandbox entry'}}
    Remove-Item -LiteralPath $src -Recurse -Force
  }
}
