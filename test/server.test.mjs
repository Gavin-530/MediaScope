import {parseReport} from '../public/report.js';
import {test,before,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from './helpers/server.mjs';
import {mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {FF,run} from '../engine.mjs';
const source=path.resolve('test-work/http-fixture.mp4');let reportRoot,caseNumber=0;
let base;
let app,token;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
before(async()=>{
 await mkdir(path.dirname(source),{recursive:true});await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-chroma_sample_location','left',source]);
});
beforeEach(async()=>{reportRoot=path.resolve('test-work/server-reports',String(++caseNumber));app=await startServer(reportRoot);base=app.base;token=app.token});
afterEach(async()=>{await app?.stop()});
const request=(url,method='GET',data)=>fetch(base+'/api/'+url,{method,headers:{'x-mediascope-token':token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});
async function finished(id){for(let i=0;i<200;i++){const j=await(await request('jobs/'+id)).json();if(!['running','queued'].includes(j.status))return j;await delay(100)}throw Error('Timed out')}
async function removed(id){for(let i=0;i<200;i++){if((await request('jobs/'+id)).status===404)return;await delay(100)}throw Error('Cancellation did not remove the job')}
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
 const job=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',crfs:[20,32],metrics:['psnr']})).json();await request('jobs/'+job.id,'DELETE');await removed(job.id);await assert.rejects(lstat(path.join(reportRoot,job.id)),e=>e.code==='ENOENT');assert.ok(!(await(await request('status')).json()).jobs.some(j=>j.id===job.id));
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
  assert.equal(report.normalization.psnrPeak,1023);assert.equal(report.metrics.vmaf.configuration.input.pixelFormat,'yuv444p10le');assert.equal(report.metrics.vmaf.configuration.evaluation.crossDepth,true);
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
 await removed(ids[3]);
 const results=[];for(const id of ids.filter(id=>id!==ids[3]))results.push(await finished(id));
 assert.deepEqual(results.map(j=>j.status),['done','done','done','error','done','done'],JSON.stringify(results.map(j=>j.message)));
 const executed=results.filter(j=>j.startedAt);for(let i=1;i<executed.length;i++)assert.ok(executed[i].startedAt>=executed[i-1].finishedAt);
 for(const id of [ids[0],ids[1],ids[2],ids[6]])assert.equal((await request('jobs/'+id+'/report')).status,200);
});
test('pausing holds waiting jobs while cancellation releases the running slot',async()=>{
 await request('queue','POST',{action:'pause'});
 const first=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',crfs:[20,32],metrics:['psnr'],enqueue:true})).json();
 const second=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 await request('queue','POST',{action:'start'});await request('queue','POST',{action:'pause'});
 await request('jobs/'+first.id,'DELETE');await removed(first.id);
 assert.equal((await(await request('jobs/'+second.id)).json()).status,'queued');
 await request('queue','POST',{action:'start'});assert.equal((await finished(second.id)).status,'done');
});
test('queue removal and scoped clearing preserve active work and protect reports already exporting',async()=>{
 const completed=await(await request('jobs','POST',{type:'inspect',file:source})).json();assert.equal((await finished(completed.id)).status,'done');
 const {key}=await(await request('local-data/export-hold','POST',{ids:[completed.id]})).json();
 await request('jobs/'+completed.id,'DELETE');
 assert.ok(!(await(await request('status')).json()).jobs.some(j=>j.id===completed.id));
 assert.equal((await request('jobs/'+completed.id+'/report')).status,200);
 await request('local-data/export-release','POST',{key});await removed(completed.id);
 await assert.rejects(lstat(path.join(reportRoot,completed.id)),e=>e.code==='ENOENT');
 const batch=await(await request('plans/import','POST',{mode:'append',start:false,plans:Array.from({length:128},(_,i)=>({entryId:'removal-'+i,input:{type:'inspect',file:source}}))})).json();
 await request('queue','POST',{action:'start'});
 await request('jobs/clear','POST',{scope:'queued'});
 assert.deepEqual((await(await request('status')).json()).jobs.map(j=>j.id),[batch.ids[0]],'clearing must retire all waiting jobs before filesystem work can release the running slot');
 await finished(batch.ids[0]);await request('jobs/'+batch.ids[0],'DELETE');await removed(batch.ids[0]);
 const active=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',presets:['slow'],crfs:[18,22,26,30],metrics:['psnr']})).json();
 const waiting=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 await request('jobs/clear','POST',{scope:'queued'});
 assert.equal((await request('jobs/'+waiting.id)).status,404);
 assert.equal((await(await request('jobs/'+active.id)).json()).status,'running');
 await request('jobs/'+active.id,'DELETE');await removed(active.id);
 const done=await(await request('jobs','POST',{type:'inspect',file:source})).json();await finished(done.id);
 const failed=await(await request('jobs','POST',{type:'inspect',file:path.resolve('test-work/missing-remove.mp4')})).json();await finished(failed.id);
 await request('jobs/clear','POST',{scope:'results'});await removed(done.id);
 assert.equal((await(await request('jobs/'+failed.id)).json()).status,'error');
 await request('jobs/clear','POST',{scope:'history'});await removed(failed.id);
 await app.stop();app=await startServer(reportRoot);base=app.base;token=app.token;
 assert.deepEqual((await(await request('status')).json()).jobs,[]);
});

test('read-only file preview does not enter the queue',async()=>{
 const before=(await(await request('status')).json()).jobs.length;
 const response=await request('probe','POST',{file:source});assert.equal(response.status,200);
 const report=await response.json();assert.equal(report.type,'inspect');assert.equal(report.file,source);assert.equal(report.raw.streams[0].codec_type,'video');assert.ok(report.commands.length>=1);assert.deepEqual(parseReport(JSON.stringify(report)),report);
 assert.equal((await(await request('status')).json()).jobs.length,before);
});
test('cancelled tasks disappear while failed tasks can be requeued and resume with later tasks',async()=>{
 await request('queue','POST',{action:'pause'});
 const cancelled=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 await request('jobs/'+cancelled.id,'DELETE');
 const invalid=await(await request('jobs','POST',{type:'inspect',file:path.resolve('test-work/not-here.mp4'),enqueue:true})).json();
 await request('queue','POST',{action:'start'});assert.equal((await finished(invalid.id)).status,'error');
 await request('queue','POST',{action:'pause'});
 assert.equal((await request('jobs/'+cancelled.id+'/retry','POST',{})).status,404);
 const first=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 const second=await(await request('jobs/'+invalid.id+'/retry','POST',{})).json();
 const later=await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json();
 for(const id of [first.id,second.id,later.id])assert.equal((await(await request('jobs/'+id)).json()).status,'queued');
 await request('queue','POST',{action:'start'});
 assert.equal((await finished(first.id)).status,'done');
 assert.equal((await finished(second.id)).status,'error');
 assert.equal((await finished(later.id)).status,'done');
 const retryRes=await request('jobs/'+first.id+'/retry','POST',{});
 assert.equal(retryRes.status,202);
 const completedRetry=await retryRes.json();
 assert.notEqual(completedRetry.id,first.id);
 assert.equal((await(await request('jobs/'+completedRetry.id)).json()).status,'queued','retry respects the queue pause after it drains');
 await request('queue','POST',{action:'start'});
 assert.equal((await finished(completedRetry.id)).status,'done');
 assert.equal((await request('jobs/'+completedRetry.id+'/report')).status,200);
 assert.equal((await request('jobs/'+first.id+'/report')).status,200,'the original report remains available');
});

test('plan export is ordered and plan import validates every item before replacing or starting work',async()=>{
 await request('queue','POST',{action:'pause'});
 const first=(await(await request('jobs','POST',{type:'analyze',file:source,stream:null,complexity:false,enqueue:true})).json()).id;
 const second=(await(await request('jobs','POST',{type:'inspect',file:source,enqueue:true})).json()).id;
 const saved=await(await request('plans')).json();
 assert.equal(saved.schema,'MediaScope/0.3');
 assert.deepEqual(saved.results,[]);
 assert.deepEqual(saved.plans.map(p=>p.entryId),[first,second]);
 assert.deepEqual(saved.plans.map(p=>p.input.type),['analyze','inspect']);
 assert.equal(saved.plans[0].input.enqueue,undefined);
 const before=(await(await request('status')).json()).jobs.filter(j=>j.status==='queued').map(j=>j.id);
 const malformed=await request('plans/import','POST',{mode:'replace',start:true,plans:[saved.plans[0],{entryId:'bad',input:{type:'compare',reference:source,candidate:source,metrics:['psnr']}}]});
 assert.equal(malformed.status,400);
 assert.deepEqual((await(await request('status')).json()).jobs.filter(j=>j.status==='queued').map(j=>j.id),before);
 const appended=await request('plans/import','POST',{mode:'append',start:false,plans:[saved.plans[1]]});
 assert.equal(appended.status,200);
 assert.equal((await(await request('plans')).json()).plans.length,3);
 const replaced=await request('plans/import','POST',{mode:'replace',start:true,plans:[saved.plans[1]]});
 assert.equal(replaced.status,200);
 const id=(await replaced.json()).ids[0];assert.equal((await finished(id)).status,'done');
 const remaining=(await(await request('plans')).json()).plans;
 assert.equal(remaining.length,0);
});
