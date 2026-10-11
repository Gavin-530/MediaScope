import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiWorkerCount} from '../siti.mjs';
import {sitiTimestamp,validateSitiPoints} from '../siti-validation.mjs';

test('SI/TI common validation rejects incomplete or invalid frame results',()=>{
  // Explicit boundary data for the validator, not simulated media-tool output.
  const points=[{frame:0,t:0,si:12,ti:0},{frame:1,t:1/24,si:13,ti:2}],frames=[{t:0},{t:0.041667}];
  assert.doesNotThrow(()=>validateSitiPoints(points,frames));
  assert.doesNotThrow(()=>validateSitiPoints(points));
  for(const invalid of [[],points.slice(0,1),[...points,{frame:2,t:1/12,si:14,ti:3}]])assert.throws(()=>validateSitiPoints(invalid,frames),/帧数/);
  assert.throws(()=>validateSitiPoints(points,[]),/帧数/);
  for(const [index,key,value,reason] of [[1,'frame',0,/序号/],[1,'t',NaN,/时间戳/],[1,'t',Infinity,/时间戳/],[1,'si',NaN,/指标/],[1,'ti',Infinity,/指标/],[1,'si',-1,/指标/],[1,'ti',-1,/指标/],[0,'ti',1,/首帧/]]){
    const invalid=structuredClone(points);invalid[index][key]=value;assert.throws(()=>validateSitiPoints(invalid,frames),reason);
  }
  assert.throws(()=>validateSitiPoints(points,[{t:0},{t:null}]),/预扫描.*时间戳/);
  assert.throws(()=>validateSitiPoints(points,[{t:0},{t:0.05}]),/时间戳与预扫描/);
  assert.doesNotThrow(()=>validateSitiPoints([{frame:0,t:7200.001,si:12,ti:0}],[{t:7200.001}]));
  assert.equal(sitiTimestamp('7200001','1/1000'),7200.001);
  assert.equal(sitiTimestamp('-1000','1/1000'),-1);
  assert.ok(Math.abs(sitiTimestamp('1001','1/30000')-1001/30000)<Number.EPSILON);
  for(const [pts,base] of [['N/A','1/1000'],['9007199254740993','1/1000'],['1',null],['1','0/1000'],['1','1/0']])assert.throws(()=>sitiTimestamp(pts,base),/PTS 或时间基/);
});

test('frame parallel SI/TI exactly preserves every sample and aggregate',async()=>{
  await mkdir('test-work',{recursive:true});
  const dir=await mkdtemp(path.resolve('test-work/siti-parallel-'));
  for(const [name,pix,codec,extra] of [
    ['eight','yuv420p','libx264',['-x264-params','open-gop=1:keyint=24:min-keyint=24:scenecut=0']],
    ['ten-vfr','yuv420p10le','ffv1',[]],
    ['av1','yuv420p','libaom-av1',['-cpu-used','8']],
    ['hevc','yuv420p10le','libx265',['-preset','ultrafast','-x265-params','open-gop=1:keyint=24:min-keyint=24:scenecut=0']],
    ['full-range','yuv420p','ffv1',[]],
    ['offset-vfr','yuv420p','ffv1',[]],
  ]){
    const file=path.join(dir,name+'.mkv');
    const filter=name==='ten-vfr'?"setpts='if(lt(N,37),N,2*N-37)/(24*TB)',setparams=range=limited:color_trc=smpte2084":name==='full-range'?'setparams=range=full':name==='offset-vfr'?"setpts='(N+floor(N/7))/(24*TB)+7200/TB'":'null';
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=96x64:rate=24:duration=${name==='offset-vfr'?6:4},format=${pix}`,'-vf',filter,'-fps_mode','passthrough','-c:v',codec,...extra,file]);
    const stream=(await probe(file)).raw.streams[0],frames=await scan(file,0),requestedWorkers=name==='offset-vfr'?4:3;
    const serial=await complexity(file,stream,{sitiWorkers:1},frames);
    const parallel=await complexity(file,stream,{sitiWorkers:requestedWorkers},frames);
    await writeFile(path.join(dir,name+'.json'),JSON.stringify({serial,parallel},null,2));
    assert.deepEqual({requestedWorkers:serial.execution.requestedWorkers,setting:serial.execution.setting},{requestedWorkers:1,setting:'manual'});
    assert.deepEqual({requestedWorkers:parallel.execution.requestedWorkers,setting:parallel.execution.setting},{requestedWorkers,setting:'manual'});
    assert.equal(parallel.execution.workers,sitiWorkerCount(stream,frames.length,requestedWorkers));
    assert.equal(parallel.execution.fallbackReason,undefined,name);
    assert.deepEqual(parallel.points,serial.points,name);
    assert.deepEqual(parallel.si,serial.si,name);
    assert.deepEqual(parallel.ti,serial.ti,name);
    assert.equal(parallel.ti.count,frames.length-1);
    validateSitiPoints(serial.points,frames);
    if(name==='offset-vfr'){
      assert.equal(serial.points[0].t,7200);
      assert.ok(serial.points.some(p=>p.t*100%1!==0),'retain sub-centisecond precision at long timestamps');
      const deltas=frames.slice(1).map((f,i)=>Math.round((f.t-frames[i].t)*1000));
      assert.ok(new Set(deltas).size>1,'fixture must have a variable frame rate');
    }
    if(name==='eight'){
      for(const sitiWorkers of [1,4]){
        for(const invalid of [[],frames.slice(0,-1),[...frames,frames.at(-1)]]){
          const commands=[];
          await assert.rejects(complexity(file,stream,{sitiWorkers,commands},invalid),/帧数/);
          assert.equal(commands.length,sitiWorkerCount(stream,invalid.length,sitiWorkers)+(sitiWorkerCount(stream,invalid.length,sitiWorkers)>1?1:0),'invalid count must also be rejected after serial recovery');
        }
        const shifted=structuredClone(frames);shifted[1].t+=0.01;
        await assert.rejects(complexity(file,stream,{sitiWorkers},shifted),/时间戳与预扫描/);
        const missing=structuredClone(frames);missing[1].t=null;
        await assert.rejects(complexity(file,stream,{sitiWorkers},missing),/预扫描.*时间戳/);
      }
      const controller=new AbortController();controller.abort();
      await assert.rejects(complexity(file,stream,{signal:controller.signal},frames),/取消/);
      const active=new AbortController(),commands=[];
      const work=complexity(file,stream,{signal:active.signal,commands,sitiWorkers:3},frames);
      active.abort();
      await assert.rejects(work);
      assert.equal(commands.length,sitiWorkerCount(stream,frames.length,3),'cancellation must not start serial fallback');
    }
  }
  assert.ok(path.resolve(dir).startsWith(path.resolve('test-work')+path.sep),'fixture must stay inside test-work');
  for(const name of ['eight','ten-vfr','av1','hevc','full-range','offset-vfr'])await unlink(path.join(dir,name+'.mkv'));
});

test('unknown counts, tiny clips and explicit serial mode remain serial',()=>{
  const stream={width:1920,height:1080};
  assert.equal(sitiWorkerCount(stream,undefined),1);
  assert.equal(sitiWorkerCount(stream,1),1);
  assert.equal(sitiWorkerCount(stream,1000,1),1);
});
