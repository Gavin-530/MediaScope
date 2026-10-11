param([ValidateSet('probe','measure')][string]$Mode='probe',[int]$Width=9,[int]$Height=7,[int]$Depth=8,[int]$FullRange=0,[ValidateSet('legacy','p910')][string]$Profile='legacy',[string]$SceneStarts='0')
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
  if($Profile -eq 'p910'){
    if($Mode -ne 'measure'){throw 'P.910 GPU requires a calculation and its lookup header'}
    Add-Type -Path (Join-Path $PSScriptRoot 'SitiP910OpenCl.cs')
    [MediaScope.SitiP910OpenCl]::Run($Width,$Height,$Depth,$FullRange,$SceneStarts)
  }else{
    Add-Type -Path (Join-Path $PSScriptRoot 'SitiOpenCl.cs')
    [MediaScope.SitiOpenCl]::Run($Mode,$Width,$Height,$Depth,$FullRange)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
