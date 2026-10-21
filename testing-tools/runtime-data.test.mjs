import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,writeFile,lstat,symlink,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {RuntimeData,acquireDataLease,removeOwned} from '../scripts/runtime-data.mjs';
import {FF,run} from '../engine.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {parseReport} from '../public/report.js';
import {makePortable} from '../public/portable.js';
import {trial} from '../analysis.mjs';
const work=path.resolve('.build/testing-work/runtime-data');let source;
before(async()=>{await mkdir(work,{recursive:true});source=path.join(work,'source.mp4');await run(FF,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=4:duration=1','-c:v','libx264','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-chroma_sample_location','left',source])});
const exists=async file=>Boolean(await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e}));
const temp=()=>mkdtemp(path.join(work,'case-'));
async function files(root){
  const result=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(entry.isDirectory())result.push(...(await files(path.join(root,entry.name))).map(file=>path.join(entry.name,file)));
    else result.push(entry.name);
  }
  return result.sort();
}

test('[runtime-data] real results stay in memory, explicit export holds survive clearing and restart restores only preferences',async()=>{
  const dir=await temp();let app=await startServer(dir);const ids=[];
  try{
    for(let i=0;i<12;i++){
      const job=await app.request('jobs','POST',{type:'inspect',file:source});ids.push(job.id);
      assert.equal((await waitForJob(app.request,job.id)).status,'done');
    }
    assert.deepEqual((await app.request('status')).jobs.map(job=>job.id),ids,'current-session results are not disk-retention records');
    assert.deepEqual(await files(dir),['runtime.lock']);
    const original=await app.request('jobs/'+ids.at(-1)+'/report');assert.deepEqual(parseReport(JSON.stringify(original)),original);
    const queued=await app.request('jobs','POST',{type:'inspect',file:source,enqueue:true});
    const {key}=await app.request('local-data/export-hold','POST',{ids:[ids.at(-1)]});
    await app.request('local-data/clean','POST',{category:'records'});
    assert.deepEqual(await app.request('jobs/'+ids.at(-1)+'/report'),original);
    assert.equal((await app.request('jobs/'+queued.id)).status,'queued');
    await app.request('local-data/export-release','POST',{key});
    assert.deepEqual((await app.request('status')).jobs.map(job=>job.id),[queued.id]);
    await app.request('local-data/settings','POST',{theme:'dark'});
    await app.stop();app=await startServer(dir);
    const status=await app.request('status');assert.deepEqual(status.settings,{theme:'dark'});assert.deepEqual(status.jobs,[]);
    await assert.rejects(app.request('jobs/'+ids.at(-1)+'/report'),/404/);
    assert.deepEqual(await files(dir),['runtime.lock','server.log','settings.json']);
  }finally{await app.stop()}
});

test('[runtime-data] explicit saved trial media survive memory clearing, task cleanup and restart',async()=>{
  const dir=await temp(),saved=await temp();let app=await startServer(dir);
  try{
    const job=await app.request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true,exportDirectory:saved});
    const result=await waitForJob(app.request,job.id);assert.equal(result.status,'done',result.message);
    const report=await app.request('jobs/'+job.id+'/report');assert.deepEqual(parseReport(JSON.stringify(report)),report);
    await writeFile(path.join(work,'measured-trial.json'),JSON.stringify(report));
    const retained=report.experiment.retainedFiles;assert.equal(retained.length,report.rows.length);
    assert.ok(retained.every(file=>path.dirname(file)===path.join(saved,job.id)));
    assert.deepEqual(retained.map(file=>path.basename(file)),report.rows.map(row=>row.id+'.mkv'));
    assert.deepEqual(await files(dir),['runtime.lock'],'a completed trial leaves no media, logs, report or task metadata on disk');
    await app.request('local-data/clean','POST',{category:'records'});
    for(const file of retained)assert.equal(await exists(file),true);
    const bad=await app.request('jobs','POST',{type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true,exportDirectory:dir});
    assert.match((await waitForJob(app.request,bad.id)).message,/运行数据目录之外/);
    assert.deepEqual(await files(dir),['runtime.lock'],'failed jobs also leave no automatic JSON or logs');
    await app.stop();app=await startServer(dir);assert.deepEqual((await app.request('status')).jobs,[]);
    for(const file of retained)assert.equal(await exists(file),true);
  }finally{await app.stop()}
});

test('[runtime-data] workspace cleanup is scoped to the current process and preserves unrelated historical data',async()=>{
  const dir=await temp(),first=new RuntimeData(dir),second=new RuntimeData(dir);await first.init();await second.init();
  const id=randomUUID(),a=path.join(first.workRoot,id),b=path.join(second.workRoot,id),old=path.join(dir,id);
  await mkdir(a);await mkdir(b);await mkdir(old);
  await writeFile(path.join(a,'temporary.mkv'),'current task');await writeFile(path.join(b,'temporary.mkv'),'other process');
  await writeFile(path.join(old,'report.json'),'historical original');
  await first.finish({id});assert.equal(await exists(a),false);assert.equal(await readFile(path.join(b,'temporary.mkv'),'utf8'),'other process');
  await first.close();assert.equal(await exists(first.workRoot),false);
  assert.equal(await readFile(path.join(old,'report.json'),'utf8'),'historical original');
  await second.close();assert.equal(await exists(second.workRoot),false);
});

test('[runtime-data] active ownership and directory links block cleanup without touching external originals',async()=>{
  const dir=await temp(),lease=await acquireDataLease(dir);
  await assert.rejects(acquireDataLease(dir),/正在使用/);await lease.release();
  await writeFile(path.join(dir,'runtime.lock'),JSON.stringify({pid:2147483647}));const recovered=await acquireDataLease(dir);await recovered.release();
  const external=await temp();await writeFile(path.join(external,'original'),'keep');
  await symlink(external,path.join(dir,'desktop-profile'),'junction');await assert.rejects(removeOwned(dir,'desktop-profile'),/链接/);
  assert.equal(await readFile(path.join(external,'original'),'utf8'),'keep');await unlink(path.join(dir,'desktop-profile'));
});

test('[runtime-data] current and legacy reports and explicitly retained media are never automatically restored, migrated or removed',async()=>{
  const dir=await temp(),id=randomUUID(),folder=path.join(dir,id);await mkdir(folder);
  const input={type:'trial',file:source,stream:0,start:0,duration:1,encoder:'libx264',presets:['ultrafast'],crfs:[28],metrics:['psnr'],keepFiles:true};
  const result=await trial(input,{cwd:folder,commands:[],update:()=>{}});
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const originals=new Map(await Promise.all(result.experiment.retainedFiles.map(async file=>[file,digest(await readFile(file))])));
  await writeFile(path.join(folder,'job-input.json'),JSON.stringify(input));
  await writeFile(path.join(folder,'report.json'),JSON.stringify(result));
  const legacy=await readFile(path.join(folder,'report.json'));
  const session=path.join(dir,'.session',randomUUID());await mkdir(session,{recursive:true});await writeFile(path.join(session,'report.json'),legacy);
  let app=await startServer(dir);
  try{
    assert.deepEqual((await app.request('status')).jobs,[]);
    const measured=await app.request('probe','POST',{file:source}),current=path.join(dir,randomUUID());await mkdir(current);
    const bytes=Buffer.from(JSON.stringify(makePortable({results:[{entryId:'saved',report:measured}],applicationVersion:measured.producer.applicationVersion})));
    await writeFile(path.join(current,'report.json'),bytes);await writeFile(path.join(current,'job-input.json'),JSON.stringify({type:'inspect',file:source}));
    await app.stop();app=await startServer(dir);assert.deepEqual((await app.request('status')).jobs,[]);
    await app.request('local-data/clean','POST',{category:'records'});
    assert.deepEqual(await readFile(path.join(current,'report.json')),bytes);
    assert.deepEqual(await readFile(path.join(folder,'report.json')),legacy);assert.deepEqual(await readFile(path.join(session,'report.json')),legacy);
    for(const [file,hash]of originals)assert.equal(digest(await readFile(file)),hash);
  }finally{await app.stop()}
});
