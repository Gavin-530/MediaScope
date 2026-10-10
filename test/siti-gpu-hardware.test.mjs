import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiGpuCapability} from '../siti-gpu.mjs';

test('GPU SI/TI hardware validates real frames against CPU without accepting CPU fallback',{timeout:180000},async t=>{
  const ctx={signal:t.signal};
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-gpu-'));
  const evidence={outcome:'running',phase:'probe',cases:[]};
  const save=()=>writeFile(path.join(dir,'hardware-equivalence.json'),JSON.stringify(evidence,null,2));
  await save();t.diagnostic('Required real GPU capability and numerical self-test');
  const capability=await sitiGpuCapability(ctx);evidence.capability=capability;await save();
  assert.equal(capability.available,true,`Real GPU required: ${capability.reason||'unavailable'}`);
  for(const [name,pix,range,codec] of [
    ['eight','yuv420p','limited','libx264'],['ten-vfr','yuv420p10le','limited','ffv1'],
    ['full','yuv420p','full','ffv1'],['ten-full','yuv422p10le','full','ffv1'],
    ['av1','yuv420p','limited','libaom-av1'],['hevc','yuv420p10le','limited','libx265'],['hd','yuv420p','limited','libx264'],
  ]){
    const file=path.join(dir,name+'.mkv');
    const timing=name==='ten-vfr'?",setpts='(N+floor(N/7))/(24*TB)'":'';
    const extra=codec==='libaom-av1'?['-cpu-used','8']:codec==='libx265'?['-preset','ultrafast']:[];
    evidence.phase=name+'/encode';await save();t.diagnostic(evidence.phase);
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=${name==='hd'?'1920x1080':'98x66'}:rate=24:duration=${name==='hd'?.25:1},format=${pix}`,'-vf',`setparams=range=${range}${timing}`,'-fps_mode','passthrough','-c:v',codec,...extra,file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
    evidence.phase=name+'/cpu';await save();
    const cpu=await complexity(file,stream,{...ctx,sitiWorkers:1},frames),commands=[];
    evidence.phase=name+'/gpu';await save();t.diagnostic(evidence.phase);
    const gpu=await complexity(file,stream,{...ctx,sitiDevice:'gpu',commands},frames);
    assert.equal(cpu.execution.device,'cpu');
    assert.equal(gpu.execution.device,'gpu',JSON.stringify(gpu.execution));
    assert.equal(gpu.execution.requestedDevice,'gpu');assert.equal(gpu.execution.gpuFallbackReason,undefined);
    assert.equal(gpu.points.length,cpu.points.length);assert.equal(gpu.ti.count,frames.length-1);
    let maxError=0;
    for(let i=0;i<frames.length;i++){
      assert.equal(gpu.points[i].frame,cpu.points[i].frame);assert.equal(gpu.points[i].t,cpu.points[i].t);
      for(const metric of ['si','ti']){const error=Math.abs(gpu.points[i][metric]-cpu.points[i][metric]);maxError=Math.max(maxError,error);assert.ok(error<=0.0100001,`${name}/${i}/${metric}: ${error}`)}
    }
    for(const metric of ['si','ti'])for(const stat of ['min','mean','p05','p95','max'])assert.ok(Math.abs(gpu[metric][stat]-cpu[metric][stat])<=0.0100001,`${name}/${metric}/${stat}`);
    evidence.cases.push({name,maxError,cpu,gpu,commands});await save();
    if(name==='eight'){
      evidence.phase='guards';await save();t.diagnostic('GPU frame guard and cancellation');
      const fallback=await complexity(file,stream,{...ctx,sitiDevice:'gpu'},frames.slice(0,-1));
      assert.equal(fallback.execution.device,'cpu');assert.match(fallback.execution.gpuFallbackReason,/帧/);assert.deepEqual(fallback.points,cpu.points);
      const controller=new AbortController(),cancelCommands=[];
      const work=complexity(file,stream,{sitiDevice:'gpu',signal:AbortSignal.any([t.signal,controller.signal]),commands:cancelCommands},frames);controller.abort();
      await assert.rejects(work);assert.ok(cancelCommands.length<=2,'GPU cancellation must not start CPU fallback');
    }
    if(name==='hd'){
      evidence.phase='hd/input-guard';await save();t.diagnostic('HD decoder input guard and process cleanup before CPU recovery');
      const fallback=await complexity(file,{...stream,width:stream.width+2},{...ctx,sitiDevice:'gpu'},frames);
      assert.equal(fallback.execution.device,'cpu');assert.match(fallback.execution.gpuFallbackReason,/格式/);
      assert.deepEqual(fallback.points,cpu.points);
      evidence.hdRecovery=fallback;await save();
    }
    await unlink(file);
  }
  evidence.phase='complete';evidence.outcome='passed';await save();
});
