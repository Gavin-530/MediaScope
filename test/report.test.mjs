import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {parseReport} from '../public/report.js';
import {makePortable,parsePortable} from '../public/portable.js';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {legacyFrameSample} from './helpers/basic-properties.mjs';
import {FF,run} from '../engine.mjs';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {sitiSceneSummary,SITI_COMPAT_PROFILE} from '../public/siti.js';
const sitiVectors=JSON.parse(await readFile(new URL('./reference/siti/vqeg-060.json',import.meta.url),'utf8'));
const historicalSiti=[...sitiVectors.historical,...JSON.parse(await readFile(new URL('./reference/siti/historical-v7.json',import.meta.url),'utf8')).snapshots];
const historicalKey=h=>`${h.id}:${h.case}`;
let app,reports={};
before(async()=>{
 const root=path.resolve('test-work/report-validation'),media=await makeMedia(path.join(root,'media'));
 app=await startServer(path.join(root,'reports'));
 reports.inspect=await app.request('probe','POST',{file:media.source});
 for(const input of [
  {type:'analyze',file:media.sitiSource,stream:0,complexity:true},
  {type:'compare',reference:media.source,candidate:media.candidate,refStream:0,candidateStream:0,confirm:true,metrics:['psnr','ssim','vmaf'],vmafModel:'vmaf_v0.6.1neg'},
  {type:'trial',file:media.source,stream:0,start:0,duration:1,encoder:'libx264',depthMode:'native',presets:['ultrafast'],crfs:[20,38],metrics:['psnr','ssim']}
 ]){
  const job=await app.request('jobs','POST',input),done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));reports[input.type]=await app.request(`jobs/${job.id}/report`);
 }
 const unknown=path.join(root,'undeclared.nut');
 const av1=path.join(root,'real-av1.mkv');
 await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=s=64x48:r=30:d=2','-c:v','libaom-av1','-cpu-used','8','-crf','0','-b:v','0','-threads:v','1','-color_range','tv','-color_trc','bt709',av1]);
 const av1Job=await app.request('jobs','POST',{type:'analyze',file:av1,stream:0,complexity:true,sitiSettings:{range:'tv',transfer:'sdr'}});
 const av1Done=await waitForJob(app.request,av1Job.id);assert.equal(av1Done.status,'done',av1Done.message);
 reports.av1=await app.request(`jobs/${av1Job.id}/report`);assert.ok(reports.av1.coding.events.length>=reports.av1.frames.length);assert.equal(reports.av1.content.points.length,reports.av1.frames.length);
 for(const history of historicalSiti){
  const c=sitiVectors.cases.find(c=>c.name===history.case),fixture=await sitiInputFixture(path.join(root,'media'),c);
  const job=await app.request('jobs','POST',{type:'analyze',file:fixture.file,stream:0,complexity:true,sitiSettings:c.settings});assert.equal((await waitForJob(app.request,job.id)).status,'done');reports[historicalKey(history)]=await app.request(`jobs/${job.id}/report`);
 }
 await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=s=96x64:r=4:d=1,format=yuv422p10le,setparams=range=unknown:color_primaries=unknown:color_trc=unknown:colorspace=unknown','-c:v','rawvideo','-pix_fmt','yuv422p10le','-f','nut',unknown]);
 for(const [name,input]of [
  ['undeclared',{type:'compare',reference:unknown,candidate:unknown,refStream:0,candidateStream:0,confirm:true,metrics:['vmaf']}],
  ['playback',{type:'compare',reference:media.source,candidate:media.candidate,refStream:0,candidateStream:0,confirm:true,timingMode:'playback-sample',playbackConfirmed:true,metrics:['vmaf']}],
  ['dual',{type:'trial',file:media.source,stream:0,start:0,duration:1,encoder:'libx264',depthMode:'both',presets:['ultrafast'],crfs:[28],metrics:['vmaf']}],
 ]){
  const job=await app.request('jobs','POST',input),done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));reports[name]=await app.request(`jobs/${job.id}/report`);
 }
});
after(async()=>{await app?.stop()});
test('all four actual report types round trip without altering measurements, tools or command evidence',()=>{
 for(const report of Object.values(reports)){assert.deepEqual(parseReport('\uFEFF'+JSON.stringify(report)),report);const wire=makePortable({results:[{entryId:'real',report}],applicationVersion:report.producer.applicationVersion});assert.deepEqual(parsePortable(JSON.stringify(wire)).results[0].report,report);}
 assert.equal(reports.analyze.content.points[0].ti,null);assert.equal(reports.analyze.content.execution.configuration.standard,'ITU-T P.910 (10/2023)');
});
test('historical SI/TI reports preserve their original method, settings and measured values',()=>{
 const report=structuredClone(reports.analyze);
 report.content.execution={...report.content.execution,method:'P910-2023-SDR-BT1886-text-v1',configuration:{profile:'P910-2023-SDR-BT1886-text-v1',standard:'ITU-T P.910 (10/2023)',inputBitDepth:8,inputRange:'tv',outputMultiplier:255,blackCdM2:.01}};
 assert.deepEqual(parseReport(JSON.stringify(report)),report);
});

test('SI/TI attempt evidence rejects contradictory devices, counts and timings while accepting older reports',()=>{
 const original=reports.analyze,e=original.content.execution;
 assert.equal(e.attempts.at(-1).framesComputed,original.frames.length);
 for(const damage of [a=>a.device='gpu',a=>a.framesComputed--,a=>a.elapsedSeconds=-1,a=>a.timeToFirstPointSeconds=a.elapsedSeconds+1,a=>a.outcome='failed']){
  const broken=structuredClone(original);damage(broken.content.execution.attempts.at(-1));assert.throws(()=>parseReport(JSON.stringify(broken)),/attempts/);
 }
 const legacy=structuredClone(original);delete legacy.content.execution.attempts;assert.deepEqual(parseReport(JSON.stringify(legacy)),legacy);
 const failed=structuredClone(original);failed.content={available:false,reason:'测试输入错误',errorPhase:'input',attempts:[{device:'gpu',workers:1,outcome:'failed',framesComputed:0,elapsedSeconds:.1,phase:'input',reason:'测试输入错误'}]};
 assert.deepEqual(parseReport(JSON.stringify(failed)),failed);
 failed.content.attempts[0].outcome='passed';assert.throws(()=>parseReport(JSON.stringify(failed)),/attempts/);
});

test('SI/TI new and frozen historical reports retain distinct formulas and reject damaged declarations',()=>{
 for(const snapshot of historicalSiti){
  const current=reports[historicalKey(snapshot)];assert.equal(current.content.execution.method,SITI_COMPAT_PROFILE);assert.equal(current.content.execution.configuration.configurationVersion,8);
  const historical=structuredClone(current),e=historical.content.execution,source=e.configuration.input.source;
  e.configuration=structuredClone(snapshot.configuration);e.configuration.input.source=source;e.method=e.configuration.profile;
  historical.content.points=historical.content.points.map((p,i)=>({...p,...snapshot.expected[i]}));Object.assign(historical.content,sitiSceneSummary(historical.content.points));historical.content.notes=['历史计算口径；保留原值。'];
  assert.deepEqual(parseReport(JSON.stringify(historical)),historical);assert.notDeepEqual(historical.content.execution.configuration,current.content.execution.configuration);
  for(const report of [current,historical])for(const damage of [c=>c.display.gamma+=.01,c=>c.outputMultiplier++,c=>c.profile='changed',c=>c.configurationVersion=99]){const broken=structuredClone(report);damage(broken.content.execution.configuration);assert.throws(()=>parseReport(JSON.stringify(broken)),/配置|configuration/)}
 }
 for(const damage of [c=>c.display.blackCdM2=.01,c=>c.inputAdapter.extendedBitDepth=true,c=>c.referenceAgreement='changed']){const broken=structuredClone(reports.analyze);damage(broken.content.execution.configuration);assert.throws(()=>parseReport(JSON.stringify(broken)),/配置|configuration/)}
});
test('real report parser rejects unknown versions and deliberately removed required structures',()=>{
 for(const report of Object.values(reports))assert.throws(()=>parseReport(JSON.stringify({...report,schema:'MediaScope/unsupported'})),/版本/);
 for(const [type,key] of [['inspect','raw'],['analyze','frames'],['compare','alignment'],['trial','rows']]){
  const damaged=structuredClone(reports[type]);delete damaged[key];assert.throws(()=>parseReport(JSON.stringify(damaged)),new RegExp(key));
 }
});
test('truncating real per-frame metrics or damaging measured GOP/time boundaries is rejected',()=>{
 const compare=structuredClone(reports.compare);compare.metrics.psnr.values.pop();assert.throws(()=>parseReport(JSON.stringify(compare)),/length/);
 const trial=structuredClone(reports.trial);trial.rows[0].metrics.psnr.values.pop();assert.throws(()=>parseReport(JSON.stringify(trial)),/length/);
 const times=structuredClone(reports.trial);times.experiment.frameTimes[1]=times.experiment.frameTimes[0];assert.throws(()=>parseReport(JSON.stringify(times)),/frameTimes/);
 const analyze=structuredClone(reports.analyze);analyze.coding.gops[0].end=analyze.frames.length;assert.throws(()=>parseReport(JSON.stringify(analyze)),/coding.gops/);
 for(const damage of [r=>r.frames.forEach(f=>delete f.bytes),r=>r.summary.count++,r=>r.coding.packets.forEach(p=>delete p.pts),r=>r.coding.events.forEach(e=>delete e.fields)]){
  const broken=structuredClone(reports.av1);damage(broken);assert.throws(()=>parseReport(JSON.stringify(broken)),/frames|summary|coding/);
 }
 for(const [path,key]of [[['frames'],'bytes'],[['coding','events'],'fields']]){
  const wire=makePortable({results:[{entryId:'damaged',report:reports.av1}],applicationVersion:reports.av1.producer.applicationVersion});
  let table=wire.results[0].report;for(const p of path)table=table[p];
  const column=table.columns.indexOf(key);
  if(column>=0){table.columns.splice(column,1);for(const row of table.rows)row.splice(column,1);}else delete table.constants[key];
  assert.throws(()=>parsePortable(JSON.stringify(wire)),/frames|coding/);
 }
 for(const damage of [r=>r.frames[0].packetIndex=r.coding.packets.length,r=>r.frames[0].eventId=r.coding.events.length,r=>r.coding.events[0].packet=r.coding.packets.length,r=>r.coding.packets[0].eventIds.push(r.coding.events.length)]){
  const broken=structuredClone(reports.av1);damage(broken);assert.throws(()=>parseReport(JSON.stringify(broken)),/packetIndex|eventId|coding/);
 }
});
test('future nonmeasurement fields survive parsing and malformed JSON is rejected',()=>{
 const extended={...reports.inspect,futureField:{note:'parser preservation contract'}};
 assert.deepEqual(parseReport(JSON.stringify(extended)),extended);assert.throws(()=>parseReport('{'),/JSON/);
});

test('VMAF report verifies actual model, configuration and official log while preserving older reports',()=>{
 const report=reports.compare;
 for(const damage of [m=>m.pooled+=1,m=>m.configuration.pool='harmonic_mean',m=>m.configuration.model.version='vmaf_4k_v0.6.1',
  m=>delete m.configuration.libraryVersion,m=>m.officialSummary.mean+=1,m=>m.values[0]+=1,m=>m.raw='{}']){
  const broken=structuredClone(report);damage(broken.metrics.vmaf);assert.throws(()=>parseReport(JSON.stringify(broken)),/vmaf/);
 }
 const old=structuredClone(report);delete old.metrics.vmaf.configuration;delete old.metrics.vmaf.officialSummary;
 assert.deepEqual(parseReport(JSON.stringify(old)),old);
 const previous=structuredClone(report),c=previous.metrics.vmaf.configuration;
 delete c.configurationVersion;delete c.evaluation;delete c.input.chromaLocation;delete c.input.fieldOrder;
 c.interpretation='旧版模型观看条件说明';assert.deepEqual(parseReport(JSON.stringify(previous)),previous);
});

test('PSNR and SSIM reports preserve official aggregate precision and reject altered summaries while accepting legacy reports',()=>{
 for(const original of [reports.compare,reports.trial])for(const metric of ['psnr','ssim']){
  const select=report=>report.metrics?.[metric]??report.rows[0].metrics[metric];
  const measured=select(original);assert.equal(measured.pooled,measured.officialSummary.pooled);
  assert.deepEqual(measured.components,measured.officialSummary.components);
  for(const damage of [m=>m.pooled+=0.000001,m=>m.components.y+=0.000001,m=>m.officialSummary.pooled+=0.000001,
   m=>m.officialSummary.components.y+=0.000001,m=>delete m.officialSummary.components.y,m=>m.officialSummary.raw='',m=>m.officialSummary.raw+=' extra']){
   const broken=structuredClone(original);damage(select(broken));assert.throws(()=>parseReport(JSON.stringify(broken)),new RegExp(metric));
  }
  const legacy=structuredClone(original);delete select(legacy).officialSummary;
  assert.deepEqual(parseReport(JSON.stringify(legacy)),legacy);
 }
});

test('VMAF undeclared, sampled and common-depth reports preserve interpretation and reject contradictory processing evidence',()=>{
 for(const name of ['undeclared','playback','dual'])assert.deepEqual(parseReport(JSON.stringify(reports[name])),reports[name]);
 assert.match(reports.undeclared.metrics.vmaf.configuration.interpretation,/未声明/);
 assert.match(reports.playback.metrics.vmaf.configuration.preprocessing,/playback sampling/);
 assert.ok(reports.dual.rows.every(row=>row.metrics.vmaf.configuration.input.pixelFormat==='yuv420p10le'));
 for(const name of ['undeclared','playback','dual']){
  const broken=structuredClone(reports[name]),m=broken.metrics?.vmaf??broken.rows[0].metrics.vmaf;
  m.configuration.evaluation.crossDepth=!m.configuration.evaluation.crossDepth;
  assert.throws(()=>parseReport(JSON.stringify(broken)),/vmaf/);
 }
});

test('[packet-distribution] real audio evidence round trips, legacy omission remains valid and damaged records are rejected',()=>{
 const report=reports.analyze,tracks=report.tracks.filter(t=>t.type==='audio');assert.equal(tracks.length,2);
 assert.ok(tracks.every(t=>t.packetDistribution.packets.length===t.count));
 assert.deepEqual(parseReport(JSON.stringify(report)),report);
 const legacy=structuredClone(report);for(const track of legacy.tracks)delete track.packetDistribution;
 assert.deepEqual(parseReport(JSON.stringify(legacy)),legacy);
 for(const change of [d=>d.count++,d=>d.packets[0][3]='-1',d=>d.packets[0][0]=0]){
  const broken=structuredClone(report);change(broken.tracks.find(t=>t.type==='audio').packetDistribution);
  assert.throws(()=>parseReport(JSON.stringify(broken)),/音轨逐包/);
 }
 const broken=structuredClone(report);broken.tracks.find(t=>t.type==='audio').packetDistribution=null;
 assert.throws(()=>parseReport(JSON.stringify(broken)),/音轨逐包/);
});
test('[basic-properties] new descriptors and explicit no-sampling status preserve legacy sample reports',async()=>{
 const current=reports.inspect;assert.ok(current.pixelFormats.raw.pixel_formats.length);assert.equal(current.frameSample,null);
 assert.equal(current.frameSampleRead.status,'not-requested');
 assert.deepEqual(parseReport(JSON.stringify(current)),current);
 const sample=await legacyFrameSample(current.file,current.raw.streams),legacy={...current,...sample};
 assert.ok(legacy.frameSample.frames.length);assert.deepEqual(parseReport(JSON.stringify(legacy)),legacy);
 for(const schema of ['MediaScope/0.1','MediaScope/0.2']){
  const old=structuredClone(legacy);old.schema=schema;delete old.pixelFormats;delete old.frameSampleRead;
  assert.throws(()=>parseReport(JSON.stringify(old)),/版本/);
 }
 const damaged=structuredClone(legacy);damaged.frameSampleRead.tracks[0].count++;
 assert.throws(()=>parseReport(JSON.stringify(damaged)),/frameSampleRead.tracks.count/);
 const failed={...legacy,frameSample:null,frameSampleRead:{status:'failed',error:'Specified failure status for report parsing; not a measured failure',tracks:legacy.frameSampleRead.tracks.map(t=>({...t,status:'failed',count:0})),commands:[]}};
 assert.deepEqual(parseReport(JSON.stringify(failed)),failed);
 const contradictory=structuredClone(legacy);contradictory.frameSampleRead.tracks[0].status='empty';
 assert.throws(()=>parseReport(JSON.stringify(contradictory)),/frameSampleRead.tracks.status/);
 const falseNoSample={...current,frameSample:legacy.frameSample};
 assert.throws(()=>parseReport(JSON.stringify(falseNoSample)),/frameSampleRead.status/);
});
