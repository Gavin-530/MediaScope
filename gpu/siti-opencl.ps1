param([ValidateSet('probe','measure')][string]$Mode='probe',[int]$Width=9,[int]$Height=7,[int]$Depth=8,[int]$FullRange=0)
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
  Add-Type -Path (Join-Path $PSScriptRoot 'SitiOpenCl.cs')
  [MediaScope.SitiOpenCl]::Run($Mode,$Width,$Height,$Depth,$FullRange)
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
