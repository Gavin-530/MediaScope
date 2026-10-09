import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseReport} from '../public/report.js';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {legacyFrameSample} from './helpers/basic-properties.mjs';
import {FF,run} from '../engine.mjs';
let app,reports={};
before(async()=>{
 const root=path.resolve('test-work/report-validation'),media=await makeMedia(path.join(root,'media'));
 app=await startServer(path.join(root,'reports'));
 reports.inspect=await app.request('probe','POST',{file:media.source});
 for(const input of [
  {type:'analyze',file:media.source,stream:0,complexity:true},
  {type:'compare',reference:media.source,candidate:media.candidate,refStream:0,candidateStream:0,confirm:true,metrics:['psnr','ssim','vmaf'],vmafModel:'vmaf_v0.6.1neg'},
  {type:'trial',file:media.source,stream:0,start:0,duration:1,encoder:'libx264',depthMode:'native',presets:['ultrafast'],crfs:[20,38],metrics:['psnr','ssim']}
 ]){
  const job=await app.request('jobs','POST',input),done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));reports[input.type]=await app.request(`jobs/${job.id}/report`);
 }
 const unknown=path.join(root,'undeclared.nut');
 await run(FF,['-v','error','-f','lavfi','-i','testsrc2=s=96x64:r=4:d=1,format=yuv422p10le,setparams=range=unknown:color_primaries=unknown:color_trc=unknown:colorspace=unknown','-c:v','rawvideo','-pix_fmt','yuv422p10le','-f','nut',unknown]);
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
 for(const report of Object.values(reports))assert.deepEqual(parseReport('\uFEFF'+JSON.stringify(report)),report);
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
  assert.deepEqual(parseReport(JSON.stringify(old)),old);
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
