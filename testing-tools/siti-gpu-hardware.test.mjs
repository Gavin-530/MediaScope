import {readFixture} from './helpers/fixtures.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {sitiGpuCapability,measureSiti,closeSitiGpu,sitiGpuRequest} from '../siti.mjs';
import {sitiInput,createSitiCalculator,sitiRawBytes,SITI_COMPAT_PROFILE,SITI_NUMERIC_TOLERANCE,sitiValuesClose} from '../public/siti.js';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {publishedSitiCases} from './helpers/siti-published.mjs';
import {independentSitiLayouts,SITI_LAYOUT_ORACLE_SHA256} from './helpers/siti-layouts.mjs';
import {withRawSitiGpu} from './helpers/siti-raw-gpu.mjs';
import {hlgBoundaryCases} from './helpers/siti-hlg-boundary.mjs';
import {auditGpuInputs} from './helpers/siti-input-audit.mjs';
import {FF,run,probe,scan} from '../engine.mjs';
const vectors=JSON.parse(await readFixture('vqeg-060.json'));
const close=(a,b)=>assert.ok(sitiValuesClose(a,b),`${a} vs ${b}`);
test('GPU SI/TI hardware validates real frames against CPU without accepting CPU fallback',{timeout:180000},async t=>{
  await mkdir('.build/testing-work',{recursive:true});const dir=await mkdtemp(path.resolve('.build/testing-work/siti-gpu-')),ctx={signal:t.signal};
  const cache=path.join(dir,'cache'),originalTmp=process.env.TMP,originalTemp=process.env.TEMP;await mkdir(cache);process.env.TMP=cache;process.env.TEMP=cache;
  t.after(async()=>{await closeSitiGpu();if(originalTmp===undefined)delete process.env.TMP;else process.env.TMP=originalTmp;if(originalTemp===undefined)delete process.env.TEMP;else process.env.TEMP=originalTemp;});
  const commands=[],capability=await sitiGpuCapability({...ctx,commands});assert.equal(capability.available,true,capability.reason);
  const bridge=commands.find(c=>c.operation==='probe').exe;
  async function rawGpu(c,frames=c.frames.map(b=>Buffer.from(b,'base64')),declaredCount=frames.length,sceneStarts=[0]){
    const input=sitiInput({pix_fmt:c.format,color_range:c.range,color_transfer:{sdr:'bt709',srgb:'iec61966-2-1',pq:'smpte2084',hlg:'arib-std-b67'}[c.domain]},c.settings),prepared=sitiGpuRequest(input,c.width,c.height,frames.length);
    prepared.header[2]=declaredCount;prepared.header[3]=sceneStarts.join(',');
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
  const evidence={outcome:'running',capability,cases:[],...SITI_NUMERIC_TOLERANCE};
  const layouts=await independentSitiLayouts();
  evidence.actualGpuInputs=await auditGpuInputs(layouts.cases,t.signal);
  evidence.independentLayouts={fixtureSha256:SITI_LAYOUT_ORACLE_SHA256,formats:150,cases:[],maxError:0};
  await withRawSitiGpu(bridge,t.signal,async measure=>{
    for(const c of layouts.cases){
      const result=await measure(c);assert.equal(result.info.metrics,'PQ-Sobel-TI-fp32');assert.equal(result.info.device,capability.device);assert.equal(result.points.length,c.expected.length);
      for(let i=0;i<result.points.length;i++){
        const p=result.points[i];close(p.si,c.expected[i].si);if(i)close(p.ti,c.expected[i].ti);else assert.equal(p.ti,null);
        evidence.independentLayouts.maxError=Math.max(evidence.independentLayouts.maxError,Math.abs(p.si-c.expected[i].si),i?Math.abs(p.ti-c.expected[i].ti):0);
      }
      evidence.independentLayouts.cases.push({name:c.name,points:result.points});
    }
  });
  evidence.exactZeros=[];
  await withRawSitiGpu(bridge,t.signal,async measure=>{
    for(const depth of [8,9,10,12,14,16])for(const range of ['pc','tv']){
      const lo=range==='pc'?0:16*2**(depth-8),hi=range==='pc'?2**depth-1:235*2**(depth-8),format=depth===8?'gray':`gray${depth}le`;
      const encode=values=>{const b=Buffer.alloc(values.length*(depth===8?1:2));for(let i=0;i<values.length;i++)depth===8?b[i]=values[i]:b.writeUInt16LE(values[i],i*2);return b.toString('base64')};
      const edge=encode(Array.from({length:16},(_,i)=>i%4<2?lo:hi));
      for(const c of [
        {name:'repeated-edge',width:4,height:4,frames:[edge,edge],zeros:[[1,'ti']]},
        {name:'checkerboard',width:4,height:4,frames:[encode(Array.from({length:16},(_,i)=>(i%4+Math.floor(i/4))%2?hi:lo))],zeros:[[0,'si']]},
        {name:'white',width:3,height:3,frames:[encode(Array(9).fill(hi))],zeros:[[0,'si']]},
        {name:'uniform-code-change',width:257,height:129,frames:[0,1].map(k=>encode(Array(257*129).fill(Math.floor((lo+hi)/2)+k))),zeros:[[0,'si'],[1,'si'],[1,'ti']]}
      ]){
        const result=await measure({...c,format,range,settings:{transfer:'pq'}});
        for(const [i,key] of c.zeros)assert.equal(result.points[i][key],0,`${c.name} ${depth} ${range} ${key}`);
        evidence.exactZeros.push({name:c.name,depth,range,points:result.points});
      }
    }
    const raw=Buffer.alloc(16*16*2);for(let i=0;i<256;i++)raw.writeUInt16LE(32768,i*2);const next=Buffer.from(raw);next.writeUInt16LE(32769,0);
    const tiny=await measure({format:'gray16le',range:'pc',width:16,height:16,frames:[raw,next].map(x=>x.toString('base64')),settings:{transfer:'pq'}});
    assert.ok(tiny.points[1].ti>0&&tiny.points[1].ti<.01,'legitimate small motion must not be clamped to zero');
    close(tiny.points[1].ti,255/65535*Math.sqrt((1/256)*(255/256)));evidence.smallMotion=tiny;
  });
  evidence.hlgBoundary=[];
  await withRawSitiGpu(bridge,t.signal,async measure=>{
    for(const c of hlgBoundaryCases()){
      const calc=createSitiCalculator(c.width,c.height,sitiInput({pix_fmt:c.format,color_range:c.range,color_transfer:'arib-std-b67'},c.settings)),cpu=c.frames.map(b=>calc.measure(Buffer.from(b,'base64'))),result=await measure(c);
      for(let i=0;i<c.expected.length;i++)for(const key of ['si','ti']){if(c.expected[i][key]===null)assert.equal(result.points[i][key],null);else{close(cpu[i][key],c.expected[i][key]);close(result.points[i][key],c.expected[i][key]);}}
      evidence.hlgBoundary.push({name:c.name,expected:c.expected,cpu,result});
    }
  });
  assert.ok(evidence.hlgBoundary.length>=6,'include actual HLG branch adversaries');
  evidence.actualHlgWorkplane=await auditGpuInputs(hlgBoundaryCases(),t.signal);
  evidence.published=[];
  for(const c of await publishedSitiCases()){
    const options={...ctx,sitiSettings:c.settings,sitiDevice:'gpu'},stream=(await probe(c.file,options)).raw.streams[0],frames=await scan(c.file,stream.index,options),result=await measureSiti(c.file,stream,options,frames);
    assert.equal(result.execution.device,'gpu',result.execution.gpuFallbackReason);assert.equal(result.points.length,c.reference.si.length);assert.equal(result.points.length-1,c.reference.ti.length);
    for(let i=0;i<result.points.length;i++){close(result.points[i].si,c.reference.si[i]);if(i)close(result.points[i].ti,c.reference.ti[i-1]);else assert.equal(result.points[i].ti,null);}
    evidence.published.push({name:c.name,reference:c.reference,result});
  }
  evidence.native=[];
  for(const c of vectors.cases){
    const result=await rawGpu(c);assert.equal(result.code,0,c.name+': '+result.stderr);const points=result.lines.slice(1);assert.equal(points.length,5);
    for(let i=0;i<5;i++){close(points[i].si,c.expected[i].si);if(i)close(points[i].ti,c.expected[i].ti);else assert.equal(points[i].ti,null);for(const key of ['si','ti'])if(c.expected[i][key]===0)assert.equal(points[i][key],0,c.name+' exact '+key);}
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
  // Protocol bounds only: truncated input is deliberately not a two-million-frame measurement.
  const atLimit=await rawGpu(truncated,[Buffer.from(truncated.frames[0],'base64')],2000000,[0,1999999]);
  assert.equal(atLimit.code,1);assert.match(atLimit.stderr,/Truncated/);assert.equal(atLimit.lines.length,2);
  const overLimit=await rawGpu(truncated,[Buffer.from(truncated.frames[0],'base64')],2000001);
  assert.equal(overLimit.code,1);assert.match(overLimit.stderr,/frame or table count/);
  for(const name of ['gray-sdr-tv','gray9le-sdr-tv','gray10le-pq-tv','gray12le-hlg-pc','gray14be-sdr-tv','gray16le-srgb-pc','nv12-sdr-tv','rgb24-sdr-pc','rgb48be-sdr-pc','gbrp12le-pq-pc','rgba-sdr-pc','gray10le-hlg-tv-display','gray10le-hlg-pc-step','gray10le-hlg-tv-step','rgb24-hlg-pc']){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c,{},ctx),options={...ctx,sitiSettings:c.settings,sitiSceneStarts:[0,2,4]};
    const jobCommands=[],cpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiWorkers:1},fixture.frames),gpu=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu',commands:jobCommands},fixture.frames);
    assert.equal(gpu.execution.device,'gpu',gpu.execution.gpuFallbackReason);assert.deepEqual(gpu.execution.validation,{selfTest:'passed',...SITI_NUMERIC_TOLERANCE});assert.deepEqual(gpu.execution.configuration,cpu.execution.configuration);
    assert.equal(gpu.execution.method,SITI_COMPAT_PROFILE);assert.equal(gpu.execution.configuration.configurationVersion,8);assert.equal(gpu.execution.configuration.outputMultiplier,255);
    assert.equal(jobCommands.some(c=>c.exe==='powershell.exe'),false,'jobs reuse the compiled bridge');assert.equal(jobCommands[0].exe,bridge);
    const input=sitiInput(fixture.stream,c.settings);assert.equal(gpu.execution.inputBytesPerFrame,sitiRawBytes(input.format,c.width,c.height));
    assert.equal(gpu.execution.preprocessingDevice,'gpu');if(c.domain==='hlg'&&input.format.family==='rgb')assert.match(gpu.execution.precision,/fp64 GPU HLG RGB/);assert.equal(gpu.execution.sessionPid,evidence.cases[0]?.gpu.execution.sessionPid??gpu.execution.sessionPid);
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
  const faultCommands=[];let killed=false;
  const fallback=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu',commands:faultCommands,onSitiPoint:()=>{
    if(killed)return;const pid=faultCommands.find(c=>c.operation==='measure')?.sessionPid;assert.ok(pid);process.kill(pid);killed=true;
  }},fixture.frames);
  assert.equal(killed,true);assert.equal(fallback.execution.device,'cpu');assert.deepEqual(fallback.points,cpu.points);assert.deepEqual(fallback.execution.configuration,cpu.execution.configuration);
  assert.equal(fallback.execution.attempts.length,2);assert.equal(fallback.execution.attempts[0].device,'gpu');assert.equal(fallback.execution.attempts[0].outcome,'failed');assert.ok(fallback.execution.attempts[0].framesComputed>0);assert.equal(fallback.execution.attempts[1].framesComputed,96);
  const afterFault=await measureSiti(fixture.file,fixture.stream,{...options,sitiDevice:'gpu'},fixture.frames);assert.equal(afterFault.execution.device,'gpu');assert.deepEqual(afterFault.points,gpu.points);
  evidence.deviceFaultRecovery={fallback,afterFault};
  evidence.validationFailure={phase:validationFailure.sitiPhase,attempts:validationFailure.sitiAttempts};evidence.decodeFailure={phase:decodeFailure.sitiPhase,attempts:decodeFailure.sitiAttempts,commands:decodeCommands};evidence.deinterlace={cpu,gpu};evidence.outcome='passed';await writeFile(path.join(dir,'hardware-equivalence.json'),JSON.stringify(evidence));
});

test('GPU SI/TI hardware measures real 8192x4320 frames against analytic values and CPU',{timeout:180000},async t=>{
  await mkdir('.build/testing-work',{recursive:true});const dir=await mkdtemp(path.resolve('.build/testing-work/siti-gpu-')),file=path.join(dir,'8k.mkv'),commands=[],ctx={signal:t.signal,decodeThreads:1,commands};
  const oldTmp=process.env.TMP,oldTemp=process.env.TEMP;process.env.TMP=dir;process.env.TEMP=dir;
  t.after(async()=>{await closeSitiGpu();if(oldTmp===undefined)delete process.env.TMP;else process.env.TMP=oldTmp;if(oldTemp===undefined)delete process.env.TEMP;else process.env.TEMP=oldTemp;});
  await run(FF,['-v','error','-y','-f','lavfi','-i',"nullsrc=s=8192x4320:r=1,format=gray,geq=lum='if(lt(X,W/2+N),16,235)',setfield=prog",'-frames:v','2','-c:v','ffv1','-threads:v','1','-color_range','tv','-color_trc','smpte2084',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx),options={...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1};
  const cpu=await measureSiti(file,stream,options,frames),gpu=await measureSiti(file,stream,{...options,sitiDevice:'gpu'},frames);
  assert.equal(gpu.execution.device,'gpu',gpu.execution.gpuFallbackReason);
  const p=2/8190,si=4*Math.sqrt(p*(1-p))*255,q=1/8192,ti=Math.sqrt(q*(1-q))*255;
  for(let i=0;i<2;i++){close(gpu.points[i].si,si);close(gpu.points[i].si,cpu.points[i].si);if(i){close(gpu.points[i].ti,ti);close(gpu.points[i].ti,cpu.points[i].ti)}else assert.equal(gpu.points[i].ti,null);}
  await writeFile(path.join(dir,'8k-boundary.json'),JSON.stringify({outcome:'passed',commands,stream,cpu,gpu,analytic:{si,ti}}));
});
