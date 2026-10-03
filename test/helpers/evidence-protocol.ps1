param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
$project=[IO.Path]::GetFullPath($Work).TrimEnd('\')
if(!$project.StartsWith((Join-Path $sourceProject 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Protocol fixture outside test sandbox'}
New-Item -ItemType Directory -Force -Path $project | Out-Null

# Load the real path/cleanup validators without invoking the cleanup CLI.
# This deliberately never disables its process guard or deletes any evidence.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $sourceProject 'scripts/local-data.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors){throw 'Invalid maintenance script'}
foreach($name in @('Assert-Contained','Get-SafeFiles','Assert-CleanTarget','Test-GeneratedName','Test-GeneratedFileName')){
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(!$function){throw "Missing validator: $name"}
  . ([scriptblock]::Create($function.Extent.Text))
}
function Assert-Throws($Body,$Pattern){
  $caught=$null;try {& $Body | Out-Null}catch{$caught=$_.Exception.Message}
  if(!$caught -or $caught -notmatch $Pattern){throw "Expected rejection $Pattern; received $caught"}
}

$fixtureRoot=Join-Path $project 'test-work'
$acceptance=Join-Path $fixtureRoot 'acceptance-20260921'
$rules=@{'test-work'=@{path=$fixtureRoot;class='mixed'};'acceptance'=@{path=$acceptance;class='protected'}}
$null=New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'bitdepth'),$acceptance -Force
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'bitdepth/protocol.txt'),'filesystem protocol input')
if(!(Test-GeneratedName 'bitdepth') -or !(Test-GeneratedFileName 'psnr.log')){throw 'Known generated inputs were not recognized'}
$null=Assert-CleanTarget (Join-Path $fixtureRoot 'bitdepth')
Write-Output 'PASS: recognized generated inputs do not require historical snapshots'
Assert-Throws {Assert-CleanTarget $acceptance} 'Protected data'
if(Test-GeneratedName 'acceptance-20260921'){throw 'Acceptance became a generated candidate'}
Write-Output 'PASS: protected acceptance data is excluded from cleanup'
Assert-Throws {Assert-Contained (Split-Path -Parent $project)} 'Outside MediaScope'
if(Test-GeneratedName 'unknown-important-data'){throw 'Unknown directory became a generated candidate'}
Write-Output 'PASS: workspace boundaries and unknown data remain protected'

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

# Explicit protocol fixture; these counts are contract inputs, not media results.
$assessmentRecord=Join-Path $project 'assessment-record'
$null=New-Item -ItemType Directory -Path $assessmentRecord
foreach($file in @('source.zip','source-manifest.json','events.jsonl.gz','artifact-manifest.json')){[IO.File]::WriteAllText((Join-Path $assessmentRecord $file),'Protocol placeholder; no media executed.')}
$assessmentLog=Join-Path $assessmentRecord 'output.log'
[IO.File]::WriteAllText($assessmentLog,'Regression assessment protocol inputs only.')
$counts=@{tests=1;passed=1;failed=0;cancelled=0;skipped=0;todo=0}
$feature=@{id='protocol-only';status='passed'}
$assessment=@{schema=3;evidenceRevision=1;kind='App';version='0.2.1';runId='20260930T000000000Z-1234abcd';scope='full';source=@{kind='working-tree'};outcome='passed';exitCode=0;testSummary=$counts;releaseCheck=@{requested=$false;ready=$true};validation=@{schema=1;mode='full-regression';status='complete';accepted=$true};log=@{file='output.log';storedBytes=(Get-Item $assessmentLog).Length;sha256=(Get-FileHash $assessmentLog).Hash}}
function Save-AssessmentProtocol {
  [IO.File]::WriteAllText((Join-Path $assessmentRecord 'manifest.json'),($assessment | ConvertTo-Json -Depth 10))
  [IO.File]::WriteAllText((Join-Path $assessmentRecord 'results.json'),(@{counts=$counts} | ConvertTo-Json -Depth 5))
  [IO.File]::WriteAllText((Join-Path $assessmentRecord 'features.json'),(@{schema=2;features=@($feature)} | ConvertTo-Json -Depth 5))
  Write-EvidenceChecksums $assessmentRecord
}
Save-AssessmentProtocol
$null=Test-EvidenceRecord $assessmentRecord $identity
$assessment.outcome='failed';$assessment.exitCode=1;$assessment.validation.status='failed';$assessment.validation.accepted=$false;$assessment.validation.processExitCode=1;Save-AssessmentProtocol
$null=Test-EvidenceRecord $assessmentRecord $identity
$assessment.outcome='passed';$assessment.exitCode=0;$assessment.validation.status='complete';$assessment.validation.accepted=$true;Save-AssessmentProtocol
Assert-Throws {Test-EvidenceRecord $assessmentRecord $identity} 'Invalid regression assessment'
$assessment.validation.processExitCode=0
$feature.status='partial';Save-AssessmentProtocol
Assert-Throws {Test-EvidenceRecord $assessmentRecord $identity} 'Invalid regression assessment'
$feature.status='passed';$counts.tests=2;$counts.skipped=1;Save-AssessmentProtocol
Assert-Throws {Test-EvidenceRecord $assessmentRecord $identity} 'Invalid regression assessment'
$assessment.outcome='failed';$assessment.exitCode=1;$assessment.releaseCheck.ready=$false
$assessment.validation.status='incomplete';$assessment.validation.accepted=$false;Save-AssessmentProtocol
$null=Test-EvidenceRecord $assessmentRecord $identity
$assessment.scope='browser';$assessment.outcome='passed';$assessment.exitCode=0
$assessment.validation.mode='partial-regression';$assessment.validation.accepted=$true;Save-AssessmentProtocol
$null=Test-EvidenceRecord $assessmentRecord $identity
$assessment.validation.status='complete';Save-AssessmentProtocol
Assert-Throws {Test-EvidenceRecord $assessmentRecord $identity} 'Invalid regression assessment'
$assessment.scope='full';$assessment.source.kind='git';$assessment.validation.mode='historical-comparison';$assessment.validation.status='incomplete';Save-AssessmentProtocol
$null=Test-EvidenceRecord $assessmentRecord $identity
$assessment.releaseCheck.ready=$true;Save-AssessmentProtocol
Assert-Throws {Test-EvidenceRecord $assessmentRecord $identity} 'Narrow scope cannot claim release readiness'
Write-Output 'PASS: explicit regression assessments reject incomplete full passes and preserve partial or historical scope'
