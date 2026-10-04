import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,utimes,readdir} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {FF,FP,run} from '../engine.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';

const root=path.resolve('.'),work=path.resolve('test-work/startup-desktop');
const deadline=async(fn,timeout=20000)=>{
  const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(50)}throw Error('Timed out');
};
const validation=async()=>({programs:Object.fromEntries(await Promise.all([
  ['node',process.execPath],['ffmpeg',FF],['ffprobe',FP]
].map(async([name,exe])=>[name,{path:exe,version:name==='node'?process.version:(await run(exe,['-version'])).split('\n')[0]}])))});
async function connectPage(child,base){
  let id=0;const calls=new Map(),events=new Map();
  child.on('message',data=>{
    if(data.type==='desktop-command-result'){const entry=calls.get(data.id);if(entry){clearTimeout(entry.timer);calls.delete(data.id);data.error?entry.reject(Error(entry.method+': '+data.error)):entry.resolve(data.result)}}
    else if(events.has(data.method)){events.get(data.method)(data.params);events.delete(data.method)}
  });
  child.on('exit',()=>{for(const entry of calls.values()){clearTimeout(entry.timer);entry.reject(Error('Page closed during '+entry.method))}calls.clear()});
  let sessionId;
  const call=(method,params={},rootCommand=false)=>new Promise((resolve,reject)=>{const sequence=++id;const timer=setTimeout(()=>{calls.delete(sequence);reject(Error('CDP command timed out: '+method))},10000);calls.set(sequence,{resolve,reject,timer,method});child.send({type:'desktop-command',id:sequence,method,params,sessionId:rootCommand?undefined:sessionId})});
  const {targetInfos}=await call('Target.getTargets');const target=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(base));assert.ok(target);
  ({sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
  return {call,evaluate:async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,userGesture:true})).result.value,event:method=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{events.delete(method);reject(Error('CDP event timed out: '+method))},10000);events.set(method,data=>{clearTimeout(timer);resolve(data)})})};
}

test('[desktop-startup] page appears before validation, rejects media work until ready, and remains usable after an error',async()=>{
  const dir=path.join(work,'pending');await mkdir(dir,{recursive:true});
  const resultFile=path.join(dir,'startup.json');await writeFile(resultFile,JSON.stringify({state:'checking'}));
  const app=await startServer(dir,{env:{MEDIASCOPE_STARTUP_RESULT:resultFile}});
  const {chromium}=await import('playwright-core');const browser=await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page=await browser.newPage();await page.goto(app.base);
    await page.locator('#startup-status').waitFor({state:'visible'});
    await deadline(async()=>await page.locator('#inspect').isDisabled());
    for(const endpoint of ['jobs','probe','queue','plans/import']){
      const response=await fetch(app.base+'/api/'+endpoint,{method:'POST',headers:{'x-mediascope-token':app.token,'content-type':'application/json'},body:'{}'});
      assert.equal(response.status,503,endpoint);
    }
    await writeFile(resultFile,JSON.stringify({state:'ready',validation:await validation()}));
    await deadline(async()=>(await app.request('status')).startup.state==='ready');
    await deadline(async()=>!(await page.locator('#inspect').isDisabled()));
    assert.equal(await page.locator('#startup-status').isVisible(),false);
    const media=path.join(dir,'sample.mkv');await run(FF,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=64x64:rate=4:duration=0.5','-c:v','libx264',media]);
    const job=await app.request('jobs','POST',{type:'inspect',file:media});assert.equal((await waitForJob(app.request,job.id)).status,'done');
  } finally {await browser.close();await app.stop()}
  const failureDir=path.join(work,'failed');await mkdir(failureDir,{recursive:true});
  const failureFile=path.join(failureDir,'startup.json');await writeFile(failureFile,JSON.stringify({state:'error',message:'运行环境损坏，请修复'}));
  const failed=await startServer(failureDir,{env:{MEDIASCOPE_STARTUP_RESULT:failureFile}});
  try {await deadline(async()=>(await failed.request('status')).startup.state==='error');assert.match((await failed.request('status')).startup.message,/损坏/);assert.equal((await fetch(failed.base)).status,200)}finally{await failed.stop()}
});

test('[desktop-startup] owned browser opens automatically, refresh keeps the service alive, and closing its page stops the server',async()=>{
  const dir=path.join(work,'owned-'+randomUUID());await mkdir(dir,{recursive:true});
  const requestFile=path.join(dir,'launch.json');
  await writeFile(requestFile,JSON.stringify({app:root,paths:{node:process.execPath,ffmpeg:FF,ffprobe:FP},validation:await validation(),needsValidation:false,desktop:true}));
  const child=spawn(process.execPath,[path.join(root,'scripts/desktop.mjs'),requestFile],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:'0',MEDIASCOPE_DATA_DIR:dir,MEDIASCOPE_DESKTOP_HEADLESS:'1'}});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  let page;
  try {
    const base=await deadline(async()=>{if(child.exitCode!==null)throw Error(output);return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]});
    await deadline(async()=>{if(child.exitCode!==null)throw Error(output);return output.includes('MediaScope 应用窗口已连接。')});
    page=await connectPage(child,base);await page.call('Page.enable');
    await deadline(async()=>await page.evaluate('document.readyState === "complete"'));
    const loaded=page.event('Page.loadEventFired');await page.call('Page.reload');await loaded;
    assert.equal((await fetch(base)).status,200);
    await page.evaluate('document.querySelector("#theme-toggle").click()');
    await deadline(async()=>{const status=await(await fetch(base+'/api/status',{headers:{'x-mediascope-token':(await(await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1]}})).json();return status.settings.theme!=='system'});
    assert.equal(await page.evaluate('navigator.userActivation.hasBeenActive'),true);
    const token=(await(await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1];
    const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'x-mediascope-token':token,'content-type':'application/json'},body:JSON.stringify({type:'inspect',file:path.join(dir,'waiting.mkv'),enqueue:true})});
    assert.equal(response.status,202);
    await deadline(async()=>await page.evaluate('document.querySelector("#queue-count").textContent.includes("1 项等待")'));
    const dismissed=page.event('Page.javascriptDialogOpening');const firstClose=page.call('Page.close');
    const dialog=await dismissed;assert.equal(dialog.type,'beforeunload');await page.call('Page.handleJavaScriptDialog',{accept:false});await firstClose;
    assert.equal((await fetch(base)).status,200,'Cancelling close keeps the service alive');
    const media=path.join(dir,'active-trial.mkv');
    await run(FF,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=2','-c:v','libx264',media]);
    const activeResponse=await fetch(base+'/api/jobs',{method:'POST',headers:{'x-mediascope-token':token,'content-type':'application/json'},body:JSON.stringify({type:'trial',file:media,stream:0,start:0,duration:2,encoder:'libaom-av1',cpuUsed:0,crfs:[20,32],metrics:['psnr'],keepFiles:false})});
    assert.equal(activeResponse.status,202);const activeJob=await activeResponse.json();
    await deadline(async()=>{
      const status=await(await fetch(base+'/api/jobs/'+activeJob.id,{headers:{'x-mediascope-token':token}})).json();
      assert.notEqual(status.status,'error',JSON.stringify(status));
      return status.status==='running';
    });
    await page.call('Target.createTarget',{url:'about:blank'},true);
    const accepted=page.event('Page.javascriptDialogOpening');const secondClose=page.call('Page.close').catch(()=>{});
    await accepted;await page.call('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{});await secondClose;
    // Shutdown can spend 3 + 10 + 10 + 10 + 3 seconds in its bounded stages.
    await deadline(async()=>child.exitCode!==null,40000);assert.equal(child.exitCode,0,output);
    await assert.rejects(fetch(base));
    const failure=JSON.parse(await readFile(path.join(dir,activeJob.id,'failure.json'),'utf8'));
    assert.equal(failure.status,'cancelled','Closing the window must cancel and record its real encoding task');
    await assert.rejects(readFile(path.join(dir,'desktop-profile','Local State')),e=>e.code==='ENOENT');
    assert.notEqual(JSON.parse(await readFile(path.join(dir,'settings.json'),'utf8')).theme,'system');
    await writeFile(path.join(dir,'launcher.log'),output);
  } finally {
    await writeFile(path.join(dir,'launcher.log'),output);
    if(child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{child.kill()}}
  }
});
