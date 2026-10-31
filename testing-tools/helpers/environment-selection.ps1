param([string]$App,[string]$Work,[string]$NodePath,[string]$FFmpegPath,[string]$FFprobePath,[ValidateSet('Selection','Install')][string]$Case='Selection')
$ErrorActionPreference='Stop'
. (Join-Path $App 'scripts/deployment.ps1')
Add-Type -AssemblyName System.Windows.Forms

# Load the production selection functions without installing or registering an app.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $App 'scripts/manage.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors){throw 'Invalid manager script'}
foreach($name in @('Select-ProgramFile','Select-FirstEnvironment','Select-ManualEnvironment','Validate-SelectedEnvironment','Confirm-ExternalFallback','Save-InstallMarker')){
  $definition=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
  if(!$definition){throw "Missing selection function: $name"}
  . ([scriptblock]::Create($definition.Extent.Text))
}
$InstallRoot=Join-Path $Work 'home';$RuntimeRoot=$InstallRoot;$Action='Install';$NonInteractive=$false
New-Item -ItemType Directory -Force (Join-Path $InstallRoot 'staging') | Out-Null
$realPaths=@{node=$NodePath;ffmpeg=(Get-Command $FFmpegPath -CommandType Application).Source;ffprobe=(Get-Command $FFprobePath -CommandType Application).Source}
$NodePath=$null;$FFmpegPath=$null;$FFprobePath=$null
$script:downloads=0
function Get-PrivateRuntime($App,$RuntimeRoot){$script:downloads++;return $realPaths.Clone()}
function Show-EnvironmentPrompt($Message,$Buttons,$DefaultButton){
  $script:messages+=,$Message
  if(!$script:choices.Count){throw 'Unexpected environment prompt'}
  return $script:choices.Dequeue()
}
# Only replace the modal UI boundary; production picker setup, path resolution,
# disposal and environment validation all run unchanged.
function New-Object {
  param([string]$TypeName,[object[]]$ArgumentList)
  if($TypeName -ne 'Windows.Forms.OpenFileDialog'){
    if($PSBoundParameters.ContainsKey('ArgumentList')){return ,(Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList)}
    return ,(Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName)
  }
  $dialog=[pscustomobject]@{Title='';Filter='';CheckFileExists=$false;RestoreDirectory=$false;InitialDirectory='';FileName=''}
  $dialog | Add-Member ScriptMethod ShowDialog {
    if(!$script:files.Count){throw 'Unexpected component picker'}
    $script:picks+=,$this.Filter.Split('|')[0];$script:dialogs+=,$this
    $file=$script:files.Dequeue()
    if($null -eq $file){return [Windows.Forms.DialogResult]::Cancel}
    $this.FileName=$file
    return [Windows.Forms.DialogResult]::OK
  }
  $dialog | Add-Member ScriptMethod Dispose {$script:disposed++}
  return $dialog
}
function Reset-Choices($Choices=@(),$Files=@()){
  $script:choices=New-Object Collections.Queue;$script:files=New-Object Collections.Queue
  foreach($choice in $Choices){$script:choices.Enqueue($choice)}
  foreach($file in $Files){$script:files.Enqueue($file)}
  $script:messages=@();$script:picks=@();$script:dialogs=@();$script:disposed=0;$script:downloads=0
}
function Assert($Value,$Message){if(!$Value){throw "FAIL: $Message"}}
function Assert-Cancelled($Body){
  $failure=$null;try{& $Body | Out-Null}catch{$failure=$_.Exception.Message}
  Assert ($failure -match 'Installation cancelled') "Expected cancellation, received: $failure"
  Assert ($script:downloads -eq 0) 'Cancellation must never download components'
  Assert ($script:disposed -eq $script:picks.Count) 'Cancelled and earlier dialogs are all disposed'
}

if($Case -eq 'Install'){
  . (Join-Path $App 'scripts/install-location.ps1')
  $source=Join-Path $Work 'package'
  New-Item -ItemType Directory -Force (Join-Path $source 'scripts') | Out-Null
  foreach($item in @('analysis.mjs','bd-measure.mjs','siti.mjs','gpu','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses')){
    Copy-Item -LiteralPath (Join-Path $App $item) -Destination $source -Recurse
  }
  foreach($item in @('deployment.ps1','manage.ps1','install-location.ps1','uninstall.ps1','check-environment.mjs','desktop.mjs','runtime-data.mjs','time.mjs','validate-launch.ps1','fast-launch.ps1','fast-bootstrap.mjs')){
    Copy-Item -LiteralPath (Join-Path $App "scripts/$item") -Destination (Join-Path $source 'scripts')
  }
  $null=& (Join-Path $App 'scripts/build-launcher.ps1') -OutputDirectory (Join-Path $source 'scripts')
  Write-Json (Join-Path $source 'MANIFEST.json') @{schema=1;platform='win32-x64';version=(Read-Json (Join-Path $source 'package.json')).version;files=@(Get-TreeRecords $source)}
  $mediaDir=Join-Path $Work "media tools [x] & ! % '"
  New-Item -ItemType Directory -Force $mediaDir | Out-Null
  $mediaCopy=Join-Path $mediaDir 'ffmpeg.exe'
  Copy-Item -LiteralPath $realPaths.ffmpeg -Destination $mediaCopy
  Reset-Choices @('Yes') @($realPaths.node,$mediaCopy,$realPaths.ffprobe)
  function Get-PrivateRuntime {throw 'Manual installation must not download private components'}
  function Register-MediaScopeInstall($Root,$Version){
    $state=Read-Json (Join-Path $Root 'current.json')
    $cached=Read-LaunchCache (Join-Path $Root "apps/$Version") $Root $state.current.environment
    Assert ($cached -and !$cached.needsValidation) 'Saved selection can be reused without another environment check'
    Assert ($script:disposed -eq 3) 'All three production component pickers are disposed'
    Write-Json (Join-Path $Work 'installation-result.json') @{root=$Root;version=$Version;paths=$realPaths;mediaCopy=$mediaCopy;picks=$script:picks;cacheReused=$true;registrationIsolated=$true}
  }
  $env:PATH="$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  # Execute the real installation body, including validation, state commit and
  # launch-cache creation. Registry registration alone is redirected above.
  $body=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
  Assert ($body.Count -eq 1) 'Manager contains one installation body'
  . ([scriptblock]::Create($body[0].Extent.Text))
  throw 'Installation must finish through the manager exit path'
}

$savedPath=$env:PATH
try {
  # Force discovery to fail while keeping every selected program at its real path.
  $env:PATH="$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  Reset-Choices @('Yes') @($realPaths.node,$realPaths.ffmpeg)
  $selected=Select-FirstEnvironment $App
  Assert ($selected.mode -eq 'external' -and $script:picks.Count -eq 2) 'Manual selection uses two file pickers with adjacent FFprobe'
  Assert ($selected.paths.ffprobe -eq $realPaths.ffprobe) 'Adjacent FFprobe is selected'
  Assert ($script:disposed -eq 2 -and @($script:dialogs | Where-Object {!$_.CheckFileExists -or !$_.RestoreDirectory -or !$_.Title}).Count -eq 0) 'Production pickers require existing files and dispose their dialogs'
  $verified=Validate-SelectedEnvironment $App $selected.paths $selected.mode
  Assert ($verified.mode -eq 'external' -and $verified.validation.programs.node.sha256.Length -eq 64 -and $script:downloads -eq 0) 'Manually selected components pass the real compatibility checks without downloads'
  Write-Output 'PASS: manual-validated'

  $separate=Join-Path $Work 'media tools without adjacent probe'
  New-Item -ItemType Directory -Force $separate | Out-Null
  $separateFF=Join-Path $separate 'ffmpeg.exe'
  [IO.File]::WriteAllText($separateFF,'Protocol path fixture only; never executed')
  Reset-Choices @('Yes') @($realPaths.node,$separateFF,$realPaths.ffprobe)
  $selected=Select-FirstEnvironment $App
  Assert ($selected.paths.ffprobe -eq $realPaths.ffprobe -and ($script:picks -join ',') -eq 'node.exe,ffmpeg.exe,ffprobe.exe') 'Missing adjacent FFprobe opens its own picker'
  Write-Output 'PASS: probe-picker'

  foreach($files in @(@($null),@($realPaths.node,$null),@($realPaths.node,$separateFF,$null))){
    Reset-Choices @('Yes') $files
    Assert-Cancelled {Select-FirstEnvironment $App}
  }
  Write-Output 'PASS: cancel-each-picker'
  Reset-Choices @('Cancel')
  Assert-Cancelled {Select-FirstEnvironment $App}
  Assert (!$script:picks.Count) 'Cancelling the prompt opens no picker'
  Write-Output 'PASS: cancel-prompt'

  Reset-Choices @('Yes') @((Join-Path $Work 'missing.exe'))
  $failure=$null;try{$null=Select-FirstEnvironment $App}catch{$failure=$_.Exception.Message}
  Assert ($failure -and $script:downloads -eq 0 -and $script:disposed -eq 1) 'A vanished selected file is rejected and its picker is disposed without downloading'
  Write-Output 'PASS: missing-file'

  Reset-Choices @('No')
  $selected=Select-FirstEnvironment $App
  Assert ($selected.mode -eq 'private' -and $script:downloads -eq 1 -and !$script:picks.Count) 'Only the download choice prepares private components'
  Write-Output 'PASS: download-choice'
  Reset-Choices
  $NonInteractive=$true
  $selected=Select-FirstEnvironment $App
  Assert ($selected.mode -eq 'private' -and $script:downloads -eq 1 -and !$script:messages.Count -and !$script:picks.Count) 'Noninteractive installation keeps the private default without dialogs'
  $NonInteractive=$false
  Write-Output 'PASS: noninteractive'

  Reset-Choices @('Yes','No') @($realPaths.node,$realPaths.ffprobe)
  $selected=Select-FirstEnvironment $App
  $failure=$null
  try{$null=Validate-SelectedEnvironment $App $selected.paths $selected.mode}catch{$failure=$_.Exception.Message}
  Assert ($failure -and $script:downloads -eq 0 -and $script:messages.Count -eq 2) 'Invalid manual components are rejected and declining fallback never downloads'
  Write-Output 'PASS: invalid-declined'
  Reset-Choices @('Yes','Yes') @($realPaths.node,$realPaths.ffprobe)
  $selected=Select-FirstEnvironment $App
  $verified=Validate-SelectedEnvironment $App $selected.paths $selected.mode
  Assert ($verified.mode -eq 'private' -and $script:downloads -eq 1 -and $script:messages.Count -eq 2) 'Invalid manual components require confirmation before using private components'
  Write-Output 'PASS: invalid-confirmed'

  $env:PATH=(Split-Path $realPaths.node)+';'+(Split-Path $realPaths.ffmpeg)+';'+$env:PATH
  Reset-Choices @('Yes')
  $selected=Select-FirstEnvironment $App
  Assert ($selected.mode -eq 'external' -and !$script:picks.Count -and !$script:downloads) 'A detected valid environment keeps the existing choice without file pickers'
  Write-Output 'PASS: detected-environment'
} finally {$env:PATH=$savedPath}
