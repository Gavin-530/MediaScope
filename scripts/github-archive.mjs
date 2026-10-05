import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {TARGET,now,initialize,assertRoot,lock,verifyArchive,verifySnapshot,snapshots,readJson,writeJson,exists,inside,noLinks,tree,seal,hash,safeRelative} from './github-archive-store.mjs';
import {inventory,latestInventory} from './github-archive-inventory.mjs';
import {migrate,boundaryBaseline,evidenceRecords,verifyEvidence,importTransport,mergeCopy} from './github-archive-migration.mjs';
import {sync} from './github-archive-collect.mjs';
import {GitHubReader} from './github-archive-api.mjs';
import {capacityReport} from './github-archive-capacity.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function options(args){const result={command:args.shift()??'status'};while(args.length){const k=args.shift();if(k==='--offline'||k==='--json'||k==='--evidence')result[k.slice(2)]=true;else if(['--root','--archive','--source','--run','--attempt','--commit','--repository','--backup','--budget-minutes','--max-download-mib'].includes(k)){if(!args.length||args[0].startsWith('--'))throw Error('Missing option value');result[k.slice(2)]=args.shift()}else throw Error('Unknown archive option: '+k)}return result}
async function mutableRoot(root){
  if(path.resolve(root)!==path.join(project,'github-archive'))throw Error('Online/migration/import writes are limited to this project github-archive root');await noLinks(root);
  const tracked=execFileSync('git',['ls-files','--','local-notes','github-archive','docs/github-archive-plan.md'],{cwd:project,encoding:'utf8',windowsHide:true}).trim();if(tracked)throw Error('Archive data or implementation plan is tracked by Git; stop and resolve explicitly');
  execFileSync('git',['check-ignore','--quiet','github-archive/protection-probe'],{cwd:project,windowsHide:true});
  const old=await latestInventory(project);if(old.remote.state!=='checked'||old.remote.identity.repositoryId!==TARGET.repositoryId)throw Error('Repository identity inventory required');
  await initialize(root,TARGET);const readme=path.join(root,'README.md');if(!await exists(readme)){
    const guide=await fs.readFile(path.join(project,'docs/data-and-archives.md'),'utf8');
    const section=guide.match(/<!-- github-archive-readme:start -->\s*([\s\S]*?)\s*<!-- github-archive-readme:end -->/);
    if(!section)throw Error('Offline archive guide section missing');
    await fs.writeFile(readme,'# 平台档案使用说明\n\n本说明在档案初始化时从项目正式文档生成，供随资料离线保存；不代表之后的工具版本或远端状态。项目当前规范由 docs/data-and-archives.md 维护。\n\n'+section[1]+'\n',{flag:'wx'});
  }
}
export async function main(args=process.argv.slice(2)){
  const opts=options([...args]),root=path.resolve(opts.root??path.join(project,'github-archive'));
  if(opts.repository&&opts.repository!==TARGET.repository)throw Error('Different repository refused');
  if(opts.command==='import'&&(!opts.archive||!/^\d+$/.test(opts.run??'')||!/^\d+$/.test(opts.attempt??'')))throw Error('Import requires --archive and numeric --run --attempt');
  if(opts.command==='inventory'){if(opts.root)throw Error('Inventory scope is fixed to this project');return inventory(project,{online:!opts.offline})}
  if(!['status','capacity','list','verify','reindex','migrate','sync','import','merge','backup','boundary'].includes(opts.command))throw Error('Unknown github archive command');
  if(opts.command==='boundary'){const result=await boundaryBaseline(project);console.log(JSON.stringify(result,null,2));if(result.releaseChanges.length||result.oldEvidenceChanges.length)process.exitCode=1;return result}
  if(['migrate','sync','import','merge'].includes(opts.command))await mutableRoot(root);else await assertRoot(root);
  if(opts.command==='capacity'){const result=await capacityReport(root);console.log(JSON.stringify(result,null,2));return result;}
  if(opts.command==='verify'){
    const result=await verifyArchive(root);
    for(const entry of await evidenceRecords(root)){
      try{verifyEvidence(project,path.join(entry.dir,'original'),entry.provenance.identity.originalRelative)}catch(e){result.errors.push({path:path.relative(root,entry.dir),reason:'Product evidence validation failed'})}
    }
    result.integrity=result.errors.length?'failed':'verified';console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;return result;
  }
  if(opts.command==='list'){
    if(opts.evidence){
      const rows=[];for(const r of await evidenceRecords(root)){
        const identity=r.provenance.identity,m=await readJson(path.join(r.dir,'original',identity.payloadRelative,'manifest.json'));
        rows.push({Time:m.startedAt??m.startedAtUtc??m.createdAtUtc??null,Origin:'github-actions',Version:m.version??null,Kind:m.kind,Outcome:m.outcome??m.testStepOutcome??'unknown',CIStep:identity.testStepOutcome,Passed:m.testSummary?.passed??null,Failed:m.testSummary?.failed??null,Scope:m.scope??null,Validation:m.validation?.status??null,Run:m.runId,GitHubRun:identity.github.runId,Attempt:identity.github.runAttempt,Path:'github-archive/'+path.relative(root,r.dir).replaceAll('\\','/'),Original:path.join(r.dir,'original',identity.payloadRelative)});
      }console.log(JSON.stringify(rows,null,2));return rows;
    }
    const rows=[];for(const dir of await snapshots(root)){const m=await verifySnapshot(dir);rows.push({object:m.object,path:path.relative(root,dir).replaceAll('\\','/'),fetchedAt:m.fetchedAt,bytes:m.files.reduce((n,f)=>n+f.bytes,0),sha256:m.contentSha256})}console.log(JSON.stringify(rows,null,2));return rows;
  }
  if(opts.command==='status'){const result={identity:await assertRoot(root),coverage:await exists(path.join(root,'coverage.json'))?await readJson(path.join(root,'coverage.json')):{state:'not-synchronized'},formal:await verifyArchive(root),pending:await exists(path.join(root,'pending'))?await tree(path.join(root,'pending')):[],continuousFreshness:false};console.log(JSON.stringify(result,null,2));return result}
  const gate=await lock(root,opts.command);
  try{
    if(opts.command==='migrate'){const result=await migrate(project,root);console.log(JSON.stringify({sources:result.sourceRecords,copied:result.copied,deduplicated:result.deduplicated,errors:result.errors,oldBytesRetained:result.oldBytesRetained},null,2));if(result.errors.length)process.exitCode=1;return result}
    if(opts.command==='merge'){if(!opts.source)throw Error('Merge requires explicit --source archive copy');const source=path.resolve(opts.source);if(source===root)throw Error('Source copy must be independent');const result=await mergeCopy(root,source);console.log(JSON.stringify(result,null,2));return result}
    if(opts.command==='sync'){
      const minutes=Number(opts['budget-minutes']??30),mib=Number(opts['max-download-mib']??3072);if(!Number.isInteger(minutes)||minutes<1||minutes>120||!Number.isInteger(mib)||mib<1||mib>3072)throw Error('Invalid execution/storage budget');
      const result=await sync(project,root,{budgetMs:minutes*60000,maxBytes:mib*1024**2});const capacity=await capacityReport(root);console.log(JSON.stringify({counts:result.counts,countScope:result.countScope,coverage:result.coverage,addedBytes:result.addedBytes,addedBytesScope:result.addedBytesScope,receipt:result.receipt,gaps:result.gaps,queue:result.queue,capacity},null,2));if(!result.coverage.scanComplete||result.counts.error)process.exitCode=1;return result;
    }
    if(opts.command==='import'){
      if(!opts.archive||!opts.run||!opts.attempt)throw Error('Import requires --archive --run --attempt');if(opts.repository&&opts.repository!==TARGET.repository)throw Error('Different repository refused');
      const reader=new GitHubReader({root,budgetMs:5*60000}),repo=(await reader.get('')).data;if(String(repo.id)!==TARGET.repositoryId)throw Error('Repository identity mismatch');
      const run=(await reader.get('actions/runs/'+opts.run+'/attempts/'+opts.attempt)).data;
      if(String(run.repository.id)!==TARGET.repositoryId||String(run.id)!==opts.run||String(run.run_attempt)!==opts.attempt)throw Error('Run identity mismatch');
      const jobs=await reader.list('actions/runs/'+opts.run+'/attempts/'+opts.attempt+'/jobs','jobs');if(jobs.length!==1||jobs[0].name!=='Windows full regression'||run.path!=='.github/workflows/tests.yml')throw Error('Product job layout not supported');
      const artifacts=await reader.list('actions/runs/'+opts.run+'/artifacts','artifacts'),digest='sha256:'+await fileHashInput(opts.archive),artifact=artifacts.find(a=>a.name==='mediascope-test-evidence-'+opts.run+'-'+opts.attempt&&a.digest===digest);
      if(!artifact)throw Error('Transport has no matching platform digest; source retained as unverified, no formal import');
      const result=await importTransport(project,root,path.resolve(opts.archive),{repository:TARGET.repository,runId:opts.run,attempt:opts.attempt,commit:opts.commit??(['push','workflow_dispatch','schedule'].includes(run.event)?run.head_sha:undefined)},{reader,artifact:{id:artifact.id,digest:artifact.digest}});console.log(path.join(root,result.path));return result;
    }
    if(opts.command==='reindex'){
      if((await verifyArchive(root)).errors.length)throw Error('Cannot rebuild pointers from damaged or misplaced formal records');
      const rows=[];for(const dir of await snapshots(root)){const m=await verifySnapshot(dir);rows.push({object:m.object,path:path.relative(root,dir).replaceAll('\\','/'),sha256:m.contentSha256,fetchedAt:m.fetchedAt})}
      // Preserve valid observed pointers. Missing pointers can only recover the latest sealed capture, not lost check state.
      for(const object of new Set(rows.map(r=>r.object))){
        const file=path.join(root,object,'latest.json');let valid=false;
        if(await exists(file)){try{const pointer=await readJson(file);safeRelative(pointer.revision);valid=rows.some(r=>r.path===object+'/'+pointer.revision&&r.sha256===pointer.contentSha256)}catch{valid=false}}
        if(!valid){const candidate=rows.filter(r=>r.object===object).sort((a,b)=>b.fetchedAt.localeCompare(a.fetchedAt))[0];await writeJson(file,{format:1,revision:candidate.path.slice(object.length+1),contentSha256:candidate.sha256,lastCheckedAt:null,observationStatus:'rebuilt-from-sealed-capture; current-state-unconfirmed'})}
      }
      await writeJson(path.join(root,'index','records.json'),{format:1,rebuiltAt:now(),records:rows});console.log('Rebuilt '+rows.length+' entries from sealed records');return rows;
    }
    if(opts.command==='backup')return await backup(root,opts.backup);
  }finally{await gate.release()}
}
async function fileHashInput(file){const {fileHash}=await import('./github-archive-store.mjs');return fileHash(path.resolve(file))}
async function backup(root,directory){
  if(!directory)throw Error('Backup requires explicit --backup directory on independent storage');const destination=path.resolve(directory);await noLinks(destination);
  try{inside(root,destination,{equal:true});throw Error('Backup cannot be inside archive')}catch(e){if(e.message!=='Path outside owned root')throw e}
  const verification=await verifyArchive(root);if(verification.errors.length)throw Error('Backup source integrity failed');
  await fs.mkdir(destination,{recursive:true});const backupRoot=path.join(destination,'MediaScope-github-archive-'+now({milliseconds:true}).replace(/[-:]/g,''));await fs.mkdir(backupRoot);
  const copy=path.join(backupRoot,'github-archive');await fs.mkdir(copy);
  // Copy sealed formal content and offline control files; exclude pending, locks, HTTP cache and credentials.
  const files=(await tree(root)).filter(f=>!f.path.startsWith('pending/')&&!f.path.startsWith('index/'));
  for(const f of files){const output=path.join(copy,f.path);await fs.mkdir(path.dirname(output),{recursive:true});await fs.copyFile(path.join(root,f.path),output,1)}
  const result=await verifyArchive(copy);if(result.errors.length)throw Error('Independent backup verification failed');
  const verificationTools=path.join(backupRoot,'verification-tools');await fs.mkdir(verificationTools);
  const toolNames=[...new Set(['verify-github-archive-standalone.ps1','github-archive-evidence.ps1','evidence-lib.ps1','github-evidence-lib.ps1',...(await fs.readdir(path.join(project,'scripts'))).filter(name=>/^github-archive.*\.mjs$/.test(name)&&!name.endsWith('.test.mjs'))])];
  for(const name of toolNames)await fs.copyFile(path.join(project,'scripts',name),path.join(verificationTools,name),1);
  const storageIndependence=path.parse(destination).root.toLowerCase()===path.parse(root).root.toLowerCase()?'same-volume-restore-trial; not-independent-backup':'user-selected-volume; physical-storage-independence-unverified';
  await writeJson(path.join(backupRoot,'backup-manifest.json'),{format:1,...TARGET,capturedAt:now(),files,verificationTools:await tree(verificationTools),storageIndependence,externalDependencies:'Release packages remain separately in releases; project Git and user reports are not included',verification:result});
  const zip=path.join(backupRoot,'github-archive.zip'),restored=path.join(backupRoot,'restored');
  execFileSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ARCHIVE_BACKUP_SOURCE,$env:ARCHIVE_BACKUP_ZIP); [IO.Compression.ZipFile]::ExtractToDirectory($env:ARCHIVE_BACKUP_ZIP,$env:ARCHIVE_BACKUP_RESTORE)"],{windowsHide:true,timeout:120000,env:{...process.env,ARCHIVE_BACKUP_SOURCE:copy,ARCHIVE_BACKUP_ZIP:zip,ARCHIVE_BACKUP_RESTORE:restored}});
  const restoredResult=await verifyArchive(restored);if(restoredResult.errors.length)throw Error('Unpacked backup verification failed');
  const standalone=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(verificationTools,'verify-github-archive-standalone.ps1'),'-Root',restored],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:2*1024**2});
  let productRecords=0;for(const r of await evidenceRecords(restored)){execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(verificationTools,'github-archive-evidence.ps1'),'-Action','Verify','-Record',path.join(r.dir,'original'),'-Relative',r.provenance.identity.originalRelative],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024**2});productRecords++}
  restoredResult.standaloneVerification=standalone.trim();restoredResult.productRecordsVerified=productRecords;restoredResult.storageIndependence=storageIndependence;
  await writeJson(path.join(backupRoot,'restore-report.json'),restoredResult);await fs.writeFile(zip+'.sha256',await fileHashInput(zip)+'  github-archive.zip\n',{flag:'wx'});console.log('Verified separate copy and ZIP restore: '+backupRoot+' ('+storageIndependence+')');return {path:backupRoot,verification:restoredResult};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main().catch(error=>{console.error('GitHub archive: '+error.message);process.exitCode=1});
