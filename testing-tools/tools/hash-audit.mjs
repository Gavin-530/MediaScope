// Explicit research audit, not a release gate or a claim of CAVP certification.
// All generated inputs, binaries, logs and results stay under this workspace's .build.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {zipMembers} from '../helpers/jvet-reference.mjs';
import {fixtures,fixtureLock} from '../helpers/fixtures.mjs';
import {hashHostSource,hashKernelSource} from '../helpers/hash-opencl-source.mjs';
import {FF as ff,FP as fp} from '../../engine.mjs';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
process.chdir(root);
const args=process.argv.slice(2);let out,phase='all';
while(args.length){const flag=args.shift();if(flag==='--out')out=path.resolve(args.shift());else if(flag==='--phase')phase=args.shift();else throw Error('Unknown argument '+flag);}
out??=path.join(root,'.build','hash-audit',new Date().toISOString().replace(/[:.]/g,'-'));
assert.ok(out.startsWith(path.join(root,'.build')+path.sep),'Audit output must remain inside workspace .build');
await fs.mkdir(out,{recursive:true});
if(phase==='all'&&(await fs.readdir(out)).length)throw Error('A complete audit requires a new empty output directory; use explicit phases to resume your own run.');
const json=async(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2)+'\n');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const hash=(bytes,alg='sha256')=>createHash(alg).update(bytes).digest('hex');
const algorithms=['sha256','sha512','sha3-256'];
const kernelAlg=alg=>alg.replaceAll('-','_');
const nodeAlg=alg=>alg.replaceAll('_','-');
process.env.FFMPEG_PATH=ff;process.env.FFPROBE_PATH=fp;
export async function command(exe,args,{env=process.env,log,allowFailure=false,maxBytes=64*1024*1024,timeoutMs=180000}={}){
 const start=performance.now();return new Promise((resolve,reject)=>{
  const p=spawn(exe,args,{cwd:root,env,windowsHide:true});const stdout=[],stderr=[];let length=0,failure;const timer=setTimeout(()=>{failure=Error('Audit command timeout after '+timeoutMs+' ms');p.kill();},timeoutMs);
  for(const [stream,parts]of [[p.stdout,stdout],[p.stderr,stderr]])stream.on('data',b=>{parts.push(b);if(exe.endsWith('HashAuditGpu.exe'))process.stderr.write(b);length+=b.length;if(length>maxBytes){failure=Error('Command output limit');p.kill();}});
  p.on('error',e=>failure=e);p.on('close',async code=>{
   clearTimeout(timer);const result={exe,args,exitCode:code,seconds:(performance.now()-start)/1000,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()};
   if(log)await json(log,result);if(failure)return reject(failure);if(code&&!allowFailure)return reject(Error(result.stderr||result.stdout||'Command failed '+exe));resolve(result);
  });
 });
}
const versions=async()=>({node:process.version,openssl:process.versions.openssl,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),ffmpeg:(await command(ff,['-version'])).stdout.split('\n')[0],ffprobe:(await command(fp,['-version'])).stdout.split('\n')[0],gpu:(await command('nvidia-smi',['--query-gpu=name,driver_version,memory.total,compute_cap','--format=csv,noheader'],{allowFailure:true})).stdout.trim()});
function casesFrom(bytes,name){
 const text=bytes.toString('utf8'),cases=[...text.matchAll(/Len = (\d+)\s+Msg = ([a-f\d]+)\s+MD = ([a-f\d]+)/gi)].map(([,bits,msg,expected],index)=>{
  assert.equal(Number(bits)%8,0);const b=Number(bits)?Buffer.from(msg,'hex'):Buffer.alloc(0);assert.equal(b.length,Number(bits)/8);return {id:name+':'+index,bits:Number(bits),bytes:b,expected:expected.toLowerCase()};
 });assert.ok(cases.length>0,name+' has actual response vectors');return cases;
}
async function officialInputs(){
 const sha2=await fixtures.read('repeat/nist-shabytetestvectors.zip'),sha2Lock=fixtureLock.files.find(f=>f.path==='repeat/nist-shabytetestvectors.zip');
 const sha3File=path.join(root,'.build/hash-audit-inputs/sha-3bytetestvectors.zip');let sha3;
 try{sha3=await fs.readFile(sha3File);}catch(error){if(error.code!=='ENOENT')throw error;const r=await fetch('https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/sha3/sha-3bytetestvectors.zip',{signal:AbortSignal.timeout(30000)});assert.ok(r.ok,'NIST SHA3 download HTTP '+r.status);sha3=Buffer.from(await r.arrayBuffer());assert.equal(sha3.length,2801880);assert.equal(hash(sha3),'cd07701af2e47f5cc889d642528b4bf11f8b6eb55797c7307a96828ed8d8fc8c');await fs.mkdir(path.dirname(sha3File),{recursive:true});await fs.writeFile(sha3File,sha3,{flag:'wx'});}
 assert.equal(sha3.length,2801880);assert.equal(hash(sha3),'cd07701af2e47f5cc889d642528b4bf11f8b6eb55797c7307a96828ed8d8fc8c');
 const members2=zipMembers(sha2),members3=zipMembers(sha3),all={};
 for(const [alg,prefix,members]of [['sha256','SHA256',members2],['sha512','SHA512',members2],['sha3-256','SHA3_256',members3]]){
  all[alg]=[];for(const kind of ['ShortMsg','LongMsg']){const key=[...members.keys()].find(k=>k.endsWith(prefix+kind+'.rsp'));assert.ok(key);all[alg].push(...casesFrom(members.get(key),key));}
 }
 return {all,members2,inputs:[sha2Lock,{url:'https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/sha3/sha-3bytetestvectors.zip',bytes:sha3.length,sha256:hash(sha3)}]};
}
async function job(name,algorithm,messages,{benchmark=false,repetitions=1,warmups=0,category='project-control'}={}){
 const dir=path.join(out,'inputs',name);await fs.mkdir(dir,{recursive:true});
 const offsets=Buffer.alloc(messages.length*8),lengths=Buffer.alloc(messages.length*8);let offset=0;
 messages.forEach((b,i)=>{offsets.writeBigUInt64LE(BigInt(offset),i*8);lengths.writeBigUInt64LE(BigInt(b.length),i*8);offset+=b.length;});
 const data=Buffer.concat(messages);for(const [file,bytes]of [['data.bin',data],['offsets.bin',offsets],['lengths.bin',lengths]])await fs.writeFile(path.join(dir,file),bytes);
 return {name,algorithm:kernelAlg(algorithm),category,count:messages.length,dataFile:path.join(dir,'data.bin'),offsetsFile:path.join(dir,'offsets.bin'),lengthsFile:path.join(dir,'lengths.bin'),bytes:data.length,inputSha256:hash(data),expected:messages.map(b=>hash(b,algorithm)),benchmark,repetitions,warmups};
}
function pattern(n,seed=1){const b=Buffer.alloc(n);let x=seed>>>0;for(let i=0;i<n;i++){x^=x<<13;x^=x>>>17;x^=x<<5;b[i]=x&255;}return b;}
function stats(values){const sorted=values.toSorted((a,b)=>a-b);return {n:values.length,min:sorted[0],median:sorted[Math.floor(sorted.length/2)],max:sorted.at(-1)};}
async function prepare(){
 const start=new Date().toISOString(),{all,members2,inputs}=await officialInputs(),records=[],jobs=[];
 for(const alg of algorithms){
  for(const c of all[alg]){assert.equal(hash(c.bytes,alg),c.expected,c.id);for(const chunk of [1,7,63,64,65,127,128,129,135,136,137]){const d=createHash(alg);for(let i=0;i<c.bytes.length;i+=chunk)d.update(c.bytes.subarray(i,i+chunk));assert.equal(d.digest('hex'),c.expected,c.id+' chunk '+chunk);}}
  records.push({algorithm:alg,kind:'NIST byte-oriented ShortMsg and LongMsg response files',cases:all[alg].map(({bytes,...c})=>c),streamingChunkSizes:[1,7,63,64,65,127,128,129,135,136,137],outcome:'passed'});
  const j=await job('nist-'+kernelAlg(alg),alg,all[alg].map(c=>c.bytes),{category:'official-response-vectors'});assert.deepEqual(j.expected,all[alg].map(c=>c.expected));jobs.push(j);
 }
 // SHA-2 Monte Carlo is recursive; record it separately from batched GPU tests.
 for(const [alg,prefix]of [['sha256','SHA256'],['sha512','SHA512']]){
  const text=members2.get([...members2.keys()].find(k=>k.endsWith(prefix+'Monte.rsp'))).toString();let seed=Buffer.from(/Seed = ([a-f\d]+)/i.exec(text)[1],'hex');const answers=[];
  for(const [,count,expected]of text.matchAll(/COUNT = (\d+)\s+MD = ([a-f\d]+)/gi)){let a=seed,b=seed,c=seed;for(let i=3;i<=1002;i++){const d=createHash(alg).update(a).update(b).update(c).digest();[a,b,c]=[b,c,d];}assert.equal(c.toString('hex'),expected);seed=c;answers.push({count:Number(count),expected,actual:c.toString('hex')});}
  assert.equal(answers.length,100);records.push({algorithm:alg,kind:'NIST CPU Monte Carlo',outerChecks:answers,hashEvaluations:100000,outcome:'passed',gpuRun:false});
 }
 const controls=[0,1,2,3,7,8,15,16,31,32,55,56,63,64,65,111,112,127,128,129,135,136,137,255,256,257,32767,32768,32769,65535,65536,65537,262143,262144,262145].map(n=>pattern(n,n+1));
 for(const alg of algorithms)jobs.push(await job('boundaries-'+kernelAlg(alg),alg,controls,{category:'project-padding-launch-boundary-controls'}));
 const benchShapes=[{name:'64KiB-x1024',bytes:65536,count:1024,meaning:'Many independent messages; not a video frame claim'},{name:'1080p420-8-x1',bytes:1920*1080*3/2,count:1},{name:'1080p420-8-x32',bytes:1920*1080*3/2,count:32},{name:'4K420-10-x1',bytes:3840*2160*3,count:1}];
 for(const shape of benchShapes){const one=pattern(shape.bytes,17),messages=Array(shape.count).fill(one);for(const alg of algorithms)jobs.push(await job('bench-'+shape.name+'-'+kernelAlg(alg),alg,messages,{benchmark:true,repetitions:5,warmups:2,category:'project-hash-microbenchmark'}));}
 await json('jobs.json',jobs);await json('cpu-correctness.json',{outcome:'passed',startedAtUtc:start,finishedAtUtc:new Date().toISOString(),inputs,records,scope:'Byte-aligned messages only. NIST vector replay is informal verification, not CAVP certification. GPU Monte Carlo and bit-oriented messages are not covered.'});
 await json('environment.json',{capturedAtUtc:new Date().toISOString(),...await versions()});
 console.log('Prepared '+jobs.length+' GPU jobs; CPU NIST response/streaming/Monte Carlo checks passed.');
}
async function gpu(){
 const generated=path.join(out,'generated');await fs.mkdir(generated,{recursive:true});const cs=path.join(generated,'HashAuditGpu.cs'),cl=path.join(generated,'hash-audit.cl'),exe=path.join(generated,'HashAuditGpu.exe');
 await fs.writeFile(cs,hashHostSource);await fs.writeFile(cl,hashKernelSource);
 await command('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/optimize+','/platform:x64','/r:System.Web.Extensions.dll','/out:'+exe,cs],{log:'gpu-compile.json'});
 const jobs=await read('jobs.json');const execution=await command(exe,[cl,path.join(out,'jobs.json'),path.join(out,'gpu-raw.json')],{log:'gpu-process.json',allowFailure:true,timeoutMs:900000});
 const report=await read('gpu-raw.json');assert.equal(execution.exitCode,0,JSON.stringify(report));assert.ok(report.devices.length>0);let comparisons=0;
 for(const device of report.devices){assert.equal(device.outcome,'executed',device.error);assert.ok(device.deviceType&4);assert.equal(device.runs.length,jobs.length);
  for(const run of device.runs){const j=jobs.find(j=>j.name===run.name);assert.ok(j);assert.ok(run.measurements.length>0);
   for(const m of run.measurements){assert.deepEqual(m.hashes,j.expected,device.name+'/'+j.name+'/'+m.mode+'/'+m.rep);assert.ok(m.kernelSeconds>0);comparisons+=m.hashes.length;}
   run.outcome='passed';run.timings=Object.fromEntries([...new Set(run.measurements.map(m=>m.mode))].map(mode=>{const a=run.measurements.filter(m=>m.mode===mode);return [mode,{wallSeconds:stats(a.map(m=>m.wallSeconds)),kernelSeconds:stats(a.map(m=>m.kernelSeconds)),uploadSeconds:stats(a.map(m=>m.uploadSeconds)),readSeconds:stats(a.map(m=>m.readSeconds))}];}));
  }device.outcome='passed';
 }
 report.outcome='passed';report.digestComparisons=comparisons;report.scope='Actual OpenCL GPU execution, no CPU fallback; project integer kernels checked against NIST byte-oriented response vectors. Performance describes these kernels, not an optimized GPU upper bound.';await json('gpu-validated.json',report);console.log('GPU checks passed: '+comparisons+' digest comparisons on '+report.devices.map(d=>d.name).join(', '));
}
async function cpuPerformance(masked=false){
 const jobs=(await read('jobs.json')).filter(j=>j.benchmark),results=[];
 const md5Messages=['','a','abc','message digest','abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789','1234567890'.repeat(8)];
 const md5Expected=['d41d8cd98f00b204e9800998ecf8427e','0cc175b9c0f1b6a831c399e269772661','900150983cd24fb0d6963f7d28e17f72','f96b697d7cb7938d525a2f31aaf161d0','c3fcd3d76192e4007dfb496cca67e13b','d174ab98d277d9f5a5611c2c9f419d9f','57edf4a22be3c955ac49da2e2107b67a'];
 assert.deepEqual(md5Messages.map(s=>hash(Buffer.from(s),'md5')),md5Expected);
 const expanded=[...jobs,...jobs.filter(j=>j.algorithm==='sha256').map(j=>({...j,name:j.name.replace('sha256','md5'),algorithm:'md5',expected:null}))];
 for(const j of expanded){const data=await fs.readFile(j.dataFile),offsets=await fs.readFile(j.offsetsFile),lengths=await fs.readFile(j.lengthsFile),alg=nodeAlg(j.algorithm),times=[];
  const expected=j.expected??Array.from({length:j.count},(_,i)=>{const start=Number(offsets.readBigUInt64LE(i*8)),n=Number(lengths.readBigUInt64LE(i*8));return hash(data.subarray(start,start+n),alg);});
  for(let rep=-2;rep<5;rep++){const begin=performance.now(),actual=[];for(let i=0;i<j.count;i++){const start=Number(offsets.readBigUInt64LE(i*8)),n=Number(lengths.readBigUInt64LE(i*8));actual.push(createHash(alg).update(data.subarray(start,start+n)).digest());}const seconds=(performance.now()-begin)/1000;assert.deepEqual(actual.map(b=>b.toString('hex')),expected);if(rep>=0)times.push(seconds);}
  results.push({name:j.name,algorithm:alg,bytes:j.bytes,count:j.count,seconds:times,wallSeconds:stats(times),scope:'Node/OpenSSL CPU; in-memory complete per-message binary digests, excluding hex encoding, verification, input generation and disk I/O'});
 }await json(masked?'cpu-performance-masked.json':'cpu-performance.json',{outcome:'passed',profile:masked?'Fresh process; OPENSSL_ia32cap=0:0':'Default OpenSSL CPU dispatch',dispatchAssemblyTraced:false,md5:{kind:'RFC 1321 Appendix A.5 legacy compatibility vectors; not an approved-security claim',source:'https://www.rfc-editor.org/rfc/rfc1321.html#appendix-A.5',messages:md5Messages,expected:md5Expected},results});console.log('CPU performance checks passed.');
}
async function masked(){
 assert.equal(process.env.OPENSSL_ia32cap,'0:0');const {all}=await officialInputs();let checks=0;
 for(const alg of algorithms)for(const c of all[alg]){assert.equal(hash(c.bytes,alg),c.expected);checks++;}
 await json('cpu-masked-correctness.json',{outcome:'passed',profile:'Fresh process; OPENSSL_ia32cap=0:0',checks,scope:'Official byte-oriented response vectors; capability override, not an assertion of which assembly instructions executed'});await cpuPerformance(true);
}
async function cpuDispatch(){await command(process.execPath,[fileURLToPath(import.meta.url),'--out',out,'--phase','masked'],{env:{...process.env,OPENSSL_ia32cap:'0:0'},log:'cpu-masked-process.json'});}
async function cpuThreads(){
 const allJobs=await read('jobs.json'),results=[],poolSetup=[];
 for(const count of [4,8]){
  const start=performance.now(),workers=[];
  const ask=(worker,message)=>new Promise((resolve,reject)=>{const receive=value=>{worker.off('error',fail);value.error?reject(Error(value.error)):resolve(value);},fail=e=>{worker.off('message',receive);reject(e);};worker.once('message',receive);worker.once('error',fail);if(message)worker.postMessage(message);});
  try{
   for(let i=0;i<count;i++){const w=new Worker(new URL('../helpers/hash-audit-worker.mjs',import.meta.url));workers.push(w);const ready=await ask(w);assert.equal(ready.ready,true);}
   poolSetup.push({workers:count,seconds:(performance.now()-start)/1000});
   for(const j of allJobs.filter(j=>j.benchmark||j.category==='official-response-vectors')){
    const bytes=await fs.readFile(j.dataFile),off=await fs.readFile(j.offsetsFile),len=await fs.readFile(j.lengthsFile),data=new SharedArrayBuffer(Math.max(1,bytes.length));Buffer.from(data).set(bytes);
    const offsets=Array.from({length:j.count},(_,i)=>Number(off.readBigUInt64LE(i*8))),lengths=Array.from({length:j.count},(_,i)=>Number(len.readBigUInt64LE(i*8)));
    await Promise.all(workers.map((w,lane)=>ask(w,{kind:'configure',data,offsets,lengths,lane,workers:count,algorithm:nodeAlg(j.algorithm)})));
    const times=[];for(let rep=j.benchmark?-2:0;rep<(j.benchmark?5:1);rep++){
     const began=performance.now(),messages=await Promise.all(workers.map(w=>ask(w,{kind:'hash'}))),seconds=(performance.now()-began)/1000,actual=Array(j.count);
     for(const m of messages)for(const [index,bytes]of m.results)actual[index]=Buffer.from(bytes).toString('hex');assert.deepEqual(actual,j.expected);if(rep>=0)times.push(seconds);
    }
    results.push({name:j.name,workers:count,category:j.category,count:j.count,bytes:j.bytes,seconds:times,wallSeconds:stats(times),outcome:'passed'});
   }
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
 }
 await json('cpu-parallel.json',{outcome:'passed',poolSetup,results,scope:'4/8 CPU worker threads; independent complete messages; shared system-memory input. Steady-state wall includes dispatch, hashing and return of binary digests, excluding pool creation, input sharing/configuration and hex verification. No affinity or power control.'});console.log('CPU 4/8-thread official vectors and batch performance passed.');
}
async function ffmpegVectors(){
 const {all}=await officialInputs(),records=[],dir=path.join(out,'ffmpeg-vectors');await fs.mkdir(dir,{recursive:true});
 for(const alg of ['sha256','sha512']){
  const boundaries=new Set([1,55,56,63,64,65,111,112,127,128,129]),selected=all[alg].filter(c=>boundaries.has(c.bytes.length)||c.id===all[alg].at(-1).id);
  for(const c of selected){const file=path.join(dir,alg+'-'+c.bits+'.raw');await fs.writeFile(file,c.bytes);
   for(const dispatch of ['default','cpuflags-0']){
    const args=['-v','error',...(dispatch==='cpuflags-0'?['-cpuflags','0']:[]),'-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray','-video_size',`${c.bytes.length}x1`,'-framerate','1','-i',file,'-c:v','rawvideo','-threads:v','1','-pix_fmt','+gray','-f','framehash','-hash',alg,'-'];
    const r=await command(ff,args),actual=r.stdout.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());assert.deepEqual(actual,[c.expected]);records.push({algorithm:alg,vector:c.id,bits:c.bits,dispatch,expected:c.expected,actual:actual[0],command:r});
   }
  }
 }
 assert.ok(records.length>0);await json('ffmpeg-vectors.json',{outcome:'passed',records,scope:'Selected official byte-oriented SHA-2 vectors, through native gray rawvideo framehash; zero-length messages are not video frames. SHA3-256 is verified on Node/GPU, not claimed as this FFmpeg framehash capability.'});console.log('FFmpeg default / cpuflags-0 selected official SHA-2 vectors passed.');
}
async function regressions(){
 const generated=path.join(root,'.build/testing-work');await fs.mkdir(generated,{recursive:true});const before=new Set(await fs.readdir(generated)),started=new Date().toISOString();
 const sourceFile=await fs.readFile('repeat.mjs'),sourceSha256=hash(sourceFile),r=await command(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','testing-tools/repeat-samples.test.mjs','testing-tools/repeat-qualification.test.mjs','testing-tools/repeat.test.mjs'],{log:'repeat-regression-process.json',allowFailure:true,timeoutMs:900000});
 assert.equal(hash(await fs.readFile('repeat.mjs')),sourceSha256,'product source changed during regression');
 const staging=path.join(out,'regression-measurements'),saved=[];await fs.mkdir(staging,{recursive:true});
 async function capture(directory,relative){for(const e of await fs.readdir(directory,{withFileTypes:true})){const source=path.join(directory,e.name),name=path.join(relative,e.name);if(e.isDirectory())await capture(source,name);else if(e.isFile()&&e.name.endsWith('.json')){const bytes=await fs.readFile(source),target=path.join(staging,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);saved.push({path:name.replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});}}}
 for(const name of (await fs.readdir(generated)).filter(n=>!before.has(n)&&/^repeat-analysis-/.test(n)))await capture(path.join(generated,name),name);
 const {saveMeasurements,criticalMeasurements}=await import('../../scripts/test-evidence.mjs'),captureDirectory=path.join(out,'regression-evidence');await fs.mkdir(captureDirectory,{recursive:true});
 const extraction=await saveMeasurements(staging,captureDirectory,{requiredMeasurements:criticalMeasurements.filter(m=>r.stdout.includes(m.testName))});
 assert.ok(saved.some(f=>f.path.endsWith('/metadata-preservation.json')));assert.ok(saved.some(f=>f.path.endsWith('/layout-change-rejection.json')));
 await json('repeat-regression.json',{outcome:r.exitCode===0?'passed':'failed',startedAtUtc:started,finishedAtUtc:new Date().toISOString(),exitCode:r.exitCode,sourceSha256,captured:saved,extraction,scope:'Selected repeat-analysis regression files only; not full product or release acceptance'});assert.equal(r.exitCode,0,r.stdout+'\n'+r.stderr);console.log('Selected repeat regressions passed; '+saved.length+' complete JSON measurements captured.');
}
async function media(){const {auditHashMedia}=await import('../helpers/hash-audit-media.mjs');await auditHashMedia({out,ff,fp,command,json,job,hash});}
async function integration(){
 const r=await command(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=repeat-analysis','testing-tools/server.test.mjs'],{log:'api-integration-process.json',allowFailure:true,timeoutMs:180000});
 const count=Number(/^# tests (\d+)/m.exec(r.stdout)?.[1]??0),failed=Number(/^# fail (\d+)/m.exec(r.stdout)?.[1]??-1);await json('api-integration.json',{outcome:r.exitCode===0&&count>0&&failed===0?'passed':'failed',exitCode:r.exitCode,tests:count,scope:'Repeat target API, report import/export and protected preview integration only'});assert.equal(r.exitCode,0,r.stdout+'\n'+r.stderr);assert.ok(count>0);assert.equal(failed,0);console.log('Repeat API integration passed: '+count+' tests.');
}
async function report(){
 const names=['cpu-correctness.json','ffmpeg-vectors.json','gpu-validated.json','cpu-performance.json','cpu-masked-correctness.json','cpu-performance-masked.json','cpu-parallel.json','media.json','repeat-regression.json','api-integration.json'],parts={};for(const name of names)parts[name]=await read(name);
 const files=[];for(const name of ['testing-tools/tools/hash-audit.mjs','testing-tools/helpers/hash-opencl-source.mjs','testing-tools/helpers/hash-audit-media.mjs','testing-tools/helpers/hash-audit-worker.mjs','testing-tools/repeat.test.mjs','testing-tools/repeat-samples.test.mjs','testing-tools/repeat-qualification.test.mjs','testing-tools/helpers/repeat-oracle.mjs','testing-tools/helpers/repeat-layouts.mjs','testing-tools/helpers/repeat-official.mjs','testing-tools/helpers/repeat-upstream.mjs','testing-tools/helpers/repeat-tooling.mjs','testing-tools/fixtures.lock.json','testing-tools/coverage.json','scripts/test-evidence.mjs','engine.mjs','repeat.mjs','repeat-samples.mjs','public/repeat-model.js','public/repeat-difference.js','public/repeat-csv.js','docs/repeat-analysis.md']){const b=await fs.readFile(name);files.push({path:name,bytes:b.length,sha256:hash(b)});}
 assert.equal(await fs.readFile(path.join(out,'generated/HashAuditGpu.cs'),'utf8'),hashHostSource);assert.equal(await fs.readFile(path.join(out,'generated/hash-audit.cl'),'utf8'),hashKernelSource);
 assert.equal(parts['repeat-regression.json'].sourceSha256,hash(await fs.readFile('repeat.mjs')));
 const tools=[];for(const [name,exe]of [['node',process.execPath],['ffmpeg',ff],['ffprobe',fp],['gpu-audit-helper',path.join(out,'generated/HashAuditGpu.exe')],['csc','C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe']]){const b=await fs.readFile(exe);tools.push({name,path:exe,bytes:b.length,sha256:hash(b)});}
 const summary={schema:1,outcome:Object.values(parts).every(p=>p.outcome==='passed')?'passed':'failed',finishedAtUtc:new Date().toISOString(),scope:'Hash correctness / controlled media scenarios / actual GPU research audit. Not CAVP validation, codec conformance certification, full product regression or release acceptance.',source:files,tools,results:Object.fromEntries(Object.entries(parts).map(([name,p])=>[name,{outcome:p.outcome}])),limitations:['Byte-oriented NIST messages only; no GPU Monte Carlo or formal CAVP validation.','Custom OpenCL kernels are test implementations, not an optimized product GPU backend.','Timing excludes compile/context/allocation and disk I/O; resident and upload-inclusive measurements are separate.','One host and its enumerated GPUs; no universal CPU/GPU performance conclusion.']};
 const observation=await read('metadata-normalization-observation.json');summary.findings=[{name:'FFmpeg metadata-driven graph reinitialization can normalize samples before hashing',observed:observation.normalizationObserved,before:observation.controls[0].firstLuma,after:observation.controls[1].firstLuma,correction:'Disable graph reinitialization after strict layout scan, including freeze and native preview paths',regressions:'Range / matrix / transfer metadata changes; freeze state, preview frame index and actual layout-change rejection'}];
 await json('summary.json',summary);
 const cpu=parts['cpu-performance.json'].results,masked=parts['cpu-performance-masked.json'].results,gpu=parts['gpu-validated.json'],media=parts['media.json'];
 const correctness=parts['cpu-correctness.json'].records.filter(r=>r.cases).map(r=>`| ${r.algorithm} | ${r.cases.length} | 每项逐字匹配 | ${gpu.devices.map(d=>d.name).join('；')} |`).join('\n');
 const timingRows=[];for(const d of gpu.devices)for(const run of d.runs.filter(r=>r.name.startsWith('bench-'))){const a=cpu.find(c=>c.name===run.name),m=masked.find(c=>c.name===run.name),resident=run.timings.resident,upload=run.timings['upload-inclusive'];timingRows.push(`| ${d.name} | ${run.name.replace('bench-','')} | ${(a.wallSeconds.median*1000).toFixed(3)} | ${(m.wallSeconds.median*1000).toFixed(3)} | ${(resident.wallSeconds.median*1000).toFixed(3)} | ${(upload.wallSeconds.median*1000).toFixed(3)} | ${(resident.kernelSeconds.median*1000).toFixed(3)} |`);}
 const processLog=JSON.parse(await fs.readFile(path.join(out,'repeat-regression-process.json'))),counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,Number(new RegExp('^# '+k+' (\\d+)','m').exec(processLog.stdout)?.[1]??NaN)]));
 const markdown=`# 原生帧哈希与 CPU/GPU 对照审计\n\n完成时间：${summary.finishedAtUtc}。结论范围：本机、已记录工具和这些输入。${summary.outcome==='passed'?'所有要求执行的本轮检查通过。':'存在失败，不能称全部通过。'}\n\n本审计不是 CAVP 认证、完整编解码器符合性认证、完整产品回归或发布验收。\n\n## 判据和来源\n\n- SHA-256/SHA-512 按 FIPS 180-4；SHA3-256 按 FIPS 202。使用 NIST 原始字节型 ShortMsg/LongMsg 参考答案，不用另一实现的输出替换答案。\n- NIST 明确说明：公开向量重放只能非正式核验实现，不能替代 CAVP 验证。来源：https://csrc.nist.gov/Projects/Cryptographic-Algorithm-Validation-Program/Secure-Hashing 。归档输入来源、长度、摘要见 cpu-correctness.json。\n- CPU 另执行 SHA-256/SHA-512 各 100 轮、每轮 1000 次递归的原始 Monte Carlo。GPU 未执行该递归测试，不把 CPU 结果算作 GPU 通过。\n- MD5 仅做 RFC 1321 附录 A.5 七项兼容向量和 CPU 性能基线，不将其描述为现代抗碰撞方案；GPU 未实现 MD5。\n- 样本相等要求全部有效样本逐值相同；所有哈希要求全部摘要位相同，不使用数值容差。布局变换只允许经独立原字节往返验证的重排和有效位对齐。\n\n## 官方向量的实际范围\n\n| 算法 | 不同官方消息数（不按重跑次数膨胀） | CPU | 实际 GPU |\n|---|---:|---|---|\n${correctness}\n\nGPU 还执行 SHA 填充、SHA3 速率边界、256-block 调度边界控制；这些是项目控制样本，不冒称官方向量。每个被测 GPU 均要求设备类型 GPU，禁止 CPU 回退，保留驱动和 OpenCL 版本及非零设备事件时间。\n\n## 媒体情景\n\n${media.cases.map(c=>'- '+c.name+'：'+c.outcome).join('\n')}\n\n实际 CUDA/NVDEC 解码：\n\n${media.gpuDecode.map(c=>'- '+c.name+'：'+c.outcome+'。NV12/P010 只做可逆布局适配，再与软件解码和原始已知样本逐字节比较。').join('\n')}\n\n实际媒体解码输出还交给两块 GPU 的三种哈希核验；相关结果见 media-gpu-raw.json 和 media.json。硬件解码使用 CUDA 帧输出和必需的 hwdownload，不能用软件回退代替。仅证明所列控制码流，不代表全部合法码流都已符合规范。\n\n## 性能观察\n\n每形状/算法预热 2 次，每种 GPU 模式测 5 次；CPU 同样预热 2 次、测 5 次。下面为单批中位数，单位 ms；完整最小/中位/最大和逐次值保存在 JSON。\n\nCPU 与 GPU 均在摘要二进制结果可供主机使用时结束墙钟计时，不含十六进制转换及验证。CPU 输入已在系统内存；GPU resident 输入已在显存，upload-inclusive 则包括本批主机输入上传、内核和摘要下载。编译、上下文、分配、输入生成、磁盘 I/O 均单列或排除；不能把 kernel-only 与 CPU 完整调用直接等同。\n\n| GPU | 输入形状/算法 | CPU 默认 ms | CPU 能力屏蔽 ms | GPU resident 墙钟 ms | GPU 含上传墙钟 ms | GPU 内核事件 ms |\n|---|---|---:|---:|---:|---:|---:|\n${timingRows.join('\n')}\n\n这是测试用 OpenCL 整数实现，一条工作项处理一条消息，按标准状态串接多个有界内核；不是最优 CUDA/OpenCL 实现或 GPU 性能上界。CPU 能力屏蔽在新进程使用 OpenSSL 官方 OPENSSL_ia32cap=0:0，且重新核验全部响应向量；没有逐条追踪实际汇编分派。固定执行顺序、未控制整机背景负载、功耗或温度，不给出跨硬件性能承诺或统计置信区间。未在实际完整媒体分析流水线上替换生产哈希后计时。\n\n## 既有受影响回归\n\n${JSON.stringify(counts)}。仅三个重复分析相关文件；不把部分范围称完整回归。完整命令及 TAP 输出见 repeat-regression-process.json。\n\n## 保留的限制和初次运行\n\n${summary.limitations.map(x=>'- '+x).join('\n')}\n- 首轮助手只在整轮末尾保存结果，在集成 GPU 的后段性能任务被主动终止；没有采用其未保存结果。日志与当时生成源码保留在 initialization-attempt-1/。之后增加逐任务检查点并完整重跑。\n- 未覆盖所有容器、所有编码配置、动态 HDR/AV1 颗粒合成、物理显示观察、其他型号 GPU、GPU Monte Carlo、比特型 NIST 向量、BLAKE3/xxHash 实测或能耗。\n\n实际源文件和工具摘要见 summary.json；机器信息见 environment.json。所有生成材料均位于项目 .build，可重建；没有改动生产检测算法。\n`;
 const parallel=parts['cpu-parallel.json'];const parallelRows=cpu.filter(c=>c.algorithm!=='md5').map(c=>{const rows=parallel.results.filter(r=>r.name===c.name);return `| ${c.name.replace('bench-','')} | ${(c.wallSeconds.median*1000).toFixed(3)} | ${rows.map(r=>(r.wallSeconds.median*1000).toFixed(3)).join(' | ')} |`;}).join('\n');
 const findings=`\n## 本轮发现并修复的媒体链路缺陷\n\n算法向量通过不代表媒体链路取到了正确的原始数据。在本机 FFmpeg 8.1.3 路径中，帧间颜色范围改变触发图重初始化；仅有 noauto_conversion_filters 仍会将后段样本归一化。相同源样本的实测首个 Y 从 ${JSON.stringify(observation.controls[0].firstLuma)} 变为显式关闭重初始化后的 ${JSON.stringify(observation.controls[1].firstLuma)}。\n\n已修正原生指纹、持续低变化和原帧复核路径；实际尺寸/像素格式变化仍在扫描阶段拒绝。新增回归核对三个元数据变化控制、持续候选历史、select 帧序及两个真实布局变化拒绝。相关完整测量已经由现有 saveMeasurements 规则提取到 regression-evidence/measurements.json.gz；清单见 repeat-regression.json。\n\n同一控制文件中，原生样本及哈希相同，但按各自 range 标签转换的 RGB 首像素实测为 ${JSON.stringify(media.cases.at(-1).rgbFirstPixels)}。这是数字转换结果，不是物理观察试验。涉及该类标签变化的旧报告应重新分析，不能补造旧摘要正确性。\n\n修复前失败的定向回归、修复后通过的定向回归及两次媒体诊断保留在本次目录。早期媒体编码设置先被严格格式协商拒绝，随后改为显式声明标签，才发现真正的样本归一化；没有通过放宽样本相等条件消除失败。\n`;
 let text=markdown+`\n## CPU 独立消息并行对照\n\n4/8 个 CPU 工作线程也先核验全部 NIST 响应向量。池初始化、共享输入配置单独记录；稳态墙钟包含任务派发、完整消息哈希和返回二进制摘要。没有把一条标准消息切成多个独立摘要。\n\n| 形状/算法 | CPU 单线程 ms | CPU 4 线程 ms | CPU 8 线程 ms |\n|---|---:|---:|---:|\n${parallelRows}\n\n完整结果和池初始化耗时见 cpu-parallel.json。CPU 单线程与并行调用包含的调度成本不同；单帧场景不会因启动更多工作线程而自动可并行。\n`+findings;
 text=text.replace(findings,'').replace('## 判据和来源',findings+'\n## 判据和来源');
 text+=`\n## API 集成检查\n\n重复目标、报告往返和受保护复核的 API 定向检查 ${parts['api-integration.json'].tests} 项通过；实际 TAP 与命令见 api-integration-process.json。它是部分范围，不替代完整产品回归。\n`;
 if(await fs.stat(path.join(out,'api-attempt-1')).catch(()=>null))text+='\n初次 API 运行在沙箱内被本机回环连接权限阻止（EACCES），尚未进入产品断言；错误和日志保存在 api-attempt-1/。获得本机服务访问能力后重跑同一检查通过，没有修改断言或产品访问校验。\n';
 if(!(await fs.stat(path.join(out,'initialization-attempt-1')).catch(()=>null)))text=text.replace(/- 首轮助手[^\n]+\n/,'');
 if(!(await fs.stat(path.join(out,'metadata-regression-before.json')).catch(()=>null)))text=text.replace('## 本轮发现并修复的媒体链路缺陷','## 媒体链路样本保留回归').replace(/修复前失败的定向回归[^\n]+\n/,'');
 text=text.replace('来源：https://csrc.nist.gov/Projects/Cryptographic-Algorithm-Validation-Program/Secure-Hashing 。','来源：[NIST 官方说明](https://csrc.nist.gov/Projects/Cryptographic-Algorithm-Validation-Program/Secure-Hashing)。');
 await fs.writeFile(path.join(out,'REPORT.md'),text);
 const snapshot=path.join(out,'source-snapshot');for(const entry of files){const target=path.join(snapshot,entry.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(entry.path,target);}
 const outputFiles=[],rootJson=(await fs.readdir(out)).filter(n=>n.endsWith('.json')&&n!=='result-manifest.json');for(const name of [...new Set([...rootJson,'REPORT.md','regression-evidence/measurements.json.gz',...files.map(e=>'source-snapshot/'+e.path)])]){const b=await fs.readFile(path.join(out,name));outputFiles.push({path:name,bytes:b.length,sha256:hash(b)});}await json('result-manifest.json',{schema:1,scope:'Integrity of explicitly listed audit artifacts, not authenticity or completeness certification; source snapshot is not a complete recovery package',files:outputFiles});
 console.log(JSON.stringify({outcome:summary.outcome,report:path.join(out,'REPORT.md'),counts,devices:gpu.devices.map(d=>d.name)},null,2));if(summary.outcome!=='passed')process.exitCode=1;
}
const phases={prepare,gpu,performance:()=>cpuPerformance(false),'cpu-dispatch':cpuDispatch,masked,'cpu-threads':cpuThreads,'ffmpeg-vectors':ffmpegVectors,media,regressions,integration,report};
try{if(phase==='all')for(const name of ['prepare','gpu','performance','cpu-dispatch','cpu-threads','ffmpeg-vectors','media','regressions','integration','report']){console.log('PHASE '+name);await phases[name]();}else{assert.ok(phases[phase],'Unknown phase');await phases[phase]();}}
catch(error){await json('failure-'+phase+'.json',{phase,outcome:'failed',error:error.stack,atUtc:new Date().toISOString()});throw error;}
