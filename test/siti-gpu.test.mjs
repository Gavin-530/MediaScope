import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiGpuCapability} from '../siti-gpu.mjs';

test('GPU SI/TI validates real frames against CPU and preserves default and unavailable paths',{timeout:180000},async()=>{
  const capability=await sitiGpuCapability();
  assert.equal(typeof capability.available,'boolean');
  if(!capability.available)assert.ok(capability.reason);
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-gpu-'));
  const evidence={capability,cases:[]};
  for(const [name,pix,range,codec] of [
    ['eight','yuv420p','limited','libx264'],['ten-vfr','yuv420p10le','limited','ffv1'],
    ['full','yuv420p','full','ffv1'],['ten-full','yuv422p10le','full','ffv1'],
    ['av1','yuv420p','limited','libaom-av1'],['hevc','yuv420p10le','limited','libx265'],['hd','yuv420p','limited','libx264'],
  ]){
    const file=path.join(dir,name+'.mkv');
    const timing=name==='ten-vfr'?",setpts='(N+floor(N/7))/(24*TB)'":'';
    const extra=codec==='libaom-av1'?['-cpu-used','8']:codec==='libx265'?['-preset','ultrafast']:[];
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=${name==='hd'?'1920x1080':'98x66'}:rate=24:duration=${name==='hd'?.25:1},format=${pix}`,'-vf',`setparams=range=${range}${timing}`,'-fps_mode','passthrough','-c:v',codec,...extra,file]);
    const info=await probe(file),stream=info.raw.streams[0],frames=await scan(file,0);
    const cpu=await complexity(file,stream,{sitiWorkers:1},frames),commands=[];
    const gpu=await complexity(file,stream,{sitiDevice:'gpu',commands},frames);
    assert.equal(cpu.execution.device,'cpu');assert.equal(cpu.execution.requestedDevice,'cpu');
    assert.equal(gpu.execution.device,capability.available?'gpu':'cpu',JSON.stringify(gpu.execution));
    if(!capability.available)assert.ok(gpu.execution.gpuFallbackReason);
    assert.equal(gpu.points.length,cpu.points.length);assert.equal(gpu.ti.count,frames.length-1);
    let maxError=0;
    for(let i=0;i<frames.length;i++){
      assert.equal(gpu.points[i].frame,cpu.points[i].frame);assert.equal(gpu.points[i].t,cpu.points[i].t);
      for(const metric of ['si','ti']){const error=Math.abs(gpu.points[i][metric]-cpu.points[i][metric]);maxError=Math.max(maxError,error);assert.ok(error<=0.0100001,`${name}/${i}/${metric}: ${error}`)}
    }
    for(const metric of ['si','ti'])for(const stat of ['min','mean','p05','p95','max'])assert.ok(Math.abs(gpu[metric][stat]-cpu[metric][stat])<=0.0100001,`${name}/${metric}/${stat}`);
    evidence.cases.push({name,maxError,cpu,gpu,commands});
    if(name==='eight'&&capability.available){
      const fallback=await complexity(file,stream,{sitiDevice:'gpu'},frames.slice(0,-1));
      assert.equal(fallback.execution.device,'cpu');assert.match(fallback.execution.gpuFallbackReason,/帧/);assert.deepEqual(fallback.points,cpu.points);
      const controller=new AbortController(),cancelCommands=[];
      const work=complexity(file,stream,{sitiDevice:'gpu',signal:controller.signal,commands:cancelCommands},frames);controller.abort();
      await assert.rejects(work);assert.ok(cancelCommands.length<=2,'GPU cancellation must not start CPU fallback');
    }
  }
  await writeFile(path.join(dir,'equivalence.json'),JSON.stringify(evidence,null,2));
  for(const item of evidence.cases)await unlink(path.join(dir,item.name+'.mkv'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(complexity('unused',{pix_fmt:'yuv420p',width:98,height:66},{sitiDevice:'gpu',signal:controller.signal},[{}]),/取消/);
  assert.equal((await complexity('unused',{pix_fmt:'yuv444p'})).available,false);
  await assert.rejects(complexity('unused',{pix_fmt:'yuv420p'},{sitiDevice:'invalid'}),/设备/);
});
