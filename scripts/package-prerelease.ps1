param([Parameter(Mandatory=$true)][ValidatePattern('^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-(alpha|beta|rc)(\.(?:0|[1-9][0-9]*))?$')][string]$Version)
& (Join-Path $PSScriptRoot 'package.ps1') -Version $Version
