import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {sitiGpuCapability,measureSiti,closeSitiGpu,sitiGpuRequest} from '../siti.mjs';
import {sitiInput,sitiRawBytes,SITI_STANDARD_PROFILE} from '../public/siti.js';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
const vectors=JSON.parse(await readFile(new URL('./reference/siti/vqeg-pq.json',import.meta.url),'utf8'));
const close=(a,b)=>assert.ok(Math.abs(a-b)<=1e-8+Math.abs(b)*1e-10,`${a} vs ${b}`);
test('GPU SI/TI hardware validates real frames against CPU without accepting CPU fallback',{timeout:180000},async t=>{
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-gpu-')),ctx={signal:t.signal};
  const cache=path.join(dir,'cache'),originalTmp=process.env.TMP,originalTemp=process.env.TEMP;await mkdir(cache);process.env.TMP=cache;process.env.TEMP=cache;
  t.after(async()=>{await closeSitiGpu();if(originalTmp===undefined)delete process.env.TMP;else process.env.TMP=originalTmp;if(originalTemp===undefined)delete process.env.TEMP;else process.env.TEMP=originalTemp;});
  const commands=[],capability=await sitiGpuCapability({...ctx,commands});assert.equal(capability.available,true,capability.reason);
  const bridge=commands.find(c=>c.operation==='probe').exe;
  async function rawGpu(c,frames=c.frames.map(b=>Buffer.from(b,'base64'))){
    const input=sitiInput({pix_fmt:c.format,color_range:c.range,color_transfer:{sdr:'bt709',srgb:'iec61966-2-1',pq:'smpte2084',hlg:'arib-std-b67'}[c.domain]},c.settings),prepared=sitiGpuRequest(input,c.width,c.height,frames.length);
    return new Promise((resolve,reject)=>{
      const child=spawn(bridge,['serve'],{windowsHide:true,signal:t.signal});let stdout='',stderr='',failure;
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',e=>failure=e);child.stdin.on('error',()=>{});
      child.on('close',code=>{
        const lines=stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)),error=lines.find(p=>p.event==='error');
        failure?reject(failure):resolve({code,stderr:stderr+(error?.message??''),lines:lines.filter(p=>p.event==='configured'||p.frame!==undefined)});
      });
      child.stdin.end(Buffer.concat([Buffer.from('M\t1\t'+prepared.header.join('\t')+'\n'),prepared.payload,...frames]));
    });
  }
  const evidence={outcome:'running',capability,cases:[],absoluteTolerance:1e-8,relativeTolerance:1e-10};
  evidence.native=[];
  for(const c of vectors.cases){
    const result=await rawGpu(c);assert.equal(result.code,0,c.name+': '+result.stderr);const points=result.lines.slice(1);assert.equal(points.length,5);
    for(let i=0;i<5;i++){close(points[i].si,c.expected[i].si);if(i)close(points[i].ti,c.expected[i].ti);else assert.equal(points[i].ti,null)}
    evidence.native.push({name:c.name,points});
  }
  for(const [name,damage,reason] of [
    ['gray10le-sdr-tv',b=>b.writeUInt16LE(63),/超出声明范围/],
    ['gray9le-sdr-pc',b=>b.writeUInt16LE(512),/超出位深/],
    ['p010le-sdr-tv',b=>b[0]|=1,/填充位/],
    ['p212be-sdr-tv',b=>b[1]|=1,/填充位/],
    ['yuva420p10le-sdr-pc',b=>b.writeUInt16LE(512,300),/半透明/]
  ]){
    const c=vectors.cases.find(c=>c.name===name),raw=Buffer.from(c.frames[0],'base64');damage(raw);const result=await rawGpu(c,[raw]);
    assert.equal(result.code,1);assert.match(result.stderr,reason);assert.equal(result.lines.length,1,'invalid frame must not produce metrics');
  }
  const truncated=vectors.cases.find(c=>c.name==='p010le-sdr-tv'),short=await rawGpu(truncated,[Buffer.from(truncated.frames[0],'base64').subarray(0,-1)]);
  assert.equal(short.code,1);assert.match(short.stderr,/Truncated/);assert.equal(short.lines.length,1);
  for(const name of ['gray-sdr-tv','gray9le-sdr-tv','gray10le-pq-tv','gray12le-hlg-pc','gray14be-sdr-tv','gray16le-srgb-pc','nv12-sdr-tv','rgb24-sdr-pc','rgb48be-sdr-pc','gbrp12le-pq-pc','rgba-sdr-pc','gray10le-hlg-tv-display','gray10le-hlg-pc-step','gray10le-hlg-tv-step','rgb24-hlg-pc']){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c,{},ctx),options={...ctx,sitiSettings:c.settings,sitiSceneStarts:[0,2,4]};
    const jobCommands=[],cpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiWorkers:1},fixture.frames),gpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu',commands:jobCommands},fixture.frames);
    assert.equal(gpu.execution.device,'gpu',gpu.execution.gpuFallbackReason);assert.equal(gpu.execution.validation.selfTest,'passed');assert.deepEqual(gpu.execution.configuration,cpu.execution.configuration);
    assert.equal(gpu.execution.method,SITI_STANDARD_PROFILE);assert.equal(gpu.execution.configuration.configurationVersion,7);assert.equal(gpu.execution.configuration.outputMultiplier,2**c.depth-1);
    assert.equal(jobCommands.some(c=>c.exe==='powershell.exe'),false,'jobs reuse the compiled bridge');assert.equal(jobCommands[0].exe,bridge);
    const input=sitiInput(fixture.stream,c.settings);assert.equal(gpu.execution.inputBytesPerFrame,sitiRawBytes(input.format,c.width,c.height));
    assert.equal(gpu.execution.preprocessingDevice,'gpu');assert.equal(gpu.execution.sessionPid,evidence.cases[0]?.gpu.execution.sessionPid??gpu.execution.sessionPid);
    let maxError=0;
    for(let i=0;i<5;i++){
      assert.equal(gpu.points[i].t,cpu.points[i].t);close(gpu.points[i].si,c.expected[i].si);close(gpu.points[i].si,cpu.points[i].si);maxError=Math.max(maxError,Math.abs(gpu.points[i].si-cpu.points[i].si));
      if([0,2,4].includes(i))assert.equal(gpu.points[i].ti,null);else{close(gpu.points[i].ti,c.expected[i].ti);close(gpu.points[i].ti,cpu.points[i].ti);maxError=Math.max(maxError,Math.abs(gpu.points[i].ti-cpu.points[i].ti))}
    }
    evidence.cases.push({name,cpu,gpu,maxError});await writeFile(path.join(dir,'hardware-equivalence.json'),JSON.stringify(evidence));
  }
  const c=vectors.cases.find(c=>c.name==='gray16le-hlg-pc'),fixture=await sitiInputFixture(dir,c,{lossless:true,metadata:true,interlaced:true,count:96},ctx),options={...ctx,sitiSettings:{...c.settings,interlaced:'bwdif'}};
  let busyCheck,queuedCheck;const queuedController=new AbortController();
  const cpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiWorkers:3},fixture.frames),gpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu',onSitiPoint:()=>{
    if(busyCheck)return;busyCheck=sitiGpuCapability(ctx);
    queuedCheck=measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu',signal:queuedController.signal},fixture.frames).catch(e=>e);queuedController.abort();
  }},fixture.frames);
  assert.equal(gpu.execution.device,'gpu',gpu.execution.gpuFallbackReason);for(let i=0;i<96;i++){close(gpu.points[i].si,cpu.points[i].si);if(i)close(gpu.points[i].ti,cpu.points[i].ti)}
  assert.equal((await busyCheck).busy,true);assert.equal((await queuedCheck).sitiPhase,'cancelled');
  const alreadyCancelled=new AbortController();alreadyCancelled.abort();await assert.rejects(sitiGpuCapability({signal:alreadyCancelled.signal}),/取消/);
  const active=new AbortController();await assert.rejects(measureSiti(fixture.file,fixture.stream,{...options,signal:active.signal,sitiDevice:'gpu',onSitiPoint:()=>active.abort()},fixture.frames),/取消|abort/i);
  const recovered=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},fixture.frames);assert.equal(recovered.execution.device,'gpu');assert.deepEqual(recovered.points,gpu.points);
  const mismatched=fixture.frames.map(p=>({...p}));mismatched[1].t+=.001;
  let validationFailure;try{await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},mismatched);}catch(e){validationFailure=e;}
  assert.equal(validationFailure?.sitiPhase,'validation');assert.equal(validationFailure.sitiAttempts.length,1);assert.equal(validationFailure.sitiAttempts[0].device,'gpu');
  const afterValidation=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},fixture.frames);
  assert.equal(afterValidation.execution.sessionPid,recovered.execution.sessionPid,'common validation errors retain a healthy GPU context');
  let decodeFailure;const decodeCommands=[];
  try{await measureSiti(path.join(dir,'missing-input.nut'),fixture.stream,{...options,sitiDevice:'gpu',commands:decodeCommands},fixture.frames);}catch(e){decodeFailure=e;}
  assert.equal(decodeFailure?.sitiPhase,'decode');assert.equal(decodeFailure.sitiAttempts.length,1);assert.equal(decodeFailure.sitiAttempts[0].device,'gpu');
  assert.equal(decodeCommands.filter(c=>c.exe===process.execPath).length,0,'a common decode failure must not launch CPU calculators');
  const afterDecode=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},fixture.frames);assert.equal(afterDecode.execution.device,'gpu');assert.deepEqual(afterDecode.points,gpu.points);
  await closeSitiGpu();assert.equal(path.dirname(bridge),cache);const retained=bridge+'.retained';await rename(bridge,retained);
  try{
    const rebuiltCommands=[],rebuilt=await sitiGpuCapability({...ctx,commands:rebuiltCommands});assert.equal(rebuilt.available,true,rebuilt.reason);
    assert.ok(rebuiltCommands.some(c=>c.exe==='powershell.exe'),'missing executable is rebuilt in the same JS session');
    const afterRebuild=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},fixture.frames);assert.equal(afterRebuild.execution.device,'gpu');
    for(let i=0;i<96;i++){close(afterRebuild.points[i].si,cpu.points[i].si);if(i)close(afterRebuild.points[i].ti,cpu.points[i].ti)}
    evidence.cacheRecovery={capability:rebuilt,execution:afterRebuild.execution};
  }finally{await unlink(retained);}
  evidence.validationFailure={phase:validationFailure.sitiPhase,attempts:validationFailure.sitiAttempts};evidence.decodeFailure={phase:decodeFailure.sitiPhase,attempts:decodeFailure.sitiAttempts,commands:decodeCommands};evidence.deinterlace={cpu,gpu};evidence.outcome='passed';await writeFile(path.join(dir,'hardware-equivalence.json'),JSON.stringify(evidence));
});
