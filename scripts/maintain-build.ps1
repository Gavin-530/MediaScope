param([switch]$Apply)
$ErrorActionPreference='Stop'
# Compatibility entry point; preview by default, use the shared cleanup guards.
& (Join-Path $PSScriptRoot 'local-data.ps1') -Action Clean -Category Build -Apply:$Apply
