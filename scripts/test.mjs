import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import {featureResults,releaseReadiness,regressionAssessment} from '../test/helpers/test-results.mjs';

// Application bytes and harness bytes are captured independently. No source rewriting.
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);let suite='full',ref,requireClean=false,release=false,maxLogMiB=16,warnTotalMiB=1024;
while(args.length){const a=args.shift();if(a==='--suite')suite=args.shift();else if(a==='--source-ref'){ref=args.shift();if(!ref)throw Error('Missing source ref')}else if(a==='--require-clean')requireClean=true;else if(a==='--release'){release=true;requireClean=true}else if(a==='--max-log-mib')maxLogMiB=Number(args.shift());else if(a==='--warn-total-mib')warnTotalMiB=Number(args.shift());else throw Error('Unknown test argument: '+a)}
if(!['full','core','browser'].includes(suite))throw Error('Suite must be full, core or browser');
if(release&&(suite!=='full'||ref))throw Error('--release requires the full suite against the clean current checkout');
if(!Number.isSafeInteger(maxLogMiB)||maxLogMiB<1||maxLogMiB>256||!Number.isSafeInteger(warnTotalMiB)||warnTotalMiB<1)throw Error('Invalid evidence size limit');
const id=new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,8);
const work=path.join(project,'evidence-archive','pending','test-runs',id),source=path.join(work,'source'),evidence=path.join(work,'evidence');
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...a)=>execFileSync('git',['-C',project,...a],{encoding:'utf8',windowsHide:true}).trim();
const psFile=path.join(project,'scripts','test-storage.ps1');
const psArgs=(action,...extra)=>['-NoProfile','-ExecutionPolicy','Bypass','-File',psFile,'-Action',action,...extra];
const ps=(action,...extra)=>execFileSync('powershell.exe',psArgs(action,...extra),{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
const json=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value,null,2)+'\n')};
async function files(dir,{excludeTopLevel=[]}={}){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){if(excludeTopLevel.includes(e.name))continue;if(e.isSymbolicLink())throw Error('Linked source/evidence entry: '+e.name);const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await files(p));else if(e.isFile())out.push(p)}return out.sort()}
async function copy(from,to){await fs.mkdir(path.dirname(to),{recursive:true});await fs.cp(from,to,{recursive:true,dereference:false,errorOnExist:false})}
const run=(exe,a,options={})=>new Promise((resolve,reject)=>{
  const child=spawn(exe,a,{windowsHide:true,...options});let stdout='',stderr='';
  child.stdout?.on('data',b=>stdout+=b);child.stderr?.on('data',b=>stderr+=b);
  child.once('error',reject);child.once('exit',(code,signal)=>resolve({code:code??1,signal,stdout,stderr}));
});
ps('Validate','-Source',work);
await fs.mkdir(path.dirname(work),{recursive:true});
const lockPath=path.join(project,'evidence-archive','pending','test-run.lock');
const lock=await fs.open(lockPath,'wx').catch(()=>{throw Error('Another test run is active, or an interrupted test-run.lock needs inspection')});
await lock.writeFile(JSON.stringify({pid:process.pid,runId:id,started:new Date().toISOString()}));
let gate,exitCode=2,version=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).version,output='',events=[],preflight={},command;
const started=new Date().toISOString();
const manifest={schema:3,evidenceRevision:1,kind:'App',runId:id,startedAt:started,scope:suite,invocation:{executable:process.execPath,args:process.argv.slice(1),cwd:process.cwd()},releaseCheck:{requested:release,ready:false,reasons:['Not evaluated']},host:{platform:process.platform,architecture:process.arch,release:os.release()},source:{},harness:{},outcome:'blocked',exitCode:2};
if(process.env.GITHUB_ACTIONS==='true')manifest.github={repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,sha:process.env.GITHUB_SHA,ref:process.env.GITHUB_REF,event:process.env.GITHUB_EVENT_NAME};
try {
  gate=spawn('powershell.exe',psArgs('Lock'),{windowsHide:true,stdio:['pipe','pipe','pipe']});
  gate.stdin.on('error',()=>{});
  await new Promise((resolve,reject)=>{let message='';const timer=setTimeout(()=>reject(Error('Evidence lock timeout')),30000);gate.stdout.on('data',b=>{message+=b;if(message.includes('READY')){clearTimeout(timer);resolve()}});gate.stderr.on('data',b=>message+=b);gate.once('error',e=>{clearTimeout(timer);reject(e)});gate.once('exit',()=>{clearTimeout(timer);reject(Error('Evidence lock/verification failed: '+message))})});
  await fs.mkdir(evidence,{recursive:true});await fs.mkdir(source,{recursive:true});
  manifest.harness={commit:git('rev-parse','HEAD'),workingTree:git('status','--porcelain=v1','--untracked-files=normal').split('\n').filter(Boolean)};
  if(requireClean&&manifest.harness.workingTree.length)throw Error('TEST_INFRA: --require-clean requires a clean working tree');
  if(ref){
    const commit=git('rev-parse','--verify','--end-of-options',ref+'^{commit}');
    if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid source commit');
    manifest.source={kind:'git',commit,tree:git('rev-parse',commit+'^{tree}')};
    const zip=path.join(work,'application.zip');git('archive','--format=zip','--output='+zip,commit);
    execFileSync('tar.exe',['-xf',zip,'-C',source],{windowsHide:true});
    await files(source); // Refuse symlinks before overlaying the current test harness.
  }else{
    manifest.source={kind:'working-tree',commit:manifest.harness.commit,workingTree:manifest.harness.workingTree};
    // All tracked application files plus current test infrastructure; never copy local data.
    for(const file of git('ls-files').split('\n').filter(Boolean)){
      if(file.startsWith('test/')||file.startsWith('scripts/'))continue;
      const from=path.join(project,file);try{await copy(from,path.join(source,file))}catch(e){if(e.code!=='ENOENT')throw e}
    }
  }
  // Remove the historical harness from a ref snapshot before installing the current harness.
  if(ref)execFileSync('powershell.exe',['-NoProfile','-Command',"$p=$env:MEDIASCOPE_HARNESS_TARGET; $root=$env:MEDIASCOPE_SANDBOX; if([IO.Path]::GetFullPath($p).StartsWith([IO.Path]::GetFullPath($root)+'\\')){if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}}else{throw 'Invalid harness target'}"],{env:{...process.env,MEDIASCOPE_HARNESS_TARGET:path.join(source,'test'),MEDIASCOPE_SANDBOX:work},windowsHide:true});
  await copy(path.join(project,'test'),path.join(source,'test'));
  await copy(path.join(project,'scripts','check-environment.mjs'),path.join(source,'scripts','check-environment.mjs'));
  const harnessScripts=['test.mjs','test-storage.ps1','evidence-lib.ps1','local-data.ps1','github-evidence-lib.ps1','import-github-test-evidence.ps1','run-ci-tests.ps1','export-github-test-evidence.ps1','sync-github-test-evidence.mjs','migrate-test-evidence.ps1','organize-test-evidence.ps1','list-test-evidence.ps1','verify-test-evidence.ps1'];
  for(const name of harnessScripts)await copy(path.join(project,'scripts',name),path.join(source,'scripts',name));
  const importerPath='evidence-archive/tools/import-local-test-evidence.ps1';
  await copy(path.join(project,importerPath),path.join(source,importerPath));
  await copy(path.join(project,'docs','evidence-archive-template.md'),path.join(source,'docs','evidence-archive-template.md'));
  await copy(path.join(project,'package-lock.json'),path.join(source,'harness-package-lock.json'));
  const sourceFiles=[];for(const file of await files(source)){const b=await fs.readFile(file);sourceFiles.push({path:path.relative(source,file).replaceAll('\\','/'),bytes:b.length,sha256:sha(b)})}
  await json(path.join(evidence,'source-manifest.json'),sourceFiles);
  manifest.harness.files=sourceFiles.filter(x=>x.path.startsWith('test/')||[...harnessScripts.map(x=>'scripts/'+x),importerPath,'scripts/check-environment.mjs','harness-package-lock.json','docs/evidence-archive-template.md'].includes(x.path));
  ps('Zip','-Source',source,'-Destination',path.join(evidence,'source.zip'));
  version=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version;
  if(!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9][0-9]*))?)?$/.test(version))throw Error('Invalid application version');
  const runtime=JSON.parse(await fs.readFile(path.join(source,'runtime-lock.json'),'utf8'));
  const component=runtime.components.find(x=>x.name==='ffmpeg');
  const privateRoot=path.join(process.env.MEDIASCOPE_HOME||path.join(process.env.LOCALAPPDATA,'MediaScope'),'runtimes',component.sha256);
  const locate=async(name)=>{const override=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];if(override)return override;const pinned=path.join(privateRoot,component.executables[name]);try{await fs.access(pinned);return pinned}catch{return execFileSync('where.exe',[name],{encoding:'utf8',windowsHide:true}).trim().split('\r\n')[0]}};
  const ffmpeg=await locate('ffmpeg'),ffprobe=await locate('ffprobe');
  const env={...process.env,FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe,MEDIASCOPE_TEST_SOURCE_KIND:ref?'git':'working-tree'};
  preflight.executables=[];for(const [name,exe] of [['node',process.execPath],['ffmpeg',ffmpeg],['ffprobe',ffprobe]])preflight.executables.push({name,path:exe,sha256:sha(await fs.readFile(exe))});
  console.log('Checking real encoders, metrics, HTTP startup and browser prerequisites…');
  const check=await run(process.execPath,[path.join(source,'scripts','check-environment.mjs'),source,ffmpeg,ffprobe,path.join(evidence,'compatibility.json')],{cwd:source,env});
  output+=check.stdout+check.stderr;
  if(check.code)throw Error('TEST_INFRA: runtime compatibility preflight failed; tests were not executed');
  preflight.compatibility=JSON.parse(await fs.readFile(path.join(evidence,'compatibility.json'),'utf8'));
  if(suite!=='core'){
    const {chromium}=await import('playwright-core');const browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})});
    try{preflight.browser={version:browser.version(),driver:JSON.parse(await fs.readFile(path.join(project,'node_modules','playwright-core','package.json'),'utf8')).version}}finally{await browser.close()}
  }
  const testFiles=(await fs.readdir(path.join(source,'test'))).filter(x=>x.endsWith('.test.mjs')&&(suite==='full'||(suite==='browser')===(x==='browser.test.mjs'))).sort().map(x=>path.join(source,'test',x));
  if(!testFiles.length)throw Error('TEST_INFRA: empty suite');
  command={executable:process.execPath,args:['--test','--test-concurrency=1','--test-reporter=spec','--test-reporter-destination='+path.join(evidence,'output.log'),'--test-reporter='+pathToFileURL(path.join(source,'test','helpers','reporter.mjs')).href,'--test-reporter-destination='+path.join(evidence,'events.jsonl'),...testFiles],cwd:source};
  console.log(`Running ${suite} suite against ${ref||'the captured working tree'}…`);
  const result=await run(command.executable,command.args,{cwd:source,env});output+=result.stdout+result.stderr;
  events=(await fs.readFile(path.join(evidence,'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const summaries=events.filter(x=>x.type==='test:summary');
  const counts=summaries.at(-1)?.data.counts;
  if(!counts||!counts.tests)throw Error('TEST_INFRA: no structured test summary; run cannot pass');
  if(!counts.passed&&!counts.failed&&!counts.cancelled)throw Error('TEST_INFRA: every test was skipped; no executed checks');
  const cases=events.filter(x=>['test:pass','test:fail'].includes(x.type)&&x.data.file).map(x=>({event:x.type,...x.data,file:path.relative(source,x.data.file).replaceAll('\\','/')}));
  const cause=(e)=>e?.cause?cause(e.cause):e;
  const failures=cases.filter(x=>x.event==='test:fail').map(x=>({...x,classification:cause(x.details?.error)?.code==='ERR_ASSERTION'?'assertion':/TEST_INFRA|hookFailed/.test(JSON.stringify(x.details?.error))?'infrastructure':'runtime-needs-review'}));
  await json(path.join(evidence,'results.json'),{counts,cases,failures,summaries:summaries.map(x=>x.data)});
  const coverage=JSON.parse(await fs.readFile(path.join(source,'test','coverage.json'),'utf8'));
  const features=featureResults(coverage,cases,suite);
  await json(path.join(evidence,'features.json'),{schema:2,scope:suite,features});
  manifest.releaseCheck={requested:release,...releaseReadiness(counts,features)};
  if(ref||suite!=='full'){
    manifest.releaseCheck.ready=false;
    manifest.releaseCheck.reasons.push(ref?'Historical comparisons are not current-version acceptance':'Partial suites are not complete regression');
  }
  manifest.validation=regressionAssessment(counts,features,{suite,historical:!!ref,processExitCode:result.code});
  manifest.testSummary=counts;manifest.failureClasses=failures.map(x=>({name:x.name,classification:x.classification}));
  if(failures.some(x=>x.classification==='infrastructure')){exitCode=2;manifest.outcome='blocked'}else{exitCode=result.code===0&&counts.failed===0&&counts.cancelled===0&&counts.passed>0?0:1;manifest.outcome=exitCode===0?'passed':'failed'}
  if(exitCode===0&&!manifest.validation.accepted){exitCode=1;manifest.outcome='failed'}
  if(exitCode===0&&manifest.validation.status==='complete')console.log('Complete current-version regression passed.');
  else console.log('Verification '+manifest.validation.status+' ('+manifest.validation.mode+'): '+manifest.validation.reasons.join('; '));
  console.log(JSON.stringify({outcome:manifest.outcome,validation:manifest.validation,counts}));
}catch(e){output+='\n'+e.stack+'\n';manifest.blockedReason=e.message;console.error(e.message)}
finally {
  try {
    Object.assign(manifest,{version,endedAt:new Date().toISOString(),exitCode,command});
    await json(path.join(evidence,'manifest.json'),manifest);
    // Retain actual measurements and recipes, never reproducible encoded media/runtime copies.
    const generated=path.join(source,'test-work');let artifacts=[];
    try{artifacts=await files(generated)}catch(e){if(e.code!=='ENOENT')throw e}
    const inventory=[];
    for(const file of artifacts){const rel=path.relative(generated,file).replaceAll('\\','/'),b=await fs.readFile(file),retained=/\.(json|jsonl|log|txt|csv|png)$/.test(file);inventory.push({path:rel,bytes:b.length,sha256:sha(b),retained});if(!retained)continue;await fs.mkdir(path.dirname(path.join(evidence,'artifacts',rel)),{recursive:true});await fs.writeFile(path.join(evidence,'artifacts',rel+'.gz'),gzipSync(b))}
    await json(path.join(evidence,'artifact-manifest.json'),inventory);
    let human='';try{human=await fs.readFile(path.join(evidence,'output.log'),'utf8')}catch{}
    const log=gzipSync(Buffer.from(output+human));await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'output.log.gz'),log);
    if(log.length>maxLogMiB*1024*1024)throw Error('Compressed log exceeds size limit; full log retained in sandbox');
    await fs.unlink(path.join(evidence,'output.log')).catch(e=>{if(e.code!=='ENOENT')throw e});
    try{const b=await fs.readFile(path.join(evidence,'events.jsonl'));await fs.writeFile(path.join(evidence,'events.jsonl.gz'),gzipSync(b));await fs.unlink(path.join(evidence,'events.jsonl'))}catch(e){if(e.code!=='ENOENT')throw e}
    Object.assign(manifest,{version,endedAt:new Date().toISOString(),exitCode,command,environment:preflight,retention:manifest.github?'temporary GitHub runner; export/upload required; permanent only after verified local import':'permanent local evidence; no automatic deletion',log:{file:'output.log.gz',compression:'gzip',storedBytes:log.length,sha256:sha(log),maximumStoredMiB:maxLogMiB}});
    await json(path.join(evidence,'manifest.json'),manifest);
    // A lock/ledger error is never bypassed with an unverified archive write.
    if(!gate||gate.exitCode!==null||gate.signalCode!==null)throw Error('Evidence lock unavailable; retained sandbox for recovery');
    const destination=path.join(project,'evidence-archive','runs',version,id);
    const archived=ps('Commit','-Source',evidence,'-Destination',destination).trim();
    console.log('Evidence: '+archived);console.log(ps('Clean','-Source',work).trim());
    let totalBytes=0;for(const file of await files(path.join(project,'evidence-archive'),{excludeTopLevel:['inbox','tools']}))totalBytes+=(await fs.stat(file)).size;
    if(totalBytes>warnTotalMiB*1024*1024)console.warn(`Evidence exceeds ${warnTotalMiB} MiB; records remain protected`);
  }catch(e){exitCode=2;console.error('Evidence/cleanup failed: '+e.stack+'\nRetained: '+work)}
  if(gate){gate.stdin.end('\n');if(gate.exitCode===null&&gate.signalCode===null)await new Promise(resolve=>gate.once('exit',resolve))}
  await lock.close();await fs.unlink(lockPath);
}
process.exitCode=exitCode;
