# Installation location is per user. Explicit paths used by development and
# deployment tests take precedence over the registered interactive install.
$script:MediaScopeInstallKey='HKCU:\Software\MediaScope'
$script:MediaScopeUninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MediaScope'

function Get-RegisteredInstallRoot {
  if(!(Test-Path -LiteralPath $script:MediaScopeInstallKey)){return $null}
  $value=(Get-ItemProperty -LiteralPath $script:MediaScopeInstallKey -Name InstallRoot -ErrorAction SilentlyContinue).InstallRoot
  if($value){return [IO.Path]::GetFullPath($value)}
  return $null
}
function Get-SourceInstallRoot($Source) {
  $version=[IO.Directory]::GetParent([IO.Path]::GetFullPath($Source)).FullName
  if((Split-Path -Leaf $version) -ne 'apps'){return $null}
  $root=[IO.Directory]::GetParent($version).FullName
  if(Test-Path -LiteralPath (Join-Path $root 'current.json')){return [IO.Path]::GetFullPath($root)}
  return $null
}
function Assert-InstallRootChoice($Root,$Source,$DefaultRoot,$AllowNested=$false) {
  $rootPath=[IO.Path]::GetFullPath($Root).TrimEnd('\')
  $sourcePath=[IO.Path]::GetFullPath($Source).TrimEnd('\')
  if($rootPath -eq [IO.Path]::GetPathRoot($rootPath).TrimEnd('\')){throw 'Select a MediaScope folder, not a drive root'}
  if($rootPath.Equals($sourcePath,[StringComparison]::OrdinalIgnoreCase) -or
     (!$AllowNested -and $rootPath.StartsWith($sourcePath+'\',[StringComparison]::OrdinalIgnoreCase)) -or
     $sourcePath.StartsWith($rootPath+'\',[StringComparison]::OrdinalIgnoreCase)){
    throw 'The installation directory must be separate from the package or source directory'
  }
  if(Test-Path -LiteralPath $rootPath){
    $existing=Get-ChildItem -LiteralPath $rootPath -Force
    $isDefault=$rootPath.Equals([IO.Path]::GetFullPath($DefaultRoot).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
    $retained=Join-Path $rootPath 'retained.json'
    $isRetained=$false
    if(Test-Path -LiteralPath $retained){
      $record=Read-Json $retained
      $isRetained=$record.schema -eq 1 -and $record.product -eq 'MediaScope' -and @($existing | Where-Object {$_.Name -notin @('retained.json','data','runtimes','runtime.lock')}).Count -eq 0
    }
    $onlyRuntimeCache=@($existing | Where-Object {$_.Name -notin @('runtimes','staging','runtime.lock','deployment.lock')}).Count -eq 0
    if($existing -and !$isDefault -and !$isRetained -and !$onlyRuntimeCache -and !(Test-Path -LiteralPath (Join-Path $rootPath 'current.json'))){
      throw 'Select an empty directory for a new installation'
    }
  }
  return $rootPath
}
function Resolve-InstallRoot($Source,$RequestedRoot,$RootWasProvided,$Action,$NonInteractive) {
  $defaultRoot=Join-Path $env:LOCALAPPDATA 'MediaScope'
  $sourceRoot=Get-SourceInstallRoot $Source
  if($RootWasProvided){
    $requested=[IO.Path]::GetFullPath($RequestedRoot).TrimEnd('\')
    if($sourceRoot -and $requested.Equals($sourceRoot,[StringComparison]::OrdinalIgnoreCase)){return $sourceRoot}
    return Assert-InstallRootChoice $RequestedRoot $Source $defaultRoot $NonInteractive
  }
  if($env:MEDIASCOPE_HOME){
    $requested=[IO.Path]::GetFullPath($env:MEDIASCOPE_HOME).TrimEnd('\')
    if($sourceRoot -and $requested.Equals($sourceRoot,[StringComparison]::OrdinalIgnoreCase)){return $sourceRoot}
    return Assert-InstallRootChoice $env:MEDIASCOPE_HOME $Source $defaultRoot $NonInteractive
  }
  if($sourceRoot){return $sourceRoot}
  $registered=Get-RegisteredInstallRoot
  if($registered){
    if(Test-Path -LiteralPath (Join-Path $registered 'current.json')){return $registered}
    if($NonInteractive -or $Action -notin @('Install','Launch')){throw "Registered installation is missing: $registered"}
    $missing="原安装位置已不可用：$registered`n`n是否重新选择安装位置？此操作不会清理旧位置留下的文件。"
    if([Windows.Forms.MessageBox]::Show($missing,'MediaScope 安装位置',[Windows.Forms.MessageBoxButtons]::OKCancel,[Windows.Forms.MessageBoxIcon]::Warning,[Windows.Forms.MessageBoxDefaultButton]::Button2) -ne [Windows.Forms.DialogResult]::OK){throw 'Installation cancelled; registered directory is missing'}
  }
  if(Test-Path -LiteralPath (Join-Path $defaultRoot 'current.json')){return $defaultRoot}
  if($NonInteractive -or $Action -notin @('Install','Launch')){return $defaultRoot}
  $dialog=New-Object Windows.Forms.FolderBrowserDialog
  $dialog.Description='请选择或新建 MediaScope 的安装文件夹。程序和报告将分别放在其 apps 和 data 子文件夹；私有组件保留在用户级运行时目录。'
  $dialog.ShowNewFolderButton=$true
  $dialog.SelectedPath=$defaultRoot
  try {
    if($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){throw 'Installation cancelled; no directory was selected'}
    $choice=Assert-InstallRootChoice $dialog.SelectedPath $Source $defaultRoot
    $message="安装位置：$choice`n`n程序和报告将放在此目录；私有组件保留在用户级运行时目录。是否继续？"
    if([Windows.Forms.MessageBox]::Show($message,'MediaScope 安装位置',[Windows.Forms.MessageBoxButtons]::OKCancel,[Windows.Forms.MessageBoxIcon]::Information) -ne [Windows.Forms.DialogResult]::OK){throw 'Installation cancelled; no directory was selected'}
    return $choice
  } finally {$dialog.Dispose()}
}
function Register-MediaScopeInstall($Root,$Version) {
  $app=Join-Path $Root "apps/$Version"
  $null=New-Item -Path $script:MediaScopeInstallKey -Force
  Set-ItemProperty -LiteralPath $script:MediaScopeInstallKey -Name InstallRoot -Value $Root
  $null=New-Item -Path $script:MediaScopeUninstallKey -Force
  $values=@{
    DisplayName='MediaScope';DisplayVersion=$Version;Publisher='MediaScope'
    InstallLocation=$Root;UninstallString=('"'+(Join-Path $app 'Uninstall.cmd')+'"')
  }
  foreach($entry in $values.GetEnumerator()){Set-ItemProperty -LiteralPath $script:MediaScopeUninstallKey -Name $entry.Key -Value $entry.Value}
}
function Unregister-MediaScopeInstall($Root) {
  $registered=Get-RegisteredInstallRoot
  if($registered -and $registered.Equals([IO.Path]::GetFullPath($Root),[StringComparison]::OrdinalIgnoreCase)){
    Remove-Item -LiteralPath $script:MediaScopeInstallKey -Force
    if(Test-Path -LiteralPath $script:MediaScopeUninstallKey){Remove-Item -LiteralPath $script:MediaScopeUninstallKey -Force}
  }
}
