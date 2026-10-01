param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
$workRoot=Assert-EvidencePath $sourceProject $Work
if(!$workRoot.StartsWith((Join-Path $sourceProject 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test outside sandbox'}
$importer=Join-Path $sourceProject 'evidence-archive/tools/import-local-test-evidence.ps1'
$sender=Join-Path $workRoot 'sender'
$receiver=Join-Path $workRoot 'receiver'
$utf8=New-Object Text.UTF8Encoding($false)
function Reject($Body,$Pattern){
  $message=$null;try{& $Body|Out-Null}catch{$message=$_.FullyQualifiedErrorId+': '+$_.Exception.Message}
  if(!$message -or $message -notmatch $Pattern){throw "Expected $Pattern, received $message"}
}
function New-Record([string]$Id,[string]$Text){
  $raw=Join-Path (Get-EvidencePendingRoot $sender) ('fixture-'+$Id)
  $null=New-Item -ItemType Directory -Path $raw -Force
  [IO.File]::WriteAllText((Join-Path $raw 'output.log'),$Text,$utf8)
  # Receiving this script must never execute it.
  [IO.File]::WriteAllText((Join-Path $raw 'do-not-run.ps1'),"throw 'Received code executed'",$utf8)
  $m=@{schema=2;kind='Custom';version='0.2.2';runId=$Id;outcome='failed';exitCode=1;source=@{commit=('a'*40)};log=@{file='output.log';storedBytes=(Get-Item (Join-Path $raw 'output.log')).Length;sha256=(Get-FileHash (Join-Path $raw 'output.log')).Hash}}
  [IO.File]::WriteAllText((Join-Path $raw 'manifest.json'),($m|ConvertTo-Json -Depth 8),$utf8)
  Write-EvidenceChecksums $raw
  return (Publish-EvidenceRecord $sender $raw ('runs/0.2.2/'+$Id))
}
function Copy-Received([string]$Batch,[string]$Source,[string]$Name){
  $records=Join-Path $receiver ('evidence-archive/inbox/'+$Batch+'/records')
  $null=New-Item -ItemType Directory -Path $records -Force
  if(!$Name){$Name=Split-Path -Leaf $Source}
  $target=Join-Path $records $Name
  Copy-Item -LiteralPath $Source -Destination $target -Recurse
  return $target
}
$local=New-Record '20261001T102030Z-1234ab01' 'Failed collaborator protocol fixture; not a media run.'
$fixtureRaw=Join-Path (Get-EvidencePendingRoot $sender) 'fixtures'
$null=New-Item -ItemType Directory -Path $fixtureRaw
[IO.File]::WriteAllText((Join-Path $fixtureRaw 'manifest.json'),'{"schema":1,"kind":"generated-fixture-snapshot","note":"Synthetic fixture protocol"}',$utf8)
Write-EvidenceChecksums $fixtureRaw
$fixture=Publish-EvidenceRecord $sender $fixtureRaw 'generated-fixtures-20261001-1234ab02'
$null=New-Item -ItemType Directory -Path $receiver -Force
& $importer -Project $receiver | Out-Null
if(!(Test-Path (Join-Path $receiver 'evidence-archive/inbox')) -or (Test-Path (Join-Path $receiver 'evidence-archive/catalog.json'))){throw 'Inbox initialization changed formal archive'}
$received=Copy-Received 'alice' $local
$receivedFixture=Copy-Received 'alice' $fixture
$originalHashes=@(Get-EvidenceFiles $received|ForEach-Object {$_.path+':'+(Get-FileHash -LiteralPath $_.full).Hash})
& $importer -Project $receiver -Batch alice | Out-Null
if(Test-Path (Join-Path $receiver 'evidence-archive/catalog.json')){throw 'Preview mutated formal archive'}
Write-Output 'PASS: inbox initialization and batch preview do not create formal records or catalogs'

$priorActions=$env:GITHUB_ACTIONS
try{$env:GITHUB_ACTIONS='true';& $importer -Project $receiver -Batch alice -Contributor 'Alice Example' -Apply | Out-Null}
finally{$env:GITHUB_ACTIONS=$priorActions}
$root=Get-EvidenceRoot $receiver
if((Test-EvidenceCatalog $root) -ne 3){throw 'Missing imports or attribution audit'}
$identity=Get-Content (Join-Path $received 'record.json') -Raw|ConvertFrom-EvidenceJson
$destination=Join-Path $root $identity.path
$importedHashes=@(Get-EvidenceFiles $destination|ForEach-Object {$_.path+':'+(Get-FileHash -LiteralPath $_.full).Hash})
if(($originalHashes -join "`n") -ne ($importedHashes -join "`n") -or $identity.outcome -ne 'failed' -or !$identity.path.StartsWith('tests/local/')){throw 'Imported bytes, outcome or origin changed'}
if(!(Test-Path $receivedFixture) -or @((Get-ChildItem (Join-Path $root 'pending') -Directory)).Count){throw 'Received originals lost or successful transaction left pending'}
$audit=@(Get-EvidenceRecords $root|Where-Object {$_.relative -like 'maintenance/*_local-evidence-import_*'})[0]
$receipt=Get-Content (Join-Path $audit.source 'original/receipt.json') -Raw|ConvertFrom-EvidenceJson
$localReceipt=@($receipt.records|Where-Object {$_.path.StartsWith('tests/local/')})[0]
if($receipt.contributor -ne 'Alice Example' -or @($receipt.records).Count -ne 2 -or $localReceipt.sourceCommit -ne ('a'*40)){throw 'Attribution or source commit lost'}
Write-Output 'PASS: actual import preserves every byte, failed outcomes and origin, records attribution and never executes received code'

$catalog=Join-Path $root 'catalog.json'
$catalogHash=(Get-FileHash $catalog).Hash
& $importer -Project $receiver -Batch alice -Contributor Alice -Apply | Out-Null
if((Get-FileHash $catalog).Hash -ne $catalogHash -or (Test-EvidenceCatalog $root) -ne 3){throw 'Repeat import changed archive'}
Write-Output 'PASS: repeat imports are idempotent without duplicate audit records'

$conflict=Copy-Received conflict $local
$raw=Join-Path $conflict 'original'
[IO.File]::WriteAllText((Join-Path $raw 'output.log'),'Different valid failure with the same identity',$utf8)
$m=Get-Content (Join-Path $raw 'manifest.json') -Raw|ConvertFrom-EvidenceJson
$m.log.storedBytes=(Get-Item (Join-Path $raw 'output.log')).Length;$m.log.sha256=(Get-FileHash (Join-Path $raw 'output.log')).Hash
[IO.File]::WriteAllText((Join-Path $raw 'manifest.json'),($m|ConvertTo-Json -Depth 8),$utf8)
Write-EvidenceChecksums $raw
$r=Get-Content (Join-Path $conflict 'record.json') -Raw|ConvertFrom-EvidenceJson
$r.originalChecksumsSha256=(Get-FileHash (Join-Path $raw 'SHA256SUMS.txt')).Hash
[IO.File]::WriteAllText((Join-Path $conflict 'record.json'),($r|ConvertTo-Json -Depth 12),$utf8)
Write-EvidenceChecksums $conflict
$newRecord=New-Record '20261001T102031Z-1234ab03' 'Second failed protocol fixture'
$null=Copy-Received conflict $newRecord 'a-new-record'
Reject {& $importer -Project $receiver -Batch conflict -Contributor Bob -Apply} 'Existing evidence conflicts'
if((Get-FileHash $catalog).Hash -ne $catalogHash -or (Test-EvidenceCatalog $root) -ne 3){throw 'Conflicting batch partially imported'}
Write-Output 'PASS: valid same-identity conflicts stop the entire batch without overwriting or partially importing'

$corrupt=Copy-Received corrupt $local
[IO.File]::AppendAllText((Join-Path $corrupt 'original/output.log'),'corruption')
Reject {& $importer -Project $receiver -Batch corrupt -Contributor Bob -Apply} 'Checksum mismatch'
$escape=Copy-Received escape $local
$r=Get-Content (Join-Path $escape 'record.json') -Raw|ConvertFrom-EvidenceJson
$r.path='../../outside'
[IO.File]::WriteAllText((Join-Path $escape 'record.json'),($r|ConvertTo-Json -Depth 12),$utf8)
Write-EvidenceChecksums $escape
Reject {& $importer -Project $receiver -Batch escape -Contributor Bob -Apply} 'Invalid evidence envelope identity'
Reject {& $importer -Project $receiver -Batch '../escape'} 'ParameterArgumentValidationError'
Write-Output 'PASS: corrupt files and traversal identities are rejected before publication'

$junctionBatch=Join-Path $receiver 'evidence-archive/inbox/linked/records'
$null=New-Item -ItemType Directory -Path $junctionBatch -Force
$junction=Join-Path $junctionBatch 'linked-record'
$null=New-Item -ItemType Junction -Path $junction -Target $local
try{Reject {& $importer -Project $receiver -Batch linked -Contributor Bob -Apply} 'Linked (received entry|evidence path)'}
finally{
  # Remove only the junction created by this test, never its target or evidence.
  $junctionPath=[IO.Path]::GetFullPath($junction)
  if(!$junctionPath.StartsWith($workRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or
     !((Get-Item -LiteralPath $junctionPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe junction fixture cleanup'}
  [IO.Directory]::Delete($junctionPath)
}
Write-Output 'PASS: junctions are rejected before recursive traversal'

$null=Copy-Received locked $newRecord
$gate=[IO.File]::Open((Get-EvidenceLockPath $receiver),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{Reject {& $importer -Project $receiver -Batch locked -Contributor Bob -Apply} 'recording is active'}finally{$gate.Dispose()}
Reject {& $importer -Project $receiver -Batch locked -Apply} 'contributor name'
if((Get-FileHash $catalog).Hash -ne $catalogHash){throw 'Lock or missing contributor changed catalog'}
Write-Output 'PASS: active archive locks and missing attribution prevent import'

$held=[IO.File]::Open($catalog,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{Reject {& $importer -Project $receiver -Batch locked -Contributor Bob -Apply} 'Replace|used by another process|being used'}finally{$held.Dispose()}
if((Test-EvidenceCatalog $root) -ne 3 -or (Get-FileHash $catalog).Hash -ne $catalogHash){throw 'Catalog failure did not roll back new record directories'}
$failedTransactions=@(Get-ChildItem (Join-Path $root 'pending') -Directory -Filter 'local-import-*')
if($failedTransactions.Count -ne 1 -or !(Test-Path (Join-Path $failedTransactions[0].FullName 'record-0/original/output.log'))){throw 'Interrupted transaction evidence was not retained'}
Write-Output 'PASS: actual atomic catalog replacement failure rolls back new directories and preserves received originals and staged evidence'

& $importer -Project $receiver -Batch locked -Contributor Bob -Apply | Out-Null
if((Test-EvidenceCatalog $root) -ne 5){throw 'Retry after rollback failed'}
$loose=Join-Path $receiver 'evidence-archive/inbox/loose/records'
$null=New-Item -ItemType Directory -Path $loose -Force
[IO.File]::WriteAllText((Join-Path $loose 'catalog.json'),'{}',$utf8)
Reject {& $importer -Project $receiver -Batch loose} 'modern sealed archive'
Write-Output 'PASS: retry imports only missing records and sender catalogs cannot replace the local index'

# A whole donated archive can itself contain received archives, tools and locks.
$extra=New-Record '20261001T102032Z-1234ab04' 'New donor record outside its inbox'
$wholeRecords=Join-Path $root 'inbox/whole/records'
$null=New-Item -ItemType Directory -Path $wholeRecords -Force
$wholeArchive=Join-Path $wholeRecords 'evidence-archive'
Copy-Item -LiteralPath (Get-EvidenceRoot $sender) -Destination $wholeArchive -Recurse
$foreignInbox=Join-Path $wholeArchive 'inbox'
$null=New-Item -ItemType Directory -Path (Join-Path $foreignInbox 'old/evidence-archive/inbox/again') -Force
[IO.File]::WriteAllText((Join-Path $foreignInbox 'old/evidence-archive/inbox/again/record.json'),'broken nested record',$utf8)
$null=New-Item -ItemType Directory -Path (Join-Path $wholeArchive 'tools') -Force
[IO.File]::WriteAllText((Join-Path $wholeArchive 'tools/import-local-test-evidence.ps1'),"throw 'Foreign tool executed'",$utf8)
$null=New-Item -ItemType Directory -Path (Join-Path $root 'tools') -Force
$ownTool=Join-Path $root 'tools/import-local-test-evidence.ps1'
[IO.File]::WriteAllText($ownTool,'receiver tool sentinel',$utf8)
$ownToolHash=(Get-FileHash $ownTool).Hash
$loop=Join-Path $foreignInbox 'cycle'
$null=New-Item -ItemType Junction -Path $loop -Target $wholeArchive
try{
  $wholeOutput=(& $importer -Project $receiver -Batch whole -Contributor Carol -Apply | Out-String)
  if($wholeOutput -notmatch 'Skipped received subtree.*inbox' -or (Test-EvidenceCatalog $root) -ne 7){throw 'Whole archive import did not skip the donor inbox or import only new records'}
}finally{
  $loopFull=[IO.Path]::GetFullPath($loop)
  if(!$loopFull.StartsWith($workRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or !((Get-Item -LiteralPath $loopFull -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe loop fixture cleanup'}
  [IO.Directory]::Delete($loopFull)
}
if((Get-FileHash $ownTool).Hash -ne $ownToolHash -or (Test-Path (Join-Path $root 'evidence-archive'))){throw 'Foreign tool overwritten or nested formal archive created'}
$wholeAudit=@(Get-EvidenceRecords $root|Where-Object {$_.relative -like 'maintenance/*_local-evidence-import_*'} | Where-Object {(Get-Content (Join-Path $_.source 'original/receipt.json') -Raw|ConvertFrom-EvidenceJson).batch -eq 'whole'})[0]
$wholeReceipt=Get-Content (Join-Path $wholeAudit.source 'original/receipt.json') -Raw|ConvertFrom-EvidenceJson
if(!$wholeReceipt.sourceCatalogs -or !$wholeReceipt.skippedSubtrees -or $wholeReceipt.records.Count -ne 4){throw 'Donor catalogs or skipped-tree provenance missing'}
Write-Output 'PASS: whole archives flatten sealed records while skipping cyclic inboxes, foreign tools and pending data'

$stableHash=(Get-FileHash $catalog).Hash
$wrappedParent=Join-Path $root 'inbox/wrapped/records/export/evidence-archive'
$null=New-Item -ItemType Directory -Path $wrappedParent -Force
Copy-Item -LiteralPath (Get-EvidenceRoot $sender) -Destination (Join-Path $wrappedParent 'evidence-archive') -Recurse
# Also tolerate an accidental archive-inside-archive alongside a valid catalog.
$wrappedArchive=Join-Path $wrappedParent 'evidence-archive'
Copy-Item -LiteralPath (Get-EvidenceRoot $sender) -Destination (Join-Path $wrappedArchive 'evidence-archive') -Recurse
& $importer -Project $receiver -Batch wrapped -Contributor Carol -Apply | Out-Null
if((Get-FileHash $catalog).Hash -ne $stableHash -or (Test-EvidenceCatalog $root) -ne 7){throw 'Nested copies produced duplicate records or audits'}
Write-Output 'PASS: nested archive wrappers and repeated whole-archive transfers remain finite and idempotent'

$badParent=Join-Path $root 'inbox/bad-catalog/records'
$null=New-Item -ItemType Directory -Path $badParent -Force
$badArchive=Join-Path $badParent 'evidence-archive'
Copy-Item -LiteralPath (Get-EvidenceRoot $sender) -Destination $badArchive -Recurse
$badCatalog=Get-Content (Join-Path $badArchive 'catalog.json') -Raw|ConvertFrom-EvidenceJson
$badCatalog.records[0].checksumsSha256='0'*64
[IO.File]::WriteAllText((Join-Path $badArchive 'catalog.json'),($badCatalog|ConvertTo-Json -Depth 10),$utf8)
Reject {& $importer -Project $receiver -Batch bad-catalog -Contributor Carol -Apply} 'Received catalog checksum mismatch'
if((Get-FileHash $catalog).Hash -ne $stableHash){throw 'Bad donor catalog changed local ledger'}
Write-Output 'PASS: donor catalog integrity is checked without replacing the local index'

$missingParent=Join-Path $root 'inbox/missing-catalog/records/evidence-archive'
$null=New-Item -ItemType Directory -Path (Join-Path $missingParent 'tests/local') -Force
$null=Copy-Received no-catalog $local
Copy-Item -LiteralPath $local -Destination (Join-Path $missingParent ('tests/local/'+(Split-Path -Leaf $local))) -Recurse
Reject {& $importer -Project $receiver -Batch missing-catalog -Contributor Carol -Apply} 'Received archive catalog missing'
if((Get-FileHash $catalog).Hash -ne $stableHash){throw 'Missing donor catalog changed local ledger'}
Write-Output 'PASS: an incomplete whole archive is rejected instead of silently importing unregistered data'
