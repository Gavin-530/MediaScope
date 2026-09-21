import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiWorkerCount} from '../siti.mjs';

test('frame parallel SI/TI exactly preserves every sample and aggregate',async()=>{
  await mkdir('test-work',{recursive:true});
  const dir=await mkdtemp(path.resolve('test-work/siti-parallel-'));
  for(const [name,pix,codec,extra] of [
    ['eight','yuv420p','libx264',['-x264-params','open-gop=1:keyint=24:min-keyint=24:scenecut=0']],
    ['ten-vfr','yuv420p10le','ffv1',[]],
    ['av1','yuv420p','libaom-av1',['-cpu-used','8']],
    ['hevc','yuv420p10le','libx265',['-preset','ultrafast','-x265-params','open-gop=1:keyint=24:min-keyint=24:scenecut=0']],
    ['full-range','yuv420p','ffv1',[]],
  ]){
    const file=path.join(dir,name+'.mkv');
    const filter=name==='ten-vfr'?"setpts='if(lt(N,37),N,2*N-37)/(24*TB)',setparams=range=limited:color_trc=smpte2084":name==='full-range'?'setparams=range=full':'null';
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=96x64:rate=24:duration=4,format=${pix}`,'-vf',filter,'-fps_mode','passthrough','-c:v',codec,...extra,file]);
    const stream={index:0,width:96,height:64,pix_fmt:pix},frames=await scan(file,0);
    const serial=await complexity(file,stream,{sitiWorkers:1},frames);
    const parallel=await complexity(file,stream,{sitiWorkers:3},frames);
    assert.deepEqual({requestedWorkers:serial.execution.requestedWorkers,setting:serial.execution.setting},{requestedWorkers:1,setting:'manual'});
    assert.deepEqual({requestedWorkers:parallel.execution.requestedWorkers,setting:parallel.execution.setting},{requestedWorkers:3,setting:'manual'});
    assert.equal(parallel.execution.workers,sitiWorkerCount(stream,frames.length,3));
    assert.equal(parallel.execution.fallbackReason,undefined,name);
    assert.deepEqual(parallel.points,serial.points,name);
    assert.deepEqual(parallel.si,serial.si,name);
    assert.deepEqual(parallel.ti,serial.ti,name);
    assert.equal(parallel.ti.count,frames.length-1);
    if(name==='eight'){
      const fallback=await complexity(file,stream,{sitiWorkers:3},frames.slice(0,-1));
      if(sitiWorkerCount(stream,95,3)>1)assert.match(fallback.execution.fallbackReason,/帧数/);
      assert.deepEqual(fallback.points,serial.points);
      const controller=new AbortController();controller.abort();
      await assert.rejects(complexity(file,stream,{signal:controller.signal},frames),/取消/);
      const active=new AbortController(),commands=[];
      const work=complexity(file,stream,{signal:active.signal,commands,sitiWorkers:3},frames);
      active.abort();
      await assert.rejects(work);
      assert.equal(commands.length,sitiWorkerCount(stream,frames.length,3),'cancellation must not start serial fallback');
    }
  }
});

test('unknown counts, tiny clips and explicit serial mode remain serial',()=>{
  const stream={width:1920,height:1080};
  assert.equal(sitiWorkerCount(stream,undefined),1);
  assert.equal(sitiWorkerCount(stream,1),1);
  assert.equal(sitiWorkerCount(stream,1000,1),1);
});
