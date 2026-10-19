param([Parameter(Mandatory=$true)][string]$SourcePath,[int]$DeviceIndex=0)
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
  # Read the actual production buffer through reflection. No diagnostic kernel,
  # alternate conversion, or changes to the source under test are involved.
  Add-Type -Path $SourcePath
  $taskType=[MediaScope.SitiOpenCl]
  $taskStatic=[Reflection.BindingFlags]'NonPublic,Static'
  $taskInstance=[Reflection.BindingFlags]'NonPublic,Instance'
  $taskType.GetField('requestedDevice',$taskStatic).SetValue($null,$DeviceIndex)
  $taskGpu=[MediaScope.SitiOpenCl]::new(9,7,0,8,0,1,504,-1,[double[]]@(0))
  try {
    $taskReader=[IO.BinaryReader]::new([Console]::OpenStandardInput())
    [Console]::WriteLine('{"ready":true}')
    while ($true) {
      try { $taskLength=$taskReader.ReadInt32() } catch [IO.EndOfStreamException] { break }
      $taskLine=[Text.Encoding]::UTF8.GetString($taskReader.ReadBytes($taskLength))
      $taskRequest=$taskLine | ConvertFrom-Json
      $taskHeader=$taskRequest.header
      $taskBytes=$taskReader.ReadBytes([int]$taskHeader[15]*8)
      $taskTable=[double[]]::new($taskBytes.Length/8)
      [Buffer]::BlockCopy($taskBytes,0,$taskTable,0,$taskBytes.Length)
      $taskArguments=[object[]]::new(14)
      foreach ($taskPair in @(@(0,0),@(1,1),@(2,4),@(3,5),@(4,6),@(5,7),@(6,8),@(7,9),@(8,10),@(9,11),@(10,12),@(11,13),@(12,14))) { $taskArguments[$taskPair[0]]=[int]$taskHeader[$taskPair[1]] }
      $taskArguments[13]=$taskTable.PSObject.BaseObject
      $null=$taskType.GetMethod('Configure',$taskInstance).Invoke($taskGpu,$taskArguments)
      $taskType.GetField('metricScale',$taskInstance).SetValue($taskGpu,[double]$taskHeader[16])
      $taskFrame=$taskReader.ReadBytes([int]$taskHeader[8])
      $null=$taskType.GetMethod('Measure',$taskInstance).Invoke($taskGpu,[object[]]@($taskFrame.PSObject.BaseObject,$true,-2))
      $taskSamples=[single[]]::new([int]$taskHeader[0]*[int]$taskHeader[1])
      $taskBuffer=$taskType.GetField('prev',$taskInstance).GetValue($taskGpu)
      $null=$taskType.GetMethod('Read',$taskInstance).Invoke($taskGpu,[object[]]@($taskBuffer,$taskSamples.PSObject.BaseObject,($taskSamples.Length*4)))
      $taskResult=New-Object byte[] ($taskSamples.Length*4)
      [Buffer]::BlockCopy($taskSamples,0,$taskResult,0,$taskResult.Length)
      [Console]::WriteLine('{"samples":"'+[Convert]::ToBase64String($taskResult)+'"}')
    }
  } finally { $taskGpu.Dispose() }
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
