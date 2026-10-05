import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {TARGET,now,canonical,hash,fileHash,tree,exists,noLinks,inside,safeRelative,readJson,writeJson,assertIdentity,assertRoot,verifySnapshot,verifySnapshotLocation,insideCleanup,seal,lock} from './github-archive-store.mjs';
import {verifyEvidence,evidenceIdentity} from './github-archive-migration.mjs';

const digest=files=>hash(JSON.stringify(canonical(files)));
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function sourcePath(project,source){
  safeRelative(source);
  if(!/^evidence-archive\/records\/[A-Za-z0-9_.-]+$/.test(source))throw Error('Removal is limited to exact migrated records children');
  return inside(path.join(project,'evidence-archive','records'),path.join(project,source));
}
async function targetRecord(project,root,row,validate){
  const source=sourcePath(project,row.source);safeRelative(row.target);
  const target=inside(root,path.join(root,row.target));await noLinks(target);
  const manifest=await verifySnapshot(target);verifySnapshotLocation(root,target,manifest);
  const provenance=await readJson(path.join(target,'provenance.json'));assertIdentity(provenance);
  if(provenance.source!=='local-migration'||provenance.sourcePath!==row.source||provenance.originalContentSha256!==row.originalContentSha256)throw Error('Exact original migration provenance required');
  const relative=row.source.slice('evidence-archive/'.length),identity=provenance.identity;
  if(identity.originalRelative!==relative||identity.github.repository!==TARGET.repository||!same(await evidenceIdentity(path.join(target,'original'),relative),identity))throw Error('Migrated product identity mismatch');
  if(manifest.object!==`actions/${identity.github.runId}/attempts/${identity.github.runAttempt}/evidence/${row.originalContentSha256.slice(0,20)}`)throw Error('Migrated Actions object mismatch');
  const original=path.join(target,'original'),files=await tree(original);
  if(digest(files)!==row.originalContentSha256||!same(files,row.files))throw Error('Original payload differs from reviewed files');
  await validate(project,original,relative);
  return {source,target,original,relative,files,identity};
}
async function preserved(project,plan){
  for(const file of plan.preservedFiles){
    safeRelative(file.path);const name=inside(path.join(project,'evidence-archive'),path.join(project,'evidence-archive',file.path));
    await noLinks(name);const stat=await fs.stat(name);
    if(!stat.isFile()||stat.size!==file.bytes||await fileHash(name)!==file.sha256)throw Error('Protected local/original file changed: '+file.path);
  }
}
async function evidenceFiles(project){
  const base=path.join(project,'evidence-archive'),files=[],seen=new Set();await noLinks(base);
  async function walk(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const name=path.join(dir,entry.name),relative=path.relative(base,name).replaceAll('\\','/');safeRelative(relative);
      if(seen.has(relative.toLowerCase()))throw Error('Case-conflicting evidence paths');seen.add(relative.toLowerCase());
      // Active diagnostics and publishing stages may change between review and
      // application. They are outside all removal targets and are never read,
      // moved or deleted by this operation.
      await noLinks(name);if(relative==='pending')continue;
      if(entry.isDirectory())await walk(name);else if(entry.isFile())files.push({path:relative,bytes:(await fs.stat(name)).size,sha256:await fileHash(name)});else throw Error('Special evidence entry');
    }
  }
  await walk(base);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function checkPlan(plan){
  assertIdentity(plan);
  if(plan.format!==1||plan.kind!=='verified-migrated-source-removal'||!Array.isArray(plan.records)||!Array.isArray(plan.preservedFiles)||plan.recordsSha256!==digest(plan.records))throw Error('Invalid reviewed removal plan');
  if(new Set(plan.records.map(r=>r.source.toLowerCase())).size!==plan.records.length)throw Error('Duplicate removal source');
}

// The caller holds the existing evidence recording lock and archive write lock.
// No source is eligible on directory name alone; every byte and product identity
// must agree with a sealed original whose provenance names that exact source.
export async function preparePrune(project,root,{validate=verifyEvidence}={}){
  await assertRoot(root);
  const migration=await readJson(path.join(root,'pending','migration-journal.json'));assertIdentity(migration);
  if(migration.operation!=='copy-migration'||migration.errors.length)throw Error('Successful copy migration receipt required');
  const before=await evidenceFiles(project),records=[];
  for(const mapping of migration.records){
    const source=sourcePath(project,mapping.source);if(!await exists(source))continue;
    const files=await tree(source),row={source:mapping.source,target:mapping.target,originalContentSha256:mapping.originalContentSha256,files,bytes:files.reduce((n,f)=>n+f.bytes,0)};
    const checked=await targetRecord(project,root,row,validate);
    if(!same(files,checked.files)||!same(await evidenceIdentity(source,checked.relative),checked.identity))throw Error('Source changed or is not the exact migrated product');
    await validate(project,source,checked.relative);
    const task=await fs.mkdtemp(path.join(root,'pending','prune-proof-'));await writeJson(path.join(task,'owner.json'),{owner:'mediascope-github-archive',state:'prune-restore-proof'});
    const restored=path.join(task,'restored',mapping.source);await fs.mkdir(path.dirname(restored),{recursive:true});await fs.cp(checked.original,restored,{recursive:true,errorOnExist:true,force:false});
    if(!same(await tree(restored),files))throw Error('Independent original-path restoration differs');
    await validate(project,restored,checked.relative);row.originalPathRestoreVerifiedAt=now();
    await insideCleanup(root,task);records.push(row);
  }
  const plan={format:1,kind:'verified-migrated-source-removal',...TARGET,preparedAt:now(),records,recordsSha256:digest(records),preservedFiles:before.filter(f=>f.path!=='catalog.json'&&!records.some(r=>f.path.startsWith(r.source.slice('evidence-archive/'.length)+'/'))),preservationScope:'Closed non-candidate records, received/inbox originals and tools; active pending is outside removal scope and not compared',independentStorageBackupCompleted:false};
  await preserved(project,plan);return plan;
}

async function removeEmptyDirectories(dir){
  await noLinks(dir);
  for(const item of await fs.readdir(dir,{withFileTypes:true})){
    if(!item.isDirectory()||item.isSymbolicLink())throw Error('Unexpected file or link remains in owned removal task');
    await removeEmptyDirectories(path.join(dir,item.name));
  }
  await fs.rmdir(dir);
}

export async function applyPrune(project,root,plan,{validate=verifyEvidence,onStage=async()=>{}}={}){
  await assertRoot(root);checkPlan(plan);await preserved(project,plan);
  const actualValidator=validate,validated=new Set();
  validate=async(projectPath,record,relative)=>{
    const key=path.resolve(record)+'|'+relative+'|'+digest(await tree(record));
    if(!validated.has(key)){await actualValidator(projectPath,record,relative);validated.add(key);}
  };
  const journalFile=path.join(root,'pending','prune-journal.json');let journal;
  if(await exists(journalFile)){
    journal=await readJson(journalFile);assertIdentity(journal);
    if(journal.planSha256!==digest(plan))throw Error('Another removal journal exists; inspect its exact plan first');
  }else{
    journal={format:1,...TARGET,operation:'remove-exact-migrated-sources',planSha256:digest(plan),startedAt:now(),task:'prune-'+randomUUID(),state:'in-progress',records:plan.records.map(r=>({...r,state:'reviewed'}))};
    await writeJson(journalFile,journal);
  }
  if(!/^prune-[a-f0-9-]{36}$/.test(journal.task)||journal.records.length!==plan.records.length||!same(journal.records.map(({state,...r})=>r),plan.records))throw Error('Removal journal does not match reviewed records');
  const task=inside(path.join(root,'pending'),path.join(root,'pending',journal.task));await noLinks(task);
  if(journal.state==='completed'){
    for(const row of journal.records){await targetRecord(project,root,row,validate);if(await exists(sourcePath(project,row.source)))throw Error('Removed source reappeared; do not treat the old receipt as a new removal');}
    if(!journal.receipt){journal.receipt=(await seal(root,'migration-reports/prune-'+journal.startedAt.replace(/[-:]/g,''),{'report.json':journal})).path;await writeJson(journalFile,journal);}
    else{safeRelative(journal.receipt);const receipt=inside(root,path.join(root,journal.receipt));verifySnapshotLocation(root,receipt,await verifySnapshot(receipt));}
    if(await exists(task)){const remaining=await tree(task),owner=await readJson(path.join(task,'owner.json'));if(owner.owner!=='mediascope-github-archive'||owner.planSha256!==journal.planSha256||remaining.length!==1||remaining[0].path!=='owner.json')throw Error('Completed removal task contains unexpected files; retained');await insideCleanup(root,task);}
    return journal;
  }
  if(await exists(task)){const owner=await readJson(path.join(task,'owner.json'));if(owner.owner!=='mediascope-github-archive'||owner.planSha256!==journal.planSha256)throw Error('Removal task ownership mismatch')}
  else{await fs.mkdir(task);await writeJson(path.join(task,'owner.json'),{owner:'mediascope-github-archive',planSha256:journal.planSha256,state:'exact-source-removal'});}
  // Validate the entire reviewed set before the first removal.
  for(const row of journal.records){
    const checked=await targetRecord(project,root,row,validate);
    if(await exists(checked.source)){
      if(!same(await tree(checked.source),row.files)||!same(await evidenceIdentity(checked.source,checked.relative),checked.identity))throw Error('Source changed since removal review');
      // Preparation already validated the source and an actual restored copy.
      // Fresh full-byte and identity equality to the freshly validated target
      // establishes the same product result without repeatedly parsing its ZIPs.
    }else if(row.state==='reviewed')throw Error('Source disappeared before this removal task');
  }
  for(let index=0;index<journal.records.length;index++){
    const row=journal.records[index],checked=await targetRecord(project,root,row,validate),detached=inside(task,path.join(task,'sources',String(index)));
    if(await exists(checked.source)){
      if(await exists(detached)||!same(await tree(checked.source),row.files))throw Error('Source changed or removal staging conflicts');
      row.state='detaching';await writeJson(journalFile,journal);await fs.mkdir(path.dirname(detached),{recursive:true});
      await noLinks(checked.source);await fs.rename(checked.source,detached);
      row.state='detached';await writeJson(journalFile,journal);await onStage('detached',row);
    }
    if(await exists(detached)){
      const actual=await tree(detached),expected=new Map(row.files.map(f=>[f.path,f]));
      if(actual.some(f=>!same(f,expected.get(f.path)))||(!['purging','removed'].includes(row.state)&&!same(actual,row.files)))throw Error('Detached source changed; retain diagnostics');
      await targetRecord(project,root,row,validate);
      row.state='purging';await writeJson(journalFile,journal);
      for(const file of actual){
        const item=inside(detached,path.join(detached,file.path));await noLinks(item);
        const current=await fs.stat(item);
        if(!current.isFile()||current.size!==file.bytes||await fileHash(item)!==file.sha256)throw Error('Detached file changed immediately before removal');
        await fs.unlink(item);await onStage('file-removed',row);
      }
      await removeEmptyDirectories(detached);
    }else if(!['purging','removed'].includes(row.state))throw Error('Reviewed source has no recoverable removal state');
    row.state='removed';await writeJson(journalFile,journal);await onStage('removed',row);
  }
  await preserved(project,plan);
  for(const row of journal.records){if(await exists(sourcePath(project,row.source)))throw Error('Removed source reappeared');await targetRecord(project,root,row,validate);}
  journal.state='completed';journal.completedAt=now();journal.removedRecords=journal.records.length;journal.releasedSourceBytes=journal.records.reduce((n,r)=>n+r.bytes,0);journal.independentStorageBackupCompleted=false;
  await writeJson(journalFile,journal);
  journal.receipt=(await seal(root,'migration-reports/prune-'+journal.startedAt.replace(/[-:]/g,''),{'report.json':journal})).path;
  await writeJson(journalFile,journal);await insideCleanup(root,task);return journal;
}

export async function restorePrunedSource(project,root,plan,source,{validate=verifyEvidence}={}){
  checkPlan(plan);const row=plan.records.find(r=>r.source===source);if(!row)throw Error('Source is not in the reviewed removal plan');
  const checked=await targetRecord(project,root,row,validate);if(await exists(checked.source))throw Error('Restore refuses to overwrite an existing original path');
  const task=await fs.mkdtemp(path.join(root,'pending','prune-restore-'));await writeJson(path.join(task,'owner.json'),{owner:'mediascope-github-archive',state:'restore-original-path'});
  const restored=path.join(task,'original');await fs.cp(checked.original,restored,{recursive:true,errorOnExist:true,force:false});
  if(!same(await tree(restored),row.files))throw Error('Restored original bytes differ');await validate(project,restored,checked.relative);
  await noLinks(checked.source);await fs.mkdir(path.dirname(checked.source),{recursive:true});await fs.rename(restored,checked.source);await insideCleanup(root,task);
  return {source:row.source,restoredAt:now(),bytes:row.bytes};
}

async function main(){
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.join(project,'github-archive'),work=path.join(project,'.build','github-archive-implementation');
  if(!/^\d+$/.test(process.env.MEDIASCOPE_PRUNE_LOCK_PARENT_PID??''))throw Error('Run through prune-github-evidence.ps1 to hold the existing evidence recording lock');
  const [command,planFile,source,...extra]=process.argv.slice(2);if(extra.length||!['prepare','apply','restore'].includes(command)||command==='prepare'&&(planFile||source)||command!=='restore'&&source)throw Error('Invalid exact-source removal command');
  await assertRoot(root);
  if(execFileSync('git',['ls-files','--','github-archive','evidence-archive/records'],{cwd:project,encoding:'utf8',windowsHide:true}).trim())throw Error('Archive or source records are Git tracked; stop');
  for(const probe of ['github-archive/repository.json','evidence-archive/records/protection-probe'])execFileSync('git',['check-ignore','--quiet',probe],{cwd:project,windowsHide:true});
  const gate=await lock(root,'prune-'+command);
  try{
    if(command==='prepare'){
      const plan=await preparePrune(project,root),file=path.join(work,'prune-plan-'+now({milliseconds:true}).replace(/[-:]/g,'')+'.json');await writeJson(file,plan);
      console.log(JSON.stringify({plan:file,records:plan.records.length,bytes:plan.records.reduce((n,r)=>n+r.bytes,0),removed:false}));
    }else{
      if(!planFile)throw Error('Explicit reviewed plan file required');const file=inside(work,path.resolve(planFile));await noLinks(file);
      const plan=await readJson(file),result=command==='apply'?await applyPrune(project,root,plan):await restorePrunedSource(project,root,plan,source);
      console.log(JSON.stringify(result,null,2));
    }
  }finally{await gate.release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
