import {parseReport} from '../public/report.js';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,run} from '../engine.mjs';
const port=4439,base=`http://127.0.0.1:${port}`,source=path.resolve('test-work/http-fixture.mp4');
let server,token,output='';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
before(async()=>{
 await mkdir(path.dirname(source),{recursive:true});await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-c:v','libx264',source]);
 server=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},windowsHide:true});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 for(let i=0;i<100;i++){if(output.includes('EADDRINUSE'))throw Error('Test port already occupied');if(output.includes('已启动'))break;await delay(100)}
 assert.match(output,/已启动/);const html=await(await fetch(base)).text();token=html.match(/name="token" content="([^"]+)"/)[1];
});
after(()=>{server?.kill()});
const request=(url,method='GET',data)=>fetch(base+'/api/'+url,{method,headers:{'x-mediascope-token':token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});
async function finished(id){for(let i=0;i<200;i++){const j=await(await request('jobs/'+id)).json();if(j.status!=='running')return j;await delay(100)}throw Error('Timed out')}
test('API protects local data and streams a reproducible completed report',async()=>{
 assert.equal((await fetch(base+'/api/status')).status,403);
 assert.equal((await fetch(base+'/api/status',{headers:{'x-mediascope-token':token,origin:'https://external.invalid'}})).status,403);
 const job=await(await request('jobs','POST',{type:'analyze',file:source,stream:0})).json();const rejected=await request('jobs','POST',{type:'inspect',file:source});assert.equal(rejected.status,409);
 const status=await finished(job.id);assert.equal(status.status,'done',status.message);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual(parseReport(JSON.stringify(report)),report);assert.equal((await fetch(base+'/report.js')).status,200);assert.equal(report.schema,'MediaScope/0.2');assert.equal(report.frames.length,12);assert.equal(report.frames[0].special,'IDR');assert.equal(report.tracks.length,1);assert.ok(report.commands.every(c=>c.cwd));
});
test('SI/TI worker setting validates input and records requested versus actual workers',async()=>{
 const invalid=await request('jobs','POST',{type:'analyze',file:source,stream:0,complexity:true,sitiWorkers:3});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/并行上限/);
 const job=await(await request('jobs','POST',{type:'analyze',file:source,stream:0,complexity:true,sitiWorkers:8})).json(),status=await finished(job.id);assert.equal(status.status,'done',status.message);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual({setting:report.content.execution.setting,requested:report.content.execution.requestedWorkers,actual:report.content.execution.workers},{setting:'manual',requested:8,actual:1});
 const html=await(await fetch(base)).text();assert.match(html,/id="siti-workers"/);assert.match(html,/value="8">8 路/);
});
test('API cancellation ends the job and does not leave experiment video files',async()=>{
 const job=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',crfs:[20,32],metrics:['psnr']})).json();await request('jobs/'+job.id,'DELETE');const result=await finished(job.id);assert.equal(result.status,'cancelled');const files=await readdir(path.resolve('.mediascope',job.id));assert.ok(!files.some(f=>f.endsWith('.mkv')));assert.ok(files.includes('job-input.json'));
});

test('API requires cross-depth opt-in and exports normalization evidence',async()=>{
 const files=[];
 for(const depth of [8,10]){
  const file=path.resolve(`test-work/http-depth-${depth}.mkv`),factor=depth===8?1:4;
  await run(FF,['-v','error','-y','-f','lavfi','-i',`nullsrc=s=96x64:r=2:d=1,format=yuv444p${depth===8?'':'10le'},geq=lum=${64*factor}:cb=${128*factor}:cr=${128*factor},setfield=prog,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,'-c:v','ffv1','-level','3',file]);
  files.push(file);
 }
 const input={type:'compare',reference:files[1],candidate:files[0],refStream:0,candidateStream:0,metrics:['psnr','ssim','vmaf'],confirm:true};
 for(const comparisonMode of [undefined,'invalid','bt709-limited-8-10']){
  const job=await(await request('jobs','POST',{...input,comparisonMode})).json(),status=await finished(job.id);
  if(comparisonMode!=='bt709-limited-8-10'){
   assert.equal(status.status,'error');assert.match(status.message,comparisonMode===undefined?/pix_fmt/:/模式无效/);continue;
  }
  assert.equal(status.status,'done',status.message);
  const report=await(await request(`jobs/${job.id}/report`)).json();
  assert.deepEqual(parseReport(JSON.stringify(report)),report);assert.equal(report.metrics.psnr.pooled,'Infinity');assert.equal(report.metrics.ssim.pooled,1);
  assert.equal(report.normalization.mode,comparisonMode);assert.equal(report.normalization.verification.passed,true);
  assert.equal(report.normalization.psnrPeak,1023);assert.match(report.skippedMetrics.vmaf,/跨位深/);
  assert.ok(report.commands.some(c=>c.args.some(a=>a.includes('scale=w=iw:h=ih'))));
 }
 const html=await(await fetch(base)).text();assert.match(html,/id="comparison-mode"/);assert.match(html,/value="bt709-limited-8-10"/);
});
