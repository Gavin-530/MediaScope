import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {parseReport} from '../public/report.js';
import {makeMedia} from './helpers/real-media.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';
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
