import {utcNow} from '../public/portable.js';
// Focused measurement evidence, not a release build or full regression claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {FF,FP,probe,run} from '../engine.mjs';
import {allPackets} from '../analysis.mjs';
import {saveBitrateEvidence} from '../test/helpers/bitrate-evidence.mjs';
import {measureSuite} from './bitrate-validation-suite.mjs';
const suite=process.argv[2]==='--suite';
const file=path.resolve(suite?'test-work/参考 多音轨.mp4':process.argv[2]??'test-work/参考 多音轨.mp4');
const startedAt=utcNow(),id=startedAt.replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')+'-'+randomUUID().slice(0,8);
const directory=path.resolve('evidence-archive/pending/bitrate-'+id);
await fs.mkdir(directory,{recursive:true});
const commands=[],ctx={cwd:process.cwd(),commands,update:()=>{}};
if(!suite)await fs.copyFile(file,path.join(directory,'input'+path.extname(file)));
let result,error;
try {
 if(suite) {
  result=await measureSuite(directory,ctx);
  await fs.writeFile(path.join(directory,'suite-summary.json'),JSON.stringify(result,null,2)+'\n');
  await fs.mkdir(path.join(directory,'replay'));
  await fs.copyFile('public/bitrate-model.js',path.join(directory,'replay/bitrate-model.mjs'));
  await fs.copyFile('scripts/replay-bitrate-evidence.mjs',path.join(directory,'replay/replay.mjs'));
  execFileSync(process.execPath,[path.join(directory,'replay/replay.mjs'),directory],{stdio:'pipe',windowsHide:true});
 } else {
  const p=await probe(file,ctx);
  const packets=JSON.parse(await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,dts,duration,size','-of','json',file],ctx));
  const fine=await allPackets(file,p.raw.streams,{...ctx,bitrateWindowMs:100});
  const coarse=await allPackets(file,p.raw.streams,{...ctx,bitrateWindowMs:1000});
  result=await saveBitrateEvidence(directory,{file,probe:p,fine:fine.filter(t=>t.bitrateCurve),coarse:coarse.filter(t=>t.bitrateCurve),commands,packets,...(process.argv[2]?{inputProvenance:'Caller-supplied media; original capture provenance not verified'}:{})});
 }
}catch(e){error=e;await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({error:e.stack,commands},null,2));}
const outcome=!error&&result.outcome==='passed'?'passed':'failed';
const tools={ffmpeg:await run(FF,['-version']),ffprobe:await run(FP,['-version'])};
const log=Buffer.from(JSON.stringify({outcome,cases:result?.cases,tracks:result?.tracks?.map(t=>({index:t.index,type:t.type,intervals:t.comparisons.length,exactEqual:t.exactEqual,displayEqual:t.displayEqual,byteConservation:t.byteConservation})),error:error?.message},null,2)+'\n');
await fs.writeFile(path.join(directory,'output.log'),log);
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const manifest={schema:2,evidenceRevision:2,kind:'Custom',label:suite?'bitrate-equivalence-suite':'bitrate-equivalence',version,runId:id,startedAt,endedAt:utcNow(),purpose:'Focused bitrate equivalence; not full regression or release acceptance',outcome,exitCode:outcome==='passed'?0:1,tools,invocation:{executable:process.execPath,args:process.argv.slice(1)},retention:'Independent retained measurement record; no automatic deletion',log:{file:'output.log',storedBytes:log.length,sha256:createHash('sha256').update(log).digest('hex')}};
await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const ps=path.resolve('scripts/test-storage.ps1');
const gate=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-Action','Lock'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
try {
  await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Evidence lock timeout')),30000);gate.stdout.on('data',b=>{out+=b;if(out.includes('READY')){clearTimeout(timer);resolve()}});gate.once('error',e=>{clearTimeout(timer);reject(e)});gate.once('exit',()=>{clearTimeout(timer);reject(Error('Evidence lock exited before ready'))});});
  manifest.runId=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-Action','Allocate'],{encoding:'utf8',windowsHide:true}).trim();
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const destination=path.resolve('evidence-archive/runs',version,manifest.runId);
  const archived=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,'-Action','Commit','-Source',directory,'-Destination',destination],{encoding:'utf8',windowsHide:true}).trim();
  console.log(log.toString());console.log('Archived: '+archived);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/verify-test-evidence.ps1'),'-Record',archived],{stdio:'pipe',windowsHide:true});
  const pendingRoot=path.resolve('evidence-archive/pending');
  if(path.dirname(directory)!==pendingRoot||!path.basename(directory).startsWith('bitrate-'))throw Error('Refusing cleanup outside owned pending directory');
  await fs.rm(directory,{recursive:true,force:true});
}finally{gate.stdin.end('\n');}
process.exitCode=manifest.exitCode;
