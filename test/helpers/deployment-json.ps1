param([Parameter(Mandatory=$true)][string]$DeploymentScript)
. $DeploymentScript
$ownedRoot=Join-Path ([IO.Path]::GetTempPath()) ('MediaScope-json-'+[guid]::NewGuid().ToString('N'))
$resolvedOwned=[IO.Path]::GetFullPath($ownedRoot)
$allowedTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(!$resolvedOwned.StartsWith($allowedTemp,[StringComparison]::OrdinalIgnoreCase)){throw 'Temporary test directory outside expected root'}
New-Item -ItemType Directory -Path $resolvedOwned | Out-Null
$reader=$null
try {
  $target=Join-Path $resolvedOwned 'state.json'
  $ready=Join-Path $resolvedOwned 'ready'
  $locker=Join-Path $resolvedOwned 'reader.ps1'
  @'
param($Target,$Ready,[int]$Milliseconds)
$handle=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{[IO.File]::WriteAllText($Ready,'ready');Start-Sleep -Milliseconds $Milliseconds}finally{$handle.Dispose()}
'@ | Set-Content -LiteralPath $locker -Encoding UTF8
  function Start-Reader([int]$Milliseconds) {
    if(Test-Path -LiteralPath $ready){Remove-Item -LiteralPath $ready}
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$locker+'"'),'-Target',('"'+$target+'"'),'-Ready',('"'+$ready+'"'),'-Milliseconds',"$Milliseconds")
    $process=Start-Process -FilePath powershell.exe -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $deadline=(Get-Date).AddSeconds(5)
    while(!(Test-Path -LiteralPath $ready)){
      if($process.HasExited -or (Get-Date) -gt $deadline){throw 'Reader failed to acquire the actual file handle'}
      Start-Sleep -Milliseconds 10
    }
    return $process
  }
  Write-Json $target @{value='before'}
  $reader=Start-Reader 350
  Write-Json $target @{value='after';values=@(1,2,3)}
  $reader.WaitForExit();$reader.Dispose();$reader=$null
  $updated=Read-Json $target
  if($updated.value -ne 'after' -or ($updated.values -join ',') -ne '1,2,3'){throw 'Complete JSON update was not retained'}
  $before=(Get-FileHash -LiteralPath $target).Hash
  $reader=Start-Reader 2200
  $rejected=$false
  try{Write-Json $target @{value='must not replace locked state'}}catch{$rejected=$true}
  if(!$rejected -or (Get-FileHash -LiteralPath $target).Hash -ne $before){throw 'Persistent lock must reject the write and preserve exact previous bytes'}
  $reader.WaitForExit();$reader.Dispose();$reader=$null
  if(@(Get-ChildItem -LiteralPath $resolvedOwned -Filter '*.tmp').Count){throw 'Temporary JSON files were not released'}
  @{temporaryReader='passed';persistentReader='passed';noTemporaryFiles=$true} | ConvertTo-Json -Compress
} finally {
  if($reader){$reader.WaitForExit();$reader.Dispose()}
  if([IO.Path]::GetFullPath($resolvedOwned).StartsWith($allowedTemp,[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $resolvedOwned -Recurse -Force
  }
}
