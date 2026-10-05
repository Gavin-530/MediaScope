import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {TARGET,initialize,seal,verifySnapshot,verifyArchive,tree,inside,safeRelative,assertRoot,lock,hash,readJson,writeJson,insideCleanup} from './github-archive-store.mjs';
import {GitHubReader,apiUrl,downloadUrl} from './github-archive-api.mjs';
import {mergeCopy,preparedRecord} from './github-archive-migration.mjs';
import {repositoryGraphql} from './github-archive-graphql.mjs';
import {sync,attachments} from './github-archive-collect.mjs';
import {preparePrune,applyPrune,restorePrunedSource} from './github-archive-prune.mjs';
import {evidenceIdentity} from './github-archive-migration.mjs';
import {boundaryBaseline} from './github-archive-migration.mjs';
import {canonical,exists} from './github-archive-store.mjs';
import {capacityWarnings,capacityReport} from './github-archive-capacity.mjs';

const owned=path.resolve('.build/github-archive-tests');
async function fixture(t){await fs.mkdir(owned,{recursive:true});const dir=await fs.mkdtemp(path.join(owned,'case-'));await initialize(dir,TARGET);t.after(async()=>{inside(owned,dir);await fs.rm(dir,{recursive:true})});return dir}
test('capacity warnings report storage pressure without removing sealed or pending data',async t=>{
  assert.deepEqual(capacityWarnings({freeBytes:1024**3,formalBytes:0,pendingBytes:0}),[]);
  assert.deepEqual(capacityWarnings({freeBytes:0,formalBytes:1024**3,pendingBytes:512*1024**2}),['free-space-below-1-GiB','formal-archive-at-least-1-GiB','pending-at-least-512-MiB']);
  const root=await fixture(t);await seal(root,'actions/123',{'run.json':{id:123}});await fs.mkdir(path.join(root,'pending/test'));await fs.writeFile(path.join(root,'pending/test/keep.txt'),'pending original');
  const before=await tree(root),report=await capacityReport(root);assert.equal(report.pendingBytes,16);assert.ok(report.formalBytes>0);assert.deepEqual(await tree(root),before);
});
test('transport result uses its structured record instead of diagnostic stdout and refuses escaping paths',async t=>{
  const receiver=await fixture(t),record=path.join(receiver,'evidence-archive/records/protocol-record');await fs.mkdir(record,{recursive:true});
  const resultFile=path.join(receiver,'prepared-record.json');
  await writeJson(resultFile,{schema:1,record:'evidence-archive/records/protocol-record'});assert.equal(await preparedRecord(receiver),record);
  for(const value of ['../outside','evidence-archive/records/../outside',record,'evidence-archive/records/protocol-record/nested']){
    await writeJson(resultFile,{schema:1,record:value});await assert.rejects(preparedRecord(receiver),/Invalid prepared record/);
  }
  const outside=await fixture(t);await fs.rm(record,{recursive:true});await fs.symlink(outside,record,'junction');
  await writeJson(resultFile,{schema:1,record:'evidence-archive/records/protocol-record'});await assert.rejects(preparedRecord(receiver),/Linked archive path/);
});
async function documentationProject(t){
  const project=await fixture(t),scripts=path.join(project,'scripts');await fs.mkdir(scripts);
  for(const name of (await fs.readdir('scripts')).filter(name=>/^github-archive.*\.mjs$/.test(name)&&!name.endsWith('.test.mjs')))await fs.copyFile(path.resolve('scripts',name),path.join(scripts,name));
  await fs.mkdir(path.join(project,'docs'));await fs.copyFile(path.resolve('docs/data-and-archives.md'),path.join(project,'docs/data-and-archives.md'));
  await fs.writeFile(path.join(project,'.gitignore'),'/local-notes/\n/github-archive/\n');
  execFileSync('git',['init','--quiet',project],{windowsHide:true});
  // Isolated protocol metadata only; no network or product verification claim.
  const inventory=path.join(project,'.build/github-archive-implementation');
  await writeJson(path.join(inventory,'protocol.json'),{target:TARGET,remote:{state:'checked',identity:TARGET},records:[]});
  await writeJson(path.join(inventory,'latest-inventory.json'),{path:'protocol.json'});
  return project;
}
test('real archive CLI initializes an offline guide from the consolidated document without removed source paths',async t=>{
  const project=await documentationProject(t),entry=path.join(project,'scripts/github-archive.mjs');
  execFileSync(process.execPath,[entry,'migrate'],{encoding:'utf8',windowsHide:true,timeout:30000});
  const guide=await fs.readFile(path.join(project,'github-archive/README.md'),'utf8');
  assert.match(guide,/1377031380/);assert.match(guide,/verification-tools/);assert.match(guide,/RestoreSource/);
  assert.ok(!guide.includes('## 软件运行数据'));assert.ok(!guide.includes('github-archive-readme:start'));
  assert.equal(await exists(path.join(project,'docs/github-archive.md')),false);
  await fs.writeFile(path.join(project,'github-archive/README.md'),guide+'\nretained local reading note\n');
  execFileSync(process.execPath,[entry,'migrate'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(await fs.readFile(path.join(project,'github-archive/README.md'),'utf8'),guide+'\nretained local reading note\n');
});
test('real archive CLI refuses forced Git tracking of local notes before archive writes',async t=>{
  const project=await documentationProject(t),note=path.join(project,'local-notes/private-plan.md');
  await fs.mkdir(path.dirname(note));await fs.writeFile(note,'private protocol note');
  execFileSync('git',['-C',project,'add','--force','--','local-notes/private-plan.md'],{windowsHide:true});
  assert.throws(()=>execFileSync(process.execPath,[path.join(project,'scripts/github-archive.mjs'),'migrate'],{encoding:'utf8',windowsHide:true,timeout:30000,stdio:'pipe'}),error=>/implementation plan is tracked by Git/.test(error.stderr));
  assert.equal(await exists(path.join(project,'github-archive')),false);
  assert.equal(await fs.readFile(note,'utf8'),'private protocol note');
});
async function pruneFixture(t){
  const project=await fixture(t),root=path.join(project,'github-archive');await initialize(root,TARGET);
  const relative='records/protocol-cloud',source='evidence-archive/'+relative,dir=path.join(project,source);
  await fs.mkdir(dir,{recursive:true});await writeJson(path.join(dir,'manifest.json'),{kind:'App',github:{repository:TARGET.repository,runId:'123',runAttempt:'1',sha:'a'.repeat(40),job:'full-regression'}});
  await fs.writeFile(path.join(dir,'SHA256SUMS.txt'),'isolated removal protocol; not a product result\n');await fs.mkdir(path.join(dir,'nested'));await fs.writeFile(path.join(dir,'nested/result.txt'),'protocol source bytes');
  const files=await tree(dir),originalContentSha256=hash(JSON.stringify(canonical(files))),identity=await evidenceIdentity(dir,relative);
  const content={'provenance.json':{format:1,...TARGET,source:'local-migration',sourcePath:source,identity,originalContentSha256}};
  for(const file of files)content['original/'+file.path]={archiveSourceFile:path.join(dir,file.path)};
  const stored=await seal(root,'actions/123/attempts/1/evidence/'+originalContentSha256.slice(0,20),content);
  await writeJson(path.join(root,'pending','migration-journal.json'),{format:1,...TARGET,operation:'copy-migration',records:[{source,target:stored.path,originalContentSha256}],errors:[]});
  for(const name of ['records/local-only/keep.txt','inbox/unknown.txt','received/original.txt','pending/diagnostic.txt']){await fs.mkdir(path.dirname(path.join(project,'evidence-archive',name)),{recursive:true});await fs.writeFile(path.join(project,'evidence-archive',name),'unique local or received bytes');}
  await fs.mkdir(path.join(project,'releases'));await fs.writeFile(path.join(project,'releases/package.zip'),'existing software package');
  // Only isolated protocol fixtures inject a validator. Production always uses
  // the existing PowerShell product validator, separately exercised on real data.
  const options={validate:async(_project,record)=>{assert.equal((await readJson(path.join(record,'manifest.json'))).kind,'App');}};
  return {project,root,source,dir,files,options,target:path.join(root,stored.path)};
}
test('exact migrated source removal preserves local/original data and restores the deleted original path',async t=>{
  const f=await pruneFixture(t),beforeLocal=await tree(path.join(f.project,'evidence-archive/records/local-only')),beforeRelease=await tree(path.join(f.project,'releases'));
  const plan=await preparePrune(f.project,f.root,f.options);assert.equal(plan.records.length,1);assert.ok(plan.records[0].originalPathRestoreVerifiedAt);
  const result=await applyPrune(f.project,f.root,plan,f.options);assert.equal(result.removedRecords,1);assert.equal(result.state,'completed');assert.equal(await exists(f.dir),false);
  assert.deepEqual(await tree(path.join(f.project,'evidence-archive/records/local-only')),beforeLocal);assert.deepEqual(await tree(path.join(f.project,'releases')),beforeRelease);assert.deepEqual(await tree(path.join(f.target,'original')),f.files);
  assert.equal((await applyPrune(f.project,f.root,plan,f.options)).releasedSourceBytes,result.releasedSourceBytes);
  await restorePrunedSource(f.project,f.root,plan,f.source,f.options);assert.deepEqual(await tree(f.dir),f.files);
  await assert.rejects(restorePrunedSource(f.project,f.root,plan,f.source,f.options),/overwrite/);
  await assert.rejects(applyPrune(f.project,f.root,plan,f.options),/reappeared/);
});
test('changed sources, extra files and damaged targets block all source removal',async t=>{
  for(const mutation of ['source','extra','target']){
    const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options);
    const file=mutation==='target'?path.join(f.target,'original/nested/result.txt'):path.join(f.dir,mutation==='extra'?'unique-local.txt':'nested/result.txt');await fs.writeFile(file,'changed or unique bytes');
    await assert.rejects(applyPrune(f.project,f.root,plan,f.options),/changed|damaged/);assert.equal(await exists(f.dir),true);
  }
});
test('forged local source, paths outside records and junctions never become removal targets',async t=>{
  for(const source of ['evidence-archive/records/local-only','evidence-archive/received/original','evidence-archive/records/../inbox']){
    const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options);plan.records[0].source=source;plan.recordsSha256=hash(JSON.stringify(canonical(plan.records)));
    await assert.rejects(applyPrune(f.project,f.root,plan,f.options),/provenance|limited|Unsafe/);assert.equal(await exists(f.dir),true);
  }
  const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options),moved=path.join(f.project,'linked-original');await fs.rename(f.dir,moved);await fs.symlink(moved,f.dir,'junction');
  await assert.rejects(applyPrune(f.project,f.root,plan,f.options),/Linked/);assert.deepEqual(await tree(moved),f.files);
});
test('interruption after source detachment and partial file removal resumes from the sealed original',async t=>{
  for(const stage of ['detached','file-removed']){
    const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options);let interrupted=false;
    await assert.rejects(applyPrune(f.project,f.root,plan,{...f.options,onStage:async actual=>{if(!interrupted&&actual===stage){interrupted=true;throw Error('simulated interruption')}}}),/simulated/);
    assert.equal(await exists(f.dir),false);assert.deepEqual(await tree(path.join(f.target,'original')),f.files);
    const result=await applyPrune(f.project,f.root,plan,f.options);assert.equal(result.state,'completed');assert.equal(result.removedRecords,1);
    await restorePrunedSource(f.project,f.root,plan,f.source,f.options);assert.deepEqual(await tree(f.dir),f.files);
  }
});
test('failed product validation and changed protected local files prevent removal',async t=>{
  const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options);
  await assert.rejects(applyPrune(f.project,f.root,plan,{validate:async()=>{throw Error('product rejected')}}),/product rejected/);assert.equal(await exists(f.dir),true);
  await fs.writeFile(path.join(f.project,'evidence-archive/inbox/unknown.txt'),'unique changed received data');
  await assert.rejects(applyPrune(f.project,f.root,plan,f.options),/Protected/);assert.equal(await exists(f.dir),true);
});
test('changing active diagnostics stays outside removal scope and is preserved',async t=>{
  const f=await pruneFixture(t),plan=await preparePrune(f.project,f.root,f.options),diagnostic=path.join(f.project,'evidence-archive/pending/diagnostic.txt');
  assert.ok(!plan.preservedFiles.some(file=>file.path.startsWith('pending/')));await fs.writeFile(diagnostic,'updated active diagnostic');
  await applyPrune(f.project,f.root,plan,f.options);assert.equal(await fs.readFile(diagnostic,'utf8'),'updated active diagnostic');
});
test('real listing scripts preserve unique maintenance that references the same Actions run as product evidence',async t=>{
  const f=await pruneFixture(t),scripts=path.join(f.project,'scripts');await fs.mkdir(scripts);
  for(const name of (await fs.readdir('scripts')).filter(name=>/^github-archive.*\.mjs$/.test(name)&&!name.endsWith('.test.mjs')).concat(['list-test-evidence.ps1','evidence-lib.ps1']))await fs.copyFile(path.resolve('scripts',name),path.join(scripts,name));
  const maintenance=path.join(f.project,'evidence-archive/records/unique-maintenance');await fs.mkdir(maintenance);
  await writeJson(path.join(maintenance,'manifest.json'),{kind:'test-system-audit',github:{repository:TARGET.repository,runId:'123',runAttempt:'1'}});await fs.writeFile(path.join(maintenance,'report.md'),'unique repair report; isolated listing protocol');
  const list=scope=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(scripts,'list-test-evidence.ps1'),'-Scope',scope,'-Json'],{encoding:'utf8',windowsHide:true,timeout:30000}));
  const local=list('local');assert.ok(local.some(row=>row.Path==='records/unique-maintenance'&&row.ArchiveClass==='maintenance-with-github-association'));assert.ok(!local.some(row=>row.ArchiveClass==='github-product-evidence'));
  const all=list('all');assert.equal(all.filter(row=>row.Kind==='test-system-audit').length,1);assert.equal(all.filter(row=>row.Kind==='App').length,1);
});
test('boundary checks accept completed exact-source removal but still detect lost local evidence',async t=>{
  const f=await pruneFixture(t),work=path.join(f.project,'.build/github-archive-implementation'),evidenceInventory=await tree(path.join(f.project,'evidence-archive'));
  await writeJson(path.join(work,'baseline.json'),{target:TARGET,evidenceInventory,releaseInventory:await tree(path.join(f.project,'releases')),records:[{path:f.source.slice('evidence-archive/'.length),github:{repository:TARGET.repository},files:f.files}]});await writeJson(path.join(work,'latest-inventory.json'),{path:'baseline.json'});
  const plan=await preparePrune(f.project,f.root,f.options);await applyPrune(f.project,f.root,plan,f.options);
  const after=await boundaryBaseline(f.project);assert.equal(after.removedMigratedSources.length,1);assert.deepEqual(after.oldEvidenceChanges,[]);assert.deepEqual(after.releaseChanges,[]);
  await fs.unlink(path.join(f.project,'evidence-archive/records/local-only/keep.txt'));
  assert.deepEqual((await boundaryBaseline(f.project)).oldEvidenceChanges,['records/local-only/keep.txt']);
});
test('junctions and cleanup of formal roots, ancestors or unowned pending are refused',async t=>{
  const root=await fixture(t),outside=await fixture(t),link=path.join(root,'issues','linked');await fs.mkdir(path.dirname(link));await fs.symlink(outside,link,'junction');
  await assert.rejects(tree(link),/Linked/);await assert.rejects(seal(root,'issues/linked/object',{'a.txt':Buffer.from('protocol')}),/Linked/);
  for(const target of [root,path.dirname(root),path.join(root,'actions')])await assert.rejects(insideCleanup(root,target),/outside/);
  const unknown=path.join(root,'pending','unknown');await fs.mkdir(unknown,{recursive:true});await writeJson(path.join(unknown,'owner.json'),{owner:'other-tool'});await assert.rejects(insideCleanup(root,unknown),/Unowned/);assert.equal((await fs.stat(unknown)).isDirectory(),true);
});
test('attachment inventory records external images without recursively fetching any host',()=>{
  const rows=attachments({body:'![a](https://external.example/a.png) <img src="https://external.example/b.svg"> https://github.com/user-attachments/assets/123',link:'https://github.com/another/repo'});
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.status==='not-downloaded'));assert.ok(!rows.some(r=>r.url.includes('another/repo')));
});
test('actual ZIP extractor refuses traversal, reserved names, case conflicts and link entries',async t=>{
  const root=await fixture(t),cases=[{name:'traversal',entries:['../escape.txt']},{name:'drive',entries:['C:/escape.txt']},{name:'reserved',entries:['NUL.txt']},{name:'case',entries:['A.txt','a.txt']},{name:'unix-link',entries:['link'],attributes:-1610612736},{name:'reparse',entries:['link'],attributes:1024},{name:'declared-oversize',entries:['oversize'],declaredBytes:3221225473}];
  const script=`$ErrorActionPreference='Stop'
  Add-Type -AssemblyName System.IO.Compression
  . (Join-Path $env:ARCHIVE_PROTOCOL_SCRIPTS 'github-evidence-lib.ps1')
  foreach($case in ($env:ARCHIVE_PROTOCOL_CASES|ConvertFrom-Json)){
    $zipPath=Join-Path $env:ARCHIVE_PROTOCOL_WORK ($case.name+'.zip')
    $zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
    try{foreach($name in $case.entries){$entry=$zip.CreateEntry($name);if($case.attributes){$entry.ExternalAttributes=[int]$case.attributes}}}finally{$zip.Dispose()}
    if($case.declaredBytes){
      $bytes=[IO.File]::ReadAllBytes($zipPath);$lengthBytes=[BitConverter]::GetBytes([uint32]$case.declaredBytes)
      for($i=0;$i -lt $bytes.Length-28;$i++){if([BitConverter]::ToUInt32($bytes,$i) -eq 0x02014b50){[Array]::Copy($lengthBytes,0,$bytes,$i+24,4);break}}
      [IO.File]::WriteAllBytes($zipPath,$bytes)
    }
    $destination=Join-Path $env:ARCHIVE_PROTOCOL_WORK ($case.name+'-expanded');$refused=$false
    try{Expand-GitHubEvidenceZip $zipPath $destination}catch{if($case.declaredBytes -and $_.Exception.Message -notmatch 'extraction limit'){throw};$refused=$true}
    if(!$refused -or (Test-Path -LiteralPath $destination)){throw 'Unsafe ZIP accepted or extraction started before validation'}
    Write-Output ('REFUSED: '+$case.name)
  }`;
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,ARCHIVE_PROTOCOL_SCRIPTS:path.resolve('scripts'),ARCHIVE_PROTOCOL_WORK:root,ARCHIVE_PROTOCOL_CASES:JSON.stringify(cases)}});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('REFUSED: ')).length,cases.length);
});
test('generic artifacts use a confirmed attempt, ambiguous transports remain pending, receipt counts match sealed report',async t=>{
  const root=await fixture(t),project=await fixture(t),inventoryRoot=path.join(project,'.build','github-archive-implementation');
  await writeJson(path.join(inventoryRoot,'inventory.json'),{target:TARGET,remote:{categories:{pages:{state:'not-found-unconfirmed'},'statistics-contributors':{state:'error'}}}});await writeJson(path.join(inventoryRoot,'latest-inventory.json'),{path:'inventory.json'});
  const repository={id:Number(TARGET.repositoryId),full_name:TARGET.repository,has_pages:false},commit='a'.repeat(40);
  const runs=[{id:10,run_attempt:1,repository,head_sha:commit,path:'protocol.yml',status:'completed'},{id:20,run_attempt:2,repository,head_sha:commit,path:'protocol.yml',status:'completed'},{id:30,run_attempt:1,repository,head_sha:commit,path:'unexpected-workflow.yml',status:'completed'}];
  const artifacts=runs.map(r=>({id:r.id+1,name:r.id===30?'mediascope-test-evidence-30-1':'generic-protocol-transport',workflow_run:{id:r.id,head_sha:commit}}));
  const reader={token:null,pages:[],remaining:()=>100000,downloadBytes:0,peakTemporaryBytes:0,
    get:async resource=>({data:resource===''?repository:resource.startsWith('actions/runs/')?{...runs.find(r=>r.id===Number(resource.split('/')[2])),run_attempt:Number(resource.split('/')[4])}:resource==='stats/contributors'?[]:{}}),
    list:async resource=>resource==='actions/runs'?runs:resource==='actions/artifacts'?artifacts:resource==='actions/runs/30/attempts/1/jobs'?[{id:300,run_id:30,run_attempt:1,name:'Windows full regression',status:'queued'}]:[],
    download:async(_,file)=>{await fs.writeFile(file,'isolated protocol transport');return {sha256:hash(Buffer.from('isolated protocol transport')),bytes:27,validation:'protocol-fixture'}}};
  const result=await sync(project,root,{reader});assert.equal(result.coverage.configured.pages.state,'not-enabled');assert.equal(result.coverage.configured['statistics-contributors'].state,'included');
  assert.equal((await fs.stat(path.join(root,'actions/10/attempts/1/artifacts/11'))).isDirectory(),true);await assert.rejects(fs.stat(path.join(root,'actions/20/artifacts')),{code:'ENOENT'});
  assert.equal(result.gaps.filter(g=>g.state==='unresolved-attempt').length,1);assert.ok((await tree(path.join(root,'pending'))).some(f=>f.path.endsWith('artifact.zip')));
  assert.ok(result.gaps.some(g=>g.identity===31&&/job layout/.test(g.reason)));await assert.rejects(fs.stat(path.join(root,'actions/30/attempts/1/evidence')),{code:'ENOENT'});
  const sealed=await readJson(path.join(root,result.receipt.path,'report.json'));assert.deepEqual(sealed.counts,result.counts);assert.equal((await verifyArchive(root)).integrity,'verified');
});
test('archive identity rejects different repository, ID, host and unsupported versions',async t=>{
  const root=await fixture(t);
  for(const identity of [{...TARGET,repositoryId:'123'},{...TARGET,repository:'other/MediaScope'},{...TARGET,host:'github.example.com'}])await assert.rejects(initialize(root,identity),/identity mismatch/);
  await writeJson(path.join(root,'repository.json'),{...TARGET,format:999});await assert.rejects(assertRoot(root),/Unsupported/);
});
test('repeated observations reuse content, changed bodies preserve old immutable bytes',async t=>{
  const root=await fixture(t),first=await seal(root,'releases/10',{'body.txt':Buffer.from('first')});
  const original=await tree(path.join(root,first.path));const repeat=await seal(root,'releases/10',{'body.txt':Buffer.from('first')});assert.equal(repeat.state,'unchanged');assert.equal(first.path,repeat.path);
  const next=await seal(root,'releases/10',{'body.txt':Buffer.from('second')});assert.notEqual(next.path,first.path);assert.deepEqual(await tree(path.join(root,first.path)),original);
  await fs.rm(path.join(root,'releases/10/latest.json'));await fs.rm(path.join(root,'index'),{recursive:true,force:true});assert.equal((await verifyArchive(root)).records,2);
});
test('independent sealed records reject changed, missing, extra or altered manifest content',async t=>{
  const root=await fixture(t),saved=await seal(root,'issues/20',{'body.txt':Buffer.from('original')}),dir=path.join(root,saved.path);
  await fs.writeFile(path.join(dir,'extra.txt'),'not declared');await assert.rejects(verifySnapshot(dir),/undeclared/);await fs.unlink(path.join(dir,'extra.txt'));
  await fs.writeFile(path.join(dir,'body.txt'),'changed');await assert.rejects(verifySnapshot(dir),/damaged/);await fs.writeFile(path.join(dir,'body.txt'),'original');
  const m=await readJson(path.join(dir,'archive-manifest.json'));m.fetchedAt='changed';await writeJson(path.join(dir,'archive-manifest.json'),m);await assert.rejects(verifySnapshot(dir),/Checksum mismatch/);
});
test('archive paths refuse traversal, reserved names, absolute paths and case conflicts',async t=>{
  const root=await fixture(t);for(const name of ['../escape','/absolute','C:/escape','A/NUL.txt','a/../b','a\\b','a./file'])assert.throws(()=>safeRelative(name),/Unsafe/);
  await assert.rejects(seal(root,'issues/30',{'A.txt':Buffer.from('one'),'a.txt':Buffer.from('two')}),/Case-conflicting/);
  assert.throws(()=>inside(root,path.dirname(root)),/outside/);
});
test('formal directory inventory refuses unsealed unexpected content',async t=>{const root=await fixture(t);await fs.mkdir(path.join(root,'actions'));await fs.writeFile(path.join(root,'actions','extra.json'),'{}');await assert.rejects(verifyArchive(root),/Unsealed/)});
test('misplaced objects, old action layouts and undeclared root files fail verification',async t=>{
  const root=await fixture(t);await assert.rejects(seal(root,'actions/1/artifacts/2',{'a.txt':Buffer.from('protocol')}),/layout/);
  await seal(root,'actions/1',{'run.json':{id:1}});await fs.rename(path.join(root,'actions/1'),path.join(root,'actions/2'));assert.match((await verifyArchive(root)).errors[0].reason,/declared object path/);
  await fs.writeFile(path.join(root,'unexpected.txt'),'protocol');await assert.rejects(verifyArchive(root),/unexpected/);
});
test('archive lock refuses concurrent writers and can be safely released',async t=>{const root=await fixture(t),gate=await lock(root,'test');await assert.rejects(lock(root,'other'),/Archive lock exists/);await gate.release();const again=await lock(root,'test');await again.release()});
test('copied archive validates offline without original root or latest pointers',async t=>{const root=await fixture(t);await seal(root,'actions/40',{'run.json':{status:'cancelled'}});const copy=await fixture(t);await fs.cp(root,copy,{recursive:true});assert.equal((await verifyArchive(copy)).integrity,'verified')});
test('reader rejects cross-repository, fork, other host and credential-bearing URLs',()=>{
  for(const url of ['https://api.github.com/repos/Other/MediaScope/issues','https://github.example.com/repos/Gavin-530/MediaScope','https://token@api.github.com/repos/Gavin-530/MediaScope'])assert.throws(()=>apiUrl(url),/Out-of-scope/);
  assert.match(apiUrl('branches/feature%2Fsafe/protection').href,/feature%2Fsafe/);
  assert.throws(()=>apiUrl('branches/%2F..%2F..%2F..%2Fother'),/Out-of-scope/);
  for(const url of ['https://evil.example/logs','http://release-assets.githubusercontent.com/file','https://user:pass@release-assets.githubusercontent.com/file'])assert.throws(()=>downloadUrl(url),/Unapproved/);
});
test('pagination follows more than twenty pages and checks discovered totals',async()=>{
  let calls=0;const reader=new GitHubReader({token:'protocol-only',fetchImpl:async url=>{calls++;const page=Number(new URL(url).searchParams.get('page')??1);return new Response(JSON.stringify({total_count:21,workflow_runs:[{id:page}]}),{headers:page<21?{link:'<https://api.github.com/repos/Gavin-530/MediaScope/actions/runs?page='+(page+1)+'>; rel="next"'}:{}})}});
  assert.equal((await reader.list('actions/runs','workflow_runs')).length,21);assert.equal(calls,22);
  const truncated=new GitHubReader({token:null,fetchImpl:async()=>new Response(JSON.stringify({total_count:2,workflow_runs:[{id:1}]}))});await assert.rejects(truncated.list('actions/runs','workflow_runs'),/truncated/);
});
test('pagination reports moving boundaries and does not collapse annotation rows without IDs',async()=>{
  let n=0;const moved=new GitHubReader({token:null,fetchImpl:async()=>new Response(JSON.stringify([{id:++n}]))});await assert.rejects(moved.list('issues'),/boundary moved/);
  const annotations=new GitHubReader({token:null,fetchImpl:async()=>new Response(JSON.stringify([{path:'a',start_line:1},{path:'a',start_line:2}]))});assert.equal((await annotations.list('check-runs/1/annotations')).length,2);
});
test('download redirect never forwards credentials, and platform digests are verified',async t=>{
  const root=await fixture(t),seen=[],bytes=Buffer.from('raw log bytes');const reader=new GitHubReader({token:'protocol-only',fetchImpl:async(url,options)=>{seen.push({url:String(url),options});return seen.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file?signature=example'}}):new Response(bytes)}});
  const result=await reader.download('actions/jobs/1/logs',path.join(root,'log'),{digest:'sha256:'+hash(bytes)});assert.equal(result.sha256,hash(bytes));assert.equal(seen[0].options.headers.Authorization,'Bearer protocol-only');assert.equal(seen[1].options.headers.Authorization,undefined);assert.equal(seen[1].options.redirect,'manual');
  assert.equal(seen[0].options.headers.Accept,'application/vnd.github+json');
  const bad=new GitHubReader({token:null,fetchImpl:async()=>new Response(bytes)});await assert.rejects(bad.download('actions/jobs/1/logs',path.join(root,'bad'),{digest:'sha256:'+'0'.repeat(64)}),/digest mismatch/);
});
test('reader reports permissions, unconfirmed not-found, expiry and 202 waiting independently',async()=>{
  for(const [status,state] of [[403,'no-permission'],[404,'not-found-unconfirmed'],[410,'expired'],[202,'waiting']]){const reader=new GitHubReader({token:null,fetchImpl:async()=>new Response('{}',{status})});await assert.rejects(reader.get('actions/runs/1'),e=>e.state===state)}
});
test('rate limits respect Retry-After and stop instead of silently skipping the resource',async()=>{
  let calls=0;const retry=new GitHubReader({token:null,fetchImpl:async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'0'}}):new Response('[{"id":1}]')});assert.deepEqual((await retry.get('labels')).data,[{id:1}]);assert.equal(calls,2);
  const limited=new GitHubReader({token:null,fetchImpl:async()=>new Response('{}',{status:403,headers:{'retry-after':'60'}})});await assert.rejects(limited.get('labels'),/rate limit/);
});
test('interrupted streaming download fails while preserving previous sealed history',async t=>{
  const root=await fixture(t),saved=await seal(root,'issues/10',{'body.txt':Buffer.from('preserved history')}),before=await tree(path.join(root,saved.path));
  let pieces=0;const reader=new GitHubReader({token:null,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){if(pieces++===0)controller.enqueue(new Uint8Array([1,2,3]));else controller.error(Error('protocol transport interrupted'))}}))});
  await assert.rejects(reader.download('actions/jobs/1/logs',path.join(root,'pending','partial.bin')),/interrupted/);assert.deepEqual(await tree(path.join(root,saved.path)),before);assert.equal((await verifyArchive(root)).integrity,'verified');
});
test('download size and complete-operation time budgets are enforced',async t=>{
  const root=await fixture(t),reader=new GitHubReader({token:null,maxBytes:3,fetchImpl:async()=>new Response('too large')});await assert.rejects(reader.download('actions/jobs/1/logs',path.join(root,'limited')),/size limit/);
  const expired=new GitHubReader({token:null,budgetMs:-1,fetchImpl:async()=>new Response('{}')});await assert.rejects(expired.get('actions/runs/1'),/time budget/);
});
test('damaged conditional cache is discarded rather than trusted',async t=>{
  const root=await fixture(t),url=apiUrl('labels').href,file=path.join(root,'index','http',hash(url)+'.json');await writeJson(file,{url,etag:'old',data:[{id:99}],sha256:'invalid'});let headers;
  const reader=new GitHubReader({root,token:null,fetchImpl:async(_,opts)=>{headers=opts.headers;return new Response('[{"id":1}]')}});assert.deepEqual((await reader.get('labels')).data,[{id:1}]);assert.equal(headers['If-None-Match'],undefined);
});
test('foreign copies deduplicate, preserve unknown history, and cannot replace local latest or authenticate claims',async t=>{
  const root=await fixture(t),source=await fixture(t);const current=await seal(root,'releases/10',{'body.txt':Buffer.from('current local')});await seal(source,'releases/10',{'body.txt':Buffer.from('older exclusive history')});await seal(source,'issues/1',{'body.txt':Buffer.from('shared')});await seal(root,'issues/1',{'body.txt':Buffer.from('shared')});
  const pointer=await readJson(path.join(root,'releases/10/latest.json'));const merged=await mergeCopy(root,source);assert.equal(merged.records.filter(x=>x.state==='duplicate').length,1);assert.equal(merged.records.filter(x=>x.state==='saved').length,1);assert.deepEqual(await readJson(path.join(root,'releases/10/latest.json')),pointer);
  const received=merged.records.find(x=>x.state==='saved'),provenance=await readJson(path.join(root,received.target,'received-provenance.json'));assert.match(provenance.verificationGrade,/authenticity-not-confirmed/);assert.equal((await verifyArchive(root)).integrity,'verified');assert.equal((await verifyArchive(source)).integrity,'verified');
  const again=await mergeCopy(root,source);assert.equal(again.records.filter(x=>x.state==='saved').length,0);assert.equal(again.records.filter(x=>x.state==='unchanged').length,1);assert.equal(current.path, 'releases/10/'+pointer.revision);
});
test('GraphQL only executes fixed repository read queries and validates repository identity and permissions',async()=>{
  let request;const reader=new GitHubReader({token:'protocol-only',fetchImpl:async(url,opts)=>{request=JSON.parse(opts.body);assert.equal(String(url),'https://api.github.com/graphql');return new Response(JSON.stringify({data:{repository:{databaseId:TARGET.repositoryId,nameWithOwner:TARGET.repository,pullRequest:{reviewThreads:{totalCount:0,nodes:[],pageInfo:{hasNextPage:false}}}}}}))}});
  assert.deepEqual(await repositoryGraphql(reader,'threads',{number:6}),[]);assert.match(request.query,/^query /);assert.doesNotMatch(request.query,/mutation|repositoryOwner/);assert.equal(request.variables.number,6);
  await assert.rejects(repositoryGraphql(reader,'mutation'),/Unknown/);await assert.rejects(repositoryGraphql(reader,'threads',{number:-1}),/Invalid/);
  const wrong=new GitHubReader({token:'protocol-only',fetchImpl:async()=>new Response(JSON.stringify({data:{repository:{databaseId:123,nameWithOwner:TARGET.repository}}}))});await assert.rejects(repositoryGraphql(wrong,'threads',{number:1}),/identity mismatch/);
  const forbidden=new GitHubReader({token:'protocol-only',fetchImpl:async()=>new Response(JSON.stringify({errors:[{type:'INSUFFICIENT_SCOPES'}]}))});await assert.rejects(repositoryGraphql(forbidden,'projects'),e=>e.state==='no-permission');
});
