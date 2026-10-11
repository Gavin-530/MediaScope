import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {sitiGpuCapability} from '../siti-gpu.mjs';
import {SITI_P910_PROFILE} from '../siti-p910.mjs';

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
    ['offset-vfr','yuv420p','limited','ffv1'],
  ]){
    const file=path.join(dir,name+'.mkv');
    const timing=name==='ten-vfr'?",setpts='(N+floor(N/7))/(24*TB)'":name==='offset-vfr'?",setpts='(N+floor(N/7))/(24*TB)+7200/TB'":'';
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
      await assert.rejects(complexity(file,stream,{...ctx,sitiDevice:'gpu'},frames.slice(0,-1)),/帧数/);
      evidence.invalidScanRejected=true;await save();
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

test('P.910 GPU SI/TI hardware validates unrounded fp64 native SDR results without CPU fallback',{timeout:240000},async t=>{
  const ctx={signal:t.signal};await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-'));
  const vectors=JSON.parse(await readFile(new URL('./reference/siti/p910-2023-sdr.json',import.meta.url),'utf8'));
  const evidence={outcome:'running',profile:SITI_P910_PROFILE,absoluteTolerance:1e-8,relativeTolerance:1e-10,toleranceSource:'engineering threshold, not ITU tolerance',cases:[]};
  const save=()=>writeFile(path.join(dir,'gpu-equivalence.json'),JSON.stringify(evidence,null,2));await save();
  function bytes(codes,depth){const raw=Buffer.alloc(codes.length*(depth===8?1:2));for(let i=0;i<codes.length;i++)if(depth===8)raw[i]=codes[i];else raw.writeUInt16LE(codes[i],i*2);return raw}
  const cases=vectors.cases.flatMap(c=>['420','422'].map(sampling=>({...c,sampling,name:c.name+'-'+sampling}))).concat([
    {name:'odd-stride-vfr',width:67,height:7,depth:10,range:'tv',sampling:'422',frames:Array.from({length:6},(_,f)=>Array.from({length:67*7},(_,i)=>64+(i*37+f*71)%877))},
    {name:'hd',width:1920,height:1080,depth:8,range:'tv',sampling:'420'},
    {name:'4k-ten',width:3840,height:2160,depth:10,range:'tv',sampling:'420'}
  ]);
  for(const c of cases){
    evidence.phase=c.name;await save();t.diagnostic('Required P.910 fp64 GPU: '+c.name);
    const file=path.join(dir,c.name+'.mkv'),raw=path.join(dir,c.name+'.yuv'),pix=`yuv${c.sampling}p${c.depth===10?'10le':''}`;
    let input;
    if(c.frames){
      const chroma=bytes(Array(Math.ceil(c.width/2)*(c.sampling==='420'?Math.ceil(c.height/2):c.height)*2).fill(128*2**(c.depth-8)),c.depth);
      await writeFile(raw,Buffer.concat(c.frames.flatMap(f=>[bytes(f,c.depth),chroma])));
      input=['-f','rawvideo','-pixel_format',pix,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw];
    }else input=['-f','lavfi','-i',`testsrc2=size=${c.width}x${c.height}:rate=24:duration=0.125,format=${pix}`];
    await run(FF,['-v','error','-noauto_conversion_filters',...input,'-vf',`setfield=prog,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=bt709:color_primaries=bt709:colorspace=bt709,setpts='(N+floor(N/3))/(24*TB)+7200/TB'`,'-fps_mode','passthrough','-c:v','ffv1','-level','3','-color_range',c.range,'-color_trc','bt709','-color_primaries','bt709','-colorspace','bt709',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx),cpu=await complexity(file,stream,{...ctx,sitiWorkers:1},frames),commands=[];
    assert.equal(stream.color_range,c.range);assert.equal(stream.pix_fmt,pix);
    const gpu=await complexity(file,stream,{...ctx,sitiDevice:'gpu',commands},frames);
    assert.equal(gpu.execution.device,'gpu',JSON.stringify(gpu.execution));assert.equal(gpu.execution.gpuFallbackReason,undefined);
    assert.equal(gpu.execution.method,SITI_P910_PROFILE);assert.equal(gpu.execution.validation.selfTest,'passed');assert.deepEqual(gpu.execution.configuration,cpu.execution.configuration);
    assert.equal(gpu.points.length,frames.length);assert.equal(gpu.points[0].ti,null);assert.equal(gpu.ti.count,frames.length-1);assert.equal(gpu.points[0].t,7200);
    assert.equal(stream.width,c.width);assert.equal(stream.height,c.height);assert.equal(commands.length,2);assert.ok(commands.every(c=>c.exitCode===0));
    let maxError=0,maxReferenceError=0;
    function close(actual,expected,label){const error=Math.abs(actual-expected);maxError=Math.max(maxError,error);assert.ok(error<=1e-8+Math.abs(expected)*1e-10,`${c.name}/${label}: ${actual} vs ${expected}`)}
    for(let i=0;i<frames.length;i++){
      assert.equal(gpu.points[i].t,cpu.points[i].t);assert.equal(gpu.points[i].frame,i);
      for(const metric of i?['si','ti']:['si']){
        close(gpu.points[i][metric],cpu.points[i][metric],i+'/'+metric);
        if(c.expected){const expected=c.expected[i][metric];maxReferenceError=Math.max(maxReferenceError,Math.abs(gpu.points[i][metric]-expected));close(gpu.points[i][metric],expected,i+'/NumPy '+metric)}
      }
    }
    for(const metric of ['si','ti'])for(const stat of ['min','mean','p05','p95','max'])close(gpu[metric][stat],cpu[metric][stat],metric+'/'+stat);
    let sceneCpu,sceneGpu;
    if(c.expected){
      const starts=[0,2,3];sceneCpu=await complexity(file,stream,{...ctx,sitiWorkers:1,sitiSceneStarts:starts},frames);sceneGpu=await complexity(file,stream,{...ctx,sitiDevice:'gpu',sitiSceneStarts:starts},frames);
      assert.equal(sceneGpu.execution.device,'gpu');assert.equal(sceneGpu.execution.gpuFallbackReason,undefined);assert.equal(sceneGpu.si,null);assert.equal(sceneGpu.ti,null);
      assert.deepEqual(sceneGpu.sceneAnalysis,sceneCpu.sceneAnalysis);assert.equal(sceneGpu.scenes[1].ti,null);
      for(let i=0;i<frames.length;i++){
        close(sceneGpu.points[i].si,c.expected[i].si,'scene/'+i+'/SI');
        if(starts.includes(i))assert.equal(sceneGpu.points[i].ti,null);else close(sceneGpu.points[i].ti,c.expected[i].ti,'scene/'+i+'/TI');
      }
      for(let i=0;i<starts.length;i++)for(const metric of ['si','ti']){
        if(sceneCpu.scenes[i][metric]===null)assert.equal(sceneGpu.scenes[i][metric],null);
        else for(const stat of ['min','mean','p05','p95','max'])close(sceneGpu.scenes[i][metric][stat],sceneCpu.scenes[i][metric][stat],'scene/'+i+'/'+metric+'/'+stat);
      }
    }
    evidence.cases.push({name:c.name,maxError,maxReferenceError,cpu,gpu,commands,...(sceneGpu?{sceneCpu,sceneGpu}:{})});await save();
    if(c.name==='8-limited-420'){
      await assert.rejects(complexity(file,stream,{...ctx,sitiDevice:'gpu'},frames.slice(0,-1)),/帧数/);
      const shifted=structuredClone(frames);shifted[1].t+=.01;await assert.rejects(complexity(file,stream,{...ctx,sitiDevice:'gpu'},shifted),/时间戳与预扫描/);
      await assert.rejects(complexity(file,{...stream,width:stream.width+2},{...ctx,sitiDevice:'gpu'},frames),/输入帧序号、格式/);
      const controller=new AbortController(),cancelCommands=[];
      await assert.rejects(complexity(file,stream,{sitiDevice:'gpu',commands:cancelCommands,signal:AbortSignal.any([t.signal,controller.signal]),update:p=>{if(p.completed>=1)controller.abort()}},frames));
      assert.equal(cancelCommands.length,2,'active GPU cancellation must not start CPU fallback');
      const invalidFile=path.join(dir,'invalid-range.mkv');
      await run(FF,['-v','error','-f','lavfi','-i','nullsrc=s=10x8:r=1:d=1,format=yuv420p,geq=lum=15:cb=128:cr=128,setfield=prog,setparams=range=limited:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v','ffv1','-level','3',invalidFile],ctx);
      const invalidStream=(await probe(invalidFile,ctx)).raw.streams[0],invalidFrames=await scan(invalidFile,0,ctx),invalidCommands=[];
      await assert.rejects(complexity(invalidFile,invalidStream,{...ctx,sitiDevice:'gpu',commands:invalidCommands},invalidFrames),/超出声明范围/);
      assert.equal(invalidCommands.length,4);assert.ok(invalidCommands.some(c=>c.exe==='powershell.exe'&&c.exitCode!==0),'GPU must reject the invalid code, then same-profile CPU must also reject it');
      evidence.guards={invalidScanRejected:true,sourceTimeRejected:true,geometryRejected:true,invalidCodeRejected:true,cancelCommands,invalidCommands};await save();await unlink(invalidFile);
    }
    await unlink(file);if(c.frames)await unlink(raw);
  }
  evidence.phase='complete';evidence.outcome='passed';await save();
});
