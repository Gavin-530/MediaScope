import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity,distribution} from '../analysis.mjs';
import {createSitiP910Calculator,sitiP910Eligible,SITI_P910_PROFILE,SITI_P910_REFERENCE} from '../siti-p910.mjs';
import {validateSitiPoints} from '../siti-validation.mjs';
import {sitiWorkerCount} from '../siti.mjs';

const vectors=JSON.parse(await readFile(new URL('./reference/siti/p910-2023-sdr.json',import.meta.url),'utf8'));
// Engineering Float64 threshold, not an ITU tolerance or a rounding allowance.
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1e-8+Math.abs(expected)*1e-10,`${label}: ${actual} vs ${expected}`);
function bytes(codes,depth){const raw=Buffer.alloc(codes.length*(depth===8?1:2));for(let i=0;i<codes.length;i++)if(depth===8)raw[i]=codes[i];else raw.writeUInt16LE(codes[i],i*2);return raw}

test('P.910 SI/TI pinned normative profile matches independent NumPy and original VQEG operators',async()=>{
  const source=await readFile(new URL('./reference/siti/vqeg-v0.3.0.py',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),SITI_P910_REFERENCE.sourceSha256);
  assert.equal(vectors.reference.commit,SITI_P910_REFERENCE.commit);assert.equal(vectors.profile,SITI_P910_PROFILE);
  for(const c of vectors.cases){
    const calculator=createSitiP910Calculator(c.width,c.height,c.depth,c.range),actual=c.frames.map(f=>calculator.measure(bytes(f,c.depth)));
    for(let i=0;i<actual.length;i++){
      close(actual[i].si,c.expected[i].si,c.name+'/'+i+'/si');
      if(i)close(actual[i].ti,c.expected[i].ti,c.name+'/'+i+'/ti');else assert.equal(actual[i].ti,null);
    }
    assert.equal(calculator.configuration.blackCdM2,0.01);assert.equal(calculator.configuration.outputMultiplier,2**c.depth-1);
    assert.equal(actual[0].si,0);assert.equal(actual[1].ti,0,'uniform brightness jump has zero spatial variance');
    close(distribution(actual.map(p=>p.si)).mean,c.expectedMean.si,c.name+'/mean SI');
    close(distribution(actual.slice(1).map(p=>p.ti)).mean,c.expectedMean.ti,c.name+'/mean TI');
  }
});

test('P.910 SI/TI rejects unsupported interpretation, invalid code values and invalid first TI',()=>{
  const stream={pix_fmt:'yuv420p',color_range:'tv',color_transfer:'bt709',field_order:'progressive'};
  assert.equal(sitiP910Eligible(stream),true);
  for(const changes of [{color_range:undefined},{color_transfer:undefined},{color_transfer:'smpte2084'},{color_transfer:'arib-std-b67'},{field_order:'tt'},{pix_fmt:'yuv420p12le'}])assert.equal(sitiP910Eligible({...stream,...changes}),false);
  for(const [depth,range,code] of [[8,'tv',15],[8,'tv',236],[10,'tv',63],[10,'tv',941],[10,'pc',1024]]){
    const calculator=createSitiP910Calculator(3,3,depth,range);assert.throws(()=>calculator.measure(bytes(Array(9).fill(code),depth)),/超出声明范围/);
  }
  const point={frame:0,t:0,si:0,ti:null};assert.doesNotThrow(()=>validateSitiPoints([point],[{t:0}],{firstTi:null}));
  assert.throws(()=>validateSitiPoints([{...point,ti:0}],[{t:0}],{firstTi:null}),/没有 TI/);
  assert.throws(()=>validateSitiPoints([point,{frame:1,t:1,si:0,ti:null}],null,{firstTi:null}),/指标/);
});

test('P.910 SI/TI CPU decodes lossless native SDR frames and preserves source time and reference values',{timeout:90000},async t=>{
  const ctx={signal:t.signal};await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-'));
  const evidence={outcome:'running',profile:SITI_P910_PROFILE,cases:[]};const save=()=>writeFile(path.join(dir,'normative-cpu.json'),JSON.stringify(evidence,null,2));await save();
  for(const c of vectors.cases)for(const sampling of ['420','422']){
    const name=c.name+'-'+sampling,raw=path.join(dir,name+'.yuv'),file=path.join(dir,name+'.mkv'),pix=`yuv${sampling}p${c.depth===10?'10le':''}`;
    const chroma=bytes(Array(c.width*c.height/(sampling==='420'?2:1)).fill(128*2**(c.depth-8)),c.depth);
    await writeFile(raw,Buffer.concat(c.frames.flatMap(f=>[bytes(f,c.depth),chroma])));
    await run(FF,['-v','error','-f','rawvideo','-pixel_format',pix,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,'-vf',`setfield=prog,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=bt709:color_primaries=bt709:colorspace=bt709,setpts=PTS+7200/TB`,'-fps_mode','passthrough','-c:v','ffv1','-level','3','-color_range',c.range,'-color_trc','bt709','-color_primaries','bt709','-colorspace','bt709',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx),commands=[];
    assert.equal(sitiP910Eligible(stream),true,c.name);
    const result=await complexity(file,stream,{...ctx,sitiWorkers:4,commands},frames);
    assert.equal(result.execution.method,SITI_P910_PROFILE);assert.equal(result.execution.device,'cpu');assert.equal(result.execution.workers,1);
    assert.equal(result.execution.requestedWorkers,4);assert.match(result.execution.parallelReason,/帧数/);
    assert.equal(result.points.length,c.frames.length);assert.equal(result.ti.count,c.frames.length-1);assert.equal(result.points[0].t,7200);
    for(let i=0;i<result.points.length;i++){close(result.points[i].si,c.expected[i].si,c.name+'/'+i+'/SI');if(i)close(result.points[i].ti,c.expected[i].ti,c.name+'/'+i+'/TI');else assert.equal(result.points[i].ti,null)}
    close(result.si.mean,c.expectedMean.si,c.name+'/SI mean');close(result.ti.mean,c.expectedMean.ti,c.name+'/TI mean');
    assert.equal(commands.length,2);assert.ok(commands.every(c=>c.exitCode===0));
    const gpuRequest=await complexity(file,stream,{...ctx,sitiDevice:'gpu'},frames);
    assert.equal(gpuRequest.execution.requestedDevice,'gpu');assert.equal(gpuRequest.execution.method,SITI_P910_PROFILE);
    if(gpuRequest.execution.device==='cpu')assert.ok(gpuRequest.execution.gpuFallbackReason);
    else{assert.equal(gpuRequest.execution.validation.selfTest,'passed');assert.equal(gpuRequest.execution.gpuFallbackReason,undefined)}
    for(let i=0;i<result.points.length;i++){assert.equal(gpuRequest.points[i].t,result.points[i].t);close(gpuRequest.points[i].si,result.points[i].si,name+'/GPU SI');if(i)close(gpuRequest.points[i].ti,result.points[i].ti,name+'/GPU TI');else assert.equal(gpuRequest.points[i].ti,null)}
    await assert.rejects(complexity(file,stream,ctx,frames.slice(0,-1)),/帧数/);
    const shifted=structuredClone(frames);shifted[1].t+=.01;await assert.rejects(complexity(file,stream,ctx,shifted),/时间戳与预扫描/);
    if(c.name==='8-full'&&sampling==='420'){
      await assert.rejects(complexity(file,{...stream,width:stream.width+2},ctx,frames),/输入帧序号、格式/);
      await assert.rejects(complexity(file,{...stream,color_range:'tv'},ctx,frames),/声明范围|与轨道声明不一致/);
    }
    if(c.name==='8-limited'&&sampling==='420'){
      const active=new AbortController(),cancelCommands=[];
      const work=complexity(file,stream,{signal:AbortSignal.any([t.signal,active.signal]),commands:cancelCommands},frames);active.abort();await assert.rejects(work);
      assert.equal(cancelCommands.length,2,'cancel calculation and decoder without a legacy retry');
    }
    evidence.cases.push({name,pixelFormat:pix,frames,result,gpuRequest,commands});await save();await unlink(raw);await unlink(file);
  }
  evidence.outcome='passed';await save();
});

test('P.910 SI/TI CPU frame parallel preserves every unrounded value, overlap TI and source VFR time',{timeout:90000},async t=>{
  const ctx={signal:t.signal};await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-'));
  const evidence={outcome:'running',profile:SITI_P910_PROFILE,cases:[]},save=()=>writeFile(path.join(dir,'parallel-equivalence.json'),JSON.stringify(evidence,null,2));await save();
  for(const c of vectors.cases){
    const sampling=c.depth===10?'422':'420',pix=`yuv${sampling}p${c.depth===10?'10le':''}`,raw=path.join(dir,c.name+'.yuv'),file=path.join(dir,c.name+'.mkv');
    const chroma=bytes(Array(c.width*c.height/(sampling==='420'?2:1)).fill(128*2**(c.depth-8)),c.depth);
    await writeFile(raw,Buffer.concat(Array.from({length:123},(_,i)=>[bytes(c.frames[i%c.frames.length],c.depth),chroma]).flat()));
    await run(FF,['-v','error','-noauto_conversion_filters','-f','rawvideo','-pixel_format',pix,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,'-vf',`setfield=prog,setparams=range=${c.range==='tv'?'limited':'full'}:color_trc=bt709:color_primaries=bt709:colorspace=bt709,setpts='(N+floor(N/7))/(24*TB)+7200/TB'`,'-fps_mode','passthrough','-c:v','ffv1','-level','3','-color_range',c.range,'-color_trc','bt709','-color_primaries','bt709','-colorspace','bt709',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx),serial=await complexity(file,stream,{...ctx,sitiWorkers:1},frames),runs=[];
    assert.equal(stream.color_range,c.range);assert.equal(stream.pix_fmt,pix);
    for(let i=0;i<c.expected.length;i++){close(serial.points[i].si,c.expected[i].si,c.name+'/parallel fixture SI');if(i)close(serial.points[i].ti,c.expected[i].ti,c.name+'/parallel fixture TI')}
    for(const requested of [2,4,8]){
      const expectedWorkers=sitiWorkerCount(stream,frames.length,requested),commands=[],parallel=await complexity(file,stream,{...ctx,sitiWorkers:requested,commands},frames);
      assert.equal(parallel.execution.mode,'frame-parallel');assert.equal(parallel.execution.workers,expectedWorkers);assert.equal(parallel.execution.overlapFrames,1);
      assert.deepEqual(parallel.points,serial.points);assert.deepEqual(parallel.si,serial.si);assert.deepEqual(parallel.ti,serial.ti);
      assert.equal(commands.length,2*parallel.execution.workers);assert.ok(commands.every(c=>c.exitCode===0));
      runs.push({requested,parallel,commands});
    }
    const starts=[0,30,31,61,62,92,122],sceneSerial=await complexity(file,stream,{...ctx,sitiWorkers:1,sitiSceneStarts:starts},frames),sceneParallel=await complexity(file,stream,{...ctx,sitiWorkers:4,sitiSceneStarts:starts},frames);
    assert.equal(sceneParallel.execution.mode,'frame-parallel');assert.deepEqual(sceneParallel.points,sceneSerial.points);assert.deepEqual(sceneParallel.scenes,sceneSerial.scenes);
    assert.equal(sceneSerial.si,null);assert.equal(sceneSerial.ti,null);assert.equal(sceneSerial.scenes.length,starts.length);
    assert.deepEqual(sceneSerial.points,serial.points.map((p,i)=>({...p,ti:starts.includes(i)?null:p.ti})));
    for(const [i,start] of starts.entries()){
      const end=starts[i+1]??frames.length,part=serial.points.slice(start,end);
      assert.deepEqual(sceneSerial.scenes[i].si,distribution(part.map(p=>p.si)));assert.deepEqual(sceneSerial.scenes[i].ti,distribution(part.slice(1).map(p=>p.ti)));
      assert.equal(sceneSerial.scenes[i].frameCount,end-start);
    }
    assert.equal(sceneSerial.scenes.at(-1).ti,null,'one-frame scene has no TI statistic');
    const single=await complexity(file,stream,{...ctx,sitiWorkers:1,sitiSceneStarts:[0]},frames);
    assert.deepEqual(single.points,serial.points);assert.deepEqual(single.si,serial.si);assert.deepEqual(single.ti,serial.ti);
    assert.equal(single.sceneAnalysis.mode,'confirmed');assert.equal(serial.sceneAnalysis.mode,'unconfirmed');
    for(const invalid of [[],[1],[0,0],[0,62,31],[0,123],[0,1.5],null])await assert.rejects(complexity(file,stream,{...ctx,sitiSceneStarts:invalid},frames),/场景/);
    if(c.name==='8-limited'){
      for(const wrong of [frames.slice(0,-1),[...frames,{...frames.at(-1),t:frames.at(-1).t+1/24}]])await assert.rejects(complexity(file,stream,{...ctx,sitiWorkers:4},wrong),/帧数/);
      const shifted=structuredClone(frames);shifted[31].t+=.01;await assert.rejects(complexity(file,stream,{...ctx,sitiWorkers:4},shifted),/时间戳与预扫描/);
      const active=new AbortController(),commands=[],expectedWorkers=sitiWorkerCount(stream,frames.length,4);
      await assert.rejects(complexity(file,stream,{sitiWorkers:4,commands,signal:AbortSignal.any([t.signal,active.signal]),update:p=>{if(p.completed>=1)active.abort()}},frames));
      assert.equal(commands.length,expectedWorkers*2,'cancel all active workers and decoders without serial retry');
      const invalidRaw=path.join(dir,'invalid.yuv'),invalidFile=path.join(dir,'invalid.mkv'),corrupt=await readFile(raw);corrupt[31*c.width*c.height*1.5]=15;await writeFile(invalidRaw,corrupt);
      await run(FF,['-v','error','-noauto_conversion_filters','-f','rawvideo','-pixel_format',pix,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',invalidRaw,'-vf','setfield=prog,setparams=range=limited:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v','ffv1','-level','3','-color_range','tv',invalidFile],ctx);
      const invalidFrames=await scan(invalidFile,0,ctx),invalidCommands=[];
      await assert.rejects(complexity(invalidFile,stream,{...ctx,sitiWorkers:4,commands:invalidCommands},invalidFrames),/超出声明范围/);
      assert.equal(invalidCommands.length,expectedWorkers*2+2,'reject bad boundary pixels again after same-profile serial recovery');
      evidence.guards={invalidScanRejected:true,boundaryTimeRejected:true,invalidBoundaryCodeRejected:true,cancellationCommands:commands,invalidCommands};
      await unlink(invalidRaw);await unlink(invalidFile);
    }
    evidence.cases.push({name:c.name,serial,runs,sceneStarts:starts,sceneSerial,sceneParallel,single});await save();await unlink(raw);await unlink(file);
  }
  evidence.outcome='passed';await save();
});
