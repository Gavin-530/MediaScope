param([Parameter(Mandatory=$true)][string]$Work)
$ErrorActionPreference='Stop'
$sourceProject=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
. (Join-Path $sourceProject 'scripts/github-evidence-lib.ps1')
$project=Assert-EvidencePath $sourceProject $Work
if(!$project.StartsWith((Join-Path $sourceProject 'test-work')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Test outside sandbox'}
function Reject($Body,$Pattern){
  $message=$null;try{& $Body|Out-Null}catch{$message=$_.Exception.Message}
  if(!$message -or $message -notmatch $Pattern){throw "Expected $Pattern, received $message"}
}
$old=Join-Path $project 'local-test-archive'
$id='20260930T123456789Z-1234abcd'
$logical="runs/0.2.2/$id"
$raw=Join-Path $old $logical
$null=New-Item -ItemType Directory -Path $raw -Force
[IO.File]::WriteAllText((Join-Path $raw 'output.log'),'Protocol fixture: no media executed.')
$m=@{schema=2;kind='Custom';version='0.2.2';runId=$id;outcome='failed';exitCode=1;log=@{file='output.log';storedBytes=(Get-Item (Join-Path $raw 'output.log')).Length;sha256=(Get-FileHash (Join-Path $raw 'output.log')).Hash}}
[IO.File]::WriteAllText((Join-Path $raw 'manifest.json'),($m|ConvertTo-Json -Depth 8))
Write-EvidenceChecksums $raw
Add-EvidenceCatalogRecord $old @{source=$raw;relative=$logical}
$before=(Get-FileHash (Join-Path $raw 'SHA256SUMS.txt')).Hash
& (Join-Path $sourceProject 'scripts/migrate-test-evidence.ps1') -Project $project -Apply -KeepLegacyLayout | Out-Null
$root=Get-EvidenceRoot $project
if((Test-EvidenceCatalog $root) -ne 2){throw 'Migration lost records or maintenance audit'}
$preserved=Join-Path $root ('legacy/local-test-archive/'+$logical)
if((Get-FileHash (Join-Path $preserved 'SHA256SUMS.txt')).Hash -ne $before -or (Test-Path $old)){throw 'Legacy bytes/location changed incorrectly'}
$legacyCatalog=Join-Path $root 'legacy/local-test-archive/catalog.json'
$catalogBytes=[IO.File]::ReadAllBytes($legacyCatalog)
[IO.File]::WriteAllText($legacyCatalog,'{}')
Reject {Test-EvidenceCatalog $root} 'Legacy evidence catalog checksum mismatch'
[IO.File]::WriteAllBytes($legacyCatalog,$catalogBytes)
$null=Test-EvidenceCatalog $root
Write-Output 'PASS: actual migration preserves original bytes, old identity and catalog plus migration audit'
$staging=Join-Path (Get-EvidencePendingRoot $project) 'staging/custom'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $staging) -Force
Copy-Item -LiteralPath $preserved -Destination $staging -Recurse
$priorActions=[Environment]::GetEnvironmentVariable('GITHUB_ACTIONS')
try {
  $env:GITHUB_ACTIONS='true'
  $published=Publish-EvidenceRecord $project $staging $logical
} finally {[Environment]::SetEnvironmentVariable('GITHUB_ACTIONS',$priorActions)}
if(!$published.StartsWith((Join-Path $root 'records')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Host environment changed local evidence provenance'}
if(!(Test-Path (Join-Path $published 'README.md')) -or (Get-FileHash (Join-Path $published 'original/SHA256SUMS.txt')).Hash -ne $before){throw 'Envelope modified original data'}
$null=Test-EvidenceCatalog $root
Write-Output 'PASS: readable timestamp envelope preserves original data and failed status'
Write-Output 'PASS: local-origin evidence stays local when published on a GitHub Actions host'
$r=Get-Content (Join-Path $published 'record.json') -Raw| ConvertFrom-EvidenceJson
$r.outcome='passed'
[IO.File]::WriteAllText((Join-Path $published 'record.json'),($r|ConvertTo-Json -Depth 8))
Write-EvidenceChecksums $published
Reject {Test-EvidenceRecord $published $r.path} 'Envelope/original mismatch'
Write-Output 'PASS: recomputed outer checksums cannot promote original failed evidence'
$r.outcome='failed';[IO.File]::WriteAllText((Join-Path $published 'record.json'),($r|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $published
# Refresh only the synthetic fixture's registered checksum, never a product archive.
$c=Get-Content (Join-Path $root 'catalog.json') -Raw| ConvertFrom-EvidenceJson
($c.records|Where-Object {$_.path -eq $r.path}).checksumsSha256=(Get-FileHash (Join-Path $published 'SHA256SUMS.txt')).Hash
[IO.File]::WriteAllText((Join-Path $root 'catalog.json'),($c|ConvertTo-Json -Depth 8))
$held=Join-Path (Get-EvidencePendingRoot $project) 'interrupted'
$null=New-Item -ItemType Directory -Path $held
[IO.File]::WriteAllText((Join-Path $held 'unique.log'),'Pending evidence is not cache.')
$null=Test-EvidenceCatalog $root
if(!(Test-Path (Join-Path $held 'unique.log'))){throw 'Pending evidence disappeared'}
Reject {Get-EvidenceDestination $project 'runs/0.2.2/invalid'} 'UTC run identifier'
Write-Output 'PASS: pending evidence remains protected and malformed new identities are rejected'
$extra=Join-Path $root 'unexpected'
$null=New-Item -ItemType Directory -Path $extra
Reject {Test-EvidenceCatalog $root} 'Unexpected archive root'
Write-Output 'PASS: unclassified archive directories are rejected by catalog validation'

# Inject a ledger failure only into this isolated filesystem fixture.
$logical2='runs/0.2.2/20260930T123456789Z-87654321'
$stage2=Join-Path (Get-EvidencePendingRoot $project) 'staging/interrupted'
$null=New-Item -ItemType Directory -Path $stage2 -Force
Copy-Item -LiteralPath (Join-Path $preserved 'output.log') -Destination $stage2
$m.runId='20260930T123456789Z-87654321'
[IO.File]::WriteAllText((Join-Path $stage2 'manifest.json'),($m|ConvertTo-Json -Depth 8))
$realAdd=(Get-Item Function:Add-EvidenceCatalogRecord).ScriptBlock
Set-Item -LiteralPath Function:Add-EvidenceCatalogRecord -Value {throw 'Injected ledger interruption'}
Reject {Publish-EvidenceRecord $project $stage2 $logical2} 'ledger interruption'
Set-Item -LiteralPath Function:Add-EvidenceCatalogRecord -Value $realAdd
$final2=Get-EvidenceDestination $project $logical2
$relative2=$final2.Substring($root.Length+1).Replace('\','/')
$null=Test-EvidenceRecord $final2 $relative2
if(!(Test-Path (Join-Path $final2 'original/output.log'))){throw 'Interrupted ledger update lost original evidence'}
# Extra root directory was deliberately created above; no recursive deletion.
Remove-Item -LiteralPath $extra
Add-EvidenceCatalogRecord $root @{source=$final2;relative=$relative2}
$null=Test-EvidenceCatalog $root
Write-Output 'PASS: interrupted publication retains original evidence and can register without rerunning tests'

function New-OrganizationFixture($Base){
  $null=New-Item -ItemType Directory -Path $Base -Force
  $root2=Initialize-EvidenceArchive $Base
  $legacy2=Join-Path $root2 'legacy/local-test-archive'
  $product=Join-Path $legacy2 'runs/0.2.2/20260930T123456789Z-abcdef12'
  $null=New-Item -ItemType Directory -Path $product -Force
  [IO.File]::WriteAllText((Join-Path $product 'output.log'),'Failed synthetic protocol check.')
  $pm=@{schema=2;kind='Custom';version='0.2.2';runId='20260930T123456789Z-abcdef12';outcome='failed';exitCode=1;log=@{file='output.log';storedBytes=(Get-Item (Join-Path $product 'output.log')).Length;sha256=(Get-FileHash (Join-Path $product 'output.log')).Hash}}
  [IO.File]::WriteAllText((Join-Path $product 'manifest.json'),($pm|ConvertTo-Json -Depth 8))
  Write-EvidenceChecksums $product
  Add-EvidenceCatalogRecord $legacy2 @{source=$product;relative='runs/0.2.2/20260930T123456789Z-abcdef12'}
  $maintenance=Join-Path $legacy2 'test-system-audit-20260930T123457789Z-abcdef13'
  $null=New-Item -ItemType Directory -Path $maintenance -Force
  [IO.File]::WriteAllText((Join-Path $maintenance 'manifest.json'),'{"schema":1,"kind":"test-system-audit","note":"Fixture audit, not product results"}')
  Write-EvidenceChecksums $maintenance
  Add-EvidenceCatalogRecord $legacy2 @{source=$maintenance;relative='test-system-audit-20260930T123457789Z-abcdef13'}
  $unknown=Join-Path $legacy2 'release-verification-2026-09-29-v0.2.0'
  $null=New-Item -ItemType Directory -Path $unknown -Force
  [IO.File]::WriteAllText((Join-Path $unknown 'report.md'),'Mixed historical release material; no structured run evidence.')
  Write-EvidenceChecksums $unknown
  Add-EvidenceCatalogRecord $legacy2 @{source=$unknown;relative='release-verification-2026-09-29-v0.2.0'}
  $c2=@{schema=2;legacyCatalogSha256=(Get-FileHash (Join-Path $legacy2 'catalog.json')).Hash;records=@(Get-EvidenceRecords $legacy2|ForEach-Object {Get-EvidenceCatalogEntry @{source=$_.source;relative='legacy/local-test-archive/'+$_.relative}})}
  [IO.File]::WriteAllText((Join-Path $root2 'catalog.json'),($c2|ConvertTo-Json -Depth 8))
  $modern=Join-Path $root2 'maintenance/2026-09-30T12-34-58.789Z-abcdef14'
  $null=New-Item -ItemType Directory -Path (Join-Path $modern 'original') -Force
  [IO.File]::WriteAllText((Join-Path $modern 'original/manifest.json'),'{"schema":1,"kind":"test-system-audit","note":"Already sealed fixture"}')
  Write-EvidenceChecksums (Join-Path $modern 'original')
  Write-EvidenceEnvelope $modern 'maintenance/2026-09-30T12-34-58.789Z-abcdef14' 'test-system-audit-20260930T123458789Z-abcdef14'
  Add-EvidenceCatalogRecord $root2 @{source=$modern;relative='maintenance/2026-09-30T12-34-58.789Z-abcdef14'}
  if((Test-EvidenceCatalog $root2) -ne 4){throw 'Invalid organization fixture'}
  return $root2
}
$organizedProject=Join-Path $project 'organized'
$organizedRoot=New-OrganizationFixture $organizedProject
& (Join-Path $sourceProject 'scripts/organize-test-evidence.ps1') -Project $organizedProject -Apply|Out-Null
if((Test-EvidenceCatalog $organizedRoot) -ne 5 -or (Test-Path (Join-Path $organizedRoot 'legacy/local-test-archive'))){throw 'Historical records were not classified'}
$audit3=@(Get-EvidenceRecords $organizedRoot|Where-Object {$_.relative -match '_archive-organization_'})[0]
$receipt=Get-Content (Join-Path $audit3.source 'original/manifest.json') -Raw| ConvertFrom-EvidenceJson
foreach($entry in $receipt.mapping){
  $preservedRoot=Join-Path $organizedRoot $entry.newPath
  if($entry.operation -eq 'wrap'){$preservedRoot=Join-Path $preservedRoot 'original'}
  foreach($file in $entry.inventory){
    if((Get-FileHash (Join-Path $preservedRoot $file.path)).Hash -ne $file.sha256){throw 'Organization changed original or sealed bytes'}
  }
}
$beforeCatalog=(Get-FileHash (Join-Path $organizedRoot 'catalog.json')).Hash
& (Join-Path $sourceProject 'scripts/organize-test-evidence.ps1') -Project $organizedProject -Apply|Out-Null
if((Get-FileHash (Join-Path $organizedRoot 'catalog.json')).Hash -ne $beforeCatalog){throw 'Repeated organization altered archive'}
Write-Output 'PASS: classification preserves every original and sealed byte and repeated organization is idempotent'
$collection=@(Get-EvidenceRecords $organizedRoot|Where-Object {$_.relative -match '/undated_release-materials_'})[0]
$ur=Get-Content (Join-Path $collection.source 'record.json') -Raw| ConvertFrom-EvidenceJson
if($ur.startedAtUtc -or $ur.outcome -ne 'unknown'){throw 'Historical collection acquired fabricated time/result'}
$ur.outcome='passed'
[IO.File]::WriteAllText((Join-Path $collection.source 'record.json'),($ur|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $collection.source
Reject {Test-EvidenceRecord $collection.source $collection.relative} 'Invalid unstructured historical evidence'
$ur.outcome='unknown'
[IO.File]::WriteAllText((Join-Path $collection.source 'record.json'),($ur|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $collection.source
$historicCatalog=Join-Path $audit3.source 'original/original-legacy-catalog.json'
$historicBytes=[IO.File]::ReadAllBytes($historicCatalog)
[IO.File]::WriteAllText($historicCatalog,'{}')
Reject {Test-EvidenceCatalog $organizedRoot} 'Historical evidence catalog checksum mismatch'
[IO.File]::WriteAllBytes($historicCatalog,$historicBytes)
Write-Output 'PASS: unknown historical results cannot become passed and retired catalogs remain protected'
# Fault injection is confined to a copied script and a separate synthetic project.
$rollbackProject=Join-Path $project 'rollback'
$rollbackRoot=New-OrganizationFixture $rollbackProject
$rollbackCatalog=[IO.File]::ReadAllBytes((Join-Path $rollbackRoot 'catalog.json'))
$scripts2=Join-Path $rollbackProject 'scripts'
$null=New-Item -ItemType Directory -Path $scripts2 -Force
Copy-Item -LiteralPath (Join-Path $sourceProject 'scripts/evidence-lib.ps1') -Destination $scripts2
$body=Get-Content (Join-Path $sourceProject 'scripts/organize-test-evidence.ps1') -Raw
$commitLine='[IO.File]::Replace($candidate,$catalogPath,(Join-Path $tx ''catalog-old.json''))'
if(!$body.Contains($commitLine)){throw 'Fault injection target absent'}
$body=$body.Replace($commitLine,"throw 'Injected catalog interruption'")
$copiedScript=Join-Path $scripts2 'organize-test-evidence.ps1'
[IO.File]::WriteAllText($copiedScript,$body,(New-Object Text.UTF8Encoding($false)))
Reject {& $copiedScript -Project $rollbackProject -Apply} 'Injected catalog interruption'
if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $rollbackRoot 'catalog.json'))) -ne [Convert]::ToBase64String($rollbackCatalog) -or (Test-EvidenceCatalog $rollbackRoot) -ne 4){throw 'Interrupted transaction did not restore original registry/records'}
Write-Output 'PASS: failure before catalog commit rolls back original locations and keeps staged diagnostic copies'

# Precision cases use raw identifiers; no filesystem timestamps are evidence.
. (Join-Path $sourceProject 'scripts/evidence-lib.ps1')
. (Join-Path $sourceProject 'scripts/github-evidence-lib.ps1')
$precisionProject=Join-Path $project 'precision'
$precisionRoot=Initialize-EvidenceArchive $precisionProject
$cases=@(
  @{id='20261001T102030220Z-1234ab01';name='2026-10-01T10-20-30.220Z-1234ab01';precision='millisecond';zone='UTC';started='2026-10-01T10:20:30.220Z'},
  @{id='20261001T102030Z-1234ab02';name='2026-10-01T10-20-30Z-1234ab02';precision='second';zone='UTC';started='2026-10-01T10:20:30Z'},
  @{id='20261001-1234ab03';name='2026-10-01-1234ab03';precision='day';zone=$null;started=$null},
  @{id='undated-1234ab04';name='undated-1234ab04';precision='unknown';zone=$null;started=$null}
)
foreach($case in $cases){
  $stage=Join-Path (Get-EvidencePendingRoot $precisionProject) ('staging/'+$case.id)
  $null=New-Item -ItemType Directory -Path $stage -Force
  [IO.File]::WriteAllText((Join-Path $stage 'output.log'),'Failed protocol fixture, no media executed.')
  $manifest4=@{schema=2;kind='Custom';version='0.2.2';runId=$case.id;outcome='failed';exitCode=1;startedAtUtc=$case.started;log=@{file='output.log';storedBytes=(Get-Item (Join-Path $stage 'output.log')).Length;sha256=(Get-FileHash (Join-Path $stage 'output.log')).Hash}}
  [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'),($manifest4|ConvertTo-Json -Depth 8))
  $manifestBytes=[IO.File]::ReadAllBytes((Join-Path $stage 'manifest.json'))
  $path4=Publish-EvidenceRecord $precisionProject $stage ('runs/0.2.2/'+$case.id)
  $r4=Get-Content (Join-Path $path4 'record.json') -Raw| ConvertFrom-EvidenceJson
  if((Split-Path -Leaf $path4) -ne $case.name -or $r4.schema -ne 3 -or $r4.identifierTimePrecision -ne $case.precision -or $r4.identifierTimeZone -ne $case.zone -or
     [Convert]::ToBase64String($manifestBytes) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $path4 'original/manifest.json')))){throw 'Precision or original manifest changed'}
  $maintenancePath=Get-EvidenceDestination $precisionProject ('test-system-audit-'+$case.id)
  if((Split-Path -Leaf $maintenancePath) -ne ($case.name.Substring(0,$case.name.Length-9)+'_test-system-audit_'+$case.id.Substring($case.id.Length-8))){throw 'Maintenance label assumes fixed timestamp width'}
}
if((Test-EvidenceCatalog $precisionRoot) -ne 4){throw 'Precision records not all valid'}
Write-Output 'PASS: millisecond, second, day and unknown identities publish without invented digits or timezone'
$second=Join-Path $precisionRoot 'records/2026-10-01T10-20-30Z-1234ab02'
$recordBytes=[IO.File]::ReadAllBytes((Join-Path $second 'record.json'))
$sumBytes=[IO.File]::ReadAllBytes((Join-Path $second 'SHA256SUMS.txt'))
$r4=Get-Content (Join-Path $second 'record.json') -Raw| ConvertFrom-EvidenceJson
$r4.path='tests/local/2026-10-01T10-20-30.000Z-1234ab02';$r4.identifierTime='2026-10-01T10:20:30.000Z';$r4.identifierTimePrecision='millisecond'
[IO.File]::WriteAllText((Join-Path $second 'record.json'),($r4|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $second
Reject {Test-EvidenceRecord $second $r4.path} 'Envelope time provenance mismatch'
[IO.File]::WriteAllBytes((Join-Path $second 'record.json'),$recordBytes)
[IO.File]::WriteAllBytes((Join-Path $second 'SHA256SUMS.txt'),$sumBytes)
$r4=Get-Content (Join-Path $second 'record.json') -Raw| ConvertFrom-EvidenceJson
$r4.startedAtUtc='2026-10-01T10:20:30.000Z'
[IO.File]::WriteAllText((Join-Path $second 'record.json'),($r4|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $second
Reject {Test-EvidenceRecord $second $r4.path} 'Envelope time provenance mismatch'
[IO.File]::WriteAllBytes((Join-Path $second 'record.json'),$recordBytes)
[IO.File]::WriteAllBytes((Join-Path $second 'SHA256SUMS.txt'),$sumBytes)
$null=Test-EvidenceCatalog $precisionRoot
Write-Output 'PASS: rehashed wrappers cannot pad seconds with guessed milliseconds or change original start time'
foreach($bad in @('20260230-1234ab01','20260229-1234ab01','20261001T246099Z-1234ab01','20261001T10203022Z-1234ab01','undated','not-a-time')){
  $failed=$false;try{Get-EvidenceRunTime $bad|Out-Null}catch{$failed=$true}
  if(!$failed){throw "Invalid calendar/identifier accepted: $bad"}
}
if((Get-EvidenceRunTime '20240229-1234ab01').value -ne '2024-02-29'){throw 'Leap date rejected'}
if((Format-EvidenceBeijingTime '2026-10-01T10:20:30Z') -ne '2026-10-01 18:20:30 +08:00' -or
   (Format-EvidenceBeijingTime '2026-10-01T10:20:30.220Z') -ne '2026-10-01 18:20:30.220 +08:00' -or
   (Format-EvidenceBeijingTime '2026-10-01T10:20:30.1234567Z') -ne '2026-10-01 18:20:30.1234567 +08:00' -or
   (Format-EvidenceBeijingTime '2026-10-01') -notmatch 'date only; timezone unspecified' -or
   (Format-EvidenceBeijingTime 'invalid') -notmatch '^unknown' -or
   (Format-EvidenceBeijingTime $null) -ne 'unknown'){throw 'Display invented precision or timezone'}
Write-Output 'PASS: real calendar validation rejects malformed dates and displays preserve source fractional precision'
$cloudPrecision=Join-Path (Get-EvidencePendingRoot $precisionProject) 'cloud-time-fixture'
$null=New-Item -ItemType Directory -Path $cloudPrecision -Force
$cm=@{schema=1;kind='github-actions-evidence';bundleId='20261001T102030Z-1234ab05';testStepOutcome='failure';github=@{repository='Gavin-530/MediaScope';runId='101';runAttempt='1';sha=('a'*40)}}
[IO.File]::WriteAllText((Join-Path $cloudPrecision 'manifest.json'),($cm|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $cloudPrecision
if((Test-GitHubEvidenceBundle $cloudPrecision).bundleId -ne $cm.bundleId){throw 'Cloud bundle rejected legitimate second precision'}
$cm.testStepOutcome='success'
[IO.File]::WriteAllText((Join-Path $cloudPrecision 'manifest.json'),($cm|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $cloudPrecision
Reject {Test-GitHubEvidenceBundle $cloudPrecision} 'Successful CI requires exactly one'
Write-Output 'PASS: cloud time compatibility retains repository/run checks and never relaxes successful CI evidence gates'

# Flatten an already sealed old layout, including cloud provenance and a
# registered historical catalog, without regenerating any sealed file.
$flatProject=Join-Path $project 'flat-layout'
$flatRoot=Initialize-EvidenceArchive $flatProject
$cm.testStepOutcome='failure'
[IO.File]::WriteAllText((Join-Path $cloudPrecision 'manifest.json'),($cm|ConvertTo-Json -Depth 8));Write-EvidenceChecksums $cloudPrecision
$fixtures=@(
  @{source=(Join-Path $published 'original');path='tests/local/2026-09-30T12-34-56.789Z-1234abcd';logical=$logical},
  @{source=$cloudPrecision;path='tests/github-actions/2026-10-01T10-20-30Z-1234ab05';logical=('github-actions-'+$cm.bundleId)},
  @{source=(Join-Path $audit3.source 'original');path=('maintenance/'+(Split-Path -Leaf $audit3.source));logical=(Get-Content (Join-Path $audit3.source 'record.json') -Raw|ConvertFrom-EvidenceJson).originalRelative}
)
$oldHashes=@{}
$longWriter=Join-Path $project 'long-path-fixture.cjs'
[IO.File]::WriteAllText($longWriter,'const fs=require("fs"),path=require("path");fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],process.argv[3]);')
foreach($entry in $fixtures){
  $target=Join-Path $flatRoot $entry.path
  $null=New-Item -ItemType Directory -Path $target -Force
  Copy-Item -LiteralPath $entry.source -Destination (Join-Path $target 'original') -Recurse
  if($entry.path.StartsWith('tests/local/')){
    $longFile=Join-Path (Join-Path $target 'original') (('a'*75)+'/'+('b'*75)+'/existing-long-path.txt')
    & node.exe $longWriter $longFile 'Existing long sealed file'
    if($LASTEXITCODE -ne 0){throw 'Long path fixture creation failed'}
    Write-EvidenceChecksums (Join-Path $target 'original')
  }
  Write-EvidenceEnvelope $target $entry.path $entry.logical
  Add-EvidenceCatalogRecord $flatRoot @{source=$target;relative=$entry.path}
  $oldHashes[$entry.path]=(Get-FileHash (Join-Path $target 'SHA256SUMS.txt')).Hash
}
$oldIndex=Get-Content (Join-Path $flatRoot 'catalog.json') -Raw|ConvertFrom-EvidenceJson
$oldIndex.PSObject.Properties.Remove('layout')
$historyPath=$fixtures[2].path+'/original/original-legacy-catalog.json'
$oldIndex|Add-Member -MemberType NoteProperty -Name historicalCatalogs -Value @(@{path=$historyPath;sha256=(Get-FileHash (Join-Path $flatRoot $historyPath)).Hash})
[IO.File]::WriteAllText((Join-Path $flatRoot 'catalog.json'),($oldIndex|ConvertTo-Json -Depth 8))
& (Join-Path $sourceProject 'scripts/organize-test-evidence.ps1') -Project $flatProject -Apply|Out-Null
if((Test-EvidenceCatalog $flatRoot) -ne 4){throw 'Flat migration lost sealed records or catalog history'}
foreach($entry in $fixtures){
  $flatPath=Get-EvidenceFlatLocation $entry.path
  if((Get-FileHash (Join-Path (Join-Path $flatRoot $flatPath) 'SHA256SUMS.txt')).Hash -ne $oldHashes[$entry.path]){throw 'Flat migration changed sealed bytes'}
}
$null=Initialize-EvidenceArchive $flatProject
if((Test-Path (Join-Path $flatRoot 'tests')) -or (Test-Path (Join-Path $flatRoot 'maintenance')) -or (Test-Path (Join-Path $flatRoot 'README.md')) -or (Test-Path (Join-Path $flatRoot 'fixtures'))){throw 'Initialization recreated scattered categories or duplicate documentation'}
Write-Output 'PASS: sealed local and cloud records flatten byte-exactly with catalog history and initialization never recreates old categories or a rule README'

$lengtheningProject=Join-Path $project 'lengthening'
$lengtheningRoot=Initialize-EvidenceArchive $lengtheningProject
$oldAudit=Join-Path $lengtheningRoot ('maintenance/'+((Split-Path -Leaf $audit3.source) -replace '_archive-organization_','-'))
$null=New-Item -ItemType Directory -Path $oldAudit -Force
Copy-Item -LiteralPath (Join-Path $audit3.source 'original') -Destination (Join-Path $oldAudit 'original') -Recurse
$longFile=Join-Path (Join-Path $oldAudit 'original') (('a'*75)+'/'+('b'*75)+'/existing-long-path.txt')
& node.exe $longWriter $longFile 'Do not lengthen this file path'
if($LASTEXITCODE -ne 0){throw 'Lengthening fixture creation failed'}
Write-EvidenceChecksums (Join-Path $oldAudit 'original')
$oldAuditRelative=$oldAudit.Substring($lengtheningRoot.Length+1).Replace('\','/')
Write-EvidenceEnvelope $oldAudit $oldAuditRelative $fixtures[2].logical
Add-EvidenceCatalogRecord $lengtheningRoot @{source=$oldAudit;relative=$oldAuditRelative}
$lengtheningHash=(Get-FileHash (Join-Path $lengtheningRoot 'catalog.json')).Hash
Reject {& (Join-Path $sourceProject 'scripts/organize-test-evidence.ps1') -Project $lengtheningProject -Apply} 'introduce or lengthen'
if(!(Test-Path $oldAudit) -or (Get-FileHash (Join-Path $lengtheningRoot 'catalog.json')).Hash -ne $lengtheningHash){throw 'Long path refusal mutated sealed records or the catalog'}
Write-Output 'PASS: shortening existing long sealed paths is allowed while extending them is refused before any records move'
