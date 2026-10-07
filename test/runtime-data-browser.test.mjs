import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {startServer,waitForJob} from './helpers/server.mjs';
import {FF,run} from '../engine.mjs';

test('[runtime-data] real browser restores recent reports and preferences, exports before clearing and imports saved results', {timeout:60000},async()=>{
  const work=path.resolve('test-work/runtime-data');await mkdir(work,{recursive:true});
  const dir=await mkdtemp(path.join(work,'browser-')),media=path.join(dir,'source.mp4'),data=path.join(dir,'reports');
  await run(FF,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=4:duration=1','-c:v','libx264',media]);
  const browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})});
  let app,context,page;const errors=[];
  const open=async()=>{
    context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}});
    page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(app.base);
    await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
  };
  try{
    app=await startServer(data);await open();
    const job=await app.request('jobs','POST',{type:'inspect',file:media});assert.equal((await waitForJob(app.request,job.id)).status,'done');
    await page.locator('[data-result-open="'+job.id+'"]').waitFor();
    const themeSaved=page.waitForResponse(r=>r.url().endsWith('/api/local-data/settings'));
    await page.locator('#theme-toggle').click();await themeSaved;await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    await context.close();context=null;await app.stop();app=await startServer(data);await open();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    await page.locator('[data-result-open="'+job.id+'"]').click();
    await page.locator('#inspect-details').getByRole('heading',{name:'文件基本信息',exact:true}).waitFor();
    const downloadEvent=page.waitForEvent('download');await page.locator('#export-portable').click();
    const download=await downloadEvent,exported=path.join(dir,'exported.json');await download.saveAs(exported);
    const bundle=JSON.parse(await readFile(exported,'utf8'));assert.equal(bundle.results.length,1);assert.equal(bundle.results[0].report.file,media);
    await writeFile(path.join(work,'measured-browser-export.json'),JSON.stringify(bundle));
    await page.locator('#local-data-panel summary').click();await page.locator('#local-data-usage').filter({hasText:'近期记录 1 / 10'}).waitFor();
    assert.equal((await app.request('local-data')).maxBytes,100000000);
    assert.match(await page.locator('#local-data-panel').innerText(),/合计不超过 100 MB/);
    const queued=await app.request('jobs','POST',{type:'inspect',file:media,enqueue:true});
    page.once('dialog',dialog=>dialog.accept());await page.locator('#local-data-clear').click();
    await page.locator('#local-data-usage').filter({hasText:'近期记录 0 / 10'}).waitFor();assert.equal((await app.request('jobs/'+queued.id)).status,'queued');
    await page.locator('#import-report').setInputFiles(exported);await page.locator('[data-result-open^="imported-"]').waitFor();
    await page.locator('#clear-on-exit').check();
    await page.waitForFunction(async()=>{const token=document.querySelector('meta[name=token]').content;return (await(await fetch('/api/status',{headers:{'x-mediascope-token':token}})).json()).settings.clearOnExit});
    assert.deepEqual(errors,[]);
  }catch(e){await page?.screenshot({path:path.join(dir,'failure.png'),fullPage:true}).catch(()=>{});throw e}
  finally{await context?.close();await app?.stop();await browser.close()}
});
