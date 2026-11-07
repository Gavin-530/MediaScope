param([string]$App,[ValidateSet('picker','prompt','install-location')][string]$Operation,[string]$OutputPath,[string]$Work)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $App 'scripts/deployment.ps1')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $App 'scripts/manage.ps1'),[ref]$tokens,[ref]$errors)
if($errors){throw 'Invalid production manager'}
# Load the exact production functions. No dialog, result or path resolver is replaced.
foreach($name in @('Select-ProgramFile','Show-EnvironmentPrompt')){
 $definition=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name},$true)
 if(!$definition){throw "Missing production native function: $name"}
 . ([scriptblock]::Create($definition.Extent.Text))
}
try {
 if($Operation -eq 'install-location'){
  $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $App 'scripts/install-location.ps1'),[ref]$tokens,[ref]$errors)
  if($errors){throw 'Invalid production installation location script'}
  foreach($name in @('Get-SourceInstallRoot','Assert-InstallRootChoice','Resolve-InstallRoot')){
   $definition=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name},$true)
   if(!$definition){throw 'Missing production location function'}
   . ([scriptblock]::Create($definition.Extent.Text))
  }
  # Isolate only discovery of preexisting user installations. All production
  # modal dialogs and location validation run unchanged; nothing is installed.
  function Get-RegisteredInstallRoot {return $null}
  $env:LOCALAPPDATA=Join-Path $Work 'local';$env:MEDIASCOPE_HOME=$null
  $source=Join-Path $Work 'package';New-Item -ItemType Directory -Force $source,$env:LOCALAPPDATA|Out-Null
  $value=Resolve-InstallRoot $source $null $false 'Install' $false
 }elseif($Operation -eq 'picker'){$value=Select-ProgramFile 'node.exe'}
 else{$value=(Show-EnvironmentPrompt 'Owned formal test: choose the requested environment branch.' ([Windows.Forms.MessageBoxButtons]::YesNoCancel)).ToString()}
 [IO.File]::WriteAllText($OutputPath,(@{outcome='returned';value=$value}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}catch{
 [IO.File]::WriteAllText($OutputPath,(@{outcome='rejected';error=$_.Exception.Message}|ConvertTo-Json),[Text.UTF8Encoding]::new($false));exit 1
}
