import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {productContract,validateProduct,softwareIdentity,testSystemIdentity} from '../testing-tools/helpers/product-contract.mjs';
import {caseCatalog,selectCases} from '../testing-tools/helpers/case-catalog.mjs';
import {zipMembers} from '../testing-tools/helpers/zip.mjs';
const project=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const harnessIdentity=async()=>(await testSystemIdentity()).sha256;
export function packagedSourceReadiness(members,identity,{contract=productContract,launcherFingerprint}={}){
 const reasons=[],verified=[];
 for(const item of contract.sources.filter(s=>s.shipment==='source')){
  const expected=identity.files.find(f=>f.path===item.file),bytes=members.get(item.file);
  if(!expected||!bytes||bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)reasons.push('Missing or changed packaged source: '+item.file);else verified.push(item.file);
 }
 let compiledLauncher=false;
 try{const meta=JSON.parse(members.get('scripts/launcher-build.json').toString()),binary=members.get('scripts/MediaScope.Launcher.exe'),bootstrap=identity.files.find(f=>f.path==='scripts/fast-bootstrap.mjs');compiledLauncher=meta.schema===1&&/^[a-f0-9]{64}$/.test(launcherFingerprint??'')&&meta.fingerprint===launcherFingerprint&&meta.bootstrapHash===bootstrap?.sha256&&meta.executableHash===sha(binary);}catch{}
 if(!compiledLauncher)reasons.push('Compiled launcher is not bound to reviewed source inputs');
 return {accepted:!reasons.length,reasons,verifiedSources:verified,compiledLauncher};
}
export function completeAssessment(stages,{source,harness,contract}={}){
 const reasons=[];
 for(const required of productContract.requiredStages){const found=stages.filter(s=>s.id===required.id);if(found.length!==1){reasons.push(required.id+': missing or duplicate stage');continue;}const s=found[0];if(s.status!=='passed'||s.exitCode!==0||!s.checks||s.failed||s.skipped||s.todo||s.cancelled)reasons.push(required.id+': executed passing checks required without skips');if(s.source!==source||s.harness!==harness||s.contract!==contract)reasons.push(required.id+': source/harness/contract mismatch');if(!s.receiptSha256||!/^[a-f0-9]{64}$/.test(s.receiptSha256))reasons.push(required.id+': immutable receipt required');}
 if(!source||!harness||!contract)reasons.push('Missing verification identities');
 if(stages.some(s=>!productContract.requiredStages.some(r=>r.id===s.id)))reasons.push('Unexpected stage');
 const packages=stages.filter(s=>['package','online'].includes(s.id));if(packages.length===2&&(!packages[0].packageSha256||packages[0].packageSha256!==packages[1].packageSha256))reasons.push('Deployment stages must use the same built package');
 if(packages.some(s=>s.artifactBinding!==true))reasons.push('Deployment package must match every shipped source and compiled launcher input');
 return {schema:1,scope:'software-complete',extensionsIncluded:false,status:reasons.length?'incomplete':'complete',accepted:!reasons.length,reasons};
}
export async function runComplete(args){
 let jobs=2,preview=false,requireClean=false;
 while(args.length){const argument=args.shift();if(['--list','--dry-run'].includes(argument))preview=true;else if(argument==='--require-clean')requireClean=true;else if(argument==='--jobs'){jobs=Number(args.shift());if(!Number.isInteger(jobs)||jobs<1||jobs>4)throw Error('Complete general-stage --jobs must be from 1 to 4');}else throw Error('--complete accepts --jobs, --require-clean, --list or --dry-run; use --module/--case/--suite for partial tests');}
 await validateProduct(caseCatalog);
 if(preview){console.log(JSON.stringify({scope:'software-complete',generalConcurrency:jobs,requireClean,stages:productContract.requiredStages,extensionsIncluded:false},null,2));return;}
 const id=new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID().slice(0,6),directory=path.join(project,'.build','complete',id);
 await fs.mkdir(directory,{recursive:true});
 const source=await softwareIdentity(),harness=await harnessIdentity(),contract=sha(await fs.readFile(path.join(project,'testing-tools/product.json')));
 const report={schema:1,scope:'software-complete',startedAt:new Date().toISOString(),source,harness,contract,requireClean,extensionsIncluded:false,stages:[],assessment:completeAssessment([],{source:source.sha256,harness,contract})};
 const output=path.join(directory,'complete.json'),save=()=>fs.writeFile(output,JSON.stringify(report,null,2)+'\n');await save();
 async function run(exe,argv,label){
  const log=path.join(directory,label+'.log');const stream=await fs.open(log,'wx');
  const chunks=[];
  try{const result=await new Promise((resolve,reject)=>{let stdout='';const child=spawn(exe,argv,{cwd:project,windowsHide:true});child.stdout.on('data',b=>{stdout+=b;chunks.push(b)});child.stderr.on('data',b=>chunks.push(b));child.once('error',reject);child.once('close',code=>resolve({code:code??2,stdout,log}));});await stream.writeFile(Buffer.concat(chunks));return result;}finally{await stream.close();}
 }
 async function stable(){if((await softwareIdentity()).sha256!==source.sha256||await harnessIdentity()!==harness)throw Error('Source or test system changed during complete validation');}
 try{
  for(const stage of productContract.requiredStages.filter(s=>s.suite)){
   console.log('Formal stage: '+stage.id);
   const args=[path.join(project,'scripts/test.mjs'),'--suite',stage.suite];
   if(stage.id==='general')args.push('--jobs',String(jobs));
   if(requireClean)args.push(stage.id==='general'?'--release':'--require-clean');
   const start=performance.now(),result=await run(process.execPath,args,stage.id);
   const marker=result.stdout.split(/\r?\n/).findLast(line=>line.startsWith('MEDIASCOPE_RUN '));if(!marker)throw Error(stage.id+': no committed evidence receipt; see '+result.log);
   const receipt=JSON.parse(marker.slice(15)),record=path.resolve(receipt.directory),archiveRoot=path.join(project,'evidence-archive','records');if(path.dirname(record)!==archiveRoot)throw Error('Stage receipt outside records');
   const bytes=await fs.readFile(path.join(record,'manifest.json'));if(sha(bytes)!==receipt.manifestSha256)throw Error('Changed stage receipt');
   const manifest=JSON.parse(bytes),coverage=await read(path.join(record,'case-coverage.json')),assertions=await read(path.join(record,'assertions.json'));
   const expected=selectCases({suite:stage.suite}).caseIds;
   if(manifest.software?.sha256!==source.sha256||manifest.testSystem?.sha256!==harness||manifest.contract?.sha256!==contract||manifest.source.kind!=='working-tree'||manifest.selection.extensionsIncluded!==false||coverage.cases.length!==expected.length||expected.some(id=>coverage.cases.filter(c=>c.id===id).length!==1||assertions.cases.filter(c=>c.id===id).length!==1))throw Error('Stage evidence identity is incomplete or mismatched: '+stage.id);
   report.stages.push({id:stage.id,status:manifest.outcome,exitCode:result.code,checks:manifest.testSummary.tests,failed:manifest.testSummary.failed,skipped:manifest.testSummary.skipped,todo:manifest.testSummary.todo,cancelled:manifest.testSummary.cancelled,source:source.sha256,harness,contract,receipt:path.relative(project,record).replaceAll('\\','/'),receiptSha256:sha(bytes),seconds:(performance.now()-start)/1000});
   await stable();await save();if(result.code!==0||!coverage.accepted||expected.some(id=>assertions.cases.find(c=>c.id===id)?.assertions<1))throw Error(stage.id+' failed: see '+record);
  }
  console.log('Formal stage: building exact-source package');
  const build=path.join(directory,'build');await fs.mkdir(build,{recursive:true});
  for(const name of ['analysis.mjs','repeat.mjs','repeat-samples.mjs','bd-measure.mjs','siti.mjs','gpu','engine.mjs','server.mjs','package.json','README.md','start.cmd','Uninstall.cmd','runtime-lock.json','public','licenses','scripts'])await fs.cp(path.join(project,name),path.join(build,name),{recursive:true});
  const version=(await read(path.join(project,'package.json'))).version;
  const built=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(build,'scripts/package.ps1'),'-Version',version],'build');if(built.code)throw Error('Package construction failed: '+built.log);
  const archive=path.join(build,'releases',`MediaScope-${version}-win-x64.zip`),archiveBytes=await fs.readFile(archive),packageSha256=sha(archiveBytes),prefix=`MediaScope-${version}-win-x64/`,members=new Map();
  for(const [name,bytes]of zipMembers(archiveBytes)){const normalized=name.replaceAll('\\','/');if(!normalized.startsWith(prefix)||members.has(normalized.slice(prefix.length)))throw Error('Unexpected or duplicate package root');members.set(normalized.slice(prefix.length),bytes);}
  const launcherFingerprint=sha(Buffer.concat(await Promise.all(['scripts/launcher/Launcher.cs','scripts/build-launcher.ps1','scripts/fast-bootstrap.mjs'].map(file=>fs.readFile(path.join(project,file))))));
  const binding=packagedSourceReadiness(members,source,{launcherFingerprint});if(!binding.accepted)throw Error(binding.reasons.join('; '));
  report.package={path:path.relative(project,archive).replaceAll('\\','/'),sha256:packageSha256,source:source.sha256,binding};await stable();await save();
  for(const stage of ['package','online']){
   console.log('Formal stage: '+stage);
   const start=performance.now(),resultPath=path.join(directory,stage+'-checks.json');
   const result=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/test-deployment.ps1'),'-Archive',archive,...(stage==='online'?['-Online']:[]),'-ResultPath',resultPath],stage);
   const checks=await read(resultPath),receipt=await fs.readFile(resultPath);
   if(checks.schema!==1||!checks.checks?.length||checks.online!==(stage==='online'))throw Error('Missing structured deployment checks');
   report.stages.push({id:stage,status:checks.outcome,exitCode:result.code,checks:checks.checks.length,failed:checks.checks.filter(c=>c.status!=='passed').length,source:source.sha256,harness,contract,packageSha256,artifactBinding:binding.accepted,receipt:path.relative(project,resultPath).replaceAll('\\','/'),receiptSha256:sha(receipt),seconds:(performance.now()-start)/1000});
   if(sha(await fs.readFile(archive))!==packageSha256)throw Error('Package changed during deployment testing');await stable();await save();if(result.code!==0)throw Error(stage+' failed');
  }
 }catch(error){report.failure=error.stack;console.error(error.message);process.exitCode=2;}
 finally{report.endedAt=new Date().toISOString();report.assessment=completeAssessment(report.stages,{source:source.sha256,harness,contract});if(report.failure){report.assessment.accepted=false;report.assessment.status='incomplete';report.assessment.reasons.push(report.failure.split('\n')[0]);}if(!report.assessment.accepted)process.exitCode=2;await save();console.log(JSON.stringify({assessment:report.assessment,report:output},null,2));}
}
