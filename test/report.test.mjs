import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseReport} from '../public/report.js';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
import {legacyFrameSample} from './helpers/basic-properties.mjs';
let app,reports={};
before(async()=>{
 const root=path.resolve('test-work/report-validation'),media=await makeMedia(path.join(root,'media'));
 app=await startServer(path.join(root,'reports'));
 reports.inspect=await app.request('probe','POST',{file:media.source});
 for(const input of [
  {type:'analyze',file:media.source,stream:0,complexity:true},
  {type:'compare',reference:media.source,candidate:media.candidate,refStream:0,candidateStream:0,confirm:true,metrics:['psnr','ssim']},
  {type:'trial',file:media.source,stream:0,start:0,duration:1,encoder:'libx264',depthMode:'native',presets:['ultrafast'],crfs:[20,38],metrics:['psnr','ssim']}
 ]){
  const job=await app.request('jobs','POST',input),done=await waitForJob(app.request,job.id);
  assert.equal(done.status,'done',JSON.stringify(done));reports[input.type]=await app.request(`jobs/${job.id}/report`);
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
