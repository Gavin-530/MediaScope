param([ValidateSet('probe','measure')][string]$Mode='probe',[int]$Width=9,[int]$Height=7,[int]$Depth=8,[int]$FullRange=0,[ValidateSet('legacy','p910')][string]$Profile='legacy',[string]$SceneStarts='0',[ValidateSet('sdr','pq','hlg')][string]$CalculationDomain='sdr',[double]$WhiteCdM2=300,[double]$BlackCdM2=0.01,[double]$SystemGamma=2.4,[string]$ProfileName='P910-2023-SDR-BT1886-text-v1',[int]$RawMode=0,[int]$ReferenceScale=0,[int]$OutputMultiplier=0)
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
  if($Profile -eq 'p910'){
    if($Mode -ne 'measure'){throw 'P.910 GPU requires a calculation and its lookup header'}
    Add-Type -Path (Join-Path $PSScriptRoot 'SitiP910OpenCl.cs')
    if($OutputMultiplier -eq 0){$OutputMultiplier=[int]([Math]::Pow(2,$Depth)-1)}
    [MediaScope.SitiP910OpenCl]::Run($Width,$Height,$Depth,$FullRange,$SceneStarts,$CalculationDomain,$WhiteCdM2,$BlackCdM2,$SystemGamma,$ProfileName,$RawMode,$ReferenceScale,$OutputMultiplier)
  }else{
    Add-Type -Path (Join-Path $PSScriptRoot 'SitiOpenCl.cs')
    [MediaScope.SitiOpenCl]::Run($Mode,$Width,$Height,$Depth,$FullRange)
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
