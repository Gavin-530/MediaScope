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
  # Own the process handle from Start(), including children that exit before
  # the first memory sample. Start-Process can lose their exit-code handle.
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=$command.exe
  $startInfo.Arguments=$quoted -join ' '
  $startInfo.WorkingDirectory=$command.cwd
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardOutput=$true
  $startInfo.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$startInfo
  try {
    if(!$process.Start()){throw 'Memory observation process did not start'}
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    $peak=0L
    while(!$process.HasExited){
      $process.Refresh();$peak=[Math]::Max($peak,$process.PeakWorkingSet64)
      if($timer.Elapsed.TotalSeconds -gt 15){$process.Kill();throw 'Memory observation timed out'}
      Start-Sleep -Milliseconds 2
    }
    $process.WaitForExit();$timer.Stop()
    if($null -eq $process.ExitCode){throw 'Memory observation exit code is unavailable'}
    $utf8=New-Object Text.UTF8Encoding -ArgumentList $false
    [IO.File]::WriteAllText($stdoutPath,$stdout.GetAwaiter().GetResult(),$utf8)
    [IO.File]::WriteAllText($stderrPath,$stderr.GetAwaiter().GetResult(),$utf8)
    $results+=@{exe=$command.exe;args=$command.args;exitCode=$process.ExitCode;elapsedSeconds=$timer.Elapsed.TotalSeconds;observedPeakWorkingSetBytes=$peak}
  } finally {
    $process.Dispose()
  }
  $sequence++
}
ConvertTo-Json -InputObject $results -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
