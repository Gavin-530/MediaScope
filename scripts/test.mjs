import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import os from 'node:os';
import {releaseReadiness,regressionAssessment} from '../testing-tools/helpers/test-results.mjs';
import {fixtureCache} from '../testing-tools/helpers/fixtures.mjs';
import {checkToolSources} from '../testing-tools/helpers/source-layout.mjs';
import {saveMeasurements,compactResults} from './test-evidence.mjs';
import {caseCatalog,selectCases,assessCases,moduleResults,requiredMeasurements} from '../testing-tools/helpers/case-catalog.mjs';
import {validateProduct,assessRequirements,softwareIdentity,testSystemIdentity,affectedModules,requirementCases} from '../testing-tools/helpers/product-contract.mjs';
import {saveExecutionCoverage} from '../testing-tools/helpers/execution-coverage.mjs';

// Application bytes and harness bytes are captured independently. No source rewriting.
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args[0]==='--complete'){
  const {runComplete}=await import('./test-complete.mjs');await runComplete(args.slice(1));
}else if(args[0]==='--maintain'){
  const {runMaintenance}=await import('../testing-tools/maintenance/index.mjs');await runMaintenance(args.slice(1));
}else if(args[0]==='--extend'){
  const {runExtension}=await import('../testing-tools/extensions/index.mjs');await runExtension(args.slice(1));
}else{
let suite='full',ref,affected,requireClean=false,release=false,maxLogMiB=16,warnTotalMiB=1024,list=false,dryRun=false,jobs=1;const modules=[],caseIds=[],requirements=[];
while(args.length){const a=args.shift();if(a==='--suite')suite=args.shift();else if(a==='--module'||a==='--case'||a==='--requirement'){const value=args.shift();if(!value||value.startsWith('--'))throw Error('Missing selection value');(a==='--module'?modules:a==='--requirement'?requirements:caseIds).push(...value.split(','))}else if(a==='--affected'){affected=args.shift();if(!affected||affected.startsWith('-'))throw Error('Missing valid --affected reference')}else if(a==='--jobs')jobs=Number(args.shift());else if(a==='--list')list=true;else if(a==='--dry-run')dryRun=true;else if(a==='--source-ref'){ref=args.shift();if(!ref)throw Error('Missing source ref')}else if(a==='--require-clean')requireClean=true;else if(a==='--release'){release=true;requireClean=true}else if(a==='--max-log-mib')maxLogMiB=Number(args.shift());else if(a==='--warn-total-mib')warnTotalMiB=Number(args.shift());else throw Error('Unknown test argument: '+a)}
if(!['full','core','browser','gpu','native'].includes(suite))throw Error('Suite must be full, core, browser, gpu or native');
if(!list&&!dryRun)execFileSync(process.execPath,[path.join(project,'scripts','local-notes.mjs'),'check'],{cwd:project,stdio:'inherit',windowsHide:true});
const contractSummary=await validateProduct(caseCatalog);
if(!Number.isSafeInteger(jobs)||jobs<1||jobs>8)throw Error('--jobs must be an integer from 1 to 8');
if(affected){
 if(modules.length||caseIds.length||requirements.length||ref||release)throw Error('--affected cannot be combined with explicit selection/source/release');
 const changed=execFileSync('git',['-C',project,'diff','--name-only',affected,'--'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean);
 changed.push(...execFileSync('git',['-C',project,'ls-files','--others','--exclude-standard'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(Boolean));
 modules.push(...affectedModules(changed));
 if(!modules.length){console.log(JSON.stringify({scope:'no-formal-software-change',changed,extensionsIncluded:false}));process.exit(0)}
}
if(requirements.length){const allowed=requirementCases(requirements);if(caseIds.length){for(const id of caseIds)if(!allowed.includes(id))throw Error('Case is outside the selected behavior requirements: '+id);}else caseIds.push(...allowed);}
const selection=selectCases({suite,modules,cases:caseIds});selection.requirements=[...new Set(requirements)];
if(release&&(suite!=='full'||ref||selection.selective))throw Error('--release requires the complete formal suite against the clean current checkout');
if(list||dryRun){console.log(JSON.stringify({scope:'formal',suite,modules:caseCatalog.modules,selection,extensionsIncluded:false,softwareContract:contractSummary,softwareComplete:false},null,2));process.exit(0)}
if(!Number.isSafeInteger(maxLogMiB)||maxLogMiB<1||maxLogMiB>256||!Number.isSafeInteger(warnTotalMiB)||warnTotalMiB<1)throw Error('Invalid evidence size limit');
const now=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
let id=now().replace(/[-:]/g,'')+'-'+randomUUID().slice(0,4);
let work=path.join(project,'.build','test-runs',id),source=path.join(work,'s'),evidence=path.join(work,'evidence');
const sha=b=>createHash('sha256').update(b).digest('hex');
await checkToolSources(path.join(project,'testing-tools'));
// Local notes were checked before product validation or allocating any evidence.
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
await fs.mkdir(path.dirname(lockPath),{recursive:true});
const lock=await fs.open(lockPath,'wx').catch(error=>{if(error.code==='EEXIST')throw Error('Another test run is active, or an interrupted test-run.lock needs inspection',{cause:error});throw error});
await lock.writeFile(JSON.stringify({pid:process.pid,runId:id,started:now()}));
let gate,allocated=false,exitCode=2,version=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).version,output='',events=[],preflight={},command;
const originalTmp=process.env.TMP,originalTemp=process.env.TEMP;
const started=now();
const manifest={schema:3,evidenceRevision:2,kind:'App',runId:id,startedAt:started,scope:selection.selective?'selected':suite,selection:{suite,modules:selection.modules,caseIds:selection.caseIds,excluded:selection.excluded,extensionsIncluded:false},invocation:{executable:process.execPath,args:process.argv.slice(1),cwd:process.cwd()},releaseCheck:{requested:release,ready:false,reasons:['Not evaluated']},host:{platform:process.platform,architecture:process.arch,release:os.release()},source:{},harness:{},outcome:'blocked',exitCode:2};
if(process.env.GITHUB_ACTIONS==='true')manifest.github={repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,sha:process.env.GITHUB_SHA,job:process.env.GITHUB_JOB,ref:process.env.GITHUB_REF,event:process.env.GITHUB_EVENT_NAME};
try {
  gate=spawn('powershell.exe',psArgs('Lock'),{windowsHide:true,stdio:['pipe','pipe','pipe']});
  gate.stdin.on('error',()=>{});
  await new Promise((resolve,reject)=>{let message='';const timer=setTimeout(()=>reject(Error('Evidence lock timeout')),180000);gate.stdout.on('data',b=>{message+=b;if(message.includes('READY')){clearTimeout(timer);resolve()}});gate.stderr.on('data',b=>message+=b);gate.once('error',e=>{clearTimeout(timer);reject(e)});gate.once('exit',()=>{clearTimeout(timer);reject(Error('Evidence lock/verification failed: '+message))})});
  id=ps('Allocate').trim();manifest.runId=id;allocated=true;
  work=path.join(project,'.build','test-runs',id);source=path.join(work,'s');evidence=path.join(work,'evidence');
  await lock.truncate(0);await lock.write(JSON.stringify({pid:process.pid,runId:id,started}),0,'utf8');
  await json(path.join(evidence,'manifest.json'),{...manifest,version,blockedReason:'Execution has not completed'});
  await fs.mkdir(source,{recursive:true});
  manifest.harness={commit:git('rev-parse','HEAD'),workingTree:git('status','--porcelain=v1','--untracked-files=normal').split('\n').filter(Boolean)};
  if(requireClean&&manifest.harness.workingTree.length)throw Error('TEST_INFRA: --require-clean requires a clean working tree');
  if(ref){
    const commit=git('rev-parse','--verify','--end-of-options',ref+'^{commit}');
    if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Invalid source commit');
    const refFiles=git('ls-tree','-rz','--name-only',commit).split('\0').filter(Boolean);
    if(refFiles.some(file=>/^(local-notes|github-archive|\.mediascope|releases|local-test-archive)\//i.test(file)||/^evidence-archive\/(?!tools\/import-local-test-evidence\.ps1$)/i.test(file)||file.toLowerCase()==='docs/github-archive-plan.md'))throw Error('TEST_INFRA: historical Git tree contains protected local data');
    manifest.source={kind:'git',commit,tree:git('rev-parse',commit+'^{tree}')};
    const zip=path.join(work,'application.zip');git('archive','--format=zip','--output='+zip,commit);
    execFileSync('tar.exe',['-xf',zip,'-C',source],{windowsHide:true});
    await files(source); // Refuse symlinks before overlaying the current test harness.
    for(const name of ['local-notes','github-archive','.mediascope','releases','local-test-archive'])if(await fs.stat(path.join(source,name)).catch(e=>{if(e.code==='ENOENT')return null;throw e}))throw Error('TEST_INFRA: historical source contains protected local data: '+name);
  }else{
    manifest.source={kind:'working-tree',commit:manifest.harness.commit,workingTree:manifest.harness.workingTree};
    // Include new nonignored application modules in the working-tree snapshot.
    for(const file of git('ls-files','--cached','--others','--exclude-standard').split('\n').filter(Boolean)){
      if(/^(local-notes|github-archive|\.mediascope|releases|local-test-archive)\//i.test(file)||file.toLowerCase()==='docs/github-archive-plan.md')throw Error('TEST_INFRA: protected local data is tracked by Git: '+file);
      if(file.startsWith('evidence-archive/'))continue;
      if(file.startsWith('testing-tools/')||file.startsWith('scripts/'))continue;
      const from=path.join(project,file);try{await copy(from,path.join(source,file))}catch(e){if(e.code!=='ENOENT')throw e}
    }
  }
  // Remove the historical harness from a ref snapshot before installing the current harness.
  if(ref)for(const name of ['test','testing-tools']){const target=path.join(source,name);if(!target.startsWith(work+path.sep))throw Error('Invalid harness target');await fs.rm(target,{recursive:true,force:true})}
  await copy(path.join(project,'testing-tools'),path.join(source,'testing-tools'));
  // Capture the maintained tooling tree once; new helper scripts cannot be omitted.
  await copy(path.join(project,'scripts'),path.join(source,'scripts'));
  const harnessScripts=(await files(path.join(project,'scripts'))).map(file=>path.relative(path.join(project,'scripts'),file).replaceAll('\\','/'));
  const importerPath='evidence-archive/tools/import-local-test-evidence.ps1';
  await copy(path.join(project,importerPath),path.join(source,importerPath));
  await copy(path.join(project,'docs','data-and-archives.md'),path.join(source,'docs','data-and-archives.md'));
  await copy(path.join(project,'package-lock.json'),path.join(source,'harness-package-lock.json'));
  const sourceFiles=[];for(const file of await files(source)){const b=await fs.readFile(file);sourceFiles.push({path:path.relative(source,file).replaceAll('\\','/'),bytes:b.length,sha256:sha(b)})}
  // Identity is retained; the isolated execution checkout is temporary, not an archive.
  manifest.source.sha256=sha(JSON.stringify(sourceFiles));
  manifest.software=await softwareIdentity(source);
  manifest.testSystem=await testSystemIdentity(source);
  manifest.contract={...contractSummary,sha256:sha(await fs.readFile(path.join(source,'testing-tools','product.json')))};
  manifest.harness.sha256=sha(JSON.stringify(sourceFiles.filter(x=>x.path.startsWith('testing-tools/')||[...harnessScripts.map(x=>'scripts/'+x),importerPath,'scripts/check-environment.mjs','harness-package-lock.json'].includes(x.path))));
  const temporaryDirectory=path.join(work,'tmp');await fs.mkdir(temporaryDirectory,{recursive:true});
  process.env.TMP=temporaryDirectory;process.env.TEMP=temporaryDirectory;
  manifest.temporaryDirectory=path.relative(project,temporaryDirectory).replaceAll('\\','/');
  version=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version;
  if(!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9][0-9]*))?)?$/.test(version))throw Error('Invalid application version');
  const runtime=JSON.parse(await fs.readFile(path.join(source,'runtime-lock.json'),'utf8'));
  if(!runtime.nodeMajors.includes(Number(process.versions.node.split('.')[0])))throw Error('Unsupported Node.js version');
  const needsMedia=selection.cases.some(c=>c.requiresMedia!==false);
  const component=runtime.components.find(x=>x.name==='ffmpeg');
  const privateRoot=path.join(process.env.MEDIASCOPE_HOME||path.join(process.env.LOCALAPPDATA,'MediaScope'),'runtimes',component.sha256);
  const locate=async(name)=>{const override=process.env[name==='ffmpeg'?'FFMPEG_PATH':'FFPROBE_PATH'];if(override)return override;const pinned=path.join(privateRoot,component.executables[name]);try{await fs.access(pinned);return pinned}catch{return execFileSync('where.exe',[name],{encoding:'utf8',windowsHide:true}).trim().split('\r\n')[0]}};
  const ffmpeg=needsMedia?await locate('ffmpeg'):undefined,ffprobe=needsMedia?await locate('ffprobe'):undefined;
  manifest.fixtures={preparation:'on-demand, checksum verified',declaredAllowedInputs:[...new Set(selection.cases.flatMap(c=>c.inputs))]};
  const selectionFile=path.join(source,'.build','test-selection.json');await json(selectionFile,{caseIds:selection.caseIds});
  const coverageDirectory=path.join(source,'.build/v8');await fs.mkdir(coverageDirectory,{recursive:true});
  const env={...process.env,NODE_V8_COVERAGE:coverageDirectory,MEDIASCOPE_TEST_SELECTION:selectionFile,MEDIASCOPE_TEST_FIXTURES:fixtureCache,...(needsMedia?{FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe}:{}),MEDIASCOPE_TEST_SOURCE_KIND:ref?'git':'working-tree'};
  preflight.executables=[];for(const [name,exe] of [['node',process.execPath],...(needsMedia?[['ffmpeg',ffmpeg],['ffprobe',ffprobe]]:[])])preflight.executables.push({name,path:exe,sha256:sha(await fs.readFile(exe))});
  if(needsMedia){
  console.log('Checking real encoders, metrics, HTTP startup and browser prerequisites…');
  const check=await run(process.execPath,[path.join(source,'scripts','check-environment.mjs'),source,ffmpeg,ffprobe,path.join(evidence,'compatibility.json')],{cwd:source,env});
  output+=check.stdout+check.stderr;
  if(check.code)throw Error('TEST_INFRA: runtime compatibility preflight failed; tests were not executed\n'+check.stderr.slice(-2000));
  preflight.compatibility=JSON.parse(await fs.readFile(path.join(evidence,'compatibility.json'),'utf8'));
  }else{preflight.compatibility={scope:'node-only selection',version:process.version,mediaToolsRequired:false};await json(path.join(evidence,'compatibility.json'),preflight.compatibility)}
  if(selection.cases.some(c=>c.scope==='browser'||c.requiresBrowser===true)){
    const {chromium}=await import('playwright-core');const browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})});
    try{preflight.browser={version:browser.version(),driver:JSON.parse(await fs.readFile(path.join(project,'node_modules','playwright-core','package.json'),'utf8')).version}}finally{await browser.close()}
  }
  await json(path.join(evidence,'manifest.json'),{...manifest,version,environment:preflight,blockedReason:'Execution has not completed'});
  const discovered=(await files(path.join(source,'testing-tools'))).filter(file=>file.endsWith('.test.mjs')).map(file=>path.relative(source,file).replaceAll('\\','/')).filter(file=>/^testing-tools\/(modules|tooling)\//.test(file));
  for(const name of discovered)if(!caseCatalog.cases.some(c=>c.file===name))throw Error('TEST_INFRA: test file has no catalog owner: '+name);
  const testFiles=selection.files.map(x=>path.join(source,x));
  if(!testFiles.length)throw Error('TEST_INFRA: empty suite');
  command={executable:process.execPath,args:['--test','--test-concurrency='+jobs,'--test-reporter=spec','--test-reporter-destination='+path.join(evidence,'output.log'),'--test-reporter='+pathToFileURL(path.join(source,'testing-tools','helpers','reporter.mjs')).href,'--test-reporter-destination='+path.join(evidence,'events.jsonl'),...testFiles],cwd:source};
  console.log(`Running ${selection.selective?'selected modules '+selection.modules.join(', '):suite+' formal suite'} (${selection.caseIds.length} cases) against ${ref||'the captured working tree'}…`);
  const result=await run(command.executable,command.args,{cwd:source,env});output+=result.stdout+result.stderr;
  events=(await fs.readFile(path.join(evidence,'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const summaries=events.filter(x=>x.type==='test:summary');
  const counts=summaries.at(-1)?.data.counts;
  if(!counts||!counts.tests)throw Error('TEST_INFRA: no structured test summary; run cannot pass');
  if(!counts.passed&&!counts.failed&&!counts.cancelled)throw Error('TEST_INFRA: every test was skipped; no executed checks');
  const cases=events.filter(x=>['test:pass','test:fail'].includes(x.type)&&x.data.file).map(x=>({event:x.type,...x.data,file:path.relative(source,x.data.file).replaceAll('\\','/')}));
  const cause=(e)=>e?.cause?cause(e.cause):e;
  const failures=cases.filter(x=>x.event==='test:fail').map(x=>({...x,classification:cause(x.details?.error)?.code==='ERR_ASSERTION'?'assertion':/TEST_INFRA|hookFailed/.test(JSON.stringify(x.details?.error))?'infrastructure':'runtime-needs-review'}));
  const classified=cases.map(item=>({...item,classification:failures.find(f=>f.file===item.file&&f.name===item.name)?.classification}));
  const assessment=assessCases(selection,cases);
  await json(path.join(evidence,'case-coverage.json'),assessment);
  await json(path.join(evidence,'requirement-coverage.json'),assessRequirements(assessment));
  const compact=compactResults(counts,classified);
  await json(path.join(evidence,'results.json'),compact);
  const features=moduleResults(selection,cases);
  await json(path.join(evidence,'features.json'),{schema:3,scope:suite,features:features.map(({id,status,missingFiles})=>({id,status,missingFiles}))});
  manifest.releaseCheck={requested:release,...releaseReadiness(counts,features)};
  if(ref||suite!=='full'||selection.selective){
    manifest.releaseCheck.ready=false;
    manifest.releaseCheck.reasons.push(ref?'Historical comparisons are not current-version acceptance':suite==='gpu'?'GPU verification must be paired with strict general regression':'Partial suites are not complete regression');
  }
  manifest.validation=regressionAssessment(counts,features,{suite:selection.selective?'selected':suite,historical:!!ref,processExitCode:result.code});
  const historicalNotApplicable=!!ref&&assessment.identitiesComplete&&assessment.cases.every(c=>['passed','skipped'].includes(c.status));
  if(!assessment.accepted&&!historicalNotApplicable){manifest.validation.accepted=false;manifest.validation.status='failed';manifest.validation.reasons.push('Required stable case IDs are missing, duplicated, failed or unexpected')}
  manifest.testSummary=counts;manifest.failureClasses=failures.map(x=>({name:x.name,classification:x.classification}));
  if(failures.some(x=>x.classification==='infrastructure')){exitCode=2;manifest.outcome='blocked'}else{exitCode=result.code===0&&counts.failed===0&&counts.cancelled===0&&counts.passed>0?0:1;manifest.outcome=exitCode===0?'passed':'failed'}
  if(exitCode===0&&!manifest.validation.accepted){exitCode=1;manifest.outcome='failed'}
  if(exitCode===0&&manifest.validation.status==='complete')console.log(`Complete ${suite==='gpu'?'GPU hardware':'general'} regression passed; release acceptance also requires the complementary scope and package checks.`);
  else console.log('Verification '+manifest.validation.status+' ('+manifest.validation.mode+'): '+manifest.validation.reasons.join('; '));
  console.log(JSON.stringify({outcome:manifest.outcome,validation:manifest.validation,counts}));
}catch(e){output+='\n'+e.stack+'\n';manifest.blockedReason=e.message;console.error(e.message)}
finally {
  try {
    if(!allocated)throw Error('No identity allocated under the evidence lock; no evidence files written');
    Object.assign(manifest,{version,endedAt:now(),exitCode,command});
    await json(path.join(evidence,'manifest.json'),manifest);
    manifest.executionCoverage=await saveExecutionCoverage(source,evidence);
    manifest.data=await saveMeasurements(path.join(source,'.build','testing-work'),evidence,{failed:exitCode!==0,requiredMeasurements:exitCode===0?requiredMeasurements(selection):[],observationRoot:path.join(source,'.build','testing-observations'),caseIds:selection.caseIds});
    const actualInputs=events.filter(e=>e.type==='test:stdout').flatMap(e=>String(e.data.message??'').split('\n').filter(line=>line.startsWith('MEDIASCOPE_INPUT ')).map(line=>JSON.parse(line.slice('MEDIASCOPE_INPUT '.length))));
    await json(path.join(evidence,'inputs.json'),{declaredAllowedInputs:manifest.fixtures?.declaredAllowedInputs??[],actualReads:actualInputs});
    let human='';try{human=await fs.readFile(path.join(evidence,'output.log'),'utf8')}catch{}
    const log=gzipSync(Buffer.from(output+human));await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'output.log.gz'),log);
    if(log.length>maxLogMiB*1024*1024)throw Error('Compressed log exceeds size limit; full log retained in sandbox');
    await fs.unlink(path.join(evidence,'output.log')).catch(e=>{if(e.code!=='ENOENT')throw e});
    await fs.unlink(path.join(evidence,'events.jsonl')).catch(e=>{if(e.code!=='ENOENT')throw e});
    Object.assign(manifest,{version,endedAt:now(),exitCode,command,environment:preflight,retention:'independent record; user may delete after execution; no automatic deletion',log:{file:'output.log.gz',compression:'gzip',storedBytes:log.length,sha256:sha(log),maximumStoredMiB:maxLogMiB}});
    await json(path.join(evidence,'manifest.json'),manifest);
    // A lock/ledger error is never bypassed with an unverified archive write.
    if(!gate||gate.exitCode!==null||gate.signalCode!==null)throw Error('Evidence lock unavailable; retained sandbox for recovery');
    const destination=path.join(project,'evidence-archive','runs',version,id);
    const archived=ps('Commit','-Source',evidence,'-Destination',destination).trim();
    console.log('Evidence: '+archived);console.log('MEDIASCOPE_RUN '+JSON.stringify({directory:archived,manifestSha256:sha(await fs.readFile(path.join(archived,'manifest.json')))}));console.log(ps('Clean','-Source',work).trim());
    try{
      let totalBytes=0;for(const file of await files(path.join(project,'evidence-archive'),{excludeTopLevel:['inbox','received','tools']}))totalBytes+=(await fs.stat(file)).size;
      if(totalBytes>warnTotalMiB*1024*1024)console.warn(`Evidence exceeds ${warnTotalMiB} MiB; review storage and completed records`);
    }catch(error){console.warn('Optional storage estimate unavailable: '+error.message)}
  }catch(e){exitCode=2;console.error('Evidence/cleanup failed: '+e.stack+'\nRetained: '+work)}
  if(originalTmp===undefined)delete process.env.TMP;else process.env.TMP=originalTmp;
  if(originalTemp===undefined)delete process.env.TEMP;else process.env.TEMP=originalTemp;
  if(gate){gate.stdin.end('\n');if(gate.exitCode===null&&gate.signalCode===null)await new Promise(resolve=>gate.once('exit',resolve))}
  await lock.close();await fs.unlink(lockPath);
}
process.exitCode=exitCode;
}
