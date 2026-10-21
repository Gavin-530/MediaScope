import {readFixture} from './helpers/fixtures.mjs';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {parsePortable,makePortable,reportFromPortable,portableFilename} from '../public/portable.js';
import {requireFeature,supportedThemeModes} from './helpers/feature-policy.mjs';
import {propertyValue} from '../public/properties.js';
import {probe,FF,run} from '../engine.mjs';
import {metadataSummary} from '../analysis.mjs';
import {legacyFrameSample} from './helpers/basic-properties.mjs';
import {formatBytes, byteEvidence, quantityScale} from '../public/units.js';
import {bitrateView} from '../public/bitrate-model.js';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {sitiSceneSummary,SITI_COMPAT_PROFILE} from '../public/siti.js';
import {trialBdRate,rowLabel} from '../public/trial-model.js';

const root=path.resolve('.build/testing-work/browser');
let browser,media,sequence=0;
before(async()=>{
  media=await makeMedia(path.join(root,'media'));
  try{browser=await chromium.launch({headless:true,...(process.env.MEDIASCOPE_BROWSER_PATH?{executablePath:process.env.MEDIASCOPE_BROWSER_PATH}:{channel:'msedge'})})}
  catch(error){throw Error('TEST_INFRA: could not launch the installed browser: '+error.message,{cause:error})}
});
after(async()=>{await browser?.close()});

function scenario(name,body){
  test(name,{timeout:90000},async t=>{
    await mkdir(root,{recursive:true});
    const dir=await mkdtemp(path.join(root,String(++sequence).padStart(2,'0')+'-'));
    let app,context,page;const errors=[];
    try{
      app=await startServer(path.join(dir,'reports'));
      context=await browser.newContext({acceptDownloads:true,colorScheme:'dark',timezoneId:'America/Los_Angeles',viewport:{width:1440,height:900}});
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
async function saveImportFixture(file,value){
  const content=value.format?{createdAt:value.createdAt,results:value.results,plans:value.plans,applicationVersion:value.producer.applicationVersion}:{results:[{entryId:'fixture',report:value}],applicationVersion:value.producer.applicationVersion};
  await writeFile(file,JSON.stringify(makePortable(content)));
}
async function importReport(page,file){
  await page.locator('#import-report').setInputFiles(file);
  // The async import handler clears the input only after rendering and polling finish.
  await page.waitForFunction(()=>document.querySelector('#import-report').value==='');
}
async function preview(page,file=media.source){
  const response=page.waitForResponse(r=>r.url().endsWith('/api/probe')&&r.request().method()==='POST');
  await page.locator('#file').fill(file);
  const report=reportFromPortable(await(await response).json());
  await page.waitForFunction(()=>!document.querySelector('#stream').disabled);
  await page.locator('#inspect-details').getByRole('heading',{name:'文件基本信息',exact:true}).waitFor();
  assert.equal(report.type,'inspect');return report;
}
async function runTask(page,app,button){
  const response=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator(button).click();const job=await(await response).json();
  if(button==='#enqueue-analyze'&&!(await app.request('status')).queueRunning)await page.locator('#queue-start').click();
  const done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));
  if(button==='#enqueue-analyze'){
    await page.locator(`[data-result-open="${job.id}"]`).click();
    await page.waitForFunction(id=>document.querySelector('#inspect-result').dataset.reportOwner===id,job.id);
  }
  else await page.waitForFunction(()=>document.querySelector('#task-label')?.textContent==='任务完成');
  return {job:done,report:await app.request(`jobs/${job.id}/report`)};
}
async function download(page,button,file){
  const pending=page.waitForEvent('download');await page.locator(button).click();
  const downloaded=await pending;
  assert.match(downloaded.suggestedFilename(),/-\d{8}T\d{6}Z(?:-\d+)?\.json$/);
  const stamp=downloaded.suggestedFilename().match(/(\d{8}T\d{6}Z)(?:-\d+)?\.json$/)[1];
  const instant=Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'));
  assert.ok(Math.abs(Date.now()-instant)<60000,'download filename must represent UTC regardless of the browser timezone');
  await downloaded.saveAs(file);const text=await readFile(file,'utf8');assert.equal(text.includes('\n'),false);
  const decoded=parsePortable(text);assert.equal(downloaded.suggestedFilename(),portableFilename(decoded.results,decoded.plans,stamp));return decoded;
}
async function analyze(page,app){await preview(page);await page.locator('#bitrate-enabled').check();return runTask(page,app,'#enqueue-analyze')}
scenario('[analysis-targets] automatic preview and independent targets follow the queue workflow and survive import',async({page,app,dir})=>{
  assert.equal(await page.locator('#frame-analysis').isChecked(),true);
  assert.equal(await page.locator('#bitrate-enabled').isChecked(),false);
  assert.equal(await page.locator('#complexity').isChecked(),false);
  assert.equal(await page.locator('#bitrate-options').isVisible(),false);
  assert.equal(await page.locator('#siti-settings').isVisible(),false);
  assert.equal(await page.locator('#analyze').count(),0);
  assert.equal(await page.locator('#inspect').isVisible(),false);
  await preview(page,media.sitiSource);
  assert.equal((await app.request('status')).jobs.length,0,'automatic preview must not start or enqueue analysis');
  await page.locator('#frame-analysis').uncheck();
  assert.equal(await page.locator('#enqueue-analyze').isDisabled(),true);
  await page.locator('#frame-analysis').check();
  const frames=await runTask(page,app,'#enqueue-analyze');
  assert.deepEqual(frames.report.analysisTargets,{frames:true,bitrate:false,complexity:false});
  assert.equal(frames.report.packets.bitrateCurve,undefined);
  assert.deepEqual(frames.report.packets.bins,[]);
  assert.equal(await page.locator('#bitrate-optional').count(),0);
  assert.equal(await page.locator('#frame-plot canvas').count(),1);

  if(await page.locator('#queue-pause').isEnabled())await page.locator('#queue-pause').click();
  await page.locator('#frame-analysis').uncheck();await page.locator('#bitrate-enabled').check();
  await page.locator('#bitrate-window').selectOption('1000');
  const queued=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator('#enqueue-analyze').click();const job=await(await queued).json();
  assert.equal((await app.request('jobs/'+job.id)).status,'queued');
  await page.locator('#bitrate-enabled').uncheck();await page.locator('#complexity').check();
  assert.equal(await page.locator('#bitrate-options').isVisible(),false);
  assert.equal(await page.locator('#bitrate-window').isDisabled(),true);
  assert.equal(await page.locator('#siti-settings').isVisible(),true);
  assert.equal(await page.locator('.siti-device-row #siti-gpu-recheck').isVisible(),true);
  assert.equal(await page.locator('#siti-settings details[open]').count(),0);
  const plan=(await app.request('plans')).plans[0].input;
  assert.equal(plan.bitrate,true);assert.equal(plan.bitrateWindowMs,1000);assert.equal(plan.complexity,false);
  await page.locator('#queue-start').click();assert.equal((await waitForJob(app.request,job.id)).status,'done');
  await page.locator(`[data-result-open="${job.id}"]`).click();
  await page.waitForFunction(id=>document.querySelector('#inspect-result').dataset.reportOwner===id,job.id);
  const bitrate=await app.request(`jobs/${job.id}/report`);
  assert.deepEqual(bitrate.analysisTargets,{frames:false,bitrate:true,complexity:false});
  assert.equal(bitrate.frames,undefined);assert.equal(bitrate.packets.bitrateCurve.windowMs,1000);
  assert.equal(await page.locator('#frame-plot').count(),0);assert.equal(await page.locator('#bitrate-optional').count(),1);
  const curveFile=path.join(dir,'curve-only.json');await saveImportFixture(curveFile,bitrate);await importReport(page,curveFile);
  await page.locator('#bitrate-optional > summary').click();assert.equal(await page.locator('#bitrate canvas').count(),1);

  const siti=await runTask(page,app,'#enqueue-analyze');
  assert.deepEqual(siti.report.analysisTargets,{frames:false,bitrate:false,complexity:true});
  assert.equal(siti.report.content.available,true,siti.report.content.reason);
  assert.equal(siti.report.packets,undefined);assert.equal(siti.report.coding,undefined);
  assert.equal(await page.locator('#frame-plot').count(),0);assert.equal(await page.locator('#bitrate').count(),0);
  assert.equal(await page.locator('#si canvas').count(),1);
  const sitiFile=path.join(dir,'siti-only.json');await saveImportFixture(sitiFile,siti.report);await importReport(page,sitiFile);
  assert.equal(await page.locator('#si canvas').count(),1);
  const exported=await download(page,'#inspect-export',path.join(dir,'siti-only-roundtrip.json'));
  assert.deepEqual(exported.results[0].report,siti.report);
  await page.locator('#complexity').uncheck();assert.equal(await page.locator('#siti-settings').isVisible(),false);
  await page.screenshot({path:path.join(dir,'analysis-targets.png'),fullPage:true});
});

scenario('[analysis-targets] invalid file preview is inline and can be retried or replaced',async({page,app})=>{
  await page.locator('#file').fill(path.join(root,'does-not-exist.mp4'));
  await page.locator('#inspect').waitFor({state:'visible'});
  assert.equal(await page.locator('#enqueue-analyze').isDisabled(),true);
  assert.equal(await page.locator('#stream').isDisabled(),true);
  const retry=page.waitForResponse(r=>r.url().endsWith('/api/probe'));
  await page.locator('#inspect').click();await retry;
  await preview(page,media.source);
  assert.equal(await page.locator('#inspect').isVisible(),false);
  assert.equal(await page.locator('#enqueue-analyze').isEnabled(),true);
  assert.equal((await app.request('status')).jobs.length,0);
});

scenario('[analysis-targets] switching files cancels a pending preview without restoring stale track information',async({page})=>{
  let unblock,started;
  const released=new Promise(resolve=>unblock=resolve),pending=new Promise(resolve=>started=resolve);
  await page.route('**/api/probe',async route=>{
    if(route.request().postDataJSON().file===media.source){started();await released;}
    await route.continue().catch(()=>{});
  });
  try{
    await page.locator('#file').fill(media.source);await pending;
    await preview(page,media.candidate);
    unblock();await page.unrouteAll({behavior:'wait'});
    assert.equal(await page.locator('#file').inputValue(),media.candidate);
    assert.equal(await page.locator('#enqueue-analyze').isEnabled(),true);
    assert.equal(await page.locator('#file-status.error').count(),0);
    assert.match(await page.locator('#inspect-details').innerText(),/候选\.mp4/);
  }finally{unblock()}
});

scenario('[bitrate-window] [units] calculation selection and display aggregation survive report import',async({page,app,dir})=>{
  await preview(page);
  await page.locator('#bitrate-enabled').check();
  await page.locator('#bitrate-window').selectOption('100');
  const {report}=await runTask(page,app,'#enqueue-analyze');
  assert.equal(report.packets.bitrateCurve.windowMs,100);
  assert.equal(report.packets.bitrateCurve.status,'ok');
  assert.equal(await page.locator('#bitrate-optional').evaluate(el=>el.open),false);
  await page.locator('#bitrate-optional > summary').click();
  assert.equal(await page.locator('#bitrate-display').inputValue(),'100');
  assert.equal(await page.locator('[id^="audio-"][id$="-display"]').count(),2);
  const videoWidth=await page.locator('#bitrate-display').evaluate(el=>el.getBoundingClientRect().width);
  assert.ok(videoWidth<=120,'short window values use a compact control');
  const audioCanvas=await page.locator('#audio-1 canvas').elementHandle();
  await page.locator('#bitrate-display').selectOption('1000');
  assert.equal(await page.locator('#audio-1-display').inputValue(),'100');
  assert.equal(await audioCanvas.evaluate(el=>el.isConnected),true,'video selection must not redraw audio');
  const videoCanvas=await page.locator('#bitrate canvas').elementHandle();
  await page.locator('#audio-1-display').selectOption('1000');
  assert.equal(await page.locator('#audio-2-display').inputValue(),'100');
  assert.equal(await videoCanvas.evaluate(el=>el.isConnected),true,'audio selection must not redraw video');
  const rateUnit=quantityScale(bitrateView(report.packets.bitrateCurve,1000).map(b=>b.mbps*1e6),'bit/s').unit;
  const view=bitrateView(report.packets.bitrateCurve,1000);
  assert.equal(Number(await page.locator('#bitrate [data-field="to"]').inputValue()),Number(view.at(-1).end.toFixed(6)),'full view includes the final measured interval');
  await page.locator('#bitrate canvas').scrollIntoViewIfNeeded();
  const canvasBox=await page.locator('#bitrate canvas').boundingBox();
  await page.mouse.move(canvasBox.x+76+(canvasBox.width-101)*0.25,canvasBox.y+40);
  assert.match(await page.locator('#bitrate .chart-label').textContent(),/\[[^\]]+, [^\]]+\) s.* B/,'tooltip reports interval boundaries and bytes');
  assert.equal(await page.locator('#bitrate .plot-axis-y').textContent(),'纵轴：'+rateUnit);
  await page.locator('#bitrate [data-op="in"]').click();
  assert.equal(await page.locator('#bitrate .plot-axis-y').textContent(),'纵轴：'+rateUnit,'zoom does not change units');
  await page.locator('#bitrate-display').selectOption('100');
  const file=path.join(dir,'bitrate.json');await saveImportFixture(file,report);
  await importReport(page,file);
  assert.equal(await page.locator('#bitrate-optional').evaluate(el=>el.open),false);
  await page.locator('#bitrate-optional > summary').click();
  assert.equal(await page.locator('#bitrate-display').inputValue(),'100');
  await page.locator('#bitrate-window').selectOption('1000');
  const next=await runTask(page,app,'#enqueue-analyze');
  assert.equal(next.report.packets.bitrateCurve.windowMs,1000);
  assert.equal(await page.locator('#bitrate-display option').count(),1);
});

scenario('[queue-removal] GUI removes waiting tasks and completed/imported results and clears each scope',async({page,app,dir})=>{
  await page.locator('#file').fill(media.source);
  for(let i=0;i<3;i++){
    const response=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
    await page.locator('#enqueue-analyze').click();await response;
    await page.waitForFunction(n=>document.querySelectorAll('#queue-list .queue-item').length===n,i+1);
  }
  await page.locator('#queue-list [data-action="remove"]').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('#queue-list .queue-item').length===2);
  assert.equal((await app.request('plans')).plans.length,2);
  assert.equal(await page.locator('#queue-history-list .queue-item').count(),0);
  await page.locator('#queue-clear').click();
  await page.waitForFunction(()=>document.querySelectorAll('#queue-list .queue-item').length===0);
  assert.equal((await app.request('status')).jobs.length,0);
  const active=await app.request('jobs','POST',{type:'trial',file:media.source,stream:0,start:0,duration:1,encoder:'libx265',presets:['slow'],crfs:[18,22,26,30],metrics:['psnr']});
  await page.locator('#cancel').waitFor({state:'visible'});await page.locator('#cancel').click();
  await page.waitForFunction(()=>document.querySelector('#task-label').textContent==='任务已取消');
  assert.ok(!(await app.request('status')).jobs.some(j=>j.id===active.id));
  assert.equal(await page.locator('#queue-history-list .queue-item').count(),0);
  const completed=await app.request('jobs','POST',{type:'inspect',file:media.source});await waitForJob(app.request,completed.id);
  await page.locator(`[data-result-remove="${completed.id}"]`).waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.locator('#queue-history').evaluate(el=>el.open=true);
  for(const selector of ['#queue-panel','#portable-panel',`[data-result-remove="${completed.id}"]`,`[data-job="${completed.id}"][data-action="remove"]`]) {
    const bounds=await page.locator(selector).boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390,selector+' must fit a narrow viewport');
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator(`[data-result-remove="${completed.id}"]`).click();
  await page.waitForFunction(()=>document.querySelectorAll('#result-list .queue-item').length===0);
  await assert.rejects(app.request('jobs/'+completed.id+'/report'),/404/);
  const inspected=await preview(page);
  const file=path.join(dir,'import-removal.json');await saveImportFixture(file,inspected);
  await importReport(page,file);
  await page.locator('#result-list [data-result-remove]').waitFor();await page.locator('#result-list [data-result-remove]').click();
  assert.equal(await page.locator('#result-list .queue-item').count(),0);
  assert.equal(await page.locator('#inspect-result').isVisible(),false,'removing the displayed imported result releases its report view');
  await importReport(page,file);
  const done=await app.request('jobs','POST',{type:'inspect',file:media.source});await waitForJob(app.request,done.id);
  await page.locator(`[data-result-remove="${done.id}"]`).waitFor();
  await page.locator('#result-clear').click();
  await page.waitForFunction(()=>document.querySelectorAll('#result-list .queue-item').length===0);
  const failed=await app.request('jobs','POST',{type:'inspect',file:path.join(dir,'missing.mp4')});await waitForJob(app.request,failed.id);
  await page.locator('#queue-history').evaluate(el=>el.open=true);
  await page.locator(`[data-job="${failed.id}"][data-action="remove"]`).waitFor();
  await page.locator('#queue-history-clear').click();
  await page.waitForFunction(()=>document.querySelectorAll('#queue-history-list .queue-item').length===0);
  assert.deepEqual((await app.request('status')).jobs,[]);
});

scenario('[startup] [units] actual browser loads the complete app and the API rejects an absent session token',async({page,app})=>{
  assert.equal((await fetch(app.base+'/api/status')).status,403);
  assert.equal(await page.locator('#enqueue-analyze').isEnabled(),false);
  const help=(await page.locator('p.hint').allTextContents()).join(' ');
  assert.match(help,/最大 256 MB/);assert.match(help,/结果仅在本次运行中保留/);
  assert.doesNotMatch(help,/近期任务自动保留|合计不超过 100 MB/);
  assert.ok(!help.includes('B 表示字节')&&!help.includes('1000 进位'));
  assert.ok(!help.includes('268.435')&&!help.includes('104.858'));
  for(const mode of ['inspect','compare','trial']){
    await page.locator(`[data-mode="${mode}"]`).click();
    assert.equal(await page.locator('#'+mode+'-panel').isVisible(),true);
  }
});
scenario('[basic-properties] actual preview omits automatic sampling and preserves old sample evidence on import',async({page,dir})=>{
  const report=await preview(page),details=page.locator('#inspect-details');
  assert.equal(await details.locator(':scope > .section').count(),1,'preview uses one basic information block');
  assert.equal(await page.locator('#inspect-summary .card').count(),0,'container summary is not repeated');
  assert.equal(await details.locator('.basic-info-extra').getAttribute('open'),null);
  assert.equal(await details.locator('.basic-info-evidence').getAttribute('open'),null);
  assert.equal(await details.locator('[data-track-main] [data-property="component-depth"] dd').innerText(),'8 bit');
  await details.locator('.basic-info-extra > summary').click();
  assert.match(await details.innerText(),/基础帧率（可能为估计）/);
  assert.match(await details.innerText(),/报告帧数/);
  assert.match(await details.innerText(),/报告编码样本位数/);
  await details.locator('.basic-info-evidence > summary').click();
  assert.equal(await details.getByRole('heading',{name:'开头样本核对',exact:true}).count(),0);
  assert.equal(report.frameSampleRead.status,'not-requested');assert.equal(report.frameSample,null);
  assert.ok(report.commands.every(c=>!c.args.includes('-show_frames')&&!c.args.includes('-read_intervals')));
  const rateRow=details.locator('[data-track-extra] [data-property="r_frame_rate"]');
  assert.equal(await rateRow.locator('dd').innerText(),propertyValue(report.raw.streams[0].r_frame_rate,'rate').text+' 帧/s');
  const audio=report.raw.streams.find(s=>s.codec_type==='audio');
  await details.locator('[data-basic-track]').selectOption(String(audio.index));
  assert.equal(await details.locator('[data-track-main] [data-property="sample_rate"] dd').innerText(),audio.sample_rate+' Hz');
  assert.equal(await page.locator('#stream').inputValue(),'0','viewing audio properties must not change the analysis target');
  assert.equal(await details.locator('.basic-info-extra').getAttribute('open'),'','track switching preserves the expanded details');
  assert.equal(await details.locator('[data-track-main] [data-property="component-depth"]').count(),0);
  const file=path.join(dir,'properties-new.json'),saved=await download(page,'#inspect-export',file);
  assert.deepEqual(saved.results[0].report,report);
  await importReport(page,file);
  const restored=await download(page,'#inspect-export',path.join(dir,'properties-restored.json'));
  assert.deepEqual(restored.results[0].report,report);
  const timeoutCommands=[],timed=await probe(report.file,{probeSupplementTimeoutMs:1,commands:timeoutCommands});
  const failed={...report,...timed,commands:timeoutCommands,metadata:metadataSummary(timed)},failedFile=path.join(dir,'properties-failed.json');
  await saveImportFixture(failedFile,failed);await importReport(page,failedFile);
  await page.waitForFunction(()=>document.querySelector('#inspect-details').textContent.includes('读取失败'));
  assert.equal(await details.locator('.notice').filter({hasText:'读取失败'}).count(),1,'pixel descriptor failure stays visible outside folded evidence');
  await details.locator('.basic-info-evidence > summary').click();
  assert.match(await details.innerText(),/读取超时/);assert.doesNotMatch(await details.innerText(),/0 个实际样本/);
  await page.screenshot({path:path.join(dir,'properties-failed.png'),fullPage:true});
  const failedSaved=await download(page,'#inspect-export',path.join(dir,'properties-failed-restored.json'));
  assert.deepEqual(failedSaved.results[0].report,failed);
  const legacyCommands=[],sample=await legacyFrameSample(report.file,report.raw.streams,{commands:legacyCommands});
  const legacy={...report,...sample,commands:[...report.commands,...legacyCommands]};legacy.metadata=metadataSummary(legacy);
  const legacyFile=path.join(dir,'properties-with-samples.json');await saveImportFixture(legacyFile,legacy);
  await importReport(page,legacyFile);
  await page.waitForFunction(()=>document.querySelector('#inspect-details').textContent.includes('个实际样本'));
  await details.locator('.basic-info-evidence > summary').click();
  assert.match(await details.innerText(),new RegExp(`${sample.frameSampleRead.tracks[0].count} 个实际样本`));
  assert.deepEqual((await download(page,'#inspect-export',path.join(dir,'legacy-samples-restored.json'))).results[0].report,legacy);
  const old=structuredClone(report);old.schema='MediaScope/0.1';delete old.pixelFormats;delete old.frameSampleRead;delete old.frameSample;delete old.frameSampleScope;
  const oldFile=path.join(dir,'properties-old.json');await writeFile(oldFile,JSON.stringify(old));await importReport(page,oldFile);
  // A legacy file is rejected; the last valid 0.4 report remains visible.
  const oldSaved=await download(page,'#inspect-export',path.join(dir,'properties-old-restored.json'));
  assert.deepEqual(oldSaved.results[0].report,legacy);
});

scenario('[basic-properties] real subtitles attachments chapters and narrow layout remain accessible without losing export data',async({page,dir})=>{
  const subtitle=path.join(dir,'caption.srt'),attachment=path.join(dir,'notes.txt'),chapters=path.join(dir,'chapters.txt'),file=path.join(dir,'all-tracks.mkv');
  await writeFile(subtitle,'1\n00:00:00,000 --> 00:00:01,000\n真实字幕样本\n');
  await writeFile(attachment,'真实附件样本');
  await writeFile(chapters,';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=第一章\n');
  const commands=[];
  await run(FF,['-v','error','-y','-i',media.source,'-f','srt','-i',subtitle,'-f','ffmetadata','-i',chapters,'-map','0','-map','1','-map_metadata','2','-map_chapters','2','-c','copy','-attach',attachment,'-metadata:s:t','mimetype=text/plain','-metadata:s:t','filename=notes.txt','-metadata:s:s:0','language=zho',file],{commands});
  const report=await preview(page,file),details=page.locator('#inspect-details');
  await writeFile(path.join(dir,'fixture-recipe.json'),JSON.stringify({commands,report}));
  const picker=details.locator('[data-basic-track]');
  assert.equal(await picker.locator('option').count(),report.raw.streams.length);
  for(const type of ['audio','subtitle','attachment']){
    const stream=report.raw.streams.find(s=>s.codec_type===type);assert.ok(stream);
    await picker.selectOption(String(stream.index));
    assert.match(await details.locator('[data-track-main]').innerText(),new RegExp(stream.codec_name));
  }
  assert.match(await details.locator('[data-track-main]').innerText(),/notes\.txt/);
  await details.locator('.basic-info-extra > summary').click();
  await details.getByText('章节 · 1 项',{exact:true}).click();
  assert.match(await details.innerText(),/第一章/);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await details.locator('[data-basic-info]').evaluate(root=>root.scrollWidth>root.clientWidth),false);
  await page.screenshot({path:path.join(dir,'properties-layout-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  await picker.selectOption('0');
  await page.screenshot({path:path.join(dir,'properties-layout-desktop.png'),fullPage:true});
  const exported=await download(page,'#inspect-export',path.join(dir,'all-tracks-export.json'));
  assert.deepEqual(exported.results[0].report,report);
});

scenario('[analysis] SI/TI reference settings and HLG display survive GUI plans and reports',async({page,app,dir})=>{
  const vectors=JSON.parse(await readFixture('vqeg-060.json'));
  for(const name of ['rgb24-sdr-pc','gray-sdr-tv','gray16le-srgb-pc','gray12le-hlg-pc','gray10le-hlg-tv-display']){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c);
    await preview(page,fixture.file);await page.locator('#complexity').check();
    if(!await page.locator('#siti-range').isVisible())await page.locator('#siti-input-settings > summary').click();
    assert.equal(await page.locator('#siti-scale').count(),0);assert.equal(await page.locator('#siti-float-depth').count(),0);assert.equal(await page.locator('#siti-alpha').count(),0);
    await page.locator('#siti-range').selectOption(c.range);await page.locator('#siti-transfer').selectOption(c.domain);await page.locator('#siti-matrix').selectOption(c.matrix??'auto');
    if(c.domain==='hlg'){if(name==='gray12le-hlg-pc')assert.equal(await page.locator('#siti-hlg-white').inputValue(),'1000');await page.locator('#siti-hlg-white').fill('2000');if(c.settings.hlg)await page.locator('#siti-hlg-black').fill(String(c.settings.hlg.blackCdM2))}
    await page.locator('#siti-scenes').selectOption('single');
    const {report}=await runTask(page,app,'#enqueue-analyze');assert.equal(report.content.available,true,report.content.reason);
    assert.equal(report.content.execution.configuration.configurationVersion,8);assert.equal(report.content.execution.configuration.outputMultiplier,255);
    if(c.domain==='hlg')assert.equal(report.content.execution.configuration.display.whiteCdM2,2000);
    await page.locator('#inspect-details').getByRole('heading',{name:'SI/TI 内容复杂度',exact:true}).waitFor();
    assert.match(await page.locator('#inspect-details').innerText(),/siti-tools 0\.6\.0 · PQ 域 · 固定尺度 255/);
    const file=path.join(dir,name+'.json'),exported=await download(page,'#inspect-export',file);assert.deepEqual(exported.results[0].report,report);
    await importReport(page,file);assert.match(await page.locator('#inspect-details').innerText(),/固定尺度 255/);
    const response=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');await page.locator('#enqueue-analyze').click();const submitted=(await response).request().postDataJSON();
    const plans=await app.request('plans');assert.deepEqual(plans.plans.at(-1).input.sitiSettings,submitted.sitiSettings);
    await page.screenshot({path:path.join(dir,name+'.png'),fullPage:true});
    for(const snapshot of vectors.historical.filter(h=>h.case===name)){
      const legacy=structuredClone(exported),old=legacy.results[0].report,e=old.content.execution,source=e.configuration.input.source;
      e.configuration=structuredClone(snapshot.configuration);e.configuration.input.source=source;e.method=e.configuration.profile;
      old.content.points=old.content.points.map((p,i)=>({...p,...snapshot.expected[i]}));Object.assign(old.content,sitiSceneSummary(old.content.points,[0]));old.content.notes=['历史 HLG 参考公式；保留原值。'];
      const oldFile=path.join(dir,`historical-${snapshot.id}.json`);await saveImportFixture(oldFile,legacy);await importReport(page,oldFile);assert.match(await page.locator('#inspect-details').innerText(),/历史计算口径，保留原值/);
      const roundTrip=await download(page,'#inspect-export',path.join(dir,`historical-${snapshot.id}-roundtrip.json`));assert.deepEqual(roundTrip.results.at(-1).report,old);
    }
  }
});

scenario('[analysis] GPU SI/TI selection preserves the P.910 SDR method and displays the actual device',async({page,app})=>{
  await preview(page,media.sitiSource);await page.locator('#complexity').check();
  const checked=page.waitForResponse(r=>r.url().endsWith('/api/siti-gpu'));
  await page.locator('#siti-device').selectOption('gpu');const capability=await(await checked).json();
  await page.waitForFunction(()=>!document.querySelector('#siti-device-status').textContent.includes('正在检查'));
  assert.equal(await page.locator('#siti-device').inputValue(),capability.available?'gpu':'cpu');
  assert.equal(await page.locator('#siti-workers').isDisabled(),capability.available);
  const {report}=await runTask(page,app,'#enqueue-analyze');
  assert.equal(report.content.execution.device,capability.available?'gpu':'cpu');
  assert.equal(report.content.execution.method,SITI_COMPAT_PROFILE);
  if(capability.available)assert.equal(report.content.execution.validation.selfTest,'passed');
  assert.equal(report.content.points.length,report.frames.length);
  assert.match(await page.locator('#inspect-details').innerText(),capability.available?/GPU ·/:/CPU ·/);
  assert.match(await page.locator('#inspect-details').innerText(),/siti-tools 0\.6\.0/);
});

scenario('[analysis] a temporary GPU capability failure can be rechecked without disabling GPU selection',async({page})=>{
  await preview(page,media.sitiSource);await page.locator('#complexity').check();
  await page.route('**/api/siti-gpu',route=>route.fulfill({json:{available:false,reason:'临时设备检查失败'}}),{times:1});
  await page.locator('#siti-device').selectOption('gpu');await page.waitForFunction(()=>document.querySelector('#siti-device-status').textContent.includes('临时设备检查失败'));
  assert.equal(await page.locator('#siti-device').inputValue(),'cpu');assert.equal(await page.locator('#siti-device option[value="gpu"]').isDisabled(),false);
  await page.route('**/api/siti-gpu',route=>route.fulfill({json:{available:true,device:'界面重试测试设备'}}),{times:1});
  await page.locator('#siti-gpu-recheck').click();await page.waitForFunction(()=>document.querySelector('#siti-device-status').textContent.includes('界面重试测试设备'));
  await page.locator('#siti-device').selectOption('gpu');assert.equal(await page.locator('#siti-device').inputValue(),'gpu');assert.equal(await page.locator('#siti-workers').isDisabled(),true);
});

scenario('[analysis] SI/TI confirmed scenes exclude boundary TI and export separate scene statistics',async({page,app,dir})=>{
  await preview(page,media.sitiSource);await page.locator('#complexity').check();
  assert.equal(await page.locator('#siti-scenes').inputValue(),'unconfirmed');
  await page.locator('#siti-scenes').selectOption('confirmed');await page.locator('#siti-scene-frames').fill('1, 7, 12');
  const {report}=await runTask(page,app,'#enqueue-analyze');
  assert.deepEqual(report.content.sceneAnalysis.starts,[0,6,11]);assert.equal(report.content.si,null);assert.equal(report.content.ti,null);
  assert.deepEqual(report.content.points.filter(p=>p.ti===null).map(p=>p.frame),[0,6,11]);assert.equal(report.content.scenes.at(-1).ti,null);
  const details=page.locator('#inspect-details');assert.match(await details.innerText(),/按用户确认/);assert.match(await details.innerText(),/1–6/);assert.match(await details.innerText(),/7–11/);
  assert.equal(await details.locator('#si canvas').count(),1);assert.equal(await details.locator('#ti canvas').count(),1);
  const exported=await download(page,'#inspect-export',path.join(dir,'scene-export.json'));assert.deepEqual(exported.results[0].report,report);
  await importReport(page,path.join(dir,'scene-export.json'));assert.match(await details.innerText(),/12–12/);
  await page.screenshot({path:path.join(dir,'siti-scenes.png'),fullPage:true});
});

scenario('[analysis] [units] actual multi-audio file, frame scan, GOP, SI/TI and export match the server report',async({page,app,dir})=>{
  const info=await preview(page,media.sitiSource);assert.deepEqual(info.raw,(await probe(media.sitiSource)).raw);
  assert.equal(info.raw.streams.length,3);
  await page.locator('#bitrate-enabled').check();await page.locator('#complexity').check();await page.locator('#siti-workers').selectOption('8');
  assert.equal(await page.locator('#siti-device').inputValue(),'cpu');
  const {report}=await runTask(page,app,'#enqueue-analyze');
  assert.deepEqual(await page.locator('#inspect-details > .section > h3').allTextContents(),['文件基本信息','帧结构与 GOP','SI/TI 内容复杂度','音轨包大小时间分布','音视频码率统计（可选曲线）','体积构成']);
  assert.equal(await page.locator('#inspect-details > .cards .card').count(),4);
  assert.equal(report.frames.length,12);assert.equal(report.tracks.filter(s=>s.type==='audio').length,2);
  assert.equal(report.content.points.length,report.frames.length);
  assert.equal(report.content.execution.requestedWorkers,8);
  assert.equal(report.content.execution.device,'cpu');
  assert.equal(report.content.points[0].ti,null);assert.equal(report.content.ti.count,report.frames.length-1);
  assert.ok(report.commands.length>0&&report.commands.every(c=>c.exitCode===0));
  assert.ok(await page.locator('#frame-plot canvas').isVisible());
  const fileSize=page.locator('[data-property="size"] dd');
  assert.equal(await fileSize.textContent(),formatBytes(report.size));
  assert.equal(await fileSize.getAttribute('title'),byteEvidence(report.size));
  const frameUnit=quantityScale(report.frames.map(f=>f.bytes)).unit;
  assert.equal(await page.locator('#frame-plot .plot-axis-y').textContent(),`纵轴：关联包大小（${frameUnit}）`);
  assert.equal(await page.locator('#frame-axis').inputValue(),'time');
  assert.match(await page.locator('#frame-plot canvas').getAttribute('aria-label'),/呈现时间 s/);
  assert.equal(Number(await page.locator('#frame-plot [data-field="to"]').inputValue()),1);
  assert.ok(!(await page.locator('#inspect-details').innerText()).includes('MiB'));
  assert.equal(await page.locator('#gop-index').inputValue(),'0');
  assert.equal(report.coding.gops.length,2);
  await page.locator('#gop-next').click();assert.equal(await page.locator('#gop-index').inputValue(),'1');
  assert.match(await page.locator('#gop-info').textContent(),/帧 6–11/);
  assert.equal(Number(await page.locator('#frame-plot [data-field="from"]').inputValue()),.5);
  await page.locator('#frame-axis').selectOption('frame');
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
  assert.equal(exported.timing.totalComputeSeconds,report.timing.computeSeconds);
  assert.match(await page.locator('#result-timing-total').innerText(),/累计计算耗时/);
  const resultRow=page.locator('#result-list .queue-item').filter({has:page.locator('[data-result-open]')}).last();
  assert.match(await resultRow.locator('.result-timing').innerText(),/计算耗时：.*秒/);
  await resultRow.locator('.result-timing-stages > summary').click();
  assert.match(await resultRow.innerText(),/完整扫描视频帧/);
  assert.match(await resultRow.innerText(),/测量 SI\/TI 内容复杂度/);
  assert.deepEqual(parsePortable(JSON.stringify(makePortable({...exported,applicationVersion:exported.producer.applicationVersion}))),exported);
});

scenario('[comparison] user confirmation gates actual lossless identity and lossy candidate measurement',async({page,app,dir})=>{
  await page.locator('[data-mode="compare"]').click();
  const unavailable=path.join(dir,'unavailable-before-confirmation.mp4');
  await page.locator('#reference').fill(unavailable);await page.locator('#candidate').fill(unavailable);
  const denied=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator('#compare').click();const rejected=await waitForJob(app.request,(await(await denied).json()).id);
  assert.equal(rejected.status,'error');assert.match(rejected.message,/请确认/);
  assert.equal(rejected.progress?.phaseIndex,undefined,'confirmation is checked before any media-processing phase');
  await assert.rejects(readFile(path.join(dir,'reports',rejected.id,'failure.json')), {code:'ENOENT'});
  await page.locator('#reference').fill(media.source);await page.locator('#candidate').fill(media.source);
  await page.locator('#confirm').check();
  const identical=await runTask(page,app,'#compare');
  assert.equal(identical.report.metrics.psnr.pooled,'Infinity');assert.equal(identical.report.metrics.ssim.pooled,1);
  await page.locator('#candidate').fill(media.candidate);
  const changed=await runTask(page,app,'#compare');
  assert.ok(Number.isFinite(changed.report.metrics.psnr.pooled));assert.ok(changed.report.metrics.ssim.pooled<1);
  assert.equal(changed.report.metrics.psnr.values.length,12);
  for(const metric of ['psnr','ssim']){
    const m=changed.report.metrics[metric],section=page.locator('#compare-details > .section').filter({has:page.getByRole('heading',{name:metric.toUpperCase(),exact:true})});
    assert.equal(await section.locator('tbody tr').first().locator('td').first().innerText(),m.officialSummary.pooled.toLocaleString('zh-CN',{maximumFractionDigits:6}));
    const components=page.locator('#compare-details > .section').filter({has:page.getByRole('heading',{name:metric.toUpperCase()+' 分量',exact:true})});
    assert.deepEqual(await components.locator('tbody td').allTextContents(),Object.values(m.officialSummary.components).map(v=>v.toLocaleString('zh-CN',{maximumFractionDigits:6})));
  }
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

scenario('[comparison] VMAF official model selection survives real computation, report and queued plan round trips',async({page,app,dir})=>{
  await page.locator('[data-mode="compare"]').click();
  await page.locator('#reference').fill(media.source);await page.locator('#candidate').fill(media.candidate);
  await page.locator('#confirm').check();await page.locator('[name="metric"][value="vmaf"]').check();
  await page.locator('#vmaf-model').selectOption('vmaf_v0.6.1neg');
  const {report}=await runTask(page,app,'#compare');
  assert.equal(report.metrics.vmaf.model,'vmaf_v0.6.1neg');
  assert.equal(report.metrics.vmaf.pooled,JSON.parse(report.metrics.vmaf.raw).pooled_metrics.vmaf.mean);
  assert.match(await page.locator('#compare-details').innerText(),/1080p \/ 3H/);
  assert.match(await page.locator('#compare-details').innerText(),/相对比较/);
  const file=path.join(dir,'vmaf-report.json'),exported=await download(page,'#compare-export',file);
  assert.deepEqual(exported.results[0].report,report);await importReport(page,file);
  assert.match(await page.locator('#compare-details').innerText(),/vmaf_v0.6.1neg/);
  await page.locator('#vmaf-model').selectOption('vmaf_4k_v0.6.1');
  const queued=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator('#enqueue-compare').click();await queued;
  const plans=await app.request('plans');assert.equal(plans.plans[0].input.vmafModel,'vmaf_4k_v0.6.1');
  await app.request('plans/import','POST',{mode:'replace',start:false,plans:plans.plans});
  assert.deepEqual((await app.request('plans')).plans.map(p=>p.input),plans.plans.map(p=>p.input));
  const broken=structuredClone(plans.plans);broken[0].input.vmafModel='vmaf_v0.6.1:enable_transform=true';
  await assert.rejects(()=>app.request('plans/import','POST',{mode:'replace',start:false,plans:broken}),/模型无效/);
  await saveImportFixture(path.join(dir,'report.json'),report);
});

scenario('[comparison] VMAF undeclared signal computes, displays unknown range, and survives report import and native trial controls',async({page,app,dir})=>{
  const source=path.join(dir,'undeclared.nut');
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=s=96x64:r=4:d=1,format=yuv422p10le,setparams=range=unknown:color_primaries=unknown:color_trc=unknown:colorspace=unknown','-c:v','rawvideo','-pix_fmt','yuv422p10le','-color_range','unknown','-f','nut',source]);
  await page.locator('[data-mode="compare"]').click();
  await page.locator('#reference').fill(source);await page.locator('#candidate').fill(source);
  await page.locator('#confirm').check();await page.locator('[name="metric"][value="vmaf"]').check();
  const {report}=await runTask(page,app,'#compare');
  assert.equal(report.metrics.vmaf.values.length,4);
  assert.match(await page.locator('#compare-details').innerText(),/范围未声明/);
  assert.match(await page.locator('#compare-details').innerText(),/感知适用性未确认/);
  const file=path.join(dir,'unknown-vmaf-report.json');await download(page,'#compare-export',file);await importReport(page,file);
  assert.match(await page.locator('#compare-details').innerText(),/范围未声明/);
  const rgbRaw=Buffer.alloc(96*64*3*2*4),changedRaw=Buffer.alloc(rgbRaw.length);
  for(let frame=0;frame<4;frame++)for(let plane=0;plane<3;plane++)for(let i=0;i<96*64;i++){
    const offset=((frame*3+plane)*96*64+i)*2,value=(i*17+frame*31+plane*73)%1024;
    rgbRaw.writeUInt16LE(value,offset);changedRaw.writeUInt16LE(plane===2?Math.floor(value/2):value,offset);
  }
  const encodeRgb=async(name,data)=>{const raw=path.join(dir,name+'.raw'),file=path.join(dir,name+'.nut');await writeFile(raw,data);await run(FF,['-v','error','-f','rawvideo','-pixel_format','gbrp10le','-video_size','96x64','-framerate','4','-i',raw,'-c:v','rawvideo','-f','nut',file]);return file;};
  const rgb=await encodeRgb('rgb',rgbRaw),rgbCandidate=await encodeRgb('rgb-changed',changedRaw);
  await page.locator('#reference').fill(rgb);await page.locator('#candidate').fill(rgbCandidate);
  const rgbResult=await runTask(page,app,'#compare');
  assert.ok(Number.isFinite(rgbResult.report.metrics.psnr.components.r));assert.equal(rgbResult.report.metrics.psnr.components.g,'Infinity');
  assert.match(await page.locator('#compare-details').innerText(),/R 红\s+G 绿\s+B 蓝/);
  await page.locator('[data-mode="trial"]').click();await page.locator('#trial-file').fill(source);
  await page.locator('#trial-duration').fill('1');await page.locator('#trial-vmaf').check();
  await page.locator('#trial-depth').selectOption('both');
  assert.equal(await page.locator('#trial-vmaf').isEnabled(),true);assert.equal(await page.locator('#trial-vmaf').isChecked(),true);
  await page.locator('#trial-depth').selectOption('native');await page.locator('#trial-encoder').selectOption('libx265');
  await page.locator('[name="trial-preset"][value="medium"]').uncheck();await page.locator('[name="trial-preset"][value="ultrafast"]').check();
  await page.locator('#trial-crfs').fill('18,23,28');await page.locator('#trial-vmaf-model').selectOption('vmaf_4k_v0.6.1');
  const trial=await runTask(page,app,'#trial');assert.equal(trial.report.rows.length,3);
  assert.ok(trial.report.rows.every(row=>row.metrics.vmaf.model==='vmaf_4k_v0.6.1'));
  await saveImportFixture(path.join(dir,'report.json'),trial.report);
});

scenario('[trial] [units] real x264 trial encodes both CRFs, preserves frame metrics and cleans generated video',async({page,app,dir})=>{
  await page.locator('[data-mode="trial"]').click();await page.locator('#trial-file').fill(media.source);
  await page.locator('#trial-duration').fill('1');await page.locator('#trial-encoder').selectOption('libx264');
  await page.locator('[name="trial-preset"][value="medium"]').uncheck();await page.locator('[name="trial-preset"][value="ultrafast"]').check();
  await page.locator('#trial-crfs').fill('20,38');
  const {report}=await runTask(page,app,'#trial');
  assert.deepEqual(report.rows.map(r=>r.crf),[20,38]);assert.deepEqual(report.experiment.retainedFiles,[]);
  assert.ok(report.rows.every(r=>r.metrics.psnr.values.length===report.experiment.actualFrames));
  assert.ok(report.rows[0].videoBytes>report.rows[1].videoBytes);
  assert.equal(await page.locator('#trial-sample-table tbody tr').first().locator('td').nth(4).innerText(),report.rows[0].metrics.psnr.officialSummary.pooled.toLocaleString('zh-CN',{maximumFractionDigits:6}));
  assert.ok(await page.locator('#trial-frames canvas').isVisible());
  await page.locator('#trial-psnr canvas').hover({position:{x:60,y:50}});
  assert.ok((await page.locator('#trial-psnr .chart-label').innerText()).includes(report.rows[0].metrics.psnr.pooled.toLocaleString('zh-CN',{maximumFractionDigits:6})), 'quality tooltips retain their original precision');
  const unit=quantityScale(report.rows.map(r=>r.videoBytes)).unit;
  await page.locator('#rd-axis').selectOption('videoBytes');
  assert.match(await page.locator('#rd canvas').getAttribute('aria-label'),new RegExp(`视频包体积（${unit}）`));
  await page.locator('#rd [data-op="in"]').click();
  assert.match(await page.locator('#rd canvas').getAttribute('aria-label'),new RegExp(`视频包体积（${unit}）`));
  const exported=await download(page,'#trial-export',path.join(dir,'units-trial.json'));
  assert.deepEqual(exported.results[0].report,report);
  await importReport(page,path.join(dir,'units-trial.json'));
  await page.locator('#rd-axis').selectOption('videoBytes');
  assert.match(await page.locator('#rd canvas').getAttribute('aria-label'),new RegExp(`视频包体积（${unit}）`));
  await page.locator('#trial-crfs').fill('0');
  const lossless=await runTask(page,app,'#trial');
  assert.equal(lossless.report.rows[0].metrics.psnr.pooled,'Infinity');
  await page.locator('#trial-psnr canvas').hover({position:{x:60,y:50}});
  assert.match(await page.locator('#trial-psnr .chart-label').innerText(),/Infinity/,'infinite quality is not presented as a missing measurement');
});

scenario('[bd-rate] changed presets distinguish the displayed single-group report from a completed queued two-group trial',async({page,app,dir})=>{
  await page.locator('[data-mode="trial"]').click();await page.locator('#trial-file').fill(media.source);
  await page.locator('#trial-duration').fill('1');await page.locator('#trial-encoder').selectOption('libx264');
  await page.locator('[name="trial-preset"][value="medium"]').uncheck();await page.locator('[name="trial-preset"][value="ultrafast"]').check();
  await page.locator('#trial-crfs').fill('18,36');
  const initial=await runTask(page,app,'#trial');
  assert.match(await page.locator('#bd-result').innerText(),/当前报告只有一组/);
  assert.match(await page.locator('#bd-report-context').innerText(),/1 条曲线，2 个采样点/);
  assert.equal(await page.locator('#bd-report-context .notice').count(),0);
  await page.locator('[name="trial-preset"][value="superfast"]').check();
  assert.match(await page.locator('#bd-report-context').innerText(),/当前设置与报告不同/);
  assert.equal(await page.locator('#bd-anchor option').count(),1);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/jobs')&&r.request().method()==='POST');
  await page.locator('#enqueue-trial').click();const submitted=await response,job=await submitted.json();
  assert.deepEqual(submitted.request().postDataJSON().presets,['ultrafast','superfast']);
  if(!(await app.request('status')).queueRunning)await page.locator('#queue-start').click();
  const done=await waitForJob(app.request,job.id);assert.equal(done.status,'done',JSON.stringify(done));
  const completed=await app.request(`jobs/${job.id}/report`);
  assert.equal(completed.rows.length,4);assert.deepEqual(completed.experiment.presets,['ultrafast','superfast']);
  assert.equal(await page.locator('#trial-result').getAttribute('data-report-owner'),initial.job.id);
  assert.equal(await page.locator('#bd-anchor option').count(),1,'a queued task must not silently replace the viewed report');
  await page.locator(`[data-result-open="${job.id}"]`).click();
  await page.waitForFunction(id=>document.querySelector('#trial-result').dataset.reportOwner===id,job.id);
  assert.equal(await page.locator('#bd-anchor option').count(),2);
  assert.match(await page.locator('#bd-report-context').innerText(),/2 条曲线，4 个采样点/);
  assert.equal(await page.locator('#bd-report-context .notice').count(),0);
  assert.equal(await page.locator('#bd-result tbody tr').count(),1);
  await writeFile(path.join(dir,'report.json'),JSON.stringify({initial:initial.report,completed}));
  await page.locator('#bd-result').locator('..').screenshot({path:path.join(dir,'bd-report-context.png')});
});

scenario('[bd-rate] real trial curves calculate all three metrics, reverse baseline and survive report export/import',async({page,app,dir})=>{
  await page.locator('[data-mode="trial"]').click();await page.locator('#trial-file').fill(media.source);
  await page.locator('#trial-duration').fill('1');await page.locator('#trial-encoder').selectOption('libx264');
  await page.locator('[name="trial-preset"][value="medium"]').uncheck();
  for(const preset of ['ultrafast','fast'])await page.locator(`[name="trial-preset"][value="${preset}"]`).check();
  await page.locator('#trial-crfs').fill('18,24,30,36');await page.locator('#trial-vmaf').check();
  let {report}=await runTask(page,app,'#trial');
  await writeFile(path.join(dir,'report.json'),JSON.stringify(report));
  const groups=[...new Set(report.rows.map(rowLabel))];assert.equal(groups.length,2);
  const check=async(metric,a=0,b=1)=>{
    await page.locator('#bd-anchor').selectOption(String(a));await page.locator('#bd-test').selectOption(String(b));
    await page.locator('#bd-metric').selectOption(metric);
    const result=trialBdRate(report.rows,groups[a],groups[b],metric);
    assert.equal(result.ok,true,JSON.stringify(result));
    const cells=page.locator('#bd-result tbody td');
    assert.equal(await cells.first().innerText(),`${result.percent>0?'+':''}${result.percent.toLocaleString('zh-CN',{maximumFractionDigits:3})} %`);
    assert.match(await cells.nth(1).innerText(),metric==='ssim'?/SSIM dB/:metric==='psnr'?/PSNR/:/VMAF/);
    assert.equal(await cells.nth(3).innerText(),result.pointCounts.join(' / '));return result;
  };
  const forward=await check('psnr'),reverse=await check('psnr',1,0);
  assert.ok(Math.abs((1+forward.percent/100)*(1+reverse.percent/100)-1)<1e-10);
  await check('ssim');await check('vmaf');
  await page.locator('#bd-test').selectOption('0');assert.match(await page.locator('#bd-result').innerText(),/两个不同/);
  const file=path.join(dir,'bd-trial.json'),exported=await download(page,'#trial-export',file);
  assert.deepEqual(exported.results[0].report,report);
  await importReport(page,file);await check('psnr');await check('ssim');await check('vmaf');
  await page.locator('#bd-result').locator('..').screenshot({path:path.join(dir,'bd-rate.png')});
  assert.doesNotMatch(await page.locator('#bd-result').innerText(),/采样稀疏/);
  for(const crfs of ['18,36','18,27,36']){
    await page.locator('#trial-crfs').fill(crfs);report=(await runTask(page,app,'#trial')).report;
    const count=crfs.split(',').length, sparseDir=path.join(dir,`sparse-${count}`);
    await mkdir(sparseDir);await writeFile(path.join(sparseDir,'report.json'),JSON.stringify(report));
    for(const metric of ['psnr','ssim','vmaf']){
      await check(metric);assert.match(await page.locator('#bd-result').innerText(),/采样稀疏/);
    }
    const sparseFile=path.join(sparseDir,'export.json');await download(page,'#trial-export',sparseFile);
    await importReport(page,sparseFile);await check('psnr');
    assert.match(await page.locator('#bd-result').innerText(),/采样稀疏/);
    await page.locator('#bd-result').locator('..').screenshot({path:path.join(sparseDir,'bd-rate.png')});
  }
  await page.locator('#trial-crfs').fill('24');
  await runTask(page,app,'#trial');assert.match(await page.locator('#bd-result').innerText(),/至少需要 2 个/);
});

scenario('[packet-distribution] actual audio packets, optional rates and frame axes survive export/import with legacy fallback',async({page,app,dir})=>{
  const {report}=await analyze(page,app);
  assert.equal(await page.locator('#frame-plot canvas').count(),1,'video reuses the existing graph');
  assert.equal(await page.locator('#bitrate-optional').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#audio-packets-optional').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#audio-packets-1 canvas').isVisible(),false);
  await page.locator('#audio-packets-optional > summary').click();
  for(const track of report.tracks.filter(t=>t.type==='audio')){
    const id=`audio-packets-${track.index}`,d=track.packetDistribution;
    assert.ok(await page.locator(`#${id} canvas`).isVisible());
    assert.equal(await page.locator(`#${id} .plot-axis-y`).textContent(),`纵轴：包大小（${quantityScale(d.packets.map(row=>row[3])).unit}）`);
    assert.equal(d.packets.reduce((n,row)=>n+BigInt(row[3]),0n),BigInt(track.bytes));
    const unit=await page.locator(`#${id} .plot-axis-y`).textContent();
    await page.locator(`#${id} [data-op="in"]`).click();assert.equal(await page.locator(`#${id} .plot-axis-y`).textContent(),unit);
    await page.getByText(`音轨 #${track.index} 逐包列表 / CSV`,{exact:true}).click();
    const pending=page.waitForEvent('download');await page.locator(`#${id}-csv`).click();
    const csvFile=path.join(dir,`audio-${track.index}.csv`);await(await pending).saveAs(csvFile);
    const rows=(await readFile(csvFile,'utf8')).trim().split('\n');assert.equal(rows.length,d.count+1);
    assert.deepEqual(rows.slice(1).map(row=>row.split(',').slice(1,5)),d.packets.map(row=>row.map(v=>v??'')));
  }
  await page.locator('#frame-axis').selectOption('frame');assert.match(await page.locator('#frame-plot canvas').getAttribute('aria-label'),/显示帧/);
  await page.locator('#frame-axis').selectOption('time');
  await page.locator('#gop-next').click();assert.match(await page.locator('#frame-detail').innerText(),/6/);
  await page.locator('#frame-full').click();assert.equal(Number(await page.locator('#frame-plot [data-field="from"]').inputValue()),0);
  const file=path.join(dir,'packets-export.json'),exported=await download(page,'#inspect-export',file);
  assert.deepEqual(exported.results[0].report,report);
  await importReport(page,file);
  assert.equal(await page.locator('#frame-axis').inputValue(),'time');
  assert.equal(await page.locator('#audio-packets-optional').evaluate(el=>el.open),false);
  await page.locator('#audio-packets-optional > summary').click();
  assert.ok(await page.locator('#audio-packets-1 canvas').isVisible());
  assert.equal(await page.locator('#bitrate-optional').evaluate(el=>el.open),false);
  await page.screenshot({path:path.join(dir,'packet-distribution.png'),fullPage:true});
  const legacy=structuredClone(report);for(const track of legacy.tracks)delete track.packetDistribution;
  const legacyFile=path.join(dir,'legacy-packets.json');await saveImportFixture(legacyFile,legacy);
  await importReport(page,legacyFile);
  await page.locator('#audio-packets-optional > summary').click();
  assert.equal(await page.locator('[id^="audio-packets-"] canvas').count(),0);
  assert.equal(await page.getByText(/此旧报告未保存音轨逐包数据/).count(),2);
  await page.locator('#bitrate-optional > summary').click();assert.ok(await page.locator('#audio-1 canvas').isVisible());
  await page.screenshot({path:path.join(dir,'legacy-packet-distribution.png'),fullPage:true});
});

scenario('[portable] real export/import restores measured frames without queuing or changing the report',async({page,app,dir})=>{
  const {report}=await analyze(page,app),file=path.join(dir,'round-trip.json');
  const saved=await download(page,'#inspect-export',file);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#environment')?.textContent.includes('ffmpeg version'));
  const before=(await app.request('status')).jobs.length;
  await importReport(page,file);
  await page.locator('#inspect-details').getByRole('heading',{name:'帧结构与 GOP',exact:true}).waitFor();
  const restored=await download(page,'#inspect-export',path.join(dir,'restored.json'));
  assert.deepEqual(restored.results[0].report,report);assert.deepEqual(saved.results[0].report,report);
  assert.equal((await app.request('status')).jobs.length,before);
});

scenario('[portable-invalid] damaged real export is rejected and the currently visible measured report survives',async({page,app,dir})=>{
  const {report}=await analyze(page,app),file=path.join(dir,'original.json');
  const saved=await download(page,'#inspect-export',file);
  saved.schema='MediaScope/unsupported';const broken=path.join(dir,'deliberately-corrupted.json');
  await writeFile(broken,JSON.stringify(saved));await importReport(page,broken);
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
  await importReport(page,file);
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

scenario('[compact-task] an actual submission failure never reuses a hidden phase from the previous task',async({t,page,app})=>{
  if(!requireFeature(t,await page.locator('#toggle-island').count()>0,'compact task status'))return;
  await analyze(page,app);await page.locator('#toggle-island').click();
  await page.locator('[data-mode="compare"]').click();
  await page.locator('#reference').fill('does-not-exist.mp4');
  await page.locator('#candidate').fill(media.source);await page.locator('#confirm').check();await page.locator('#compare').click();
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
