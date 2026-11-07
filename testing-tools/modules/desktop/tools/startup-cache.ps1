param([string]$App,[string]$HomeDir,[string]$NodePath,[string]$FFmpegPath,[string]$FFprobePath)
$ErrorActionPreference='Stop'
. (Join-Path $App 'scripts/deployment.ps1')
New-Item -ItemType Directory -Force $HomeDir,(Join-Path $HomeDir 'staging'),(Join-Path $HomeDir 'tools') | Out-Null
$probeCopy=Join-Path $HomeDir 'tools/ffprobe.exe'
Copy-Item -LiteralPath $FFprobePath -Destination $probeCopy
$paths=@{node=$NodePath;ffmpeg=$FFmpegPath;ffprobe=$probeCopy}
$validation=Test-Environment $App $paths $HomeDir
Save-LaunchCache $App $paths 'external' $validation $HomeDir
$timer=[Diagnostics.Stopwatch]::StartNew()
$unchanged=Read-LaunchCache $App $HomeDir
$timer.Stop()
if(!$unchanged -or $unchanged.needsValidation){throw 'Unchanged environment did not reuse the receipt'}
$item=Get-Item -LiteralPath $probeCopy
$modified=$item.LastWriteTimeUtc.AddSeconds(1)
$deadline=[DateTime]::UtcNow.AddSeconds(10)
# Wait only for Windows to release the copied executable during fixture setup.
# Product assertions and validation failures are never retried.
while($true){
  try{[IO.File]::SetLastWriteTimeUtc($probeCopy,$modified);break}
  catch{
    $failure=$_.Exception
    while($failure.InnerException){$failure=$failure.InnerException}
    if(($failure.HResult -band 0xFFFF) -notin @(32,33) -or [DateTime]::UtcNow -ge $deadline){throw}
    Start-Sleep -Milliseconds 50
  }
}
$changed=Read-LaunchCache $App $HomeDir
if(!$changed -or $changed.needsValidation){throw 'Normal launch unexpectedly checked the changed probe'}
$changed=Read-LaunchCache $App $HomeDir -CheckChanges
if(!$changed -or !$changed.needsValidation){throw 'Explicit change check did not detect the probe'}
$validation=Test-Environment $App $paths $HomeDir
Save-LaunchCache $App $paths 'external' $validation $HomeDir
$dll=Join-Path $HomeDir 'tools/added-test.dll'
[IO.File]::WriteAllText($dll,'test adjacent library')
$added=Read-LaunchCache $App $HomeDir -CheckChanges
if(!$added -or !$added.needsValidation){throw 'New adjacent DLL was not detected'}
Move-Item -LiteralPath $dll -Destination ($dll+'.retired') -Force
$selection=@{mode='external';validation=$validation}
$selection.validation.programs.ffprobe.path=$FFprobePath
if(Read-LaunchCache $App $HomeDir $selection){throw 'Different selected paths incorrectly reused the cache'}
$validation.programs.ffprobe.path=$probeCopy
Save-LaunchCache $App $paths 'external' $validation $HomeDir
# Prove the daily path does not call a snapshot, hash, or codec check, even when
# an old optional background check left a failure marker.
Write-Json ((Get-LaunchCachePath $App $HomeDir)+'.failed') @{message='previous optional check failed'}
function Get-LaunchSnapshot {throw 'Normal launch scanned runtime metadata'}
function Get-FileHash {throw 'Normal launch hashed a file'}
function Test-Environment {throw 'Normal launch ran environment tests'}
$normal=Read-LaunchCache $App $HomeDir
if(!$normal -or $normal.needsValidation){throw 'Normal launch did not reuse the successful selection'}
Remove-Item -LiteralPath ((Get-LaunchCachePath $App $HomeDir)+'.failed')
Write-Output ('CACHE_RESULT:'+(@{milliseconds=$timer.Elapsed.TotalMilliseconds;paths=$paths;validation=$validation;changedNeedsValidation=$changed.needsValidation} | ConvertTo-Json -Depth 20 -Compress))
