import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startServer} from '../../helpers/server.mjs';
import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {recordObservation} from '../../helpers/observations.mjs';
const test=projectTest(import.meta.url);
const driver=fileURLToPath(new URL('../../helpers/native-dialog.ps1',import.meta.url));
async function drive(pid,action,value,button=1){
 const output=workPath('dialog-'+Math.random().toString(16).slice(2)+'.json');
 const args=['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',driver,'-RootPid',String(pid),'-Action',action,'-Button',String(button),'-OutputPath',output,...(value?['-Value',value]:[])];
 const result=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',args,{windowsHide:true});let text='';const timer=setTimeout(()=>{child.kill();reject(Error('TEST_INFRA: native dialog driver timed out'))},35000);child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({code,text})})});
 assert.equal(result.code,0,result.text);
 const evidence=JSON.parse(await readFile(output,'utf8'));assert.equal(evidence.owned,true);assert.equal(evidence.rootPid,pid);assert.ok(evidence.pid>0);
 await recordObservation('native.dialog',{result:evidence});return evidence;
}
test('native media picker selects Unicode paths, cancels, rejects reentrance and opens again', {timeout:120000},async t=>{
 await mkdir(workRoot,{recursive:true});const file=workPath('媒体 [原件] control.y4m');await writeFile(file,'YUV4MPEG2 W4 H4 F1:1 Ip A1:1 Cmono\nFRAME\n'+'x'.repeat(16));
 const app=await startServer(workPath('file-data'));t.after(()=>app.stop());
 const first=app.request('select-file','POST',{});const ready=await drive(app.pid,'inspect');
 assert.match(ready.title,/媒体|media/i);
 await assert.rejects(app.request('select-file','POST',{}),/400/);
 await drive(app.pid,'file',file);assert.equal(path.resolve((await first).file),file);
 const cancelled=app.request('select-file','POST',{});await drive(app.pid,'cancel');assert.equal((await cancelled).file,null);
 const reopen=app.request('select-file','POST',{});await drive(app.pid,'file',file);assert.equal(path.resolve((await reopen).file),file);
});
test('native directory picker returns only the selected owned folder and cancellation returns null',{timeout:90000},async t=>{
 const folder=workPath('目录 [保存]');await mkdir(folder,{recursive:true});
 const app=await startServer(workPath('folder-data'));t.after(()=>app.stop());
 const accepted=app.request('select-directory','POST',{});await drive(app.pid,'folder',folder);assert.equal(path.resolve((await accepted).directory),folder);
 const cancelled=app.request('select-directory','POST',{});await drive(app.pid,'cancel');assert.equal((await cancelled).directory,null);
});
test('native environment component picker and Yes No Cancel prompts return actual Windows choices',{timeout:240000},async()=>{
 await mkdir(workRoot,{recursive:true});
 const wrapper=fileURLToPath(new URL('./tools/native-environment.ps1',import.meta.url));
 async function actual(operation,action,value,button){
  const output=workPath('environment-'+Math.random().toString(16).slice(2)+'.json');
  const child=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',wrapper,'-App',process.cwd(),'-Operation',operation,'-OutputPath',output,'-Work',workPath('installation')],{windowsHide:true});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  try{await drive(child.pid,action,value,button);if(operation==='install-location'&&action==='folder')await drive(child.pid,'command',undefined,button);const code=await done;const result=JSON.parse(await readFile(output,'utf8'));await recordObservation('native.environment',{operation,code,result});return {code,...result}}
  finally{if(child.exitCode===null)child.kill()}
 }
 const selected=await actual('picker','file',process.execPath);assert.equal(selected.code,0);assert.equal(path.resolve(selected.value),process.execPath);
 const cancelled=await actual('picker','cancel');assert.equal(cancelled.code,1);assert.match(cancelled.error,/cancelled/);
 for(const [button,value]of [[6,'Yes'],[7,'No'],[2,'Cancel']]){const result=await actual('prompt','command',undefined,button);assert.equal(result.code,0);assert.equal(result.value,value)}
 const install=workPath('installation/choice');await mkdir(install,{recursive:true});
 const accepted=await actual('install-location','folder',install,1);assert.equal(accepted.code,0);assert.equal(path.resolve(accepted.value),install);
 const rejected=await actual('install-location','folder',install,2);assert.equal(rejected.code,1);assert.match(rejected.error,/cancelled/);
 const cancelledInstall=await actual('install-location','cancel');assert.equal(cancelledInstall.code,1);assert.match(cancelledInstall.error,/cancelled/);
});
test('browser file and directory controls invoke owned native dialogs and preserve cancelled selections',{timeout:180000},async t=>{
 const {chromium}=await import('playwright-core');const browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})});t.after(()=>browser.close());
 const app=await startServer(workPath('browser-data'));t.after(()=>app.stop());const page=await browser.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});
 const file=workPath('browser-control.y4m'),folder=workPath('browser-directory');await mkdir(folder,{recursive:true});await writeFile(file,'YUV4MPEG2 W4 H4 F1:1 Ip A1:1 Cmono\nFRAME\n'+'x'.repeat(16));await page.goto(app.base);await page.waitForFunction(()=>document.querySelector('#environment').textContent.includes('ffmpeg version'));
 for(const [mode,id]of [['inspect','file'],['compare','reference'],['compare','candidate'],['trial','trial-file']]){
  await page.locator(`[data-mode="${mode}"]`).click();const button=page.locator(`.file-picker[data-target="${id}"]`);await button.click();await drive(app.pid,'file',file);await page.waitForFunction(id=>document.getElementById(id).value.endsWith('browser-control.y4m'),id);assert.equal(await page.locator('#'+id).inputValue(),file);
 }
 const keyboard=workPath('keyboard-control.y4m');await writeFile(keyboard,'YUV4MPEG2 W4 H4 F1:1 Ip A1:1 Cmono\nFRAME\n'+'y'.repeat(16));await page.locator('[data-mode="inspect"]').click();const preview=page.waitForResponse(r=>r.url()===app.base+'/api/probe'&&r.request().postDataJSON()?.file===keyboard);await page.locator('#file').fill(keyboard);await page.locator('#file').press('Enter');assert.equal((await preview).status(),200);await page.waitForFunction(()=>!document.querySelector('#stream').disabled);
 await page.locator('[data-mode="trial"]').click();
 await page.locator('#trial-keep').check();await page.locator('#trial-save-picker').click();await drive(app.pid,'folder',folder);await page.waitForFunction(()=>document.querySelector('#trial-save-directory').value.length>0);assert.equal(path.resolve(await page.locator('#trial-save-directory').inputValue()),folder);
 await page.locator('#trial-save-picker').click();await drive(app.pid,'cancel');await page.waitForFunction(()=>!document.querySelector('#trial-save-picker').disabled);assert.equal(path.resolve(await page.locator('#trial-save-directory').inputValue()),folder);
 await recordObservation('native.browser',{browser:browser.version(),result:{file,folder,inputs:await page.locator('#file,#reference,#candidate,#trial-file,#trial-save-directory').evaluateAll(es=>es.map(e=>({id:e.id,value:e.value})))}});
 await recordObservation('browser.coverage',{result:(await page.coverage.stopJSCoverage()).filter(s=>s.url.startsWith(app.base+'/')).map(s=>({file:'public'+new URL(s.url).pathname,functions:s.functions}))});
});
