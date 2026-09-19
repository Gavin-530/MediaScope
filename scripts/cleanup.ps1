param([switch]$IncludeBuild)
$ErrorActionPreference='Stop'
$project=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot=Join-Path $project 'test-work'
function Remove-VerifiedDirectory([string]$Target){
  if(-not(Test-Path -LiteralPath $Target)){return}
  $resolved=(Resolve-Path -LiteralPath $Target).Path
  if(-not $resolved.StartsWith($project+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)){throw "Outside workspace: $resolved"}
  if((Get-Item -LiteralPath $resolved).Attributes -band [System.IO.FileAttributes]::ReparsePoint){throw "Refusing linked directory: $resolved"}
  Write-Output "Removing verified generated directory: $resolved"
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
$reportRoot=Join-Path $project '.mediascope'
if(Test-Path -LiteralPath $reportRoot){
  foreach($dir in Get-ChildItem -LiteralPath $reportRoot -Directory){
    if(-not(Get-ChildItem -LiteralPath $dir.FullName -Force)){Remove-VerifiedDirectory $dir.FullName;continue}
    $report=Join-Path $dir.FullName 'report.json'
    if(-not(Test-Path -LiteralPath $report)){$report=Join-Path $dir.FullName 'job-input.json'}
    if(-not(Test-Path -LiteralPath $report)){continue}
    try{$data=Get-Content -Raw -LiteralPath $report | ConvertFrom-Json}catch{continue}
    $inputs=@($data.file,$data.reference.file,$data.candidate.file,$data.source.file) | Where-Object {$_}
    if($data.reference -is [string]){$inputs+=@($data.reference)}
    if($data.candidate -is [string]){$inputs+=@($data.candidate)}
    if($inputs.Count -eq 0){continue}
    $onlyGenerated=$true
    foreach($file in $inputs){if(-not ([System.IO.Path]::GetFullPath($file)).StartsWith($testRoot+[System.IO.Path]::DirectorySeparatorChar,[System.StringComparison]::OrdinalIgnoreCase)){$onlyGenerated=$false}}
    if($onlyGenerated){Remove-VerifiedDirectory $dir.FullName}else{Write-Output "Preserving user report: $($dir.Name)"}
  }
}
Remove-VerifiedDirectory $testRoot
if($IncludeBuild){
  $buildRoot=Join-Path $project '.build'
  if(Test-Path -LiteralPath $buildRoot){
    foreach($stage in Get-ChildItem -LiteralPath $buildRoot -Directory){
      $zip=Join-Path $project "releases/$($stage.Name).zip"
      if(-not(Test-Path -LiteralPath $zip)){throw "No preserved release for stage: $($stage.FullName)"}
      Remove-VerifiedDirectory $stage.FullName
    }
    if(-not(Get-ChildItem -LiteralPath $buildRoot -Force)){Remove-Item -LiteralPath $buildRoot}
  }
}
