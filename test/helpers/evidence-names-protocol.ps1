param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
$project=Assert-EvidencePath $sourceProject $Work
if(!$project.StartsWith((Join-Path $sourceProject 'test-work')+'\')){throw 'Fixture outside test-work'}
$root=Initialize-EvidenceArchive $project
$migration=Join-Path $sourceProject 'scripts/rename-evidence-records.ps1'
$utf8=New-Object Text.UTF8Encoding($false)
function Reject($Body,$Pattern){$errorText=$null;try{& $Body|Out-Null}catch{$errorText=$_.Exception.Message};if(!$errorText -or $errorText -notmatch $Pattern){throw "Expected $Pattern; received $errorText"}}
function New-Record($Base,$Id){
  $root2=Initialize-EvidenceArchive $Base
  $relative='records/'+(Convert-EvidenceRunName $Id)
  $dir=Join-Path $root2 $relative;$null=New-Item -ItemType Directory -Path $dir
  [IO.File]::WriteAllText((Join-Path $dir 'output.log'),'Synthetic failed Custom protocol; no product test executed.',$utf8)
  $m=@{schema=2;evidenceRevision=2;kind='Custom';version='0.2.7';runId=$Id;outcome='failed';exitCode=1;log=@{file='output.log';storedBytes=(Get-Item (Join-Path $dir 'output.log')).Length;sha256=(Get-FileHash (Join-Path $dir 'output.log')).Hash}}
  [IO.File]::WriteAllText((Join-Path $dir 'manifest.json'),($m|ConvertTo-Json -Depth 8),$utf8)
  Write-EvidenceChecksums $dir;Update-EvidenceCatalogCache $root2
  $null=Test-EvidenceRecord $dir $relative
  return @{source=$dir;from=$relative;to='records/'+(Get-EvidenceReadableName $m $Id)}
}
$record=New-Record $project '20261001T102030.123456789Z-1234abcd'
$before=(Get-FileHash (Join-Path $record.source 'SHA256SUMS.txt')).Hash
& $migration -Project $project|Out-Null
if(!(Test-Path $record.source)){throw 'Preview moved a record'}
& $migration -Project $project -Apply|Out-Null
$new=Join-Path $root $record.to
if(!(Test-Path $new) -or (Test-Path $record.source) -or (Get-FileHash (Join-Path $new 'SHA256SUMS.txt')).Hash -ne $before){throw 'Migration changed sealed identity or bytes'}
if((Resolve-EvidenceLocation $root ($record.from+'/output.log')) -ne (Join-Path $new 'output.log')){throw 'Old path did not resolve'}
$null=Test-EvidenceRecord $new $record.to
Reject {Test-EvidenceRecord $new ($record.to -replace '_Custom$','_Package')} 'location mismatch'
Reject {Test-EvidenceRecord $new ($record.to -replace '_abcd_','_0000_')} 'location mismatch'
$cacheBefore=[IO.File]::ReadAllBytes((Join-Path $root 'catalog.json'))
& $migration -Project $project -Apply|Out-Null
if([Convert]::ToBase64String($cacheBefore) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'catalog.json')))){throw 'Repeated migration changed the catalog'}
$journal=Get-Content (Join-Path $root 'pending/record-name-migration.json') -Raw|ConvertFrom-EvidenceJson
if($journal.state -ne 'completed' -or !(Test-Path (Join-Path $root ($journal.auditPath+'/original/mapping.json')))){throw 'Sealed mapping receipt missing'}
# A crash after receipt publication must finalize without duplicate audit.
$journal.state='verified'
[IO.File]::WriteAllText((Join-Path $root 'pending/record-name-migration.json'),($journal|ConvertTo-Json -Depth 30),$utf8)
& $migration -Project $project -Apply|Out-Null
if((Test-EvidenceCatalog $root) -ne 2){throw 'Receipt recovery duplicated records'}
Write-Output 'PASS: preview, immutable migration, full identity checks, old path lookup, independent copies and receipt recovery'

$conflict=Join-Path $project 'conflict'
$first=New-Record $conflict '20261001T102030.1Z-1234abcd'
$second=New-Record $conflict '20261001T102030.2Z-9876abcd'
Reject {& $migration -Project $conflict -Apply} 'collision'
if(!(Test-Path $first.source) -or !(Test-Path $second.source)){throw 'Collision partially migrated records'}
Write-Output 'PASS: truncated token collisions reject the entire historical batch without overwriting'

$rollback=Join-Path $project 'rollback'
$r=New-Record $rollback '20261001T102030Z-1234abcd'
$rr=Get-EvidenceRoot $rollback;$catalog=Join-Path $rr 'catalog.json';$bytes=[IO.File]::ReadAllBytes($catalog)
$files=@(Get-EvidenceFiles $r.source|Sort-Object path|ForEach-Object {@{path=$_.path;bytes=$_.bytes;sha256=(Get-FileHash $_.full).Hash}})
$fake=@{schema=1;operation='readable-record-names';project=$rollback;id='20261007T103000Z-eeee';state='moving';catalogExisted=$true;catalogBefore=[Convert]::ToBase64String($bytes);mapping=@(@{from=$r.from;to=$r.to;files=$files})}
[IO.File]::WriteAllText((Join-Path $rr 'pending/record-name-migration.json'),($fake|ConvertTo-Json -Depth 30),$utf8)
$target=Assert-EvidencePath $rollback (Join-Path $rr $r.to)
[IO.Directory]::Move((Assert-EvidencePath $rollback $r.source),$target)
$log=Join-Path $target 'output.log';$originalLog=[IO.File]::ReadAllBytes($log)
[IO.File]::AppendAllText($log,'tampered')
Reject {& $migration -Project $rollback -Rollback} 'changed|mismatch'
if(!(Test-Path $target)){throw 'Rollback moved unverified evidence'}
[IO.File]::WriteAllBytes($log,$originalLog)
& $migration -Project $rollback -Rollback|Out-Null
if(!(Test-Path $r.source) -or [Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($catalog))){throw 'Rollback did not restore exact catalog and path'}
Write-Output 'PASS: interrupted renames recover from actual paths; tampered evidence blocks rollback'

$script:tokens=@('abcd','bbbb','cccc');$script:tokenIndex=0
$null=New-Item -ItemType Directory -Path (Join-Path $rr 'pending/test-runs/20261001T102030Z-bbbb') -Force
$allocated=New-EvidenceRunId $rollback -Clock {'20261001T102030Z'} -TokenGenerator {$value=$script:tokens[$script:tokenIndex];$script:tokenIndex++;return $value}
if($allocated -ne '20261001T102030Z-cccc'){throw 'Allocator did not retry both sealed and pending collisions'}
Write-Output 'PASS: four-character allocator retries closed and pending identities under the caller lock'

$cases=@('20261001T102030Z-abcd','20261001T102030123Z-1234abcd','20261001T102030.123456789Z-1234abcd','20261001-1234abcd','undated-1234abcd')
foreach($id in $cases){Write-Output ('NAME:'+ $id+'='+ (Get-EvidenceReadableName @{kind='App';scope='full'} $id))}

$descriptions=@(
  @{kind='App';scope='full';label=''},
  @{kind='Custom';scope='';label='bitrate-equivalence'},
  @{kind='Custom';scope='';label='bitrate-equivalence-suite'},
  @{kind='Custom';scope='';label='A long human explanation is retained in the manifest'},
  @{kind='Custom';scope='single';label='bitrate-equivalence'},
  @{kind='Benchmark';scope='gpu';label=''},
  @{kind='Custom';scope='';label=('a'*26)}
)
foreach($description in $descriptions){
  $name=Get-EvidenceReadableName $description '20261001T102030Z-abcd'
  Write-Output ('LABEL:'+ $description.kind+'|'+$description.scope+'|'+$description.label+'='+$name)
}
Reject {Get-EvidenceReadableName @{kind='../escape'} '20261001T102030Z-abcd'} 'Invalid evidence kind'
Reject {Get-EvidenceReadableName @{kind='App';scope='../escape'} '20261001T102030Z-abcd'} 'Invalid evidence scope'
$labeledProject=Join-Path $project 'labeled'
$labeled=New-Record $labeledProject '20261001T102030Z-abcd'
$mp=Join-Path $labeled.source 'manifest.json';$lm=Get-Content $mp -Raw|ConvertFrom-EvidenceJson
$lm|Add-Member NoteProperty label 'bitrate-equivalence'
[IO.File]::WriteAllText($mp,($lm|ConvertTo-Json -Depth 8),$utf8);Write-EvidenceChecksums $labeled.source
$generic='records/'+(Get-EvidenceReadableName $lm -Generic)
$specific='records/'+(Get-EvidenceReadableName $lm)
$null=Test-EvidenceRecord $labeled.source $generic
$null=Test-EvidenceRecord $labeled.source $specific
Reject {Test-EvidenceRecord $labeled.source ($specific -replace 'bitrate-equivalence$','storage')} 'location mismatch'
Write-Output 'PASS: declared short descriptions, future naming tokens, old generic names and exact descriptor validation'
