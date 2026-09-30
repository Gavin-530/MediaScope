param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Work).TrimEnd('\')
if(!$project.StartsWith((Join-Path $sourceProject 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Protocol fixture outside test sandbox'}
New-Item -ItemType Directory -Force -Path $project | Out-Null

# Load the real path/snapshot validators without invoking the cleanup CLI.
# This deliberately never disables its process guard or deletes any evidence.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceProject 'scripts/local-data.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors){throw 'Invalid maintenance script'}
foreach($name in @('Assert-Contained','Get-SafeFiles','Assert-TestGeneratedArchived')){
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(!$function){throw "Missing validator: $name"}
  . ([scriptblock]::Create($function.Extent.Text))
}
function Assert-Throws($Body,$Pattern){
  $caught=$null;try {& $Body | Out-Null}catch{$caught=$_.Exception.Message}
  if(!$caught -or $caught -notmatch $Pattern){throw "Expected rejection $Pattern; received $caught"}
}

$fixtureRoot=Join-Path $project 'test-work'
$archiveRoot=Join-Path $project 'local-test-archive'
$rules=@{'test-work'=@{path=$fixtureRoot};'local-test-archive'=@{path=$archiveRoot}}
New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot 'bitdepth'),$archiveRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'bitdepth/protocol.txt'),'filesystem evidence protocol')
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'psnr.log'),'filesystem fixture, not a media measurement')
foreach($name in @('bitdepth','psnr.log')){
  $snapshot=Join-Path $archiveRoot ('generated-fixtures-'+$name.Replace('.','-'))
  New-Item -ItemType Directory -Path $snapshot | Out-Null
  $files=@(Get-SafeFiles (Join-Path $fixtureRoot $name) | ForEach-Object {@{path=$_.FullName.Substring($fixtureRoot.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}})
  $manifest=@{schema=1;kind='generated-fixture-snapshot';items=@($name);files=$files}
  [IO.File]::WriteAllText((Join-Path $snapshot 'manifest.json'),($manifest | ConvertTo-Json -Depth 5))
  Write-EvidenceChecksums $snapshot
  Add-EvidenceCatalogRecord $archiveRoot @{source=$snapshot;relative=(Split-Path -Leaf $snapshot)}
}
$null=Test-EvidenceCatalog $archiveRoot
$candidates=@(@{path=(Join-Path $fixtureRoot 'bitdepth')},@{path=(Join-Path $fixtureRoot 'psnr.log')})
Assert-TestGeneratedArchived $candidates
Write-Output 'PASS: different complete snapshots jointly cover separate candidates'
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'bitdepth/protocol.txt'),'filesystem evidence PROTOCOL')
Assert-Throws {Assert-TestGeneratedArchived $candidates} 'not covered'
Write-Output 'PASS: same-size changed content is rejected'
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'bitdepth/protocol.txt'),'filesystem evidence protocol')
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'bitdepth/new.txt'),'new')
Assert-Throws {Assert-TestGeneratedArchived $candidates} 'not covered'
Write-Output 'PASS: extra files are rejected before any cleanup'
if(!(Test-Path (Join-Path $fixtureRoot 'psnr.log'))){throw 'Validation must not delete candidates'}

$record=Join-Path $project 'record'
New-Item -ItemType Directory -Path $record | Out-Null
$log=Join-Path $record 'output.log';[IO.File]::WriteAllText($log,'evidence protocol log')
$identity='runs/0.2.1/20260930T000000000Z-1234abcd'
$manifest=@{schema=2;kind='Package';version='0.2.1';runId='20260930T000000000Z-1234abcd';outcome='passed';exitCode=0;log=@{file='output.log';storedBytes=(Get-Item $log).Length;sha256=(Get-FileHash $log).Hash}}
[IO.File]::WriteAllText((Join-Path $record 'manifest.json'),($manifest | ConvertTo-Json -Depth 5))
Write-EvidenceChecksums $record
$null=Test-EvidenceRecord $record $identity
Assert-Throws {Test-EvidenceRecord $record 'runs/0.2.1/invalid-name'} 'directory layout'
Write-Output 'PASS: malformed run names are rejected while legacy schema remains readable'
$manifest.evidenceRevision=1
[IO.File]::WriteAllText((Join-Path $record 'manifest.json'),($manifest | ConvertTo-Json -Depth 5))
Write-EvidenceChecksums $record
Assert-Throws {Test-EvidenceRecord $record $identity} 'Missing verifier snapshot'
Write-Output 'PASS: new successful deployment records require verifier snapshots'
