import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {MAX_ANALYSIS_FRAMES,MAX_SITI_PIXELS,validateSitiDimensions} from '../../../public/analysis-limits.js';
import {sitiInput,validateSitiSceneStarts} from '../../../public/siti.js';
import {measureSiti,sitiGpuRequest} from '../../helpers/subject.mjs';
const test=projectTest(import.meta.url);

test('SI/TI admission validates dimensional and scene boundaries without allocating a maximum workload',()=>{
 const h=Math.floor(MAX_SITI_PIXELS/3);
 for(const [w,height]of [[3,3],[3,h],[h,3]])validateSitiDimensions(w,height);
 for(const [w,height]of [[2,3],[3,h+1],[h+1,3],[NaN,3],[3,3.5],[Infinity,3],[0,3]])assert.throws(()=>validateSitiDimensions(w,height));
 validateSitiSceneStarts([0,MAX_ANALYSIS_FRAMES-1],MAX_ANALYSIS_FRAMES);
 for(const starts of [[0,MAX_ANALYSIS_FRAMES],[0,1,1],[1],[],[0,-1],[0,.5]])assert.throws(()=>validateSitiSceneStarts(starts,MAX_ANALYSIS_FRAMES));
 const input=sitiInput({pix_fmt:'gray',color_range:'pc',color_transfer:'smpte2084',field_order:'progressive'},{range:'pc',transfer:'pq'});
 const request=sitiGpuRequest(input,3,3,2,[0]);
 assert.deepEqual(request.header.slice(0,4),[3,3,2,'0']);assert.equal(request.bytes,9);
 // Dimension admission belongs to validateSitiDimensions/measureRun.
 assert.equal(request.header[4],input.format.storage);
});

test('SI/TI invalid frame counts and device settings stop before any decoder starts',async()=>{
 const stream={pix_fmt:'gray',width:3,height:3,color_range:'pc',color_transfer:'smpte2084',field_order:'progressive'};
 const settings={sitiSettings:{range:'pc',transfer:'pq'}};
 for(const frames of [[],new Array(MAX_ANALYSIS_FRAMES+1),{length:1}]){
  const commands=[];
  await assert.rejects(measureSiti('not-opened.mkv',stream,{...settings,commands},frames),e=>e.sitiPhase==='input'&&/单轨支持/.test(e.message));
  assert.equal(commands.length,0);
 }
 const commands=[];
 await assert.rejects(measureSiti('not-opened.mkv',stream,{...settings,commands,sitiDevice:'invalid'},[{best_effort_timestamp_time:'0'}]),e=>e.sitiPhase==='input'&&/计算设备无效/.test(e.message));
 assert.equal(commands.length,0);
});
