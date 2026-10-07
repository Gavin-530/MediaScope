import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,unlink,access,rename} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireDataLease,removeOwned,DesktopWindowData,desktopWindowBounds} from './runtime-data.mjs';

const requestPath=process.argv[2];
const config=JSON.parse((await readFile(requestPath,'utf8')).replace(/^\uFEFF/,''));
const resultPath=requestPath+'.result.json';
const started=performance.now();
let server,validator,browser,browserCall,browserDisconnected=false,base,token,stopping=false,stopPromise;
const dataRoot=path.resolve(process.env.MEDIASCOPE_DATA_DIR);
let dataLease;
const exited=child=>!child||!child.pid||child.exitCode!==null||child.signalCode!==null;
async function writeStartup(value){await writeFile(resultPath+'.tmp',JSON.stringify(value));await rename(resultPath+'.tmp',resultPath)}
const waitExit=async(child,timeout=10000)=>{
  if(exited(child))return;
  await new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve()};
    const timer=setTimeout(done,timeout);child.once('exit',done);
  });
};
function stop(){
  if(stopPromise)return stopPromise;stopping=true;
  stopPromise=(async()=>{
  // The validator owns its encoder/probe children. Kill only this process tree,
  // never global Node/FFmpeg/browser processes.
  if(!exited(validator)){
    const killer=spawn('taskkill.exe',['/PID',String(validator.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>validator.kill());await waitExit(killer);await waitExit(validator);
  }
  if(base&&token&&!exited(server)){
    await fetch(base+'/api/desktop/shutdown',{method:'POST',headers:{'x-mediascope-token':token},signal:AbortSignal.timeout(3000)}).catch(()=>{});
  }
  await waitExit(server);
  if(!exited(server))server.kill();
  await waitExit(server);
  if(browserCall&&!browserDisconnected)await browserCall('Browser.close').catch(()=>{});
  await waitExit(browser,3000);
  if(!exited(browser))browser.kill();
  await waitExit(browser,3000);
  if(dataLease){
    if(exited(browser))await removeOwned(dataRoot,'desktop-profile').catch(e=>console.error('浏览器缓存清理未完成，下次启动重试：'+e.message));
    if(exited(server)&&exited(browser))await dataLease.release();
  }
  await unlink(resultPath).catch(()=>{});
  await unlink(resultPath+'.tmp').catch(()=>{});
  })();return stopPromise;
}
async function findBrowser(){
  const candidates=[
    process.env.MEDIASCOPE_BROWSER_PATH,
    ...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).flatMap(dir=>[
      path.join(dir,'Microsoft/Edge/Application/msedge.exe'),path.join(dir,'Google/Chrome/Application/chrome.exe')
    ])
  ].filter(Boolean);
  for(const candidate of candidates){try{await access(candidate);return candidate}catch{}}
  throw Error('未找到 Edge 或 Chrome。请安装其中一个，或设置 MEDIASCOPE_NO_BROWSER=1 使用手动浏览器模式。');
}
async function openWindow(){
  const exe=await findBrowser();
  const profile=path.join(dataRoot,'desktop-profile');
  await mkdir(profile,{recursive:true});
  // Chromium's inherited pipe gives this launcher an exclusive control channel;
  // no debugger TCP port is exposed and ordinary browser profiles are untouched.
  browser=spawn(exe,[`--app=${base}`,`--user-data-dir=${profile}`,'--remote-debugging-pipe',
    '--no-first-run','--no-default-browser-check','--disable-background-mode','--disable-extensions',
    // A guest session cannot sign in or sync the Windows account. A separate
    // user-data-dir alone still lets Edge implicitly sign in on every launch.
    '--guest','--disable-sync','--disable-background-networking',
    // Edge's compatibility relaunch closes the inherited control pipe. Keep
    // the original process, as Playwright does, so window ownership is retained.
    ...(path.basename(exe).toLowerCase()==='msedge.exe'?['--edge-skip-compat-layer-relaunch']:[]),
    // The test host restricts nested Windows sandbox tokens. This matches the
    // existing Playwright test setup; the normal application keeps its sandbox.
    ...(process.env.MEDIASCOPE_DESKTOP_HEADLESS==='1'?['--headless=new','--disable-gpu','--no-sandbox']:[])],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
  if(browser.pid)await dataLease.browser(browser.pid);
  let browserLog='';browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk.toString()).slice(-16384)});
  let sequence=0,buffer=Buffer.alloc(0),browserError;const pending=new Map();
  const closedError=()=>browserError||Error('应用窗口已关闭'+(browserLog?'：\n'+browserLog:''));
  const disconnected=()=>{browserDisconnected=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(closedError())}pending.clear()};
  browser.on('error',e=>{browserError=e;disconnected()});
  browser.stdio[3].on('error',disconnected);browser.stdio[4].on('error',disconnected);browser.stdio[4].on('close',disconnected);
  browser.stdio[4].on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);let end;
    while((end=buffer.indexOf(0))!==-1){
      const message=JSON.parse(buffer.subarray(0,end).toString('utf8'));buffer=buffer.subarray(end+1);
      const entry=pending.get(message.id);
      if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(message.error.message)):entry.resolve(message.result)}
      else if(process.connected&&process.env.MEDIASCOPE_DESKTOP_HEADLESS==='1')process.send({type:'desktop-event',method:message.method,params:message.params,sessionId:message.sessionId},()=>{});
    }
  });
  browserCall=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    if(browserDisconnected){reject(closedError());return}
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('应用窗口响应超时'))},10000);
    pending.set(id,{resolve,reject,timer});browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  // Tests can exercise native close/cancel through the inherited parent IPC.
  // Explorer launches have no IPC channel and never install this handler.
  if(process.send&&process.env.MEDIASCOPE_DESKTOP_HEADLESS==='1')process.on('message',async message=>{
    if(message.type!=='desktop-command')return;
    try{const result=await browserCall(message.method,message.params,message.sessionId);if(process.connected)process.send({type:'desktop-command-result',id:message.id,result},()=>{})}
    catch(e){if(process.connected)process.send({type:'desktop-command-result',id:message.id,error:e.message},()=>{})}
  });
  const windowData=new DesktopWindowData(dataRoot);await windowData.init();
  const deadline=Date.now()+20000;let seen=false,announced=false,appTargetId,windowId,windowSession,normalBounds,lastBounds;
  const workArea=async()=>{
    // Screen coordinates and available dimensions are logical CSS pixels,
    // already adjusted for Windows scaling and the taskbar on this monitor.
    const {result}=await browserCall('Runtime.evaluate',{expression:'({left:screen.availLeft,top:screen.availTop,width:screen.availWidth,height:screen.availHeight})',returnByValue:true},windowSession);
    return result.value;
  };
  const rememberWindow=async()=>{
    const {bounds}=await browserCall('Browser.getWindowBounds',{windowId});
    if(!['normal','maximized'].includes(bounds.windowState)||JSON.stringify(bounds)===lastBounds)return;
    const area=await workArea();
    if(bounds.windowState==='normal')normalBounds={left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height};
    else normalBounds=desktopWindowBounds(area,normalBounds);
    await windowData.save(normalBounds,bounds.windowState==='maximized',area);
    lastBounds=JSON.stringify(bounds);
  };
  while(!stopping&&!exited(server)&&!browserDisconnected){
    let targetInfos;
    try{({targetInfos}=await browserCall('Target.getTargets'))}catch(e){if(seen&&browserDisconnected)break;throw e}
    const pages=targetInfos.filter(t=>t.type==='page');
    if(!appTargetId)appTargetId=pages.find(t=>t.url.startsWith(base))?.targetId;
    if(appTargetId)seen=true;
    if(seen&&!announced){
      ({windowId}=await browserCall('Browser.getWindowForTarget',{targetId:appTargetId}));
      ({sessionId:windowSession}=await browserCall('Target.attachToTarget',{targetId:appTargetId,flatten:true}));
      await browserCall('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
      // Position a remembered window first so screen reports its monitor. If
      // that monitor was removed, fit it to the nearest available work area.
      if(windowData.state){
        const saved=windowData.state;
        const placement=saved.maximized&&saved.area?desktopWindowBounds(saved.area,saved.normal):saved.normal;
        await browserCall('Browser.setWindowBounds',{windowId,bounds:placement});
        await delay(100);
      }
      normalBounds=desktopWindowBounds(await workArea(),windowData.state?.normal);
      await browserCall('Browser.setWindowBounds',{windowId,bounds:normalBounds});
      if(windowData.state?.maximized)await browserCall('Browser.setWindowBounds',{windowId,bounds:{windowState:'maximized'}});
      await rememberWindow().catch(e=>console.error('窗口设置保存失败：'+e.message));
      console.log('MediaScope 应用窗口已连接。');announced=true;
    }
    if(seen&&!pages.some(t=>t.targetId===appTargetId))break;
    if(announced)await rememberWindow().catch(e=>{if(!browserDisconnected)console.error('窗口设置保存失败：'+e.message)});
    if(!seen&&Date.now()>deadline)throw Error('应用页面未能打开');
    await delay(200);
  }
  if(!seen&&!stopping)throw Error('应用窗口未能启动。请关闭上次未退出的 MediaScope 窗口后重试。');
}
try {
  dataLease=await acquireDataLease(dataRoot);
  await removeOwned(dataRoot,'desktop-profile');
  await writeStartup({state:config.needsValidation?'checking':'ready',validation:config.validation});
  const env={...process.env,FFMPEG_PATH:config.paths.ffmpeg,FFPROBE_PATH:config.paths.ffprobe,
    MEDIASCOPE_STARTUP_RESULT:resultPath,MEDIASCOPE_DESKTOP:config.desktop?'1':'0'};
  // Bootstrap flags must never leak into the compatibility check's HTTP probe.
  env.MEDIASCOPE_DATA_LEASE=dataLease.token;
  server=spawn(process.execPath,[path.join(config.app,'server.mjs')],{cwd:config.app,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let log='';server.stderr.on('data',b=>process.stderr.write(b));
  base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('服务启动超时')),20000);
    server.once('error',e=>{clearTimeout(timer);reject(e)});
    server.once('exit',code=>{clearTimeout(timer);reject(Error(`服务启动失败 (${code})：${log}`))});
    server.stdout.on('data',b=>{log+=b;process.stdout.write(b);const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0])}});
  });
  const html=await(await fetch(base,{signal:AbortSignal.timeout(5000)})).text();
  token=html.match(/name="token" content="([^"]+)"/)?.[1];if(!token)throw Error('页面启动校验失败');
  console.log(`MediaScope 页面已就绪 (${Math.round(performance.now()-started)} ms)。`);
  if(config.needsValidation){
    validator=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(config.app,'scripts/validate-launch.ps1'),'-RequestPath',requestPath,'-ResultPath',resultPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    validator.stdout.on('data',b=>process.stdout.write(b));validator.stderr.on('data',b=>process.stderr.write(b));
    validator.on('error',async e=>{if(!stopping)await writeStartup({state:'error',message:e.message}).catch(()=>{})});
    validator.on('exit',async code=>{
      if(stopping)return;
      try{
        const result=JSON.parse((await readFile(resultPath,'utf8')).replace(/^\uFEFF/,''));
        if(result.state==='checking')await writeStartup({state:'error',message:`环境检查意外退出 (${code})，请重新检查或修复。`});
      }catch(e){if(!stopping)await writeStartup({state:'error',message:e.message}).catch(()=>{})}
    });
  }
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  if(config.desktop)await openWindow();
  else await new Promise(resolve=>server.once('exit',resolve));
  if(server.exitCode&& !stopping)process.exitCode=server.exitCode;
} catch(e){console.error(`[MediaScope] ${e.message}`);process.exitCode=1}
finally {await stop();if(process.connected)process.disconnect()}
