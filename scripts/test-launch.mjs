import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [app,home,media]=process.argv.slice(2);
// PowerShell 7's host injects its own PSModulePath. Let Windows PowerShell build
// its normal module path, as it does when launched by Explorer/start.cmd.
const env={...process.env,PORT:'0'};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(app,'scripts/manage.ps1'),'-Action','Launch','-InstallRoot',home,'-NonInteractive'],{windowsHide:true,env});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  let match;
  for(let i=0;i<900;i++){match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)break;if(child.exitCode!==null)throw Error(output);await delay(100)}
  assert.ok(match,'Launcher did not start HTTP server: '+output);
  const base=match[0], html=await(await fetch(base)).text(), token=html.match(/name="token" content="([^"]+)"/)[1];
  const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'content-type':'application/json','x-mediascope-token':token},body:JSON.stringify({type:'inspect',file:media})});
  assert.equal(response.status,202);const job=await response.json();
  let result;
  for(let i=0;i<100;i++){result=await(await fetch(base+'/api/jobs/'+job.id,{headers:{'x-mediascope-token':token}})).json();if(!['queued','running'].includes(result.status))break;await delay(100)}
  assert.equal(result.status,'done',result.message);
  assert.ok(existsSync(path.join(home,'data',job.id,'report.json')),'Report must be outside the application directory');
  const state=JSON.parse(readFileSync(path.join(home,'current.json'),'utf8').replace(/^\uFEFF/,''));
  assert.ok(!existsSync(path.join(home,'apps',state.current.version,'.mediascope')));
  console.log('PASS: packaged Launch starts HTTP and writes a real report only to the separate data directory');
} finally {
  if(child.exitCode===null)execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
}
