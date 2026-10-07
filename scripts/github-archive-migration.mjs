import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TARGET,now,hash,canonical,tree,readJson,writeJson,exists,inside,noLinks,seal,snapshots,verifySnapshot,verifySnapshotLocation,insideCleanup,verifyArchive,safeRelative,canonicalTimePath,resolveArchivePath,evidenceLocationAliases} from './github-archive-store.mjs';
import {latestInventory} from './github-archive-inventory.mjs';

export function verifyEvidence(project,record,relative,timeout=120000){
  return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(path.dirname(fileURLToPath(import.meta.url)),'github-archive-evidence.ps1'),'-Action','Verify','-Record',record,'-Relative',relative],{encoding:'utf8',windowsHide:true,timeout,maxBuffer:2*1024**2});
}
export async function evidenceIdentity(record,relative){
  const envelope=await exists(path.join(record,'record.json'))?await readJson(path.join(record,'record.json')):null;
  const payload=envelope?path.join(record,'original'):record;
  const manifest=await readJson(path.join(payload,'manifest.json'));
  const origin=await exists(path.join(payload,'origin.json'))?await readJson(path.join(payload,'origin.json')):null;
  const github=manifest.github;
  if(!github||github.repository!==TARGET.repository||!/^\d+$/.test(github.runId)||!/^\d+$/.test(github.runAttempt)||!/^([a-f0-9]{40})$/.test(github.sha)||github.job!=='full-regression')throw Error('Unrecognized repository/run/attempt/job identity; retain original');
  return {github,kind:manifest.kind,evidenceRevision:manifest.evidenceRevision??null,originalRelative:relative,payloadRelative:envelope?'original':'',productChecksums:origin?.originalChecksumsSha256??envelope?.originalChecksumsSha256??hash(await fs.readFile(path.join(payload,'SHA256SUMS.txt'))),transportSha256:origin?.transportSha256??(await exists(path.join(record,'artifact.zip'))?hash(await fs.readFile(path.join(record,'artifact.zip'))):null),testStepOutcome:origin?.testStepOutcome??manifest.testStepOutcome??null};
}
export async function evidenceRecords(root,{verify=true}={}){
  const result=[];
  for(const dir of await snapshots(root)){
    const declared=await readJson(path.join(dir,'archive-manifest.json'));if(!declared.object?.match(/^actions\/\d+\/attempts\/\d+\/evidence\//))continue;
    const manifest=verify?await verifySnapshot(dir):declared;
    verifySnapshotLocation(root,dir,manifest);
    const provenance=await readJson(path.join(dir,'provenance.json'));result.push({dir,manifest,provenance});
  }
  return result;
}
export async function storeEvidence(project,root,record,relative,{source='github-transport',sourcePath=null,platformArtifact=null}={}){
  safeRelative(relative);await noLinks(record);verifyEvidence(project,record,relative);const identity=await evidenceIdentity(record,relative);
  const files=await tree(record),digest=hash(JSON.stringify(canonical(files)));
  for(const known of await evidenceRecords(root,{verify:false})){
    const prior=known.provenance;
    if(prior.identity.github.runId===identity.github.runId&&prior.identity.github.runAttempt===identity.github.runAttempt&&prior.identity.github.job===identity.github.job){
      await verifySnapshot(known.dir);
      if(prior.originalContentSha256===digest||(identity.transportSha256&&prior.identity.transportSha256?.toLowerCase()===identity.transportSha256.toLowerCase())||(identity.evidenceRevision===2&&prior.identity.evidenceRevision===2&&prior.identity.productChecksums.toLowerCase()===identity.productChecksums.toLowerCase()&&prior.identity.testStepOutcome===identity.testStepOutcome)){
        verifyEvidence(project,path.join(known.dir,'original'),prior.identity.originalRelative);
        return {state:'unchanged',path:path.relative(root,known.dir).replaceAll('\\','/'),bytes:0};
      }
      throw Error('Same run/attempt/job has conflicting evidence; overwrite refused, source retained');
    }
  }
  const content={'provenance.json':{format:1,...TARGET,source,sourcePath,identity,platformArtifact,originalContentSha256:digest,verificationGrade:source==='local-migration'?'validated-local-history-associated-with-repository':'validated-content-and-platform-transport',originalBytesUnchanged:true,historicalInternalRedundancy:files.some(x=>/\.zip$/i.test(x.path))}};
  for(const f of files)content['original/'+f.path]={archiveSourceFile:path.join(record,f.path)};
  const result=await seal(root,'actions/'+identity.github.runId+'/attempts/'+identity.github.runAttempt+'/evidence/'+digest.slice(0,20),content,{sourceCreatedAt:null,sourceUpdatedAt:null});
  verifyEvidence(project,path.join(root,result.path,'original'),relative);return result;
}
export async function migrate(project,root){
  const inventory=await latestInventory(project);if(inventory.remote.state!=='checked')throw Error('Online identity inventory required before migration');
  const sources=inventory.records.filter(r=>r.github),receipt={format:1,...TARGET,operation:'copy-migration',startedAt:now(),records:[],preserved:inventory.records.filter(r=>!r.github).map(r=>r.path),deletedSourceBytes:0,errors:[]};
  const journal=path.join(root,'pending','migration-journal.json');
  for(const record of sources){
    try{
      if(record.validation!=='verified'||record.github.repository!==TARGET.repository)throw Error('Source inventory failed validation or repository scope');
      safeRelative(record.path);const source=inside(path.join(project,'evidence-archive'),path.join(project,'evidence-archive',record.path));
      const before=await tree(source);if(JSON.stringify(canonical(before))!==JSON.stringify(canonical(record.files)))throw Error('Source changed since inventory');
      const result=await storeEvidence(project,root,source,record.path,{source:'local-migration',sourcePath:'evidence-archive/'+record.path});
      const after=await tree(source);if(JSON.stringify(canonical(before))!==JSON.stringify(canonical(after)))throw Error('Source changed during copy');
      const mapping={source:'evidence-archive/'+record.path,target:result.path,originalContentSha256:hash(JSON.stringify(canonical(before))),bytes:before.reduce((n,f)=>n+f.bytes,0),state:result.state,sourceRetained:true};
      // Exercise independent copy and original-path restoration without touching the real source.
      const task=await fs.mkdtemp(path.join(root,'pending','restore-'+hash(mapping.source).slice(0,16)+'-'));
      await writeJson(path.join(task,'owner.json'),{owner:'mediascope-github-archive',state:'restore-check'});
      const copied=path.join(task,'independent');await fs.cp(path.join(root,result.path),copied,{recursive:true,errorOnExist:true});await verifySnapshot(copied);
      const restored=path.join(task,'restored','evidence-archive',record.path);await fs.mkdir(path.dirname(restored),{recursive:true});await fs.cp(path.join(copied,'original'),restored,{recursive:true,errorOnExist:true});
      verifyEvidence(project,restored,record.path);if(JSON.stringify(canonical(await tree(restored)))!==JSON.stringify(canonical(before)))throw Error('Restore byte inventory mismatch');
      mapping.independentCopyVerified=true;mapping.originalPathRestoreVerified=true;await insideCleanup(root,task);
      receipt.records.push(mapping);await writeJson(journal,receipt);console.log('Migrated copy: '+record.path+' ('+result.state+'); source retained');
    }catch(e){receipt.errors.push({source:record.path,reason:e.message});await writeJson(journal,receipt)}
  }
  receipt.completedAt=now();receipt.sourceRecords=sources.length;receipt.copied=receipt.records.filter(r=>r.state==='saved').length;receipt.deduplicated=receipt.records.filter(r=>r.state==='unchanged').length;receipt.oldBytesRetained=receipt.records.reduce((n,r)=>n+r.bytes,0);
  await seal(root,'migration-reports/'+receipt.startedAt.replace(/[-:]/g,''),{'report.json':receipt});await writeJson(journal,receipt);return receipt;
}
export async function preparedRecord(receiver){
  const result=await readJson(path.join(receiver,'prepared-record.json'));
  if(result.schema!==1||typeof result.record!=='string'||!/^evidence-archive\/records\/[A-Za-z0-9_.-]+$/.test(result.record))throw Error('Invalid prepared record result');
  safeRelative(result.record);const record=inside(receiver,path.join(receiver,result.record));await noLinks(record);
  if(!(await fs.stat(record)).isDirectory())throw Error('Prepared record is not a directory');
  return record;
}
export async function importTransport(project,root,archive,identity,{reader,artifact}={}){
  if(identity.repository!==TARGET.repository||!/^\d+$/.test(identity.runId)||!/^\d+$/.test(identity.attempt))throw Error('Import requires explicit verified repository/run/attempt');
  const task=path.join(root,'pending','import-'+hash(identity.runId+'/'+identity.attempt+'/'+now()).slice(0,20));await fs.mkdir(task);await writeJson(path.join(task,'owner.json'),{owner:'mediascope-github-archive',state:'importing'});
  const receiver=path.join(task,'receiver');const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/github-archive-evidence.ps1'),'-Action','Prepare','-Project',receiver,'-Archive',archive,'-RunId',identity.runId,'-Attempt',identity.attempt,...identity.commit?['-Commit',identity.commit]:[]];
  execFileSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:Math.min(120000,reader?.remaining()??120000),maxBuffer:4*1024**2});
  const record=await preparedRecord(receiver);const relative=path.relative(path.join(receiver,'evidence-archive'),record).replaceAll('\\','/');
  const result=await storeEvidence(project,root,record,relative,{platformArtifact:artifact??null});reader?.remaining();await insideCleanup(root,task);return result;
}
export async function boundaryBaseline(project){
  const baseline=await latestInventory(project),releases=await tree(path.join(project,'releases')),evidence=await tree(path.join(project,'evidence-archive'));
  const evidenceRoot=path.join(project,'evidence-archive');
  const aliases=evidenceLocationAliases(evidenceRoot);
  const evidencePath=p=>p.startsWith('records/')?path.relative(evidenceRoot,resolveArchivePath(evidenceRoot,p,{aliases})).replaceAll('\\','/'):canonicalTimePath(p);
  const changed=(old,current,normalize=canonicalTimePath)=>{const items=new Map(current.map(f=>[normalize(f.path),{...f,path:normalize(f.path)}]));return old.filter(f=>JSON.stringify(canonical(items.get(normalize(f.path))))!==JSON.stringify(canonical({...f,path:normalize(f.path)}))).map(f=>f.path)};
  const evidenceChanges=changed(baseline.evidenceInventory,evidence,evidencePath),cacheChanges=evidenceChanges.filter(p=>/^catalog\.json(?:\.|$)/.test(p)),toolChanges=evidenceChanges.filter(p=>p==='tools/import-local-test-evidence.ps1');
  const baselinePaths=new Set(baseline.evidenceInventory.map(f=>evidencePath(f.path)));
  const removedMigratedSources=[],expectedRemovedFiles=new Set(),root=path.join(project,'github-archive');
  if(await exists(path.join(root,'repository.json'))){
    for(const dir of await snapshots(root)){
      const declared=await readJson(path.join(dir,'archive-manifest.json'));if(!declared.object.startsWith('migration-reports/prune-'))continue;
      const sealed=await verifySnapshot(dir);verifySnapshotLocation(root,dir,sealed);
      const report=await readJson(path.join(dir,'report.json'));
      if(report.operation!=='remove-exact-migrated-sources'||report.state!=='completed'||report.repositoryId!==TARGET.repositoryId||report.repository!==TARGET.repository||report.host!==TARGET.host)throw Error('Invalid completed removal receipt');
      for(const row of report.records){
        safeRelative(row.source);safeRelative(row.target);
        if(row.state!=='removed'||!/^evidence-archive\/records\/[A-Za-z0-9_.-]+$/.test(row.source))throw Error('Removal receipt source scope mismatch');
        if(await exists(resolveArchivePath(path.join(project,'evidence-archive'),row.source.slice('evidence-archive/'.length))))continue;
        const target=resolveArchivePath(root,row.target),manifest=await verifySnapshot(target);verifySnapshotLocation(root,target,manifest);
        const provenance=await readJson(path.join(target,'provenance.json')),files=await tree(path.join(target,'original'));
        if(provenance.source!=='local-migration'||provenance.sourcePath!==row.source||provenance.originalContentSha256!==row.originalContentSha256||hash(JSON.stringify(canonical(files)))!==row.originalContentSha256||JSON.stringify(canonical(files))!==JSON.stringify(canonical(row.files)))throw Error('Removal recovery target does not match original bytes');
        const relative=row.source.slice('evidence-archive/'.length),original=baseline.records.find(r=>r.path===relative);
        if(!original?.github||JSON.stringify(canonical(original.files))!==JSON.stringify(canonical(files)))throw Error('Removal receipt does not match the original source baseline');
        removedMigratedSources.push({source:row.source,target:row.target,bytes:row.bytes,receipt:path.relative(root,dir).replaceAll('\\','/')});
        for(const file of files)expectedRemovedFiles.add(relative+'/'+file.path);
      }
    }
  }
  return {checkedAt:now(),releaseChanges:changed(baseline.releaseInventory,releases),oldEvidenceChanges:evidenceChanges.filter(p=>!cacheChanges.includes(p)&&!toolChanges.includes(p)&&!expectedRemovedFiles.has(p)),removedMigratedSources,rebuildableCacheChanges:cacheChanges,archiveToolCodeChanges:toolChanges,addedEvidenceFiles:evidence.filter(f=>!baselinePaths.has(evidencePath(f.path))).length};
}
export async function mergeCopy(root,source){
  const records=await snapshots(source),existing=await snapshots(root),known=new Map();
  for(const dir of existing){const m=await verifySnapshot(dir);known.set(canonicalTimePath(m.object)+'/'+m.contentSha256,path.relative(root,dir).replaceAll('\\','/'))}
  const receipt={format:1,...TARGET,operation:'receive-archive-history',startedAt:now(),sourceRetained:true,records:[],credentialsLocksAndProgressAdopted:false,latestPointersAdopted:false};
  for(const dir of records){
    const manifest=await verifySnapshot(dir),key=canonicalTimePath(manifest.object)+'/'+manifest.contentSha256;
    if(known.has(key)){receipt.records.push({sourceObject:manifest.object,sha256:manifest.contentSha256,state:'duplicate',target:known.get(key)});continue}
    const content={'received-provenance.json':{...TARGET,sourceObject:manifest.object,sourceDeclaredCapture:manifest.fetchedAt,verificationGrade:'self-consistent-foreign-copy; platform-authenticity-not-confirmed',sourceIdentityIsDeclaration:true,localLatestUnaffected:true}};
    for(const f of await tree(dir))content['received/'+f.path]={archiveSourceFile:path.join(dir,f.path)};
    const saved=await seal(root,'supplements/received/'+hash(key).slice(0,24),content);await verifySnapshot(path.join(root,saved.path,'received'));known.set(key,saved.path);
    receipt.records.push({sourceObject:manifest.object,sha256:manifest.contentSha256,state:saved.state,target:saved.path,trust:'unconfirmed-source-retained'});
  }
  receipt.completedAt=now();await seal(root,'migration-reports/received-'+receipt.startedAt.replace(/[-:]/g,''),{'report.json':receipt});return receipt;
}
