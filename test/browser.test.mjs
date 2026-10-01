import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {parsePortable} from '../public/portable.js';
import {requireFeature,supportedThemeModes} from './helpers/feature-policy.mjs';

const root=path.resolve('test-work/browser');
let browser,media,sequence=0;
before(async()=>{
  media=await makeMedia(path.join(root,'media'));
  try{browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})})}
  catch(error){throw Error('TEST_INFRA: could not launch the installed browser: '+error.message,{cause:error})}
});
after(async()=>{await browser?.close()});

function scenario(name,body){
  test(name,{timeout:90000},async t=>{
    const dir=path.join(root,String(++sequence).padStart(2,'0'));
    await mkdir(dir,{recursive:true});
    let app,context,page;const errors=[];
    try{
      app=await startServer(path.join(dir,'reports'));
      context=await browser.newContext({acceptDownloads:true,colorScheme:'dark',viewport:{width:1440,height:900}});
      page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto(app.base);
      await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
      await body({t,page,context,app,dir});
      assert.deepEqual(errors,[],'the real ES modules must initialize without browser exceptions');
    }catch(error){
      await page?.screenshot({path:path.join(dir,'failure.png'),fullPage:false}).catch(()=>{});
      await writeFile(path.join(dir,'browser-errors.json'),JSON.stringify(errors));
      throw error;
    }finally{try{await context?.close()}finally{await app?.stop()}}
  });
}
async function preview(page,file=media.source){
  await page.locator('#file').fill(file);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/probe')&&r.request().method()==='POST');
  await page.locator('#inspect').click();
  const report=await(await response).json();
  await page.locator('#inspect-details').getByRole('heading',{name:'轨道清单',exact:true}).waitFor();
  assert.equal(report.type,'inspect');return report;
}
async function runTask(page,app,button){
  const response=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator(button).click();const job=await(await response).json();
  const done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));
  await page.waitForFunction(()=>document.querySelector('#task-label')?.textContent==='任务完成');
  return {job:done,report:await app.request(`jobs/${job.id}/report`)};
}
async function download(page,button,file){
  const pending=page.waitForEvent('download');await page.locator(button).click();
  await(await pending).saveAs(file);return JSON.parse(await readFile(file,'utf8'));
}
async function analyze(page,app){await preview(page);return runTask(page,app,'#analyze')}

scenario('[startup] actual browser loads the complete app and the API rejects an absent session token',async({page,app})=>{
  assert.equal((await fetch(app.base+'/api/status')).status,403);
  assert.equal(await page.locator('#analyze').isEnabled(),false);
  for(const mode of ['inspect','compare','trial']){
    await page.locator(`[data-mode="${mode}"]`).click();
    assert.equal(await page.locator('#'+mode+'-panel').isVisible(),true);
  }
});

scenario('[analysis] actual multi-audio file, frame scan, GOP, SI/TI and export match the server report',async({page,app,dir})=>{
  const info=await preview(page);assert.deepEqual(info.raw,media.info.raw);
  assert.equal(info.raw.streams.length,3);
  await page.locator('#complexity').check();await page.locator('#siti-workers').selectOption('8');
  const {report}=await runTask(page,app,'#analyze');
  assert.equal(report.frames.length,12);assert.equal(report.tracks.filter(s=>s.type==='audio').length,2);
  assert.equal(report.content.points.length,report.frames.length);
  assert.equal(report.content.execution.requestedWorkers,8);
  assert.ok(report.commands.length>0&&report.commands.every(c=>c.exitCode===0));
  assert.ok(await page.locator('#frame-plot canvas').isVisible());
  assert.equal(await page.locator('#gop-index').inputValue(),'0');
  assert.equal(report.coding.gops.length,2);
  await page.locator('#gop-next').click();assert.equal(await page.locator('#gop-index').inputValue(),'1');
  assert.match(await page.locator('#gop-info').textContent(),/帧 6–11/);
  const plot=page.locator('#frame-plot'),span=async()=>Number(await plot.locator('[data-field="to"]').inputValue())-Number(await plot.locator('[data-field="from"]').inputValue());
  assert.equal(await span(),6);await plot.locator('[data-op="in"]').click();assert.ok(await span()<6);
  await plot.locator('[data-op="reset"]').click();assert.equal(await span(),12);
  await plot.locator('[data-field="from"]').fill('3');await plot.locator('[data-field="to"]').fill('7');
  await plot.locator('[data-op="apply"]').click();assert.equal(await span(),4);
  await page.getByText('逐帧列表 / CSV',{exact:true}).click();
  const csvDownload=page.waitForEvent('download');await page.locator('#csv').click();
  const csvFile=path.join(dir,'actual-frames.csv');await(await csvDownload).saveAs(csvFile);
  const csv=(await readFile(csvFile,'utf8')).trim().split('\n');assert.equal(csv.length,report.frames.length+1);
  assert.deepEqual(csv.slice(1),report.frames.map((f,i)=>[i,f.t,f.type,f.special??'',f.key?1:0,f.bytes,f.duration].join(',')));
  const exported=await download(page,'#inspect-export',path.join(dir,'actual-analysis.json'));
  assert.deepEqual(exported.results[0].report,report);
  assert.deepEqual(parsePortable(JSON.stringify(exported)),exported);
});

scenario('[comparison] user confirmation gates actual lossless identity and lossy candidate measurement',async({page,app,dir})=>{
  await page.locator('[data-mode="compare"]').click();
  await page.locator('#reference').fill(media.source);await page.locator('#candidate').fill(media.source);
  const denied=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator('#compare').click();const rejected=await waitForJob(app.request,(await(await denied).json()).id);
  assert.equal(rejected.status,'error');assert.match(rejected.message,/请确认/);
  const failure=JSON.parse(await readFile(path.join(dir,'reports',rejected.id,'failure.json'),'utf8'));
  assert.deepEqual(failure.commands,[],'no media processing before user confirmation');
  await page.locator('#confirm').check();
  const identical=await runTask(page,app,'#compare');
  assert.equal(identical.report.metrics.psnr.pooled,'Infinity');assert.equal(identical.report.metrics.ssim.pooled,1);
  await page.locator('#candidate').fill(media.candidate);
  const changed=await runTask(page,app,'#compare');
  assert.ok(Number.isFinite(changed.report.metrics.psnr.pooled));assert.ok(changed.report.metrics.ssim.pooled<1);
  assert.equal(changed.report.metrics.psnr.values.length,12);
});

scenario('[alignment] ordinal pairing requires its own explicit confirmation before a real comparison',async({page,app})=>{
  await page.locator('[data-mode="compare"]').click();
  await page.locator('#reference').fill(media.source);await page.locator('#candidate').fill(media.source);
  await page.locator('#confirm').check();await page.locator('#timing-mode').selectOption('ordinal-confirmed');
  assert.ok(await page.locator('#timing-confirm-row').isVisible());
  await page.locator('#compare').click();assert.equal((await app.request('status')).jobs.length,0);
  await page.locator('#timing-confirm').check();
  const {report}=await runTask(page,app,'#compare');
  assert.equal(report.alignment.pairing,'ordinal-confirmed');assert.equal(report.metrics.psnr.pooled,'Infinity');
});

scenario('[trial] real x264 trial encodes both CRFs, preserves frame metrics and cleans generated video',async({page,app})=>{
  await page.locator('[data-mode="trial"]').click();await page.locator('#trial-file').fill(media.source);
  await page.locator('#trial-duration').fill('1');await page.locator('#trial-encoder').selectOption('libx264');
  await page.locator('[name="trial-preset"][value="medium"]').uncheck();await page.locator('[name="trial-preset"][value="ultrafast"]').check();
  await page.locator('#trial-crfs').fill('20,38');
  const {report}=await runTask(page,app,'#trial');
  assert.deepEqual(report.rows.map(r=>r.crf),[20,38]);assert.deepEqual(report.experiment.retainedFiles,[]);
  assert.ok(report.rows.every(r=>r.metrics.psnr.values.length===report.experiment.actualFrames));
  assert.ok(report.rows[0].videoBytes>report.rows[1].videoBytes);
  assert.ok(await page.locator('#trial-frames canvas').isVisible());
});

scenario('[portable] real export/import restores measured frames without queuing or changing the report',async({page,app,dir})=>{
  const {report}=await analyze(page,app),file=path.join(dir,'round-trip.json');
  const saved=await download(page,'#inspect-export',file);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
  const before=(await app.request('status')).jobs.length;
  await page.locator('#import-report').setInputFiles(file);
  await page.locator('#inspect-details').getByRole('heading',{name:'帧结构与 GOP',exact:true}).waitFor();
  const restored=await download(page,'#inspect-export',path.join(dir,'restored.json'));
  assert.deepEqual(restored.results[0].report,report);assert.deepEqual(saved.results[0].report,report);
  assert.equal((await app.request('status')).jobs.length,before);
});

scenario('[portable-invalid] damaged real export is rejected and the currently visible measured report survives',async({page,app,dir})=>{
  const {report}=await analyze(page,app),file=path.join(dir,'original.json');
  const saved=await download(page,'#inspect-export',file);
  saved.schema='MediaScope/unsupported';const broken=path.join(dir,'deliberately-corrupted.json');
  await writeFile(broken,JSON.stringify(saved));await page.locator('#import-report').setInputFiles(broken);
  await page.waitForFunction(()=>document.querySelector('#task-label')?.textContent==='任务未完成');
  const after=await download(page,'#inspect-export',path.join(dir,'after-rejection.json'));
  assert.deepEqual(after.results[0].report,report);
});

scenario('[queue-plans] GUI captures actual inputs; plan export/import preserves order while remaining paused',async({page,app,dir})=>{
  for(const file of [media.source,media.candidate]){
    await page.locator('#file').fill(file);
    const queued=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
    await page.locator('#enqueue-analyze').click();await queued;
  }
  let state=await app.request('status');assert.equal(state.queueRunning,false);assert.equal(state.jobs.length,2);
  assert.deepEqual(state.jobs.map(j=>j.file),[media.source,media.candidate]);
  const plans=await app.request('plans');
  await page.locator('#export-result-scope').selectOption('none');await page.locator('#export-plan-scope').selectOption('all');
  const file=path.join(dir,'actual-plan.json'),exported=await download(page,'#export-portable',file);
  assert.deepEqual(exported.plans,plans.plans);assert.deepEqual(exported.results,[]);
  await page.locator('#import-results').uncheck();await page.locator('#import-plan-mode').selectOption('replace');
  await page.locator('#import-report').setInputFiles(file);
  await page.waitForFunction(()=>document.querySelector('#task-message')?.textContent.includes('已导入'));
  state=await app.request('status');assert.equal(state.queueRunning,false);
  const after=await app.request('plans');assert.deepEqual(after.plans.map(p=>p.input),plans.plans.map(p=>p.input));
});

scenario('[tab-retention] actual analysis canvas remains the same DOM node after completing a comparison',async({page,app})=>{
  await analyze(page,app);const canvas=await page.locator('#frame-plot canvas').elementHandle();
  await page.locator('[data-mode="compare"]').click();await page.locator('#reference').fill(media.source);
  await page.locator('#candidate').fill(media.source);await page.locator('#confirm').check();await runTask(page,app,'#compare');
  await page.locator('[data-mode="inspect"]').click();
  assert.equal(await canvas.evaluate(el=>el===document.querySelector('#frame-plot canvas')),true);
});

scenario('[sidebar] asynchronous report completion leaves every visible sidebar link with an existing target',async({t,page,app,dir})=>{
  if(!requireFeature(t,await page.locator('.floating-nav').count()>0,'report sidebar'))return;
  await analyze(page,app);
  // A bounded condition check, independent of the application's timer or generation duration.
  await page.waitForFunction(()=>{
    const links=[...document.querySelectorAll('.floating-nav a')];
    return links.some(a=>a.textContent.includes('帧结构'))&&links.every(a=>document.getElementById(a.hash.slice(1)));
  },undefined,{timeout:3000}).catch(e=>{if(e.name!=='TimeoutError')throw e});
  const links=await page.locator('.floating-nav a').evaluateAll(links=>links.map(a=>({label:a.textContent,hash:a.hash,targetExists:!!document.getElementById(a.hash.slice(1))})));
  await writeFile(path.join(dir,'sidebar-links.json'),JSON.stringify(links,null,2));
  assert.ok(links.some(a=>a.label.includes('帧结构'))&&links.every(a=>a.targetExists),JSON.stringify(links));
  const chapter=links.find(a=>a.label.includes('帧结构'));
  await page.locator('.floating-nav a').filter({hasText:'帧结构与 GOP'}).click();
  assert.equal(new URL(page.url()).hash,chapter.hash,'the first sidebar click navigates to the actual rendered heading');
});

scenario('[compact-task] an actual missing-file failure never reuses a hidden phase from the previous task',async({t,page,app})=>{
  if(!requireFeature(t,await page.locator('#toggle-island').count()>0,'compact task status'))return;
  await analyze(page,app);await page.locator('#toggle-island').click();
  await page.locator('#file').fill(path.join(root,'does-not-exist.mp4'));await page.locator('#inspect').click();
  await page.waitForFunction(()=>document.querySelector('#task-label')?.textContent==='任务未完成');
  await page.waitForFunction(()=>document.querySelector('#island-brief-text')?.textContent.includes('任务未完成'));
  assert.doesNotMatch(await page.locator('#island-brief-text').textContent(),/阶段\s*\d/);
});

scenario('[theme] theme toggle overrides the system, survives reload and returns to following the system',async({page})=>{
  const toggle=page.locator('#theme-toggle'),html=page.locator('html');
  const background=()=>page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.equal(await html.getAttribute('data-theme'),null);
  assert.equal(await page.locator('#theme-icon-system').isVisible(),true);
  const dark=await background();
  await toggle.click();
  assert.equal(await html.getAttribute('data-theme'),'light');
  assert.equal(await page.locator('#theme-icon-light').isVisible(),true);
  const light=await background();assert.notEqual(light,dark);
  await toggle.click();
  assert.equal(await html.getAttribute('data-theme'),'dark');
  assert.equal(await page.locator('#theme-icon-dark').isVisible(),true);
  await page.emulateMedia({colorScheme:'light'});
  assert.equal(await background(),dark,'explicit dark mode overrides a light system');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
  assert.equal(await html.getAttribute('data-theme'),'dark');
  assert.equal(await page.locator('#theme-icon-dark').isVisible(),true);
  assert.equal(await background(),dark);
  await toggle.click();
  assert.equal(await html.getAttribute('data-theme'),null);
  assert.equal(await page.locator('#theme-icon-system').isVisible(),true);
  assert.equal(await background(),light);
  await page.emulateMedia({colorScheme:'dark'});
  assert.equal(await background(),dark,'system mode responds to an operating-system theme change');
});

scenario('[theme] actual report text and enabled actions remain readable in each advertised theme',async({t,page,app,dir})=>{
  const supported=await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme);
  const modes=supportedThemeModes(supported);
  if(!requireFeature(t,modes.length>0&&modes.every(mode=>supported.split(/\s+/).includes(mode)),'declared light and dark themes'))return;
  await analyze(page,app);
  for(const colorScheme of modes){
    await page.emulateMedia({colorScheme});
    // Wait for actual CSS transitions, otherwise a light-theme check may read the preceding dark colors.
    await page.evaluate(async()=>{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const controls=[...document.querySelectorAll('#inspect-panel button, #frame-detail, #inspect-details pre, #inspect-details .notice')];
      controls.forEach(el=>getComputedStyle(el).color);
      await Promise.all(controls.flatMap(el=>el.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
    });
    const colors=await page.locator('#inspect-panel button:enabled, #frame-detail, #inspect-details pre, #inspect-details .notice').evaluateAll(elements=>elements.filter(el=>el.getClientRects().length>0).flatMap(el=>{
      // Check every gradient stop behind translucent panels, rather than treating
      // a transparent backgroundColor as the actual background of the text.
      const rgba=value=>{
        if(!/^rgba?\(/.test(value))throw Error('Unsupported contrast color: '+value);
        return value.match(/[\d.]+/g).map(Number);
      };
      const over=(color,background)=>background.map((v,i)=>color[i]*(color[3]??1)+v*(1-(color[3]??1)));
      const chain=[];for(let parent=el;parent;parent=parent.parentElement)chain.push(getComputedStyle(parent));
      let backgrounds=[[255,255,255]];
      for(const css of chain.reverse()){
        backgrounds=backgrounds.map(background=>over(rgba(css.backgroundColor),background));
        if(css.backgroundImage!=='none'){
          if(!css.backgroundImage.startsWith('linear-gradient('))throw Error('Unsupported contrast background: '+css.backgroundImage);
          const stops=css.backgroundImage.match(/rgba?\([^)]*\)/g);
          if(!stops?.length)throw Error('Gradient has no measurable sRGB stops');
          backgrounds=backgrounds.flatMap(background=>stops.map(stop=>over(rgba(stop),background)));
        }
      }
      const foreground=rgba(getComputedStyle(el).color);
      return backgrounds.map((background,i)=>({label:(el.id||el.className||el.textContent.trim())+' / background '+i,foreground:`rgb(${over(foreground,background).join(', ')})`,background:`rgb(${background.join(', ')})`}));
    }));
    assert.ok(colors.length>0);
    await writeFile(path.join(dir,'theme-'+colorScheme+'.json'),JSON.stringify({samples:colors},null,2));
    const lum=s=>s.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
    for(const c of colors){const a=lum(c.foreground),b=lum(c.background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert.ok(ratio>=4.5,`${colorScheme} ${c.label}: foreground ${c.foreground}, background ${c.background}, contrast ${ratio.toFixed(2)}`)}
  }
});
