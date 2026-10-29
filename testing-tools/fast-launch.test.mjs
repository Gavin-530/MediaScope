import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rename,unlink,symlink,readdir,access,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {FF,FP} from '../engine.mjs';

const root=path.resolve('.');let work,fixture;
const helper=path.join(root,'testing-tools/helpers/fast-launch-fixture.ps1');
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
const deadline=async(fn,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await delay(30)}throw Error('Fast launch test timeout')};
function environment(){const env={...process.env,TEMP:path.join(work,'temp'),TMP:path.join(work,'temp'),TMPDIR:path.join(work,'temp'),PORT:'0',MEDIASCOPE_NO_BROWSER:'1',MEDIASCOPE_LAUNCH_TRACE:'1'};for(const name of ['MEDIASCOPE_HOME','MEDIASCOPE_RUNTIME_HOME','MEDIASCOPE_DATA_DIR','MEDIASCOPE_BROWSER_PATH','MEDIASCOPE_DESKTOP_HEADLESS'])delete env[name];return env;}
function ps(action,args=[],app=root){return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Action',action,'-App',app,...args],{cwd:root,env:environment(),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});}
const exe=app=>path.join(app,app===fixture.source?'.build/launcher':'scripts','MediaScope.Launcher.exe');
const home=app=>app===fixture.source?fixture.sourceHome:fixture.client;
async function launch(app,{fast=true,extraEnv={},expect=0}={}){
  const data=path.join(work,'data '+Math.random().toString(16).slice(2));
  const env={...environment(),MEDIASCOPE_HOME:home(app),MEDIASCOPE_DATA_DIR:data,...extraEnv};
  const child=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${path.join(app,'start.cmd')}""`],{cwd:path.join(work,'arbitrary cwd'),env,windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  try{
    const base=await deadline(()=>{if(child.exitCode!==null)throw Error(output);return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]});
    await deadline(()=>output.includes('MediaScope 页面已就绪'));
    const token=(await(await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1];
    const status=await(await fetch(base+'/api/status',{headers:{'x-mediascope-token':token}})).json();assert.equal(status.startup.state,'ready');
    assert.equal(output.includes('MS_LAUNCH:fast'),fast,output);assert.doesNotMatch(output,/Downloading|Checking real|Reusing verified/);
    return {child,base,token,data,output:()=>output,close:async()=>{await fetch(base+'/api/desktop/shutdown',{method:'POST',headers:{'x-mediascope-token':token}});await deadline(()=>child.exitCode!==null,45000);assert.equal(child.exitCode,expect,output);ps('UnlockCheck',['-File',path.join(home(app),'deployment.lock')]);await writeFile(path.join(work,'launch-'+Date.now()+'.log'),output);}};
  }catch(error){if(child.exitCode===null)execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});throw error;}
}
before(async()=>{
  const base=path.join(root,'.build/testing-work/fast-launch');await mkdir(base,{recursive:true});work=await mkdtemp(path.join(base,'case-'));
  for(const name of ['temp','arbitrary cwd'])await mkdir(path.join(work,name),{recursive:true});
  ps('Prepare',['-Work',work,'-HomeRoot',path.join(work,"home 中文 [x] & ! % '"),'-RuntimeRoot',path.join(work,'shared runtime'),'-NodePath',process.execPath,'-FFmpegPath',FF,'-FFprobePath',FP]);
  fixture=await json(path.join(work,'fixture.json'));
});

test('[desktop-startup] fast CMD entries preserve selected components, arbitrary cwd, source data and installed data rules',async()=>{
  for(const app of [fixture.source,fixture.installed]){
    // Removing an empty managed staging directory must behave like the original launcher.
    await rmdir(path.join(home(app),'staging'));
    const running=await launch(app,{extraEnv:{MEDIASCOPE_DATA_DIR:'..\\relative data 中文 [x] & ! %'}});
    try{
      const data=app===fixture.source?path.resolve(app,'..\\relative data 中文 [x] & ! %'):path.join(fixture.client,'data');
      await access(path.join(data,'startup.json')).catch(async()=>{assert.ok((await readdir(data)).length>0)});
      const state=await json(path.join(fixture.client,'current.json'));assert.equal(state.current.environment.validation.programs.node.path,fixture.node);
      const other=spawnSync(exe(app),['--app',app],{cwd:app,env:{...environment(),MEDIASCOPE_HOME:home(app)},windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(other.status,1);assert.doesNotMatch(other.stdout,/MS_LAUNCH:fast/);
    }finally{await running.close();}
  }
});

test('[desktop-startup] absent or stale fast hints fall back before launching and source edits rebuild the launcher',async()=>{
  for(const app of [fixture.source,fixture.installed]){
    const files=(await readdir(path.join(home(app),'launch-cache'))).filter(f=>f.endsWith('.fast'));
    assert.equal(files.length,1);const hint=path.join(home(app),'launch-cache',files[0]);await rename(hint,hint+'.saved');
    try{const running=await launch(app,{fast:false});await running.close();await access(hint);}finally{await unlink(hint+'.saved');}
  }
  const cs=path.join(fixture.source,'scripts/launcher/Launcher.cs'),prior=await readFile(cs),metadata=path.join(fixture.source,'.build/launcher/launcher-build.json'),old=await json(metadata);
  try{await writeFile(cs,Buffer.concat([prior,Buffer.from('\n// Fixture source changed.\n')]));const running=await launch(fixture.source,{fast:false});await running.close();assert.notEqual((await json(metadata)).fingerprint,old.fingerprint);}finally{await writeFile(cs,prior);ps('Refresh',['-HomeRoot',fixture.sourceHome,'-RuntimeRoot',fixture.sourceHome],fixture.source);}
});

test('[desktop-startup] malformed fast envelopes and signed invalid records cannot start the desktop layer',async()=>{
  const hint=fixture.sourceCache.replace(/\.json$/,'.fast'),original=await readFile(hint),cache=await readFile(fixture.sourceCache);
  const native=args=>spawnSync(exe(fixture.source),args,{cwd:fixture.source,env:{...environment(),MEDIASCOPE_HOME:fixture.sourceHome},windowsHide:true,encoding:'utf8',timeout:15000});
  function signed(body){return Buffer.concat([Buffer.from('MSFAST03'),Buffer.from(sha(body),'hex'),body])}
  const malformed=[Buffer.alloc(0),original.subarray(0,43),Buffer.concat([original,Buffer.from([0])]),signed(Buffer.concat([original.subarray(40),Buffer.from([0])]))];
  const negative=Buffer.from(original.subarray(40));negative.writeInt32LE(-1,0);malformed.push(signed(negative));
  try{
    for(const bytes of malformed){await writeFile(hint,bytes);const r=native(['--app',fixture.source]);assert.equal(r.status,75,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/MS_LAUNCH:fast/);}
    await writeFile(hint,original);await writeFile(fixture.sourceCache,Buffer.concat([cache,Buffer.from(' ')]));assert.equal(native(['--app',fixture.source]).status,75);
    const invalid=JSON.parse(cache.toString('utf8').replace(/^\uFEFF/,''));invalid.validation.programs.ffmpeg.sha256='bad';await writeFile(fixture.sourceCache,JSON.stringify(invalid));
    let offset=40;const fields=[];while(offset<original.length){const size=original.readInt32LE(offset);offset+=4;fields.push(original.subarray(offset,offset+size).toString('utf8'));offset+=size;}fields[6]=sha(await readFile(fixture.sourceCache));const parts=[];for(const field of fields){const b=Buffer.from(field),n=Buffer.alloc(4);n.writeInt32LE(b.length);parts.push(n,b);}await writeFile(hint,signed(Buffer.concat(parts)));
    const r=spawnSync(fixture.node,[path.join(fixture.source,'scripts/fast-bootstrap.mjs'),hint],{cwd:fixture.source,env:environment(),windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(r.status,75,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/页面已就绪/);
  }finally{await writeFile(fixture.sourceCache,cache);await writeFile(hint,original);}
  for(const app of ['D:\\','D:relative','\\\\localhost\\unproven',path.join(work,'x'.repeat(240))])assert.equal(native(['--app',app]).status,75);
  const linked=path.join(work,'linked source');try{await symlink(fixture.source,linked,'junction');assert.equal(native(['--app',linked]).status,75);}finally{await unlink(linked);}
});

test('[desktop-startup] optional hint write failures do not block PowerShell startup; desktop errors never retry',async()=>{
  const hint=fixture.sourceCache.replace(/\.json$/,'.fast');
  const holder=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',helper,'-Action','Lock','-App',root,'-File',hint],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';holder.stdout.on('data',b=>output+=b);
  try{await deadline(()=>output.includes('LOCKED'));const running=await launch(fixture.source,{fast:false});await running.close();}finally{holder.stdin.end('\n');await deadline(()=>holder.exitCode!==null);}
  // The intentionally blocked auxiliary write may leave a stale hint. Establish a fresh fast-entry fixture.
  ps('Refresh',['-HomeRoot',fixture.sourceHome,'-RuntimeRoot',fixture.sourceHome],fixture.source);
  const desktop=path.join(fixture.source,'scripts/desktop.mjs'),original=await readFile(desktop);
  try{
    for(const code of ["process.exitCode=75;throw Error('fixture desktop failure after preflight');\n","process.exit(75);\n"]){
      await writeFile(desktop,code);
      const r=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${path.join(fixture.source,'start.cmd')}""`],{cwd:work,env:{...environment(),MEDIASCOPE_HOME:fixture.sourceHome,MEDIASCOPE_DATA_DIR:path.join(work,'error data')},windowsHide:true,windowsVerbatimArguments:true,encoding:'utf8',timeout:15000});
      assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/MS_LAUNCH:fast/);assert.doesNotMatch(r.stdout,/MS_LAUNCH:legacy/);
    }
    assert.ok(!(await readdir(path.join(fixture.sourceHome,'staging'))).some(name=>/^handoff-/.test(name)));
    await writeFile(desktop,"console.log('MODULE_PATH:'+process.env.PSModulePath);\n");
    const inherited=spawnSync(exe(fixture.source),['--app',fixture.source],{cwd:fixture.source,env:{...environment(),MEDIASCOPE_HOME:fixture.sourceHome,MEDIASCOPE_DATA_DIR:path.join(work,'module path data'),PSModulePath:'inherited-pwsh-only-modules'},windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(inherited.status,0,inherited.stdout+inherited.stderr);
    assert.ok(inherited.stdout.includes(path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/Modules')+';inherited-pwsh-only-modules'),inherited.stdout);
  }finally{await writeFile(desktop,original);}
});

test('[desktop-startup] update and rollback invalidate old hints and installed entries follow the selected version',async()=>{
  const old=fixture.installed,parts=fixture.version.split('.'),next=parts[0]+'.'+parts[1]+'.'+(Number(parts[2])+1),archive=path.join(work,'next.zip');
  ps('PackageVersion',['-Version',next,'-File',archive],fixture.package);
  ps('Update',['-HomeRoot',fixture.client,'-RuntimeRoot',fixture.runtime,'-File',archive],old);
  assert.equal((await json(path.join(fixture.client,'current.json'))).current.version,next);
  let running=await launch(old,{fast:false});await running.close();
  running=await launch(path.join(fixture.client,'apps',next));await running.close();
  ps('Rollback',['-HomeRoot',fixture.client,'-RuntimeRoot',fixture.runtime],old);
  assert.equal((await json(path.join(fixture.client,'current.json'))).current.version,fixture.version);
  running=await launch(old);await running.close();
  const state=await json(path.join(fixture.client,'current.json'));assert.equal(state.current.environment.validation.programs.node.path,fixture.node);
});

test('[desktop-startup] real Windows Ctrl+C, Ctrl+Break and console close stop the fast launcher and its service',async()=>{
  for(const signal of ['INT','BREAK','CLOSE']){
    const data=path.join(work,'console-'+signal),log=path.join(work,'console-'+signal+'.log');
    const driver=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'testing-tools/helpers/launcher-console.ps1'),'-Executable',exe(fixture.source),'-App',fixture.source,'-Log',log],{cwd:fixture.source,env:{...environment(),MEDIASCOPE_HOME:fixture.sourceHome,MEDIASCOPE_DATA_DIR:data},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';driver.stdout.on('data',b=>output+=b);driver.stderr.on('data',b=>output+=b);let base;
    try{
      await deadline(()=>{if(driver.exitCode!==null)throw Error(output);return output.includes('CHILD:')});
      base=await deadline(async()=>{const text=await readFile(log,'utf8').catch(()=>'' );return text.includes('MediaScope 页面已就绪')&&text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]});
      const token=(await(await fetch(base)).text()).match(/name="token" content="([^"]+)"/)[1];assert.equal((await(await fetch(base+'/api/status',{headers:{'x-mediascope-token':token}})).json()).startup.state,'ready');
      driver.stdin.end(signal+'\n');await deadline(()=>driver.exitCode!==null,30000);assert.equal(driver.exitCode,0,output);
      await assert.rejects(fetch(base));ps('UnlockCheck',['-File',path.join(fixture.sourceHome,'deployment.lock')]);
      assert.ok(!(await readdir(path.join(fixture.sourceHome,'staging'))).some(name=>/^launch-/.test(name)),signal+' request cleanup');
    }finally{if(driver.exitCode===null){driver.stdin.end('INT\n');await deadline(()=>driver.exitCode!==null,25000).catch(()=>{});}}
  }
});
