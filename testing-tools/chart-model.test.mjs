import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {trialFramePlotData,rowLabel,sortTrialRows} from '../public/trial-model.js';
import {finiteSegments,extent,countTicks,validYRange,visiblePoints} from '../public/charts.js';
import {makeMedia} from './helpers/real-media.mjs';
import {trial} from '../analysis.mjs';
let rows,times;
before(async()=>{
 const root=path.resolve('.build/testing-work/chart-model'),media=await makeMedia(root),commands=[];
 const report=await trial({file:media.source,stream:0,start:0,duration:1,encoder:'libx264',depthMode:'native',presets:['ultrafast','fast'],crfs:[20,38],metrics:['psnr','ssim']},{cwd:root,commands,update:()=>{}});
 await writeFile(path.join(root,'measured-trial.json'),JSON.stringify({report,commands},null,2));
 rows=report.rows;times=report.experiment.frameTimes;
});
test('CRF chart retains every real trial timestamp and measured value within the selected group',()=>{
 const group=rowLabel(rows[0]),selected=rows.filter(r=>rowLabel(r)===group),result=trialFramePlotData(rows,'psnr',group,[20,38],times);
 assert.equal(result.timed,true);assert.equal(result.series.length,2);assert.equal(result.data.length,times.length*2);
 for(const [time,value,metadata] of result.data){
  const row=selected.find(r=>r.crf===metadata.crf);
  assert.equal(time,times[metadata.frame]);assert.equal(metadata.value,row.metrics.psnr.values[metadata.frame]);assert.equal(value,metadata.value);
 }
 const single=trialFramePlotData(rows,'psnr',group,[38],times);
 assert.equal(single.series[0].color,result.series[1].color);assert.equal(single.data.length,times.length);
 assert.equal(trialFramePlotData(rows,'psnr',group,[],times).data.length,0);
});
test('old reports use frame indices; absent metrics are reported without generated values',()=>{
 for(const damagedTimes of [undefined,[],times.slice(1),times.map(()=>0)]){
  const result=trialFramePlotData(rows,'psnr',rowLabel(rows[0]),[20],damagedTimes);
  assert.equal(result.timed,false);assert.deepEqual(result.data.map(p=>p[0]),times.map((_,i)=>i));
 }
 const missing=trialFramePlotData(rows,'vmaf',rowLabel(rows[0]),[20,38],times);assert.deepEqual(missing.missing,[20,38]);assert.deepEqual(missing.data,[]);
});
test('[contract] geometry never bridges missing or infinite inputs',()=>{
 // Mathematical boundary inputs, not fabricated media measurements.
 const points=[[0,1],[1,null],[2,3],[3,Infinity],[4,5],[5,6]];
 assert.deepEqual(finiteSegments(points),[[[0,1]],[[2,3]],[[4,5],[5,6]]]);
 assert.deepEqual(extent(points),[1,6]);assert.deepEqual(extent([[0,null]]),[0,1]);
 assert.deepEqual(visiblePoints([[0,1],[1,2],[1,3],[2,4]],1,1),[[1,2],[1,3]]);
});
test('[charts] count ticks cover integer observations without fractional labels or a truncated baseline',()=>{
 // Mathematical count-axis contracts, not fabricated video measurements.
 assert.deepEqual(countTicks(0),[0,1]);assert.deepEqual(countTicks(1),[0,1]);
 assert.deepEqual(countTicks(9),[0,2,4,6,8,10]);
 assert.deepEqual(countTicks(25),[0,5,10,15,20,25]);
 assert.deepEqual(countTicks(7,3),[3,4,5,6,7]);
 assert.deepEqual(countTicks(8.5,2.5).filter(value=>value>=2.5&&value<=8.5),[4,6,8]);
 for(const maximum of [...Array.from({length:2049},(_,i)=>i),10000,1000000,2000000]){
  const ticks=countTicks(maximum);
  assert.equal(ticks[0],0);assert.ok(ticks.at(-1)>=maximum);
  assert.ok(ticks.length>=2&&ticks.length<=6);
  assert.ok(ticks.every(Number.isSafeInteger));
  for(let i=1;i<ticks.length;i++)assert.ok(ticks[i]>ticks[i-1]);
 }
 assert.deepEqual(extent([[0,1],[1,1]],true),[0,1]);
 assert.deepEqual(extent([[0,.25],[1,.75]]),[.25,.75],'continuous measurements keep their fractional range');
});
test('[charts] explicit Y bounds accept finite ordered ranges and reject missing, equal, reversed or overflowing ranges',()=>{
 for(const range of [[3,7],[.25,.75],[-5,-1],[0,1e-10]])assert.equal(validYRange(...range),true);
 for(const range of [[NaN,1],[0,Infinity],[0,0],[2,1],[-Number.MAX_VALUE,Number.MAX_VALUE]])assert.equal(validYRange(...range),false);
});
test('sorts real trial bytes and scores without mutating the source report',()=>{
 const original=structuredClone(rows),bytes=sortTrialRows(rows,'videoBytes','asc'),psnr=sortTrialRows(rows,'psnr','desc');
 assert.equal(bytes.length,rows.length);assert.equal(bytes[0].videoBytes,Math.min(...rows.map(r=>r.videoBytes)));
 assert.equal(bytes.at(-1).videoBytes,Math.max(...rows.map(r=>r.videoBytes)));
 assert.equal(psnr[0].metrics.psnr.pooled,Math.max(...rows.map(r=>r.metrics.psnr.pooled)));
 for(let i=1;i<bytes.length;i++)assert.ok(bytes[i].videoBytes>=bytes[i-1].videoBytes);
 for(let i=1;i<psnr.length;i++)assert.ok(psnr[i].metrics.psnr.pooled<=psnr[i-1].metrics.psnr.pooled);
 assert.deepEqual(rows,original);
});
