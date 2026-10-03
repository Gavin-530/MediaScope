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
  const call=(method,params={})=>new Promise((resolve,reject)=>{const sequence=++id;const timer=setTimeout(()=>{calls.delete(sequence);reject(Error('CDP command timed out: '+method))},10000);calls.set(sequence,{resolve,reject,timer,method});child.send({type:'desktop-command',id:sequence,method,params,sessionId})});
  const {targetInfos}=await call('Target.getTargets');const target=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(base));assert.ok(target);
  ({sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
  return {call,evaluate:async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true,userGesture:true})).result.value,event:method=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{events.delete(method);reject(Error('CDP event timed out: '+method))},10000);events.set(method,data=>{clearTimeout(timer);resolve(data)})})};
}

test('[desktop-startup] daily launch skips runtime scans; explicit checking detects real media tool and DLL changes',async()=>{
  await mkdir(work,{recursive:true});
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'test/helpers/startup-cache.ps1'),'-App',root,'-HomeDir',path.join(work,'cache'),'-NodePath',process.execPath,'-FFmpegPath',FF,'-FFprobePath',FP],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  const line=output.split(/\r?\n/).find(s=>s.startsWith('CACHE_RESULT:'));assert.ok(line,output);
  const result=JSON.parse(line.slice('CACHE_RESULT:'.length));assert.equal(result.changedNeedsValidation,true);
  await writeFile(path.join(work,'cache-result.json'),JSON.stringify(result,null,2));
  console.log(`Receipt check: ${result.milliseconds.toFixed(1)} ms (no codec subprocesses)`);
});

test('[desktop-startup] source launcher validates a changed real tool behind the page and preserves its receipt after a failed check',async()=>{
  const cacheHome=path.join(work,'cache'),result=JSON.parse(await readFile(path.join(work,'cache-result.json'),'utf8'));
  const cacheFiles=await readdir(path.join(cacheHome,'launch-cache'));const cachePath=path.join(cacheHome,'launch-cache',cacheFiles[0]);
  const original=JSON.parse((await readFile(cachePath,'utf8')).replace(/^\uFEFF/,''));
  await utimes(result.paths.ffprobe,new Date(),new Date(Date.now()+2000));
  async function launch(check,checkEnvironment=true){
    const dir=path.join(work,'background-'+randomUUID());await mkdir(dir,{recursive:true});
    const begun=performance.now(),child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/start-source.ps1'),'-InstallRoot',cacheHome,...(checkEnvironment?['-CheckEnvironment']:[])],{windowsHide:true,env:{...process.env,PORT:'0',MEDIASCOPE_NO_BROWSER:'1',MEDIASCOPE_DATA_DIR:dir}});
    let output='',base,token;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    try{
      base=await deadline(async()=>{if(child.exitCode!==null)throw Error(output);return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]});
      await deadline(async()=>{if(child.exitCode!==null)throw Error(output);return output.includes('MediaScope 页面已就绪')});
      token=(await(await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1];
      const status=async()=>(await(await fetch(base+'/api/status',{headers:{'x-mediascope-token':token}})).json());
      assert.equal((await status()).startup.state,checkEnvironment?'checking':'ready');
      await writeFile(path.join(dir,'page-timing.json'),JSON.stringify({milliseconds:performance.now()-begun}));
      await check({base,token,status});
      assert.doesNotMatch(output,/No compatible local environment|Downloading/);
      if(!checkEnvironment)assert.doesNotMatch(output,/Checking real|Reusing verified|ffmpeg version/);
    }finally{
      if(base&&token)await fetch(base+'/api/desktop/shutdown',{method:'POST',headers:{'x-mediascope-token':token}}).catch(()=>{});
      try{await deadline(async()=>child.exitCode!==null,15000)}catch{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}
      await writeFile(path.join(dir,'launcher.log'),output);
      assert.equal(child.exitCode,0,output);
    }
  }
  await launch(async({status})=>{
    await deadline(async()=>(await status()).startup.state==='ready',60000);
    const updated=JSON.parse((await readFile(cachePath,'utf8')).replace(/^\uFEFF/,''));assert.notEqual(updated.validation.checkedAt,original.validation.checkedAt);
  });
  const savedReceipt=await readFile(cachePath,'utf8');
  await writeFile(result.paths.ffprobe,'damaged test copy');
  // A changed/broken tool is discovered when the user runs work or asks for a
  // check; it must not turn an ordinary launch into an automatic full recheck.
  await launch(async({status})=>assert.equal((await status()).startup.state,'ready'),false);
  await launch(async({base,token,status})=>{
    await deadline(async()=>(await status()).startup.state==='error',60000);
    const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'x-mediascope-token':token,'content-type':'application/json'},body:'{}'});assert.equal(response.status,503);
    assert.equal(await readFile(cachePath,'utf8'),savedReceipt,'A failed check must retain the last successful receipt');
    assert.match(await readFile(cachePath+'.failed','utf8'),/message/);
    assert.equal((await fetch(base)).status,200);
  });
  await launch(async({status})=>assert.equal((await status()).startup.state,'ready'),false);
  const retryDecision=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command','$ErrorActionPreference="Stop"; . (Join-Path $env:MEDIASCOPE_TEST_APP "scripts/deployment.ps1"); if(Read-LaunchCache $env:MEDIASCOPE_TEST_APP $env:MEDIASCOPE_TEST_HOME -CheckChanges){throw "Explicit check ignored the failure marker"}; "RECHECK_REQUIRED"'],{windowsHide:true,encoding:'utf8',env:{...process.env,MEDIASCOPE_TEST_APP:root,MEDIASCOPE_TEST_HOME:cacheHome}});
  assert.match(retryDecision,/RECHECK_REQUIRED/);
});
