param([switch]$IncludeBuild,[switch]$BuildOnly,[switch]$Preview,[switch]$Apply)
$ErrorActionPreference='Stop'
if($BuildOnly -and !$IncludeBuild){throw '-BuildOnly requires -IncludeBuild'}
if($Preview -and $Apply){throw '-Preview and -Apply cannot be combined'}
$manager=Join-Path $PSScriptRoot 'local-data.ps1'
$categories=if($BuildOnly){@('BuildStages')}elseif($IncludeBuild){@('TestGenerated','BuildStages')}else{@('TestGenerated')}
foreach($category in $categories){
  & $manager -Action Clean -Category $category -Apply:$Apply
}
