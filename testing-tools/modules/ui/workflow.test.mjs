import {before,after} from 'node:test';
import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {chromium} from 'playwright-core';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workPath} from '../../helpers/workspace.mjs';
import {createBrowserScenario} from '../../helpers/browser-harness.mjs';
import {engineControl,av1Control} from '../../helpers/encoded-controls.mjs';
import {waitForJob} from '../../helpers/server.mjs';
import {FF,run} from '../../helpers/subject.mjs';
import {makePortable,parsePortable} from '../../../public/portable.js';
const test=projectTest(import.meta.url),root=workPath('flows');let browser,sourcePromise;
const source=()=>sourcePromise??=engineControl(path.join(root,'media'));
before(async()=>{await mkdir(root,{recursive:true});browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})});});
after(async()=>browser?.close());
const scenario=createBrowserScenario({test,root,browser:()=>browser});
async function completed(app,input){const job=await app.request('jobs','POST',input),done=await waitForJob(app.request,job.id);assert.equal(done.status,'done',done.message);return {id:job.id,report:await app.request('jobs/'+job.id+'/report')};}
async function importMeasured(page,dir,report,name='measured.json'){
 const file=path.join(dir,name);await writeFile(file,JSON.stringify(makePortable({results:[{entryId:name,report}],applicationVersion:'actual-test-subject'})));
 await page.locator('#import-report').setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#import-report').value==='');return file;
}
async function openSections(page){
 const details=page.locator('#inspect-details details');for(const d of await details.all())if(!await d.evaluate(e=>e.open))await d.locator(':scope > summary').click();
}
async function exported(page,dir,name,button='#export-portable'){
 const pending=page.waitForEvent('download');await page.locator(button).click();const download=await pending,file=path.join(dir,name);await download.saveAs(file);return {name:download.suggestedFilename(),value:parsePortable(await readFile(file,'utf8')),file};
}
scenario('local data controls refresh actual usage, preserve originals and require confirmation before clearing results',async({page,app})=>{
 const file=await source(),original=createHash('sha256').update(await readFile(file)).digest('hex'),done=await completed(app,{type:'inspect',file});
 await page.locator(`[data-result-open="${done.id}"]`).waitFor();await page.locator('#local-data-panel > summary').click();
 await page.waitForFunction(()=>/本次结果 1 项/.test(document.querySelector('#local-data-usage').textContent));
 const refresh=page.waitForResponse(r=>r.url()===app.base+'/api/local-data');await page.locator('#local-data-refresh').click();assert.equal((await refresh).status(),200);
 const cache=page.waitForResponse(r=>r.url()===app.base+'/api/local-data/clean');await page.locator('#local-cache-clear').click();const response=await cache;assert.equal(response.status(),200);assert.deepEqual(response.request().postDataJSON(),{category:'cache'});
 assert.equal((await app.request('local-data')).count,1);
 const dismiss=page.waitForEvent('dialog'),cancelClick=page.locator('#local-data-clear').click();await(await dismiss).dismiss();await cancelClick;assert.equal((await app.request('local-data')).count,1);
 const accept=page.waitForEvent('dialog'),acceptClick=page.locator('#local-data-clear').click();await(await accept).accept();await acceptClick;
 await page.waitForFunction(()=>/本次结果 0 项/.test(document.querySelector('#local-data-usage').textContent));assert.equal(await page.locator('#result-list .queue-item').count(),0);
 assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),original);
});
scenario('selected result and plan exports contain only checked entries and import through the file chooser',async({page,app,dir})=>{
 const file=await source(),done=[];for(let i=0;i<2;i++)done.push(await completed(app,{type:'inspect',file}));
 await app.request('queue','POST',{action:'pause'});const pending=[];for(let i=0;i<2;i++)pending.push(await app.request('jobs','POST',{type:'inspect',file,enqueue:true}));
 await page.locator(`[data-plan-select="${pending[0].id}"]`).waitFor();await page.locator(`[data-result-select="${done[1].id}"]`).check();await page.locator(`[data-plan-select="${pending[0].id}"]`).check();
 await page.locator('#export-result-scope').selectOption('selected');await page.locator('#export-plan-scope').selectOption('selected');
 // Filename time is controlled; real report values and backend clocks are not changed.
 await page.clock.setFixedTime(new Date('2026-01-01T00:00:00Z'));
 const first=await exported(page,dir,'selected.json'),second=await exported(page,dir,'selected-again.json');
 assert.deepEqual(first.value.results.map(x=>x.entryId),[done[1].id]);assert.deepEqual(first.value.plans.map(x=>x.entryId),[pending[0].id]);assert.deepEqual(first.value.results[0].report,done[1].report);assert.equal(first.name,second.name);assert.deepEqual(first.value,second.value);
 await page.locator(`[data-result-select="${done[1].id}"]`).uncheck();await page.locator(`[data-plan-select="${pending[0].id}"]`).uncheck();await page.locator('#export-portable').click();await page.waitForFunction(()=>document.querySelector('#task-message').textContent.includes('没有可导出'));
 await page.locator('#import-plans').uncheck();const chooser=page.waitForEvent('filechooser');await page.locator('#import-button').click();await(await chooser).setFiles(first.file);await page.waitForFunction(()=>document.querySelector('#import-report').value==='');
 assert.ok((await app.request('status')).jobs.filter(x=>pending.some(p=>p.id===x.id)).every(x=>x.status==='queued'));
});
scenario('floating task view expands, drags and snaps without changing a real validation error or starting work',async({page,app})=>{
 await page.locator('[data-mode="compare"]').click();await page.locator('#compare').click();const task=page.locator('#task');await task.waitFor();const message=await page.locator('#task-message').textContent();assert.ok(message.length>0);
 await page.locator('#toggle-island').click();assert.equal(await task.evaluate(e=>e.classList.contains('island')),true);
 await task.locator('.island-header').click();assert.equal(await task.evaluate(e=>e.classList.contains('expanded')),true);
 await page.locator('#toggle-snap').click();assert.equal(await page.locator('#toggle-snap').evaluate(e=>e.classList.contains('active')),false);
 const before=await task.boundingBox(),header=await task.locator('.island-header').boundingBox();await page.mouse.move(header.x+40,header.y+12);await page.mouse.down();await page.mouse.move(header.x-100,header.y-55,{steps:8});await page.mouse.up();
 const after=await task.boundingBox();assert.ok(Math.abs(after.x-before.x)>5);assert.equal(await task.evaluate(e=>e.style.position),'fixed');
 await page.locator('#toggle-snap').click();await page.waitForFunction(()=>{const r=document.querySelector('#task').getBoundingClientRect();return Math.min(Math.abs(r.left-20),Math.abs(document.documentElement.clientWidth-r.right-20))<1&&r.top>=19;});
 await page.locator('#toggle-island').click();assert.equal(await task.evaluate(e=>e.classList.contains('task-banner')),true);assert.equal(await task.evaluate(e=>e.style.left),'');assert.equal(await page.locator('#task-message').textContent(),message);assert.equal((await app.request('status')).jobs.length,0);
});
scenario('frame and audio packet pagers, previous GOP and point inspection retain the measured record',async({page,app,dir})=>{
 const file=path.join(dir,'packet-control.mkv');await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=40:duration=3','-f','lavfi','-i','sine=sample_rate=48000:duration=3','-map','0:v','-map','1:a','-c:v','libx264','-g','10','-keyint_min','10','-sc_threshold','0','-c:a','pcm_s16le',file]);
 const {report}=await completed(app,{type:'analyze',file,frameAnalysis:true,bitrate:true,complexity:false});await importMeasured(page,dir,report);await openSections(page);
 assert.ok(report.frames.length>100);await page.locator('#next').click();assert.equal(await page.locator('#frames tbody tr').first().locator('td').first().textContent(),'100');await page.locator('#prev').click();assert.equal(await page.locator('#frames tbody tr').first().locator('td').first().textContent(),'0');
 assert.ok(report.coding.gops.length>1);await page.locator('#gop-next').click();assert.equal(await page.locator('#gop-index').inputValue(),'0');await page.locator('#gop-next').click();assert.equal(await page.locator('#gop-index').inputValue(),'1');await page.locator('#gop-prev').click();assert.equal(await page.locator('#gop-index').inputValue(),'0');
 const track=report.tracks.find(t=>t.type==='audio'),id='audio-packets-'+track.index;assert.ok(track.packetDistribution.count>100);await page.locator('#'+id+'-next').click();assert.equal(await page.locator('#'+id+'-list tbody tr').first().locator('td').first().textContent(),'100');await page.locator('#'+id+'-prev').click();assert.equal(await page.locator('#'+id+'-list tbody tr').first().locator('td').first().textContent(),'0');
 const canvas=page.locator('#'+id+' canvas');await canvas.hover({position:{x:100,y:50}});assert.ok((await page.locator('#'+id+' .chart-label dt').allTextContents()).includes('包序号'));await canvas.click({position:{x:100,y:50}});assert.ok((await page.locator('#'+id+'-detail tbody tr').count())>0);
 const csv=[];for(let i=0;i<2;i++){const waiting=page.waitForEvent('download');await page.locator('#csv').click();const download=await waiting;assert.equal(download.suggestedFilename(),i?'frames-2.csv':'frames.csv');const file=path.join(dir,'frames-'+i+'.csv');await download.saveAs(file);csv.push(await readFile(file,'utf8'));}assert.equal(csv[0],csv[1]);assert.equal(csv[0].trim().split('\n').length,report.frames.length+1);
 const saved=await exported(page,dir,'packet-preserved.json','#inspect-export');assert.deepEqual(saved.value.results[0].report,report);
});
scenario('actual AV1 event navigation and a legacy optional GOP view preserve frames and event evidence',async({page,app,dir})=>{
 const file=await av1Control(dir),{report}=await completed(app,{type:'analyze',file,frameAnalysis:true,bitrate:false,complexity:false});assert.equal(report.coding.codec,'av1');assert.ok(report.coding.events.length>1);
 await importMeasured(page,dir,report);await openSections(page);const last=report.coding.events.at(-1);await page.locator('#av1-index').fill(String(last.id));await page.locator('#av1-index').press('Tab');assert.ok((await page.locator('#av1-detail').textContent()).includes(last.id+' / '+last.packet));
 const canvas=page.locator('#av1-plot canvas');await canvas.hover({position:{x:100,y:50}});assert.ok((await page.locator('#av1-plot .chart-label dt').allTextContents()).includes('编码事件'));await canvas.click({position:{x:100,y:50}});assert.ok(Number(await page.locator('#av1-index').inputValue())<report.coding.events.length);
 const legacy=structuredClone(report);delete legacy.coding.gops;await importMeasured(page,dir,legacy,'optional-old-gops.json');await openSections(page);assert.ok(await page.locator('#gop-count').count()||await page.locator('#gop-index').count());
 const saved=await exported(page,dir,'legacy-preserved.json','#inspect-export');assert.deepEqual(saved.value.results[0].report,legacy);
});
scenario('GUI chroma assumptions require confirmation and preserve unknown source declarations in real metrics',async({page,app,dir})=>{
 const file=path.join(dir,'undeclared.mkv');await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=4:duration=1','-c:v','ffv1','-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709',file]);
 await page.locator('[data-mode="compare"]').click();await page.locator('#reference').fill(file);await page.locator('#candidate').fill(file);await page.locator('#confirm').check();await page.locator('#chroma-confirm-mode').check();assert.equal(await page.locator('#chroma-assumption-controls').isVisible(),true);await page.locator('#reference-chroma').selectOption('left');await page.locator('#candidate-chroma').selectOption('left');
 await page.locator('#compare').click();await page.waitForFunction(()=>document.querySelector('#task-message').textContent.includes('色度'));assert.equal((await app.request('status')).jobs.length,0);
 await page.locator('#chroma-confirm').check();const response=page.waitForResponse(r=>r.url()===app.base+'/api/jobs'&&r.request().method()==='POST');await page.locator('#compare').click();const {id}=await(await response).json(),done=await waitForJob(app.request,id);assert.equal(done.status,'done',done.message);const report=await app.request('jobs/'+id+'/report');assert.equal(report.metrics.psnr.pooled,'Infinity');assert.deepEqual(report.chromaAssumptions.map(x=>[x.side,x.declared,x.assumed]),[['reference',null,'left'],['candidate',null,'left']]);
 await page.waitForFunction(()=>!document.querySelector('#compare-result').classList.contains('hidden'));assert.match(await page.locator('#compare-details').innerText(),/用户确认/);const saved=await exported(page,dir,'assumptions.json','#compare-export');assert.deepEqual(saved.value.results[0].report,report);
});
scenario('desktop queued work triggers a real unload confirmation and dismissing it preserves the queue',async({page,app})=>{
 const file=await source(),job=await app.request('jobs','POST',{type:'inspect',file,enqueue:true});await page.locator(`[data-plan-select="${job.id}"]`).waitFor();await page.locator('[data-mode="inspect"]').click();
 let prompt=page.waitForEvent('dialog'),navigation=page.reload().catch(e=>e);const dismissed=await prompt;assert.equal(dismissed.type(),'beforeunload');await dismissed.dismiss();await navigation;assert.equal((await app.request('jobs/'+job.id)).status,'queued');
 prompt=page.waitForEvent('dialog');navigation=page.reload();const accepted=await prompt;assert.equal(accepted.type(),'beforeunload');await accepted.accept();await navigation;await page.waitForFunction(()=>document.querySelector('#environment').textContent.includes('ffmpeg version'));assert.equal((await app.request('jobs/'+job.id)).status,'queued');
},{serverEnv:{MEDIASCOPE_DESKTOP:'1'}});
scenario('startup transport failures remain visible and real polling restores readiness',async({page,app})=>{
 let failed=false;await page.route('**/api/status',async route=>{if(!failed){failed=true;await route.abort('failed');}else await route.continue();});await page.reload();await page.waitForFunction(()=>document.querySelector('#task-message').textContent.includes('fetch'));assert.equal(failed,true);await page.waitForFunction(()=>document.querySelector('#environment').textContent.includes('ffmpeg version'));assert.equal((await app.request('status')).startup.state,'ready');
});
