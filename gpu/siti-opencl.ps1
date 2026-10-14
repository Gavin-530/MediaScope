param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
  Add-Type -Path (Join-Path $PSScriptRoot 'SitiOpenCl.cs') -OutputAssembly $OutputPath -OutputType ConsoleApplication
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
