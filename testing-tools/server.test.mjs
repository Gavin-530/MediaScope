import {readFixture} from './helpers/fixtures.mjs';
import {parseReport} from '../public/report.js';
import {reportFromPortable,parsePortable} from '../public/portable.js';
import {test,before,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,waitForJob} from './helpers/server.mjs';
import {mkdir,mkdtemp,lstat,readFile} from 'node:fs/promises';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {SITI_COMPAT_PROFILE} from '../public/siti.js';
import path from 'node:path';
import {FF,run} from '../engine.mjs';
const source=path.resolve('.build/testing-work/http-fixture.mp4'),sitiSource=path.resolve('.build/testing-work/http-sdr-lossless.mkv');let reportRoot,suiteRoot,caseNumber=0;
let base;
let app,token;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
before(async()=>{
 await mkdir('.build/testing-work/server-reports',{recursive:true});suiteRoot=await mkdtemp(path.resolve('.build/testing-work/server-reports/suite-'));
 await mkdir(path.dirname(source),{recursive:true});await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-chroma_sample_location','left',source]);
 await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=128x96:rate=12:duration=1,setfield=prog,setparams=range=limited:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v','ffv1','-level','3',sitiSource]);
});
beforeEach(async()=>{reportRoot=path.join(suiteRoot,String(++caseNumber));app=await startServer(reportRoot);base=app.base;token=app.token});
afterEach(async()=>{await app?.stop()});
const request=async(url,method='GET',data)=>{const response=await fetch(base+'/api/'+url,{method,headers:{'x-mediascope-token':token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});const json=response.json.bind(response);response.json=async()=>{const value=await json();return response.ok&&(url==='probe'||/^jobs\/[^/]+\/report$/.test(url))?reportFromPortable(value):value;};return response;};
// GPU initialization may take 30 seconds before CPU recovery; use the shared task deadline.
const finished=id=>waitForJob(async url=>(await request(url)).json(),id);
test('[repeat-analysis] isolated API target, 0.5 exports and 0.4 imports retain exact evidence and protected preview',async()=>{
  const input={type:'analyze',file:sitiSource,frameAnalysis:false,bitrate:false,complexity:false,repeatAnalysis:true,freezeDetection:true,enqueue:true};
  const queued=await request('jobs','POST',input);assert.equal(queued.status,202);const id=(await queued.json()).id;
  const exportedPlans=await(await request('plans')).json();assert.equal(exportedPlans.formatVersion,'0.5');
  const plan=exportedPlans.plans.find(p=>p.entryId===id);assert.equal(plan.input.repeatAnalysis,true);assert.equal(plan.input.freezeDetection,true);
  await request('jobs/'+id,'DELETE');
  const imported=await request('plans/import','POST',{mode:'append',start:true,plans:[plan]});assert.equal(imported.status,200);
  const job=await finished((await imported.json()).ids[0]);assert.equal(job.status,'done',job.message);
  const report=await(await request('jobs/'+job.id+'/report')).json(),r=report.repeatAnalysis;
  const wire=await(await fetch(base+`/api/jobs/${job.id}/report`,{headers:{'x-mediascope-token':token}})).json();assert.equal(wire.formatVersion,'0.5');
  for(const formatVersion of ['0.4','0.5']){
    assert.deepEqual(reportFromPortable({...wire,formatVersion}),report);
    const broken=structuredClone({...wire,formatVersion});broken.results[0].report.repeatAnalysis.frames.count++;
    assert.throws(()=>reportFromPortable(broken),/明细表/);
  }
  assert.deepEqual(report.analysisTargets,{frames:false,bitrate:false,complexity:false,repeat:true});assert.equal(r.status,'complete');
  assert.equal(r.configurationVersion,2);assert.equal(r.frames[0].equalPrevious,null);assert.equal(r.source.contentSha256.length,64);assert.equal(r.tools.length,3);
  assert.equal(r.sourceClassification.status,'not-qualified');assert.equal(r.sourceClassification.defaultEnabled,false);
  assert.equal(report.frames,undefined);assert.equal(report.tracks,undefined);assert.equal(report.coding,undefined);assert.equal(report.content,null);
  assert.deepEqual(report.timing.stages.map(s=>s.name),['读取文件','原生重复帧与时间诊断']);
  assert.deepEqual(parseReport(JSON.stringify(report)),report);
  const preview={file:sitiSource,signature:r.source.signature,contentSha256:r.source.contentSha256,stream:0,frame:1,hashes:r.frames.slice(0,2).map(f=>f.sha256)};
  assert.equal((await fetch(base+'/api/repeat/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(preview)})).status,403);
  const result=await request('repeat/preview','POST',preview);assert.equal(result.status,200);assert.equal((await result.json()).images.length,2);
  assert.equal((await request('repeat/preview','POST',{...preview,frame:-1})).status,400);
  assert.equal((await request('repeat/preview','POST',{...preview,contentSha256:'0'.repeat(64)})).status,400);
  const bad=structuredClone(report);bad.repeatAnalysis.frames[1].pts='999999';assert.throws(()=>parseReport(JSON.stringify(bad)),/重复画面/);
  delete bad.repeatAnalysis;assert.throws(()=>parseReport(JSON.stringify(bad)),/重复画面/);
  for(const values of [{repeatAnalysis:'yes'},{repeatAnalysis:false,freezeDetection:true},{freezeDetection:1}])assert.equal((await request('jobs','POST',{...input,...values})).status,400);
  await import('node:fs/promises').then(fs=>fs.writeFile(path.join(reportRoot,'report.json'),JSON.stringify(report)));
});
test('[repeat-analysis] repeat target coexists with each of the seven original target combinations',async()=>{
  const reports=[];
  for(let mask=1;mask<8;mask++){
    const input={type:'analyze',file:sitiSource,frameAnalysis:!!(mask&1),bitrate:!!(mask&2),complexity:!!(mask&4),repeatAnalysis:true};
    const response=await request('jobs','POST',input);assert.equal(response.status,202);const done=await finished((await response.json()).id);assert.equal(done.status,'done',done.message);
    const report=await(await request('jobs/'+done.id+'/report')).json();
    assert.equal(report.repeatAnalysis.status,'complete');assert.equal(report.repeatAnalysis.frames.length,12);
    assert.equal(!!report.frames,input.frameAnalysis||input.complexity);assert.equal(!!report.tracks,input.frameAnalysis||input.bitrate);assert.equal(!!report.coding,input.frameAnalysis);assert.equal(!!report.content,input.complexity);
    assert.deepEqual(parseReport(JSON.stringify(report)),report);
    reports.push({mask,report});
  }
  await import('node:fs/promises').then(fs=>fs.writeFile(path.join(reportRoot,'report.json'),JSON.stringify({outcome:'passed',reports})));
});
test('[analysis-limits] SI/TI API accepts 2048 seven-digit scene starts and rejects an out-of-range index',async()=>{
  const starts=Array.from({length:2048},(_,i)=>i===0?0:1999999-(2047-i)),input={type:'analyze',file:source,complexity:true,sitiSceneStarts:starts,enqueue:true};
  assert.ok(Buffer.byteLength(JSON.stringify(input))>16384);
  const response=await request('jobs','POST',input);assert.equal(response.status,202);
  const id=(await response.json()).id;assert.equal((await(await request('jobs/'+id)).json()).status,'queued');
  assert.equal((await request('jobs','POST',{...input,sitiSceneStarts:[0,2000000]})).status,400);
});
async function removed(id){for(let i=0;i<200;i++){if((await request('jobs/'+id)).status===404)return;await delay(100)}throw Error('Cancellation did not remove the job')}
test('[analysis-targets] all seven target combinations run only required stages and round-trip their reports and plans',async()=>{
  for(let mask=1;mask<8;mask++){
    const frameAnalysis=!!(mask&1),bitrate=!!(mask&2),complexity=!!(mask&4);
    const input={type:'analyze',file:sitiSource,frameAnalysis,bitrate,complexity,enqueue:true,...(bitrate?{bitrateWindowMs:1000}:{})};
    const response=await request('jobs','POST',input);assert.equal(response.status,202);
    const job=await response.json();assert.equal((await(await request('jobs/'+job.id)).json()).status,'queued');
    const plans=await(await request('plans')).json();
    const plan=plans.plans.find(p=>p.entryId===job.id).input;
    assert.equal(plan.frameAnalysis,frameAnalysis);assert.equal(plan.bitrate,bitrate);assert.equal(plan.complexity,complexity);
    // Import the exported plan before execution to exercise the same public validation.
    await request('jobs/'+job.id,'DELETE');
    const imported=await request('plans/import','POST',{mode:'append',start:false,plans:[{entryId:'combination-'+mask,input:plan}]});assert.equal(imported.status,200);
    const state=await(await request('status')).json(),id=state.jobs.find(j=>j.status==='queued').id;
    await request('queue','POST',{action:'start'});
    const done=await finished(id);assert.equal(done.status,'done',done.message);
    const report=await(await request('jobs/'+id+'/report')).json();
    assert.deepEqual(report.analysisTargets,{frames:frameAnalysis,bitrate,complexity});
    assert.equal(Array.isArray(report.frames),frameAnalysis||complexity);
    assert.equal(!!report.coding,frameAnalysis);assert.equal(!!report.tracks,frameAnalysis||bitrate);
    assert.equal(!!report.content,complexity);
    if(complexity)assert.equal(report.content.available,true,report.content.reason);
    if(report.tracks){
      for(const track of report.tracks){
        assert.equal(!!track.bitrateCurve,bitrate&&['video','audio'].includes(track.type));
        if(!bitrate)assert.deepEqual(track.bins,[]);
      }
    }
    const stages=report.timing.stages.map(s=>s.name);
    assert.equal(stages.includes('完整扫描视频帧'),frameAnalysis||complexity);
    assert.equal(stages.includes('解析全流编码帧头 / NAL / OBU'),frameAnalysis);
    assert.equal(stages.includes('统计全部轨道的压缩包'),frameAnalysis||bitrate);
    assert.equal(stages.includes('测量 SI/TI 内容复杂度'),complexity);
    assert.deepEqual(parseReport(JSON.stringify(report)),report);
    const incomplete=structuredClone(report);
    if(report.frames)delete incomplete.frames;else delete incomplete.tracks;
    assert.throws(()=>parseReport(JSON.stringify(incomplete)));
    if(bitrate){
      const missingCurve=structuredClone(report);delete missingCurve.tracks.find(t=>t.type==='video').bitrateCurve;
      assert.throws(()=>parseReport(JSON.stringify(missingCurve)),/bitrateCurve/);
    }
    const bad=structuredClone(report);delete bad.analysisTargets;
    if(!report.frames||!report.packets)assert.throws(()=>parseReport(JSON.stringify(bad)));
    await request('queue','POST',{action:'pause'});
  }
  for(const values of [{frameAnalysis:false,bitrate:false,complexity:false},{frameAnalysis:'yes'},{bitrate:1}]){
    assert.equal((await request('jobs','POST',{type:'analyze',file:source,...values,enqueue:true})).status,400);
    assert.equal((await request('plans/import','POST',{mode:'append',start:false,plans:[{entryId:'invalid',input:{type:'analyze',file:source,...values}}]})).status,400);
  }
});

test('API protects local data and returns a reproducible in-memory report',async()=>{
 assert.equal((await fetch(base+'/api/status')).status,403);
 assert.equal((await fetch(base+'/api/status',{headers:{'x-mediascope-token':token,origin:'https://external.invalid'}})).status,403);
 const job=await(await request('jobs','POST',{type:'analyze',file:source,stream:0})).json();const queued=await request('jobs','POST',{type:'inspect',file:source});assert.equal(queued.status,202);const next=await queued.json();await finished(next.id);
 const status=await finished(job.id);assert.equal(status.status,'done',status.message);
 assert.equal(status.progress.stage,'完成');assert.equal(status.progress.completed,1);assert.equal(status.progress.total,1);assert.ok(status.progress.phaseIndex>=1);assert.ok(status.progress.phaseCount>=status.progress.phaseIndex);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual(parseReport(JSON.stringify(report)),report);assert.equal((await fetch(base+'/report.js')).status,200);assert.equal(report.schema,undefined);assert.equal(report.frames.length,12);assert.equal(report.frames[0].special,'IDR');assert.equal(report.tracks.length,1);assert.ok(report.commands.every(c=>c.cwd));
 assert.equal(status.reportPath,undefined);
 const fileText=await(await fetch(base+`/api/jobs/${job.id}/report`,{headers:{'x-mediascope-token':token}})).text(),wire=JSON.parse(fileText);
 assert.equal(fileText.includes('\n'),false);assert.equal(wire.formatVersion,'0.5');assert.equal(wire.results[0].report.schema,undefined);
 assert.equal(wire.results[0].report.frames.count,report.frames.length);assert.equal(wire.results[0].report.packets,undefined);
 assert.deepEqual(parsePortable(fileText).results[0].report,report);
 const rawResponse=await fetch(base+`/api/jobs/${job.id}/report`,{headers:{'x-mediascope-token':token}});
 // Each export has its own outer creation time; the measured report is immutable.
 const freshWire=await rawResponse.json();
 assert.ok(Number.isFinite(Date.parse(freshWire.createdAt)));
 assert.ok(Date.parse(freshWire.createdAt)>=Date.parse(wire.createdAt));
 assert.deepEqual({...freshWire,createdAt:wire.createdAt},wire);
 assert.deepEqual(parsePortable(JSON.stringify(freshWire)).results[0].report,report);
 const concurrent=report.timing.stages.filter(s=>s.concurrentGroup);assert.equal(concurrent.length,2);assert.equal(new Set(concurrent.map(s=>s.concurrentGroup)).size,1);assert.ok(report.timing.decodeThreads>=1&&report.timing.decodeThreads<=12);
 assert.deepEqual(status.timing,report.timing,'result list metadata preserves recorded task and stage timing');
});
test('SI/TI worker setting validates input and records requested versus actual workers',async()=>{
 const invalidDevice=await request('jobs','POST',{type:'analyze',file:source,complexity:true,sitiDevice:'invalid'});assert.equal(invalidDevice.status,400);assert.match((await invalidDevice.json()).error,/设备/);
 const invalid=await request('jobs','POST',{type:'analyze',file:source,stream:0,complexity:true,sitiWorkers:3});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/并行上限/);
 const job=await(await request('jobs','POST',{type:'analyze',file:sitiSource,stream:0,complexity:true,sitiWorkers:8})).json(),status=await finished(job.id);assert.equal(status.status,'done',status.message);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual({setting:report.content.execution.setting,requested:report.content.execution.requestedWorkers,actual:report.content.execution.workers},{setting:'manual',requested:8,actual:1});
 const html=await(await fetch(base)).text();assert.match(html,/id="siti-workers"/);assert.match(html,/value="8">8 路/);
 assert.equal(report.content.execution.device,'cpu');assert.equal(report.content.execution.requestedDevice,'cpu');assert.match(html,/id="siti-device"/);
});

test('SI/TI reference API preserves input settings, plans and validated reports',async()=>{
 const vectors=JSON.parse(await readFixture('vqeg-060.json'));
 const invalid=await request('jobs','POST',{type:'analyze',file:sitiSource,complexity:true,sitiSettings:{scale:'literal'}});assert.equal(invalid.status,400);
 assert.equal((await fetch(base+'/siti.js')).status,200);
 for(const name of ['gray12le-hlg-pc','gray10le-pq-tv','rgb24-sdr-pc']){
  const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(reportRoot,c);
  await request('queue','POST',{action:'pause'});
  await request('jobs','POST',{type:'analyze',file:fixture.file,stream:0,complexity:true,sitiSettings:c.settings,sitiSceneStarts:[0,2,4],enqueue:true});
  const saved=await(await request('plans')).json();assert.deepEqual(saved.plans[0].input.sitiSettings,c.settings);
  const imported=await(await request('plans/import','POST',{mode:'replace',start:true,plans:saved.plans})).json(),id=imported.ids[0],status=await finished(id);assert.equal(status.status,'done',status.message);
  const report=await(await request(`jobs/${id}/report`)).json();assert.equal(report.content.available,true,report.content.reason);assert.deepEqual(parseReport(JSON.stringify(report)),report);assert.equal(report.content.execution.configuration.configurationVersion,8);
  for(const damage of [c=>c.outputMultiplier=1,c=>c.input.source.transfer='changed',c=>c.inputDomain='changed',c=>c.display={whiteCdM2:1},c=>delete c.configurationVersion,c=>c.reference.commit='changed']){const broken=structuredClone(report);damage(broken.content.execution.configuration);assert.throws(()=>parseReport(JSON.stringify(broken)),/configuration/)}
 }
});

test('SI/TI rejects float and partial alpha while completing other media analysis',async()=>{
 const vectors=JSON.parse(await readFixture('vqeg-060.json'));
 const pixels=Float32Array.from({length:80},(_,i)=>i/79),raw=Buffer.from(pixels.buffer).toString('base64');
 const floating={name:'unreferenced-float',format:'grayf32le',width:10,height:8,range:'pc',domain:'sdr',frames:Array(5).fill(raw),settings:{range:'pc',transfer:'sdr'}};
 const alpha=structuredClone(vectors.cases.find(c=>c.format==='rgba'));alpha.name='unreferenced-alpha';alpha.frames=alpha.frames.map(s=>{const raw=Buffer.from(s,'base64');raw[3]=128;return raw.toString('base64')});
 for(const [c,reason] of [[floating,/浮点/],[alpha,/半透明/]]){
  const fixture=await sitiInputFixture(reportRoot,c),job=await(await request('jobs','POST',{type:'analyze',file:fixture.file,stream:0,complexity:true,sitiSettings:c.settings})).json(),status=await finished(job.id);
  assert.equal(status.status,'done',status.message);const report=await(await request(`jobs/${job.id}/report`)).json();
  assert.equal(report.frames.length,5);assert.equal(report.content.available,false);assert.match(report.content.reason,reason);assert.ok(report.packets.bins.length);assert.deepEqual(parseReport(JSON.stringify(report)),report);
 }
});

test('GPU SI/TI API records actual device and round-trips queued device selection',async()=>{
 const capability=await(await request('siti-gpu')).json();assert.equal(typeof capability.available,'boolean');
 await request('queue','POST',{action:'pause'});
 await request('jobs','POST',{type:'analyze',file:sitiSource,stream:0,complexity:true,sitiDevice:'gpu',sitiSceneStarts:[0,1,6,11],enqueue:true});
 const saved=await(await request('plans')).json();assert.equal(saved.plans[0].input.sitiDevice,'gpu');
 assert.deepEqual(saved.plans[0].input.sitiSceneStarts,[0,1,6,11]);
 const imported=await(await request('plans/import','POST',{mode:'replace',start:true,plans:saved.plans})).json();
 const job={id:imported.ids[0]};
 const status=await finished(job.id);assert.equal(status.status,'done',status.message);
 const report=await(await request(`jobs/${job.id}/report`)).json();
 assert.equal(report.content.execution.requestedDevice,'gpu');assert.equal(report.content.execution.method,SITI_COMPAT_PROFILE);
 assert.equal(report.content.execution.device,capability.available?'gpu':'cpu');
 if(capability.available)assert.equal(report.content.execution.validation.selfTest,'passed');else assert.ok(report.content.execution.gpuFallbackReason);
 assert.deepEqual(parseReport(JSON.stringify(report)),report);
 assert.equal(report.content.si,null);assert.equal(report.content.ti,null);assert.equal(report.content.scenes.length,4);assert.equal(report.content.scenes.at(-1).ti,null);
 assert.deepEqual(report.content.points.filter(p=>p.ti===null).map(p=>p.frame),[0,1,6,11]);
});
test('SI/TI scene boundaries validate input, exclude boundary TI and survive report validation',async()=>{
 for(const starts of [[],[1],[0,0],[0,4,2],null,[0,1.5]]){
  const invalid=await request('jobs','POST',{type:'analyze',file:sitiSource,complexity:true,sitiSceneStarts:starts});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/场景/);
 }
 const job=await(await request('jobs','POST',{type:'analyze',file:sitiSource,stream:0,complexity:true,sitiSceneStarts:[0,1,6,11]})).json(),status=await finished(job.id);assert.equal(status.status,'done',status.message);
 const report=await(await request(`jobs/${job.id}/report`)).json();assert.deepEqual(parseReport(JSON.stringify(report)),report);
 assert.equal((await fetch(base+'/siti.js')).status,200);
 assert.equal(report.content.sceneAnalysis.mode,'confirmed');assert.equal(report.content.scenes[0].ti,null);
 for(const damage of [c=>c.points[1].ti=0,c=>c.sceneAnalysis.starts=[0,12],c=>c.scenes[1].si.mean+=1,c=>c.scenes.pop(),c=>c.si=c.scenes[1].si,c=>c.points.pop(),c=>c.points[2].t+=1]){
  const broken=structuredClone(report);damage(broken.content);assert.throws(()=>parseReport(JSON.stringify(broken)),/SI\/TI/);
 }
 const outside=await(await request('jobs','POST',{type:'analyze',file:sitiSource,complexity:true,sitiSceneStarts:[0,12]})).json();assert.equal((await finished(outside.id)).status,'error');
});
test('API cancellation ends the job and does not leave experiment video files',async()=>{
 const job=await(await request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx265',crfs:[20,32],metrics:['psnr']})).json();await request('jobs/'+job.id,'DELETE');await removed(job.id);await assert.rejects(lstat(path.join(reportRoot,job.id)),e=>e.code==='ENOENT');assert.ok(!(await(await request('status')).json()).jobs.some(j=>j.id===job.id));
});

test('API requires cross-depth opt-in and exports normalization evidence',async()=>{
 const files=[];
 for(const depth of [8,10]){
  const file=path.resolve(`.build/testing-work/http-depth-${depth}.mkv`),factor=depth===8?1:4;
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
  {type:'inspect',file:path.resolve('.build/testing-work/missing-queue-file.mp4')},
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
 const failed=await(await request('jobs','POST',{type:'inspect',file:path.resolve('.build/testing-work/missing-remove.mp4')})).json();await finished(failed.id);
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
 const invalid=await(await request('jobs','POST',{type:'inspect',file:path.resolve('.build/testing-work/not-here.mp4'),enqueue:true})).json();
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
 assert.equal(saved.format,'MediaScope');assert.equal(saved.formatVersion,'0.5');
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
