param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
if(!$OutputDirectory){$OutputDirectory=Join-Path $project '.build/launcher'}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if(!$OutputDirectory.StartsWith($project+'\.build\',[StringComparison]::OrdinalIgnoreCase)){throw 'Launcher build output must stay inside this workspace .build'}
function Assert-BuildPath($Path){
  for($part=$Path;$part;$part=[IO.Path]::GetDirectoryName($part)){
    if([IO.File]::Exists($part) -or [IO.Directory]::Exists($part)){
      if([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint){throw "Linked launcher build path: $part"}
    }
  }
}
function Hash-Bytes([byte[]]$Bytes){$digest=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($digest.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$digest.Dispose()}}
function Publish-BuildFile($From,$To){
  for($attempt=0;;$attempt++){
    try{if([IO.File]::Exists($To)){[IO.File]::Replace($From,$To,[NullString]::Value)}else{[IO.File]::Move($From,$To)};return}
    catch{
      $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}
      # A just-exited launcher image or a scanner can briefly retain the old build file.
      if(($failure.HResult -band 0xffff) -notin @(5,32,33,1175) -or $attempt -ge 7){throw}
      Start-Sleep -Milliseconds 125
    }
  }
}
$inputStream=New-Object IO.MemoryStream
try{
  foreach($name in @('launcher/Launcher.cs','build-launcher.ps1','fast-bootstrap.mjs')){
    $file=Join-Path $PSScriptRoot $name;Assert-BuildPath $file
    $part=[IO.File]::ReadAllBytes($file);$inputStream.Write($part,0,$part.Length)
  }
  $fingerprint=Hash-Bytes $inputStream.ToArray()
}finally{$inputStream.Dispose()}
$bootstrapHash=Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'fast-bootstrap.mjs')))
Assert-BuildPath $OutputDirectory
$executable=Join-Path $OutputDirectory 'MediaScope.Launcher.exe'
$metadata=Join-Path $OutputDirectory 'launcher-build.json'
Assert-BuildPath $executable;Assert-BuildPath $metadata
if([IO.File]::Exists($metadata) -and [IO.File]::Exists($executable)){
  try{
    $saved=[IO.File]::ReadAllText($metadata) | ConvertFrom-Json
    if($saved.schema -eq 1 -and $saved.fingerprint -eq $fingerprint -and $saved.bootstrapHash -eq $bootstrapHash -and $saved.executableHash -eq (Hash-Bytes ([IO.File]::ReadAllBytes($executable)))){return $saved}
  }catch{}
}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(![IO.File]::Exists($compiler)){throw 'The Windows .NET Framework C# compiler is unavailable; the PowerShell launcher remains usable'}
$temporary=Join-Path $project ('.build/launcher-build/'+[guid]::NewGuid().ToString('N'))
Assert-BuildPath $temporary
[IO.Directory]::CreateDirectory($temporary) | Out-Null
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$buildInfo=Join-Path $temporary 'LauncherBuild.cs'
[IO.File]::WriteAllText($buildInfo,('internal static class LauncherBuild { public const string Fingerprint="'+$fingerprint+'"; public const string BootstrapHash="'+$bootstrapHash+'"; }'))
$built=Join-Path $temporary 'MediaScope.Launcher.exe'
$priorTemp=$env:TEMP;$priorTmp=$env:TMP
try{
  $env:TEMP=$temporary;$env:TMP=$temporary
  $compilerOutput=& $compiler /nologo /target:exe /platform:x64 /optimize+ ('/out:'+$built) (Join-Path $PSScriptRoot 'launcher/Launcher.cs') $buildInfo 2>&1
  if($LASTEXITCODE -ne 0){throw "Launcher compilation failed: $compilerOutput"}
}finally{$env:TEMP=$priorTemp;$env:TMP=$priorTmp}
Assert-BuildPath $executable;Assert-BuildPath $metadata
Publish-BuildFile $built $executable
$result=@{schema=1;fingerprint=$fingerprint;bootstrapHash=$bootstrapHash;executableHash=(Hash-Bytes ([IO.File]::ReadAllBytes($executable)))}
$pending=Join-Path $temporary 'launcher-build.json'
[IO.File]::WriteAllText($pending,($result | ConvertTo-Json -Compress))
Publish-BuildFile $pending $metadata
return $result
