# GitHub-hosted Windows runner only; uses the same test entry as local releases.
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($env:GITHUB_ACTIONS -ne 'true'){throw 'This bootstrap is for GitHub Actions; use npm test locally'}
. (Join-Path $PSScriptRoot 'deployment.ps1')
$diagnostics=Join-Path $project '.build/ci-diagnostics'
New-Item -ItemType Directory -Force -Path $diagnostics | Out-Null
Start-Transcript -Path (Join-Path $diagnostics 'bootstrap.log') -NoClobber | Out-Null
$code=2
try {
  Set-Location -LiteralPath $project
  $paths=Get-PrivateRuntime $project (Join-Path $project '.build/ci-runtime')
  $env:FFMPEG_PATH=$paths.ffmpeg
  $env:FFPROBE_PATH=$paths.ffprobe
  $env:PATH=(Split-Path -Parent $paths.node)+';'+$env:PATH
  $npm=Join-Path (Split-Path -Parent $paths.node) 'node_modules/npm/bin/npm-cli.js'
  if(!(Test-Path -LiteralPath $npm -PathType Leaf)){throw 'Locked Node.js distribution is missing npm'}
  & $paths.node $npm ci --ignore-scripts
  if($LASTEXITCODE -ne 0){throw "npm ci failed ($LASTEXITCODE)"}
  & $paths.node (Join-Path $PSScriptRoot 'test.mjs') --release
  $code=$LASTEXITCODE
} catch {
  Write-Output $_.Exception.Message
} finally {
  Stop-Transcript | Out-Null
}
exit $code
