param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+-(alpha|beta|rc)(\.\d+)?$')][string]$Version)
& (Join-Path $PSScriptRoot 'package.ps1') -Version $Version
