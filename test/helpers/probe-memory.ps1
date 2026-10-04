param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$commands=Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$results=@();$sequence=0
foreach($command in $commands){
  # Quote these fixed FFprobe arguments for Start-Process's Windows command line.
  $quoted=@($command.args | ForEach-Object {
    if($_ -match '["\r\n]' -or $_.EndsWith('\')){throw 'Unsupported memory-test argument'}
    '"'+$_+'"'
  })
  $stdoutPath=Join-Path (Split-Path $OutputPath) ("memory-$sequence.stdout")
  $stderrPath=Join-Path (Split-Path $OutputPath) ("memory-$sequence.stderr")
  $timer=[Diagnostics.Stopwatch]::StartNew()
  $process=Start-Process -FilePath $command.exe -ArgumentList $quoted -WorkingDirectory $command.cwd -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $null=$process.Handle
  $peak=0L
  while(!$process.HasExited){
    $process.Refresh();$peak=[Math]::Max($peak,$process.PeakWorkingSet64)
    if($timer.Elapsed.TotalSeconds -gt 15){$process.Kill();throw 'Memory observation timed out'}
    Start-Sleep -Milliseconds 2
  }
  $process.WaitForExit();$timer.Stop()
  $results+=@{exe=$command.exe;args=$command.args;exitCode=$process.ExitCode;elapsedSeconds=$timer.Elapsed.TotalSeconds;observedPeakWorkingSetBytes=$peak}
  $process.Dispose();$sequence++
}
ConvertTo-Json -InputObject $results -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
