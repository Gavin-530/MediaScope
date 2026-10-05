param([Parameter(Mandatory=$true)][string]$RequestPath,[Parameter(Mandatory=$true)][string]$ResultPath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'deployment.ps1')
try {
  $request=Read-Json $RequestPath
  $paths=@{};foreach($name in @('node','ffmpeg','ffprobe')){$paths[$name]=$request.paths.$name}
  $before=Get-LaunchSnapshot $request.app $paths
  if($request.mode -eq 'private'){
    $verified=Get-PrivateRuntime $request.app $request.runtimeRoot
    foreach($name in $paths.Keys){if($paths[$name] -ne $verified[$name]){throw 'Runtime selection changed; restart MediaScope'}}
  }
  $validation=Test-Environment $request.app $paths $request.installRoot
  if(!(Compare-LaunchSnapshot $before (Get-LaunchSnapshot $request.app $paths))){throw 'Runtime changed during validation; restart MediaScope'}
  Save-LaunchCache $request.app $paths $request.mode $validation $request.installRoot
  if($request.statePath){
    $state=Read-Json $request.statePath
    if($state.current.version -ne (Read-Json (Join-Path $request.app 'package.json')).version -or $state.current.environment.mode -ne $request.mode){throw 'Installation selection changed; restart MediaScope'}
    $state.current.environment.validation=$validation
    Write-Json $request.statePath $state
  }
  Write-Json $ResultPath @{state='ready';validation=$validation}
} catch {
  if($request){Write-Json ((Get-LaunchCachePath $request.app $request.installRoot)+'.failed') @{message=$_.Exception.Message;checkedAt=(Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)}}
  Write-Json $ResultPath @{state='error';message=$_.Exception.Message}
  exit 1
}
