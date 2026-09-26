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
 await mkdir(path.dirname(source),{recursive:true});await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-chroma_sample_location','left',source]);
 server=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},windowsHide:true});server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
 for(let i=0;i<100;i++){if(output.includes('EADDRINUSE'))throw Error('Test port already occupied');if(output.includes('已启动'))break;await delay(100)}
 assert.match(output,/已启动/);const html=await(await fetch(base)).text();token=html.match(/name="token" content="([^"]+)"/)[1];
});
after(()=>{server?.kill()});
const request=(url,method='GET',data)=>fetch(base+'/api/'+url,{method,headers:{'x-mediascope-token':token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});
async function finished(id){for(let i=0;i<200;i++){const j=await(await request('jobs/'+id)).json();if(!['running','queued'].includes(j.status))return j;await delay(100)}throw Error('Timed out')}
test('API protects local data and streams a reproducible completed report',async()=>{
 assert.equal((await fetch(base+'/api/status')).status,403);
 assert.equal((await fetch(base+'/api/status',{headers:{'x-mediascope-token':token,origin:'https://external.invalid'}})).status,403);
 const job=await(await request('jobs','POST',{type:'analyze',file:source,stream:0})).json();const queued=await request('jobs','POST',{type:'inspect',file:source});assert.equal(queued.status,202);const next=await queued.json();await finished(next.id);
 const status=await finished(job.id);assert.equal(status.status,'done',status.message);
 assert.equal(status.progress.stage,'完成');assert.equal(status.progress.completed,1);assert.equal(status.progress.total,1);assert.ok(status.progress.phaseIndex>=1);assert.ok(status.progress.phaseCount>=status.progress.phaseIndex);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual(parseReport(JSON.stringify(report)),report);assert.equal((await fetch(base+'/report.js')).status,200);assert.equal(report.schema,'MediaScope/0.2');assert.equal(report.frames.length,12);assert.equal(report.frames[0].special,'IDR');assert.equal(report.tracks.length,1);assert.ok(report.commands.every(c=>c.cwd));
 const concurrent=report.timing.stages.filter(s=>s.concurrentGroup);assert.equal(concurrent.length,2);assert.equal(new Set(concurrent.map(s=>s.concurrentGroup)).size,1);assert.ok(report.timing.decodeThreads>=1&&report.timing.decodeThreads<=12);
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

test('mixed queue waits for start, preserves all reports and continues after failure or cancellation',async()=>{
 await request('queue','POST',{action:'pause'});
 const ids=[];
 for(const input of [
  {type:'analyze',file:source,stream:null},
  {type:'compare',reference:source,candidate:source,refStream:0,candidateStream:0,metrics:['psnr'],confirm:true},
  {type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr']},
  {type:'inspect',file:source},
  {type:'inspect',file:path.resolve('test-work/missing-queue-file.mp4')},
  {type:'inspect',file:source},
  {type:'inspect',file:source}
 ]){const response=await request('jobs','POST',{...input,enqueue:true});assert.equal(response.status,202);ids.push((await response.json()).id)}
 await delay(150);let state=await(await request('status')).json();assert.equal(state.queueRunning,false);assert.ok(ids.every(id=>state.jobs.find(j=>j.id===id).status==='queued'));
 await request('jobs/'+ids[3],'DELETE');
 await request('queue','POST',{action:'start'});
 const results=[];for(const id of ids)results.push(await finished(id));
 assert.deepEqual(results.map(j=>j.status),['done','done','done','cancelled','error','done','done'],JSON.stringify(results.map(j=>j.message)));
 const executed=results.filter(j=>j.startedAt);for(let i=1;i<executed.length;i++)assert.ok(executed[i].startedAt>=executed[i-1].finishedAt);
 for(const id of [ids[0],ids[1],ids[2],ids[6]])assert.equal((await request('jobs/'+id+'/report')).status,200);
});
test('pausing holds waiting jobs while cancellation releases the running slot',async()=>{
 await request('queue','POST',{action:'pause'});
 const first=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',crfs:[20,32],metrics:['psnr'],enqueue:true})).json();
 const second=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 await request('queue','POST',{action:'start'});await request('queue','POST',{action:'pause'});
 await request('jobs/'+first.id,'DELETE');assert.equal((await finished(first.id)).status,'cancelled');
 assert.equal((await(await request('jobs/'+second.id)).json()).status,'queued');
 await request('queue','POST',{action:'start'});assert.equal((await finished(second.id)).status,'done');
});
test('read-only file preview does not enter the queue',async()=>{
 const before=(await(await request('status')).json()).jobs.length;
 const response=await request('probe','POST',{file:source});assert.equal(response.status,200);
 const report=await response.json();assert.equal(report.type,'inspect');assert.equal(report.file,source);assert.equal(report.raw.streams[0].codec_type,'video');assert.ok(report.commands.length>=1);assert.deepEqual(parseReport(JSON.stringify(report)),report);
 assert.equal((await(await request('status')).json()).jobs.length,before);
});
test('cancelled and failed tasks can be requeued while paused and resume with later tasks',async()=>{
 await request('queue','POST',{action:'pause'});
 const cancelled=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 await request('jobs/'+cancelled.id,'DELETE');
 const invalid=await(await request('jobs','POST',{type:'inspect',file:path.resolve('test-work/not-here.mp4'),enqueue:true})).json();
 await request('queue','POST',{action:'start'});assert.equal((await finished(invalid.id)).status,'error');
 await request('queue','POST',{action:'pause'});
 const first=await(await request('jobs/'+cancelled.id+'/retry','POST',{})).json();
 const second=await(await request('jobs/'+invalid.id+'/retry','POST',{})).json();
 const later=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 for(const id of [first.id,second.id,later.id])assert.equal((await(await request('jobs/'+id)).json()).status,'queued');
 await request('queue','POST',{action:'start'});
 assert.equal((await finished(first.id)).status,'done');
 assert.equal((await finished(second.id)).status,'error');
 assert.equal((await finished(later.id)).status,'done');
 assert.equal((await request('jobs/'+first.id+'/retry','POST',{})).status,409);
});
