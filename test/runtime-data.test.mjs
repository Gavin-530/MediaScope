import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,writeFile,lstat,open,symlink,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {RuntimeData,acquireDataLease,removeOwned,recentBytes} from '../scripts/runtime-data.mjs';
import {FF,run} from '../engine.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {parseReport} from '../public/report.js';
import {trial} from '../analysis.mjs';
const work=path.resolve('test-work/runtime-data');let source;
before(async()=>{await mkdir(work,{recursive:true});source=path.join(work,'source.mp4');await run(FF,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=4:duration=1','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-chroma_sample_location','left',source])});
const exists=async file=>Boolean(await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e}));
const temp=()=>mkdtemp(path.join(work,'case-'));

test('[runtime-data] real completed jobs retain the newest ten, restore exact reports and protect an export during clearing',async()=>{
  const dir=await temp();let app=await startServer(dir);const ids=[];
  try{
    for(let i=0;i<12;i++){
      const job=await app.request('jobs','POST',{type:'inspect',file:source});ids.push(job.id);
      assert.equal((await waitForJob(app.request,job.id)).status,'done');
    }
    let status=await app.request('status');assert.deepEqual(status.jobs.map(j=>j.id),ids.slice(-10));
    assert.equal(await exists(path.join(dir,ids[0])),false);
    const original=await app.request('jobs/'+ids.at(-1)+'/report');assert.deepEqual(parseReport(JSON.stringify(original)),original);
    await app.request('local-data/settings','POST',{theme:'dark'});
    await app.stop();app=await startServer(dir);
    status=await app.request('status');assert.equal(status.settings.theme,'dark');assert.equal(status.jobs.length,10);assert.ok(status.jobs.every(j=>j.restored));
    assert.deepEqual(await app.request('jobs/'+ids.at(-1)+'/report'),original);
    await writeFile(path.join(work,'measured-restored.json'),JSON.stringify(original));
    const queued=await app.request('jobs','POST',{type:'inspect',file:source,enqueue:true});
    const {key}=await app.request('local-data/export-hold','POST',{ids:[ids.at(-1)]});
    await app.request('local-data/clean','POST',{category:'records'});
    assert.deepEqual(await app.request('jobs/'+ids.at(-1)+'/report'),original);
    assert.equal((await app.request('jobs/'+queued.id)).status,'queued');
    await app.request('local-data/export-release','POST',{key});
    assert.equal(await exists(path.join(dir,ids.at(-1))),false);
    assert.deepEqual((await app.request('status')).jobs.map(j=>j.id),[queued.id]);
    const retry=await app.request('jobs/'+queued.id,'DELETE');assert.equal(retry.ok,true);
    await app.stop();app=await startServer(dir);
    await assert.rejects(app.request('jobs/'+queued.id),/404/);assert.deepEqual((await app.request('status')).jobs,[]);
    const again=await app.request('jobs','POST',{type:'inspect',file:source,enqueue:true});await app.request('queue','POST',{action:'start'});
    assert.equal((await waitForJob(app.request,again.id)).status,'done');
  }finally{await app.stop()}
});

test('[runtime-data] explicit saved trial media survive manual clearing and clear-on-exit preserves small preferences',async()=>{
  const dir=await temp(),saved=await temp();let app=await startServer(dir);
  try{
    const job=await app.request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true,exportDirectory:saved});
    const result=await waitForJob(app.request,job.id);assert.equal(result.status,'done',result.message);
    const report=await app.request('jobs/'+job.id+'/report');assert.deepEqual(parseReport(JSON.stringify(report)),report);
    await writeFile(path.join(work,'measured-trial.json'),JSON.stringify(report));
    const files=report.experiment.retainedFiles;assert.equal(files.length,report.rows.length);assert.ok(files.every(file=>path.dirname(file)===path.join(saved,job.id)));
    assert.deepEqual(files.map(file=>path.basename(file)),report.rows.map(row=>row.id+'.mkv'));assert.equal(report.experiment.preparation.reference,'source-segment');
    assert.deepEqual((await readdir(path.join(dir,job.id))).sort(),['job-input.json','job.json','report.json']);
    await app.request('local-data/clean','POST',{category:'records'});for(const file of files)assert.equal(await exists(file),true);
    const bad=await app.request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true,exportDirectory:dir});
    assert.match((await waitForJob(app.request,bad.id)).message,/运行数据目录之外/);
    await app.request('local-data/settings','POST',{theme:'light',clearOnExit:true});
    await app.stop();assert.equal(await exists(path.join(dir,bad.id)),false);
    // Re-create a measured report as the on-disk state left by an interrupted exit.
    const stranded=path.join(dir,job.id);await mkdir(stranded);
    await writeFile(path.join(stranded,'job-input.json'),JSON.stringify({type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true,exportDirectory:saved}));
    await writeFile(path.join(stranded,'report.json'),JSON.stringify(report));
    app=await startServer(dir);assert.deepEqual((await app.request('status')).settings,{theme:'light',clearOnExit:true});assert.deepEqual((await app.request('status')).jobs,[]);
    assert.equal(await exists(stranded),false);
    for(const file of files)assert.equal(await exists(file),true);
  }finally{await app.stop()}
});

// These sparse files exercise filesystem quota rules, not media measurements.
test('[runtime-data] the byte limit evicts old records and oversized reports remain session-only',async()=>{
  const dir=await temp(),store=new RuntimeData(dir);await store.init();const jobs=new Map(),inputs=new Map();
  for(let i=0;i<2;i++){
    const id=randomUUID(),folder=path.join(dir,id);await mkdir(folder);
    const file=await open(path.join(folder,'report.json'),'w');await file.truncate(60*1024**2);await file.close();
    const job={id,type:'inspect',status:'done',finishedAt:new Date(1000+i).toISOString(),reportPath:path.join(folder,'report.json')},input={type:'inspect',file:source};
    jobs.set(id,job);inputs.set(id,input);await store.save(job,input);await store.prune(jobs,inputs);
  }
  assert.equal(jobs.size,1);assert.ok((await store.usage(jobs)).recordBytes<=recentBytes);
  const id=randomUUID(),folder=path.join(dir,id);await mkdir(folder);const file=await open(path.join(folder,'report.json'),'w');await file.truncate(recentBytes+1);await file.close();
  const job={id,type:'inspect',status:'done',finishedAt:new Date(2000).toISOString(),reportPath:path.join(folder,'report.json')};jobs.set(id,job);
  await store.save(job,{type:'inspect',file:source});assert.equal(job.sessionOnly,true);assert.equal(await exists(job.reportPath),true);assert.equal(await exists(folder),false);
  assert.equal(job.retentionMessage,'报告超过 100 MB，仅在本次会话可用；请导出保存');
  await store.prune(jobs,inputs,{clear:true});assert.equal(await exists(job.reportPath),false);assert.equal(jobs.size,0);
});

test('[runtime-data] active ownership and links block cleanup; stale session data are recovered without touching external originals',async()=>{
  const dir=await temp(),lease=await acquireDataLease(dir);
  await assert.rejects(acquireDataLease(dir),/正在使用/);await lease.release();
  await writeFile(path.join(dir,'runtime.lock'),JSON.stringify({pid:2147483647}));const recovered=await acquireDataLease(dir);await recovered.release();
  await mkdir(path.join(dir,'.session'));await writeFile(path.join(dir,'.session','scratch'),'discard');await new RuntimeData(dir).init();assert.equal(await exists(path.join(dir,'.session')),false);
  const interrupted=randomUUID(),folder=path.join(dir,interrupted);await mkdir(folder);
  await writeFile(path.join(folder,'job-input.json'),JSON.stringify({type:'inspect',file:source}));await writeFile(path.join(folder,'reference.mkv'),'interrupted scratch');
  const restored=await new RuntimeData(dir).init();assert.deepEqual(restored,[]);assert.equal(await exists(folder),false);
  const external=await temp();await writeFile(path.join(external,'original'),'keep');
  await symlink(external,path.join(dir,'desktop-profile'),'junction');await assert.rejects(removeOwned(dir,'desktop-profile'),/链接/);
  assert.equal(await readFile(path.join(external,'original'),'utf8'),'keep');await unlink(path.join(dir,'desktop-profile'));
});

test('[runtime-data] legacy explicitly retained real trial videos migrate outside the disposable directory',async()=>{
  const dir=await temp(),id=randomUUID(),folder=path.join(dir,id);await mkdir(folder);
  const input={type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true};
  const result=await trial(input,{cwd:folder,commands:[],update:()=>{}});
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const originals=new Map(await Promise.all(result.experiment.retainedFiles.map(async file=>[path.basename(file),digest(await readFile(file))])));
  await writeFile(path.join(folder,'job-input.json'),JSON.stringify(input));await writeFile(path.join(folder,'report.json'),JSON.stringify(result));
  const store=new RuntimeData(dir),records=await store.init(),report=JSON.parse(await readFile(records[0].job.reportPath,'utf8'));
  assert.ok(store.warnings.some(w=>w.includes('旧版保留的实验视频')));
  assert.equal(report.experiment.retainedFiles.length,originals.size);
  for(const file of report.experiment.retainedFiles)assert.equal(digest(await readFile(file)),originals.get(path.basename(file)));
  const jobs=new Map(records.map(r=>[r.job.id,r.job]));await store.prune(jobs,new Map(),{clear:true});
  for(const file of report.experiment.retainedFiles)assert.equal(await exists(file),true);
});


test('[runtime-data] mixed precision restoration and retention preserve the actual newest ten',async()=>{
  const dir=await temp(),store=new RuntimeData(dir);await store.init();const jobs=new Map(),inputs=new Map();
  const times=['2026-10-05T03:04:05Z','2026-10-05T03:04:05.123Z','2026-10-05T03:04:05.1230001Z',...Array.from({length:8},(_,i)=>'2026-10-05T03:04:'+String(6+i).padStart(2,'0')+'Z')];
  for(const finishedAt of times){
    const id=randomUUID(),folder=path.join(dir,id);await mkdir(folder);await writeFile(path.join(folder,'report.json'),'{}');
    const job={id,type:'inspect',status:'done',finishedAt,reportPath:path.join(folder,'report.json')},input={type:'inspect',file:source};
    jobs.set(id,job);inputs.set(id,input);await store.save(job,input);
  }
  assert.deepEqual((await new RuntimeData(dir).init()).map(r=>r.job.finishedAt),times);
  await store.prune(jobs,inputs);
  assert.deepEqual([...jobs.values()].map(j=>j.finishedAt),times.slice(1));
  assert.deepEqual((await new RuntimeData(dir).init()).map(r=>r.job.finishedAt),times.slice(1));
});
