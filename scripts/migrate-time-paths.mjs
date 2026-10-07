import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {canonicalTimePath,canonical,hash,now,inside,noLinks,exists,tree,fileHash,readJson,writeJson,snapshots,verifySnapshot,verifySnapshotLocation,verifyArchive,seal,lock,insideCleanup} from './github-archive-store.mjs';
import {evidenceRecords,verifyEvidence} from './github-archive-migration.mjs';

const digest=value=>hash(JSON.stringify(canonical(value)));
const relative=(root,file)=>path.relative(root,file).replaceAll('\\','/');
const journalName='pending/time-path-migration.json';
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
async function inventoryAt(file){
  await noLinks(file);const stat=await fs.lstat(file);
  return stat.isFile()?[{path:'content',bytes:stat.size,sha256:await fileHash(file)}]:await tree(file);
}

export async function planTimePaths(project){
  const plans=[],github=path.join(project,'github-archive'),evidence=path.join(project,'evidence-archive');
  await noLinks(project);
  for(const name of await fs.readdir(path.join(evidence,'records'))){
    const from='records/'+name,to=canonicalTimePath(from);
    if(from!==to)plans.push({root:'evidence-archive',from,to});
  }
  for(const dir of await snapshots(github)){
    const m=await verifySnapshot(dir);verifySnapshotLocation(github,dir,m);
    const from=relative(github,dir),to=canonicalTimePath(from);
    if(from!==to)plans.push({root:'github-archive',from,to});
  }
  const work=path.join(project,'.build/github-archive-implementation');
  if(await exists(work))for(const entry of await fs.readdir(work,{withFileTypes:true})){
    if(!/^(inventory|prune-plan)-.*\.json$/.test(entry.name))continue;
    const to=canonicalTimePath(entry.name);if(to===entry.name)continue;
    if(!entry.isFile())throw Error('Linked or invalid operation receipt');
    plans.push({root:'.build/github-archive-implementation',from:entry.name,to,kind:'file'});
  }
  const seen=new Set();
  for(const row of plans){
    const root=path.join(project,row.root),source=inside(root,path.join(root,row.from)),target=inside(root,path.join(root,row.to));
    await noLinks(source);await noLinks(target);
    const stat=await fs.lstat(source);
    if(row.kind==='file'?!stat.isFile():!stat.isDirectory())throw Error('Migration source type mismatch');
    const key=(row.root+'/'+row.to).toLowerCase();
    if(seen.has(key)||await exists(target))throw Error('Migration destination collision: '+key);
    if(row.root==='github-archive'){
      const object=row.from.slice(0,row.from.lastIndexOf('/revisions/'));
      if(object!==canonicalTimePath(object)&&await exists(path.join(root,canonicalTimePath(object))))throw Error('Migration object collision: '+object);
    }
    seen.add(key);
  }
  return plans;
}

async function verifyCurrent(project){
  const github=path.join(project,'github-archive'),result=await verifyArchive(github);
  if(result.errors.length)throw Error('Platform archive verification failed: '+JSON.stringify(result.errors));
  const code=`. ${psQuote(path.join(project,'scripts/evidence-lib.ps1'))}; $null=Test-EvidenceCatalog ${psQuote(path.join(project,'evidence-archive'))}`;
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{windowsHide:true,stdio:'pipe',maxBuffer:8*1024**2});
  for(const entry of await evidenceRecords(github))verifyEvidence(project,path.join(entry.dir,'original'),entry.provenance.identity.originalRelative);
  return result;
}

async function saveJournal(file,journal){
  const {journalSha256,...payload}=journal;
  await writeJson(file,{...payload,journalSha256:digest(payload)});
}
function checkJournal(journal){
  const {journalSha256,...payload}=journal;
  if(journal.format!==1||journal.kind!=='utc-time-path-migration'||journalSha256!==digest(payload))throw Error('Migration journal integrity failure');
  for(const row of journal.moves){
    if(!['github-archive','evidence-archive','.build/github-archive-implementation'].includes(row.root)||canonicalTimePath(row.from)!==row.to||row.from===row.to)throw Error('Invalid migration mapping');
    if(row.root.startsWith('.build/')&&(row.kind!=='file'||!/^(inventory|prune-plan)-[^/]+\.json$/.test(row.from)))throw Error('Invalid operation receipt mapping');
  }
  for(const file of journal.controls){
    if(!/^github-archive\/(?:.+\/latest\.json|index\/records\.json)$/.test(file.path)&&!['evidence-archive/catalog.json','.build/github-archive-implementation/latest-inventory.json'].includes(file.path))throw Error('Invalid migration control file');
    if(file.before!==null&&hash(Buffer.from(file.before,'base64'))!==file.beforeSha256)throw Error('Control backup integrity failure');
  }
}

async function finishReceipt(github,file,journal){
  const {controls:backups,createdParents,journalSha256,...report}=journal;
  const receipt=await seal(github,'migration-reports/time-format-'+journal.startedAt.replace(/[-:]/g,''),{'report.json':report});
  await fs.unlink(file);
  return {...report,receipt:receipt.path};
}

export async function rollbackTimePaths(project,{verify=verifyCurrent}={}){
  const github=path.join(project,'github-archive'),file=path.join(github,journalName),journal=await readJson(file);checkJournal(journal);
  if(journal.state==='completed')throw Error('Completed migration must not be rolled back as an interrupted transaction');
  for(const row of [...journal.moves].reverse()){
    const root=path.join(project,row.root),from=inside(root,path.join(root,row.from)),to=inside(root,path.join(root,row.to));
    await noLinks(from);await noLinks(to);
    const oldExists=await exists(from),newExists=await exists(to);
    if(oldExists===newExists)throw Error('Ambiguous or missing rollback source: '+row.from);
    const source=newExists?to:from;
    if(digest(await inventoryAt(source))!==row.inventorySha256)throw Error('Changed rollback source; original retained: '+row.from);
    if(newExists){await fs.mkdir(path.dirname(from),{recursive:true});await fs.rename(to,from);}
  }
  for(const saved of journal.controls){
    const name=inside(project,path.join(project,saved.path));await noLinks(name);
    if(saved.before===null){if(await exists(name))await fs.unlink(name)}
    else{await fs.mkdir(path.dirname(name),{recursive:true});await fs.writeFile(name,Buffer.from(saved.before,'base64'));}
  }
  // Remove only directories created by this transaction, and only when empty.
  for(const dir of [...journal.createdParents].reverse()){
    const name=inside(github,path.join(github,dir));await noLinks(name);
    if(await exists(name)&&!(await fs.readdir(name)).length)await fs.rmdir(name);
  }
  await verify(project);
  const proof=path.join(github,'pending/time-path-restore-proof');
  if(await exists(proof))await insideCleanup(github,proof);
  journal.state='rolled-back';journal.finishedAt=now();await saveJournal(file,journal);
  return journal;
}

export async function applyTimePaths(project,{verify=verifyCurrent,onStage=async()=>{}}={}){
  const github=path.join(project,'github-archive'),file=path.join(github,journalName);
  if(await exists(file)){
    const prior=await readJson(file);checkJournal(prior);
    if(prior.state==='completed'){
      if(prior.proofs!==prior.moves.length)throw Error('Completed journal has incomplete restoration proofs');
      for(const row of prior.moves){
        if(digest(await inventoryAt(path.join(project,row.root,row.to)))!==row.inventorySha256)throw Error('Completed migration content changed; receipt finalization refused');
      }
      await verify(project);
      return finishReceipt(github,file,prior);
    }
    if(!['completed','rolled-back'].includes(prior.state))throw Error('Interrupted time migration; run --rollback first');
  }
  await verify(project);
  const moves=await planTimePaths(project);
  if(!moves.length)return {moves:[],state:'unchanged'};
  await onStage('baseline-verified',{count:moves.length});
  const controls=new Map();
  const remember=async name=>{
    const key=relative(project,name);if(controls.has(key))return;
    await noLinks(name);const bytes=await exists(name)?await fs.readFile(name):null;
    controls.set(key,{path:key,before:bytes?.toString('base64')??null,beforeSha256:bytes?hash(bytes):null});
  };
  await remember(path.join(project,'evidence-archive/catalog.json'));
  await remember(path.join(github,'index/records.json'));
  const inventoryPointer=path.join(project,'.build/github-archive-implementation/latest-inventory.json');
  if(moves.some(r=>r.kind==='file'))await remember(inventoryPointer);
  const objects=new Set(moves.filter(r=>r.root==='github-archive').map(r=>r.from.slice(0,r.from.lastIndexOf('/revisions/'))));
  for(const object of objects){await remember(path.join(github,object,'latest.json'));await remember(path.join(github,canonicalTimePath(object),'latest.json'));}
  for(const row of moves){
    const inventory=await inventoryAt(path.join(project,row.root,row.from));
    row.inventorySha256=digest(inventory);row.files=inventory.length;row.bytes=inventory.reduce((n,f)=>n+f.bytes,0);
  }
  const journal={format:1,kind:'utc-time-path-migration',startedAt:now(),state:'prepared',moves,controls:[...controls.values()],createdParents:[],proofs:0};
  await saveJournal(file,journal);
  let sealed=false;
  try{
    journal.state='moving';await saveJournal(file,journal);
    for(const row of moves){
      const root=path.join(project,row.root),from=inside(root,path.join(root,row.from)),to=inside(root,path.join(root,row.to));
      if(digest(await inventoryAt(from))!==row.inventorySha256||await exists(to))throw Error('Migration source or destination changed');
      const missing=[];for(let p=path.dirname(to);!await exists(p);p=path.dirname(p))missing.unshift(p);
      for(const p of missing){journal.createdParents.push(relative(github,p));await saveJournal(file,journal);await fs.mkdir(p);}
      await noLinks(to);await fs.rename(from,to);await onStage('moved',row);
      if(digest(await inventoryAt(to))!==row.inventorySha256)throw Error('Moved record bytes changed');
      await saveJournal(file,journal);
    }
    journal.state='verifying';await saveJournal(file,journal);
    // Preserve observed pointer status and time; only update its location.
    for(const object of objects){
      const old=path.join(github,object,'latest.json'),current=path.join(github,canonicalTimePath(object),'latest.json');
      if(await exists(old)){
        const pointer=await readJson(old),destination=canonicalTimePath(object+'/'+pointer.revision).slice(canonicalTimePath(object).length+1);
        const snapshot=await verifySnapshot(path.join(path.dirname(current),destination));
        if(snapshot.contentSha256!==pointer.contentSha256)throw Error('Observed pointer content mismatch');
        await writeJson(current,{...pointer,revision:destination});if(old!==current)await fs.unlink(old);
      }
    }
    if(await exists(path.join(github,'index/records.json'))){
      const index=await readJson(path.join(github,'index/records.json'));
      index.records=index.records.map(r=>({...r,object:canonicalTimePath(r.object),path:canonicalTimePath(r.path)}));
      await writeJson(path.join(github,'index/records.json'),index);
    }
    const catalogFile=path.join(project,'evidence-archive/catalog.json');
    if(await exists(catalogFile)){
      const catalog=await readJson(catalogFile);catalog.records=catalog.records.map(r=>({...r,path:canonicalTimePath(r.path)}));await writeJson(catalogFile,catalog);
    }
    if(moves.some(r=>r.kind==='file')&&await exists(inventoryPointer)){
      const pointer=await readJson(inventoryPointer);await writeJson(inventoryPointer,{...pointer,path:canonicalTimePath(pointer.path)});
    }
    // Old report object directories are empty after moving their revisions and pointer.
    for(const object of objects){if(object===canonicalTimePath(object))continue;
      const revisions=path.join(github,object,'revisions');if(await exists(revisions)&&!(await fs.readdir(revisions)).length)await fs.rmdir(revisions);
      const dir=path.join(github,object);if(await exists(dir)&&!(await fs.readdir(dir)).length)await fs.rmdir(dir);
    }
    await verify(project);
    // Each record is independently copied back under its exact old leaf name.
    // Complete byte inventories prove restoration, including frozen manifests.
    const proof=path.join(github,'pending/time-path-restore-proof');
    if(await exists(proof))throw Error('Unfinished restoration proof exists; preserve it');
    for(const row of moves){
      const source=path.join(project,row.root,row.to),restored=path.join(proof,row.root,row.from);
      await writeJson(path.join(proof,'owner.json'),{owner:'mediascope-github-archive',state:'time-path-restore-proof'});
      await fs.mkdir(path.dirname(restored),{recursive:true});await fs.cp(source,restored,{recursive:true,errorOnExist:true,force:false});
      if(digest(await inventoryAt(restored))!==row.inventorySha256)throw Error('Independent original-path restoration failed');
      if(row.root==='github-archive')await verifySnapshot(restored);
      journal.proofs++;await saveJournal(file,journal);await insideCleanup(github,proof);await onStage('restored',row);
    }
    if((await planTimePaths(project)).length)throw Error('Noncanonical formal paths remain');
    journal.state='completed';journal.finishedAt=now();await saveJournal(file,journal);
    // Publication is idempotent. An interruption after verification is finalized
    // from the saved completed journal, with the same report bytes and identity.
    sealed=true;return await finishReceipt(github,file,journal);
  }catch(error){
    if(!sealed){journal.state='failed';await saveJournal(file,journal);await rollbackTimePaths(project,{verify});}
    throw error;
  }
}

async function main(){
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2);
  if(args.some(a=>!['--apply','--rollback','--locked'].includes(a))||args.includes('--apply')&&args.includes('--rollback'))throw Error('Use no arguments to preview, --apply to migrate, or --rollback to recover');
  if(!args.length){const moves=await planTimePaths(project);console.log(JSON.stringify({moves,state:'preview'},null,2));return;}
  if(!args.includes('--apply')&&!args.includes('--rollback'))throw Error('An explicit migration or recovery action is required');
  if(execFileSync('git',['ls-files','--','github-archive','evidence-archive/records'],{cwd:project,encoding:'utf8',windowsHide:true}).trim())throw Error('Archive data is tracked; migration refused');
  if(!args.includes('--locked')){
    const operation=args.includes('--rollback')?'--rollback':'--apply';
    const command=`$ErrorActionPreference='Stop'; . ${psQuote(path.join(project,'scripts/evidence-lib.ps1'))}; if(Test-Path -LiteralPath ${psQuote(path.join(project,'evidence-archive/pending/test-run.lock'))}){throw 'Active or interrupted test run'}; $gate=[IO.File]::Open((Get-EvidenceLockPath ${psQuote(project)}),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try{$env:MEDIASCOPE_TIME_MIGRATION_PARENT_PID=[string]$PID; & ${psQuote(process.execPath)} ${psQuote(fileURLToPath(import.meta.url))} ${operation} --locked; if($LASTEXITCODE -ne 0){throw 'Time migration failed'}} finally{$gate.Dispose()}`;
    const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true});if(result.error)throw result.error;process.exitCode=result.status??1;return;
  }
  if(!/^\d+$/.test(process.env.MEDIASCOPE_TIME_MIGRATION_PARENT_PID??''))throw Error('Evidence recording lock parent required');
  const gate=await lock(path.join(project,'github-archive'),'time-format-migration');
  const counts={moved:0,restored:0};
  try{const result=args.includes('--rollback')?await rollbackTimePaths(project):await applyTimePaths(project,{onStage:async(stage,row)=>{
    if(stage==='baseline-verified')console.log('Verified baseline; planned moves: '+row.count);
    else if(++counts[stage]%50===0)console.log(stage+': '+counts[stage]);
  }});console.log(JSON.stringify({state:result.state,moves:result.moves.length,proofs:result.proofs,receipt:result.receipt}));}
  finally{await gate.release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1});
