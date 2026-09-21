import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trialFramePlotData,rowLabel,sortTrialRows} from '../public/trial-model.js';
import {finiteSegments,extent,visiblePoints} from '../public/charts.js';
const row=(preset,bitDepth,crf,values)=>({preset,bitDepth,crf,metrics:{psnr:{values}}});
const rows=[row('fast',8,20,[40,41,42]),row('fast',8,30,[35,'Infinity',null]),row('slow',8,20,[43,44,45]),row('fast',10,20,[46,47,48])];
test('CRF overlay fixes preset and depth, honors selected CRFs, and preserves variable timestamps',()=>{
 const result=trialFramePlotData(rows,'psnr',rowLabel(rows[0]),[20,30],[0,.041,.12]);
 assert.equal(result.timed,true);assert.equal(result.series.length,2);
 assert.deepEqual(result.data.map(p=>p[0]),[0,0,.041,.041,.12,.12]);
 assert.deepEqual(result.data.map(p=>p[1]),[40,35,41,null,42,null]);
 assert.equal(result.data[3][2].value,'Infinity');assert.equal(result.data[5][2].value,null);
 const single=trialFramePlotData(rows,'psnr',rowLabel(rows[0]),[30],[0,.041,.12]);
 assert.equal(single.series[0].color,result.series[1].color);assert.equal(single.data.length,3);
 assert.equal(trialFramePlotData(rows,'psnr',rowLabel(rows[0]),[],[]).data.length,0);
});
test('old reports use frame indices; absent metrics are reported without generated values',()=>{
 for(const times of [undefined,[],[0,.1],[0,.1,.1]]){
  const result=trialFramePlotData(rows,'psnr',rowLabel(rows[0]),[20],times);
  assert.equal(result.timed,false);assert.deepEqual(result.data.map(p=>p[0]),[0,1,2]);
 }
 const missing=trialFramePlotData(rows,'vmaf',rowLabel(rows[0]),[20,30],[0,.041,.12]);assert.deepEqual(missing.missing,[20,30]);assert.deepEqual(missing.data,[]);
});
test('line segments never bridge unavailable or infinite measurements',()=>{
 const points=[[0,1],[1,null],[2,3],[3,Infinity],[4,5],[5,6]];
 assert.deepEqual(finiteSegments(points),[[[0,1]],[[2,3]],[[4,5],[5,6]]]);
 assert.deepEqual(extent(points),[1,6]);assert.deepEqual(extent([[0,null]]),[0,1]);
 assert.deepEqual(visiblePoints([[0,1],[1,2],[1,3],[2,4]],1,1),[[1,2],[1,3]]);
});
test('sample rows sort without mutation and keep missing metrics last',()=>{
 const samples=[
  {...row('slow',10,26,[1]),videoBytes:300,encodeSeconds:2,metrics:{psnr:{pooled:40},vmaf:{pooled:undefined}}},
  {...row('fast',8,20,[1]),videoBytes:500,encodeSeconds:1,metrics:{psnr:{pooled:'Infinity'},vmaf:{pooled:95}}},
  {...row('fast',8,32,[1]),videoBytes:200,encodeSeconds:3,metrics:{psnr:{pooled:35},vmaf:{pooled:80}}}
 ];
 const original=[...samples];
 assert.deepEqual(sortTrialRows(samples,'videoBytes','asc').map(x=>x.videoBytes),[200,300,500]);
 assert.deepEqual(sortTrialRows(samples,'psnr','desc').map(x=>x.metrics.psnr.pooled),['Infinity',40,35]);
 assert.deepEqual(sortTrialRows(samples,'vmaf','desc').map(x=>x.metrics.vmaf.pooled),[95,80,undefined]);
 assert.deepEqual(sortTrialRows(samples,'group','asc').map(rowLabel),['8-bit / fast','8-bit / fast','10-bit / slow']);
 assert.deepEqual(samples,original);
});
