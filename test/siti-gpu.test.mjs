import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiGpuCapability} from '../siti-gpu.mjs';

// General regression checks a short real request and recovery. Hardware precision
// across formats belongs to the separately required GPU suite.
test('GPU SI/TI preserves CPU default, actual device selection and unavailable recovery',{timeout:90000},async t=>{
  const ctx={signal:t.signal};
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-gpu-'));
  const evidence={outcome:'running',phase:'probe',cases:[]};
  const save=()=>writeFile(path.join(dir,'general.json'),JSON.stringify(evidence,null,2));
  await save();t.diagnostic('GPU capability probe');
  const capability=await sitiGpuCapability(ctx);evidence.capability=capability;
  assert.equal(typeof capability.available,'boolean');
  if(!capability.available)assert.ok(capability.reason);
  const file=path.join(dir,'short.mkv');evidence.phase='encode';await save();
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=98x66:rate=8:duration=0.5','-c:v','libx264',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  const cpu=await complexity(file,stream,{...ctx,sitiWorkers:1},frames);
  evidence.phase='device-request';await save();t.diagnostic('Short GPU request or real unavailable-device fallback');
  const gpu=await complexity(file,stream,{...ctx,sitiDevice:'gpu'},frames);
  assert.equal(cpu.execution.device,'cpu');assert.equal(cpu.execution.requestedDevice,'cpu');
  assert.equal(gpu.execution.device,capability.available?'gpu':'cpu',JSON.stringify(gpu.execution));
  assert.equal(gpu.execution.requestedDevice,'gpu');
  if(!capability.available){assert.ok(gpu.execution.gpuFallbackReason);assert.deepEqual(gpu.points,cpu.points)}
  assert.equal(gpu.points.length,cpu.points.length);
  // A missing frame scan is a real production guard, independent of the host GPU.
  const fallback=await complexity(file,stream,{...ctx,sitiDevice:'gpu'},[]);
  assert.equal(fallback.execution.device,'cpu');assert.match(fallback.execution.gpuFallbackReason,/帧/);
  assert.deepEqual(fallback.points,cpu.points);
  const controller=new AbortController();controller.abort();
  await assert.rejects(complexity('unused',{pix_fmt:'yuv420p',width:98,height:66},{sitiDevice:'gpu',signal:controller.signal},[{}]),/取消/);
  assert.equal((await complexity('unused',{pix_fmt:'yuv444p'})).available,false);
  await assert.rejects(complexity('unused',{pix_fmt:'yuv420p'},{sitiDevice:'invalid'}),/设备/);
  evidence.cases.push({cpu,gpu,fallback});evidence.phase='complete';evidence.outcome='passed';await save();await unlink(file);
});
