import {spawn} from 'node:child_process';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function startServer(dataDirectory,{port=0,attempt=1,env={}}={}) {
  await mkdir(dataDirectory,{recursive:true});
  const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const child=spawn(process.execPath,[path.join(app,'server.mjs')],{cwd:app,windowsHide:true,env:{...process.env,...env,PORT:String(port),MEDIASCOPE_DATA_DIR:dataDirectory}});
  let log='',logFile='server.log',token;child.stdout.on('data',value=>{log+=value});child.stderr.on('data',value=>{log+=value});
  const stop=async()=>{
    if(!token&&child.exitCode===null&&child.signalCode===null)child.kill();
    if(token&&child.exitCode===null&&child.signalCode===null)await fetch(base+'/api/desktop/shutdown',{method:'POST',headers:{'x-mediascope-token':token},signal:AbortSignal.timeout(3000)}).catch(()=>{});
    if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve()},12000);child.once('exit',()=>{clearTimeout(timer);resolve()})});
    await writeFile(path.join(dataDirectory,logFile),log);
  };
  const base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('TEST_INFRA: server did not advertise a random port within 30 seconds')),30000);
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Application exited during startup (${code}): ${log}`))});
    child.stdout.on('data',()=>{const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0])}});
  }).catch(async e=>{await stop();throw Error('TEST_INFRA: application server startup failed',{cause:e})});
  try {const html=await(await fetch(base)).text();token=html.match(/name="token" content="([^"]+)"/)?.[1];if(!token)throw Error('Application HTTP response did not contain its session token')}
  catch(e){
    // PORT=0 can select a port blocked by Fetch: https://fetch.spec.whatwg.org/#port-blocking.
    // Retry only this confirmed setup condition, before any product assertion; retain every rejected startup.
    if(e.cause?.message==='bad port'){
      logFile=`server-rejected-port-${attempt}.log`;await stop();
      if(attempt>=10)throw Error('TEST_INFRA: no Fetch-compatible random HTTP port after 10 starts',{cause:e});
      return startServer(dataDirectory,{attempt:attempt+1,env});
    }
    await stop();throw Error('TEST_INFRA: application HTTP/session startup failed',{cause:e});
  }
  const request=async(url,method='GET',input)=>{
    const response=await fetch(base+'/api/'+url,{method,headers:{'x-mediascope-token':token,'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
    const data=await response.json();if(!response.ok)throw Error(`API ${method} ${url}: ${response.status} ${JSON.stringify(data)}`);return data;
  };
  return {base,token,request,stop};
}
export async function waitForJob(request,id) {
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){const job=await request('jobs/'+id);if(!['running','queued'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,50))}
  throw Error(`Job ${id} did not finish within 60 seconds`);
}
