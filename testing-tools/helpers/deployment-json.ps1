param([Parameter(Mandatory=$true)][string]$DeploymentScript)
. $DeploymentScript
$ownedRoot=Join-Path ([IO.Path]::GetTempPath()) ('MediaScope-json-'+[guid]::NewGuid().ToString('N'))
$resolvedOwned=[IO.Path]::GetFullPath($ownedRoot)
$allowedTemp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(!$resolvedOwned.StartsWith($allowedTemp,[StringComparison]::OrdinalIgnoreCase)){throw 'Temporary test directory outside expected root'}
New-Item -ItemType Directory -Path $resolvedOwned | Out-Null
try {
  $target=Join-Path $resolvedOwned 'state.json'
  $retry=Join-Path $resolvedOwned 'retry'
  $resume=Join-Path $resolvedOwned 'resume'
  $outcome=Join-Path $resolvedOwned 'outcome.json'
  $writerScript=Join-Path $resolvedOwned 'writer.ps1'
  @'
param($Target,$Retry,$Resume,$Outcome,$Value,$DeploymentScript)
. $DeploymentScript
$script:retryCount=0
# Observe the real writer's retry boundary. The reader controls release; module
# loading and scheduling cannot turn a short test lock into a persistent one.
function Start-Sleep([int]$Milliseconds) {
  $script:retryCount++
  [IO.File]::WriteAllText($Retry,'retry')
  $wait=[Diagnostics.Stopwatch]::StartNew()
  while(![IO.File]::Exists($Resume)){
    if($wait.ElapsedMilliseconds -gt 10000){throw 'Reader did not acknowledge the retry'}
    [Threading.Thread]::Sleep(10)
  }
  Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds $Milliseconds
}
$result=@{rejected=$false;message='';retries=0}
try{Write-Json $Target @{value=$Value;values=@(1,2,3)}}catch{$result.rejected=$true;$result.message=$_.Exception.Message}
$result.retries=$script:retryCount
[IO.File]::WriteAllText($Outcome,($result|ConvertTo-Json -Compress))
'@ | Set-Content -LiteralPath $writerScript -Encoding UTF8
  function Invoke-LockedWrite([string]$Value,[bool]$Persistent) {
    foreach($signal in @($retry,$resume,$outcome)){if(Test-Path -LiteralPath $signal){Remove-Item -LiteralPath $signal}}
    $handle=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $writer=$null
    try {
      $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$writerScript+'"'),'-Target',('"'+$target+'"'),'-Retry',('"'+$retry+'"'),'-Resume',('"'+$resume+'"'),'-Outcome',('"'+$outcome+'"'),'-Value',$Value,'-DeploymentScript',('"'+$DeploymentScript+'"'))
      $writer=Start-Process -FilePath powershell.exe -ArgumentList $arguments -PassThru -WindowStyle Hidden
      $wait=[Diagnostics.Stopwatch]::StartNew()
      while(![IO.File]::Exists($retry)){
        if($writer.HasExited -or $wait.ElapsedMilliseconds -gt 10000){throw 'Writer did not retry under the actual file lock'}
        [Threading.Thread]::Sleep(10)
      }
      if(!$Persistent){$handle.Dispose();$handle=$null}
      [IO.File]::WriteAllText($resume,'resume')
      if(!$writer.WaitForExit(10000) -or $writer.ExitCode -ne 0){throw 'Writer did not complete after the retry acknowledgement'}
      return Read-Json $outcome
    } finally {
      if($handle){$handle.Dispose()}
      if($writer){if(!$writer.HasExited){$writer.Kill();$writer.WaitForExit()};$writer.Dispose()}
    }
  }
  Write-Json $target @{value='before'}
  $temporary=Invoke-LockedWrite 'after' $false
  if($temporary.rejected -or $temporary.retries -lt 1){throw 'Temporary lock must retry and complete the write'}
  $updated=Read-Json $target
  if($updated.value -ne 'after' -or ($updated.values -join ',') -ne '1,2,3'){throw 'Complete JSON update was not retained'}
  $before=(Get-FileHash -LiteralPath $target).Hash
  $persistent=Invoke-LockedWrite 'blocked' $true
  if(!$persistent.rejected -or $persistent.message -notmatch '\(Windows error 32\)' -or $persistent.retries -ne 7 -or (Get-FileHash -LiteralPath $target).Hash -ne $before){throw 'Persistent lock must exhaust sharing-error retries and preserve exact previous bytes'}
  if(@(Get-ChildItem -LiteralPath $resolvedOwned -Filter '*.tmp').Count){throw 'Temporary JSON files were not released'}
  @{temporaryReader='passed';persistentReader='passed';noTemporaryFiles=$true;temporaryRetries=$temporary.retries;persistentRetries=$persistent.retries} | ConvertTo-Json -Compress
} finally {
  if([IO.Path]::GetFullPath($resolvedOwned).StartsWith($allowedTemp,[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $resolvedOwned -Recurse -Force
  }
}
