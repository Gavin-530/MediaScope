import {readFixture} from './helpers/fixtures.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {sitiInput,sitiConfiguration,sitiPreprocessedValue,createSitiLut,createSitiReader,createSitiCalculator,validateSitiConfiguration,sitiTimestamp,validateSitiPoints,sitiSceneSummary,validateSitiSceneResult,SITI_REFERENCE,SITI_COMPAT_PROFILE,SITI_NUMERIC_TOLERANCE,sitiValuesClose} from '../public/siti.js';
import {measureSiti,sitiWorkerCount} from '../siti.mjs';
import {complexity} from '../analysis.mjs';
import {FF,run,probe,scan} from '../engine.mjs';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {publishedSitiCases} from './helpers/siti-published.mjs';
import {independentSitiLayouts,SITI_LAYOUT_ORACLE_SHA256} from './helpers/siti-layouts.mjs';
const vectors=JSON.parse(await readFixture('vqeg-060.json'));
const version7=JSON.parse(await readFixture('historical-v7.json'));
const close=(actual,expected,label)=>assert.ok(sitiValuesClose(actual,expected),`${label}: ${actual} vs ${expected}`);
// Local formula/input checks are distinct from the final SI/TI comparison rule.
const closePreprocessing=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1e-8+Math.abs(expected)*1e-10,`${label}: ${actual} vs ${expected}`);
const context=c=>({pix_fmt:c.format,color_range:c.range,color_transfer:{sdr:'bt709',srgb:'iec61966-2-1',pq:'smpte2084',hlg:'arib-std-b67'}[c.domain],field_order:'progressive'});
async function directory(){await mkdir('.build/testing-work',{recursive:true});return mkdtemp(path.resolve('.build/testing-work/siti-p910-'))}
function equivalent(actual,expected,starts=[0]){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){close(actual[i].si,expected[i].si,'SI '+i);if(starts.includes(i))assert.equal(actual[i].ti,null);else close(actual[i].ti,expected[i].ti,'TI '+i)}}

test('SI/TI numeric acceptance uses pinned upstream absolute OR relative tolerance with actual as the relative base',()=>{
  assert.equal(SITI_NUMERIC_TOLERANCE.absoluteTolerance,.01);assert.equal(SITI_NUMERIC_TOLERANCE.relativeTolerance,.005);
  for(const [actual,reference,accepted] of [[0,.01,true],[0,.010001,false],[100,100.5,true],[100,100.505,false],[100,100.501,false],[100.501,100,true],[NaN,0,false],[Infinity,Infinity,false],[0,null,false]])assert.equal(sitiValuesClose(actual,reference),accepted,`${actual} vs ${reference}`);
});

test('SI/TI independent byte oracle validates 150 layouts and 900 CPU input cases',async()=>{
  const data=await independentSitiLayouts(),cases=[];let maxSampleError=0,maxError=0;
  for(const c of data.cases){
    const input=sitiInput(context(c),c.settings),reader=createSitiReader(input,c.width,c.height),calculator=createSitiCalculator(c.width,c.height,input),out=new Float64Array(c.width*c.height),points=[];
    for(let i=0;i<c.frames.length;i++){
      const raw=Buffer.from(c.frames[i],'base64');reader.read(raw,out);
      for(let j=0;j<out.length;j++){const error=Math.abs(out[j]-c.normalized[i][j]);maxSampleError=Math.max(maxSampleError,error);assert.ok(error<=5e-16,c.name+' sample '+j)}
      const p=calculator.measure(raw);points.push(p);close(p.si,c.expected[i].si,c.name+' SI');if(i)close(p.ti,c.expected[i].ti,c.name+' TI');else assert.equal(p.ti,null);
      maxError=Math.max(maxError,Math.abs(p.si-c.expected[i].si),i?Math.abs(p.ti-c.expected[i].ti):0);
    }
    cases.push({name:c.name,points});
  }
  const dir=await directory();await writeFile(path.join(dir,'independent-layout-cpu.json'),JSON.stringify({outcome:'passed',fixtureSha256:SITI_LAYOUT_ORACLE_SHA256,formats:150,cases,maxSampleError,maxError}));
});

test('SI/TI invalid NUT layout fixtures are rejected before CPU or GPU calculation',{timeout:30000},async t=>{
  const dir=await directory(),cases=[];
  for(const format of ['nv16','nv24','p010le','p212be','p416le']){
    const c=vectors.cases.find(c=>c.format===format);let mismatch;
    try{await sitiInputFixture(dir,c,{}, {signal:t.signal})}catch(e){mismatch=e}
    assert.equal(mismatch?.code,'SITI_FIXTURE_FORMAT_MISMATCH');assert.equal(mismatch.requestedFormat,format);assert.equal(mismatch.stream.pix_fmt,'rgb555le');
    const rejected=[];
    for(const device of ['cpu','gpu']){
      const commands=[];let failure;
      try{await measureSiti(mismatch.file,mismatch.stream,{signal:t.signal,sitiDevice:device,sitiSettings:c.settings,commands})}catch(e){failure=e}
      assert.equal(failure?.sitiPhase,'input');assert.match(failure.message,/像素布局/);assert.equal(commands.length,0,'Invalid decoded layout must not start compute or a fallback');
      rejected.push({device,phase:failure.sitiPhase,message:failure.message,commands});
    }
    cases.push({requestedFormat:format,decodedFormat:mismatch.stream.pix_fmt,classification:'invalid-fixture',rejected});
  }
  await writeFile(path.join(dir,'fixture-rejections.json'),JSON.stringify({outcome:'passed',cases}));
});

test('SI/TI reproduces unchanged upstream published files and ground truth',{timeout:60000},async t=>{
  const dir=await directory(),cases=[];
  for(const c of await publishedSitiCases()){
    const ctx={signal:t.signal,sitiSettings:c.settings,sitiWorkers:1},stream=(await probe(c.file,ctx)).raw.streams[0],frames=await scan(c.file,stream.index,ctx),result=await measureSiti(c.file,stream,ctx,frames);
    assert.equal(result.points.length,c.reference.si.length);assert.equal(result.points.length-1,c.reference.ti.length);
    for(let i=0;i<result.points.length;i++){close(result.points[i].si,c.reference.si[i],c.name+' SI');if(i)close(result.points[i].ti,c.reference.ti[i-1],c.name+' TI');else assert.equal(result.points[i].ti,null);}
    cases.push({name:c.name,reference:c.reference,result});
  }
  await writeFile(path.join(dir,'published-equivalence.json'),JSON.stringify({outcome:'passed',cases}));
});

test('SI/TI matches pinned unmodified siti-tools 0.6.0 functions across integer formats',async()=>{
  const source=await readFixture('vqeg-reference.py');assert.equal(createHash('sha256').update(source).digest('hex'),SITI_REFERENCE.sourceSha256);
  assert.equal(vectors.reference.commit,SITI_REFERENCE.commit);
  assert.ok(['normalize_between_0_1','apply_display_model','eotf_hlg','normalize_to_original_si_range','si','ti'].every(k=>vectors.reference.unmodifiedFunctions.includes(k)));
  assert.equal(vectors.reference.version,'0.6.0');assert.equal(vectors.cases.length,84);
  for(const c of vectors.cases){
    const input=sitiInput(context(c),c.settings),calculator=createSitiCalculator(c.width,c.height,input);
    const points=c.frames.map(raw=>calculator.measure(Buffer.from(raw,'base64')));equivalent(points,c.expected);
    const sceneCalculator=createSitiCalculator(c.width,c.height,input);equivalent(c.frames.map((raw,i)=>sceneCalculator.measure(Buffer.from(raw,'base64'),[0,2,4].includes(i))),c.expected,[0,2,4]);
  }
});

test('HLG preserves the pinned upstream transfer and discontinuity without substituting a display model',()=>{
  for(const hlg of vectors.hlgCurves){
    const settings={transfer:'hlg',hlg:{whiteCdM2:hlg.whiteCdM2,blackCdM2:hlg.blackCdM2}},input=sitiInput({pix_fmt:'gray10le',color_range:'pc',color_transfer:'arib-std-b67'},settings);
    for(const p of hlg.points)closePreprocessing(sitiPreprocessedValue(p.signal,input),p.pq,'pinned HLG '+hlg.whiteCdM2+' / '+p.signal);
    assert.equal(sitiConfiguration(input).configurationVersion,8);assert.equal(sitiConfiguration(input).profile,SITI_COMPAT_PROFILE);
    assert.ok(sitiPreprocessedValue(.5,input)>sitiPreprocessedValue(.500000001,input),'reproduce upstream join');
    if(hlg.whiteCdM2===600)assert.equal(input.hlg.gamma,1.2);
    assert.equal(input.hlg.beta,undefined);
  }
  const c=vectors.cases.find(c=>c.name==='gray10le-hlg-pc-step'),calculator=createSitiCalculator(c.width,c.height,sitiInput(context(c),c.settings));
  calculator.measure(Buffer.from(c.frames[0],'base64'));const point=calculator.measure(Buffer.from(c.frames[1],'base64'));
  close(point.ti,c.expected[1].ti,'one-code HLG TI');assert.ok(point.si>40);assert.ok(point.ti>10);
});

test('SI/TI pinned display endpoints, fixed 255 scale and analytic population statistics',()=>{
  for(const curve of vectors.sdrCurves){
    const input=sitiInput({pix_fmt:'gray',color_range:'pc',color_transfer:'bt709'},{transfer:curve.domain});
    for(const p of curve.points)closePreprocessing(sitiPreprocessedValue(p.signal,input),p.pq,curve.domain+' '+p.signal);
    closePreprocessing(curve.points[0].luminance,.1,'display black');
    closePreprocessing(curve.points.at(-1).luminance,300,'display white');
  }
  for(const depth of [8,9,10,12,14,16])for(const range of ['pc','tv']){
    const input=sitiInput({pix_fmt:depth===8?'gray':`gray${depth}le`,color_range:range,color_transfer:'smpte2084'}),maximum=2**depth-1,factor=2**(depth-8),lo=range==='tv'?16*factor:0,hi=range==='tv'?235*factor:maximum,table=createSitiLut(input);
    const middle=Math.floor((lo+hi)/2);assert.equal(table[lo],0);assert.equal(table[hi],1);closePreprocessing(table[middle],(middle-lo)/(hi-lo),'native midpoint');
    assert.equal(sitiConfiguration(input).outputMultiplier,255);
    const raw=samples=>{const b=Buffer.alloc(samples.length*(depth===8?1:2));samples.forEach((v,i)=>depth===8?b[i]=v:b.writeUInt16LE(v,i*2));return b};
    const black=raw(Array(16).fill(lo)),edge=raw(Array.from({length:16},(_,i)=>i%4===3?hi:lo)),calculator=createSitiCalculator(4,4,input);
    assert.deepEqual(calculator.measure(black),{frame:0,si:0,ti:null});
    const point=calculator.measure(edge);close(point.si,2*255,'Sobel edge');close(point.ti,Math.sqrt(3)/4*255,'population temporal deviation');
    assert.equal(calculator.measure(edge).ti,0);
    const checker=raw(Array.from({length:16},(_,i)=>(i%4+Math.floor(i/4))%2?hi:lo));assert.equal(createSitiCalculator(4,4,input).measure(checker).si,0);
    assert.equal(createSitiCalculator(3,3,input).measure(raw(Array(9).fill(hi))).si,0);
  }
  const single=[{frame:0,t:0,si:12,ti:null}],summary=sitiSceneSummary(single,[0]);assert.equal(summary.si.count,1);assert.equal(summary.si.mean,12);assert.equal(summary.ti,null);
  const points=[...single,{frame:1,t:1,si:14,ti:4},{frame:2,t:2,si:20,ti:null}],scenes=sitiSceneSummary(points,[0,2]);assert.equal(scenes.si,null);assert.equal(scenes.ti,null);assert.equal(scenes.scenes[0].si.mean,13);assert.equal(scenes.scenes[0].ti.count,1);assert.equal(scenes.scenes[0].ti.mean,4);assert.equal(scenes.scenes[1].ti,null);
});

test('SI/TI frozen version 5 and 6 configurations retain their historical declarations',()=>{
  assert.equal(vectors.historical.length,4);
  for(const history of vectors.historical){
    const c=vectors.cases.find(c=>c.name===history.case),execution={method:history.configuration.profile,configuration:history.configuration};
    validateSitiConfiguration(execution,context(c));assert.equal(execution.configuration.outputMultiplier,255);
    const damaged=structuredClone(execution);damaged.configuration.outputMultiplier++;assert.throws(()=>validateSitiConfiguration(damaged,context(c)));
  }
});
test('SI/TI frozen version 7 configurations retain original display models, HLG and input-depth scale',async()=>{
  const bytes=await readFixture('historical-v7.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'0037f8675f84f97ae99da67b3a4b8032aef81bed4cafe84d3f4fd74d27132572');
  for(const history of version7.snapshots){const c=vectors.cases.find(c=>c.name===history.case),execution={method:history.configuration.profile,configuration:history.configuration};validateSitiConfiguration(execution,context(c));assert.equal(execution.configuration.outputMultiplier,2**c.depth-1);}
});

test('SI/TI rejects unreferenced inputs, invalid legal codes, padding and partial alpha',()=>{
  const c=vectors.cases.find(c=>c.name==='gray10le-sdr-tv'),stream=context(c);
  for(const settings of [{scale:'literal'},{floatDepth:10},{alpha:{mode:'straight'}},{transfer:'hlg',hlg:{whiteCdM2:1,blackCdM2:1}}])assert.throws(()=>sitiInput(stream,settings));
  assert.ok(sitiInput(stream,{transfer:'hlg',hlg:{whiteCdM2:1000,blackCdM2:900}}));
  const historicalInput=sitiInput(stream,{transfer:'hlg',hlg:{whiteCdM2:1000,blackCdM2:900}});
  const newConfig=sitiConfiguration(historicalInput);validateSitiConfiguration({method:newConfig.profile,configuration:newConfig},stream);
  for(const format of ['grayf32le','gbrpf32le','gbrapf32be','xyz12le','unknown'])assert.throws(()=>sitiInput({...stream,pix_fmt:format},c.settings));
  assert.throws(()=>sitiInput({...stream,color_range:'unknown'},undefined),/范围/);
  assert.throws(()=>sitiInput({...stream,field_order:'tt'},c.settings),/隔行/);
  const raw=Buffer.from(c.frames[0],'base64');raw.writeUInt16LE(63);assert.throws(()=>createSitiCalculator(c.width,c.height,sitiInput(stream,c.settings)).measure(raw),/超出声明范围/);
  const padding=vectors.cases.find(c=>c.format==='p010le'),bad=Buffer.from(padding.frames[0],'base64');bad[0]|=1;assert.throws(()=>createSitiCalculator(10,8,sitiInput(context(padding),padding.settings)).measure(bad),/填充位/);
  const alpha=vectors.cases.find(c=>c.format==='rgba'),transparent=Buffer.from(alpha.frames[0],'base64');transparent[3]=128;assert.throws(()=>createSitiCalculator(10,8,sitiInput(context(alpha),alpha.settings)).measure(transparent),/半透明/);
  assert.throws(()=>sitiInput({pix_fmt:'rgb24',color_range:'pc',color_transfer:'bt709',color_space:'bt2020nc',color_primaries:'bt709'}),/矩阵/);
});

test('SI/TI out-of-range decoded input reports its cause and closes serial and parallel pipelines',{timeout:30000},async t=>{
  const dir=await directory(),file=path.join(dir,'outside-range.mkv');
  await run(FF,['-v','error','-y','-f','lavfi','-i','nullsrc=size=320x240:rate=30:duration=3,geq=lum=15:cb=128:cr=128,setfield=prog,setparams=range=limited:color_trc=bt709','-c:v','ffv1','-color_range','tv','-color_trc','bt709',file],{signal:t.signal});
  const stream=(await probe(file,{signal:t.signal})).raw.streams[0],frames=await scan(file,0,{signal:t.signal});
  for(const workers of [1,3])await assert.rejects(measureSiti(file,stream,{signal:t.signal,sitiWorkers:workers},frames),e=>{
    assert.equal(e.sitiPhase,'input');assert.match(e.message,/码值 15.*超出声明范围/);assert.equal(e.sitiAttempts.length,1);return true;
  });
});

test('SI/TI timestamps, scene statistics and saved configuration reject inconsistent results',()=>{
  const points=[{frame:0,t:7200,si:12,ti:null},{frame:1,t:7200.041666666667,si:13,ti:2}],frames=[{t:7200},{t:7200.041667}];
  validateSitiPoints(points,frames);assert.equal(sitiTimestamp('7200001','1/1000'),7200.001);
  for(const [pts,base] of [['N/A','1/1000'],['9007199254740993','1/1000'],['1','0/1000']])assert.throws(()=>sitiTimestamp(pts,base));
  for(const damage of [p=>p.pop(),p=>p[0].ti=0,p=>p[1].ti=-1,p=>p[1].si=NaN,p=>p[1].frame=0,p=>p[1].t+=.001]){const p=structuredClone(points);damage(p);assert.throws(()=>validateSitiPoints(p,frames))}
  const zeroFirstTi=structuredClone(points);zeroFirstTi[0].ti=0;assert.throws(()=>validateSitiPoints(zeroFirstTi,frames,{firstTi:0}));
  const scenePoints=structuredClone(points);scenePoints[1].ti=null;const content={points:scenePoints,...sitiSceneSummary(scenePoints,[0,1])};validateSitiSceneResult(content,frames);content.scenes[0].si.mean++;assert.throws(()=>validateSitiSceneResult(content,frames));
});

test('P.910 SI/TI CPU decodes lossless native SDR frames and preserves source time and reference values',{timeout:180000},async t=>{
  const dir=await directory(),evidence={outcome:'running',cases:[]};
  for(const name of ['gray-sdr-tv','gray9le-sdr-tv','gray10le-pq-tv','gray12le-hlg-pc','gray14be-sdr-tv','gray16le-srgb-pc','yuv420p-sdr-tv','yuv422p-sdr-tv','yuv444p-sdr-tv','nv12-sdr-tv','rgb24-sdr-pc','rgb48be-sdr-pc','gbrp12le-pq-pc','rgba-sdr-pc','gray10le-hlg-pc-step','gray10le-hlg-tv-step','rgb24-hlg-pc']){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c,{}, {signal:t.signal});
    const result=await complexity(fixture.file,fixture.stream,{signal:t.signal,sitiSettings:c.settings,sitiWorkers:1},fixture.frames);
    assert.equal(result.available,true,name+': '+result.reason+' / '+fixture.stream.pix_fmt);assert.equal(result.execution.method,SITI_COMPAT_PROFILE);validateSitiConfiguration(result.execution,fixture.stream);
    equivalent(result.points,c.expected);assert.equal(result.points[0].t,7200);assert.deepEqual(result.points.map(p=>Number(p.t.toFixed(6))),fixture.frames.map(p=>p.t));
    if(name==='gray-sdr-tv'){
      const fallback=await measureSiti(fixture.file,fixture.stream,{signal:t.signal,sitiSettings:c.settings,sitiDevice:'gpu',sitiWorkers:1});
      assert.equal(fallback.execution.device,'cpu');assert.ok(fallback.execution.gpuFallbackReason);assert.deepEqual(fallback.points,result.points);assert.deepEqual(fallback.execution.configuration,result.execution.configuration);
    }
    evidence.cases.push({name,stream:fixture.stream,result});
  }
  evidence.outcome='passed';await writeFile(path.join(dir,'normative-cpu.json'),JSON.stringify(evidence));
});

test('P.910 SI/TI CPU frame parallel preserves every unrounded value, overlap TI and source VFR time',{timeout:180000},async t=>{
  const dir=await directory(),evidence={outcome:'running',cases:[]};
  for(const name of ['gray9le-sdr-tv','gray12le-hlg-pc','gray16be-sdr-tv','rgb24-sdr-pc']){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c,{count:96},{signal:t.signal}),options={signal:t.signal,sitiSettings:c.settings,sitiSceneStarts:[0,31,32,63,95]};
    const serial=await complexity(fixture.file,fixture.stream,{...options,sitiWorkers:1},fixture.frames),parallel=await complexity(fixture.file,fixture.stream,{...options,sitiWorkers:3},fixture.frames);
    assert.equal(serial.available,true,serial.reason);assert.equal(parallel.available,true,parallel.reason);assert.deepEqual(parallel.points,serial.points);assert.deepEqual(parallel.scenes,serial.scenes);
    assert.equal(parallel.execution.workers,sitiWorkerCount(fixture.stream,96,3));assert.equal(parallel.execution.fallbackReason,undefined);
    assert.deepEqual(parallel.execution.configuration,serial.execution.configuration);assert.equal(parallel.execution.decodePasses,1);evidence.cases.push({name,serial,parallel});
  }
  evidence.outcome='passed';await writeFile(path.join(dir,'parallel-equivalence.json'),JSON.stringify(evidence));
});

test('SI/TI explicitly selected BWDIF measures progressive output with preserved frames and time',{timeout:60000},async t=>{
  const dir=await directory(),c=vectors.cases.find(c=>c.name==='gray16le-hlg-pc'),fixture=await sitiInputFixture(dir,c,{lossless:true,metadata:true,interlaced:true,count:96},{signal:t.signal});
  const rejected=await complexity(fixture.file,fixture.stream,{signal:t.signal},fixture.frames);assert.equal(rejected.available,false);assert.match(rejected.reason,/隔行/);
  const settings={...c.settings,interlaced:'bwdif'},serial=await complexity(fixture.file,fixture.stream,{signal:t.signal,sitiSettings:settings,sitiWorkers:1},fixture.frames),parallel=await complexity(fixture.file,fixture.stream,{signal:t.signal,sitiSettings:settings,sitiWorkers:3},fixture.frames);
  assert.equal(serial.available,true,serial.reason);assert.equal(parallel.available,true,parallel.reason);assert.deepEqual(parallel.points,serial.points);assert.equal(serial.points.length,96);validateSitiConfiguration(serial.execution,fixture.stream);
  await writeFile(path.join(dir,'deinterlace-equivalence.json'),JSON.stringify({outcome:'passed',serial,parallel}));
});

test('SI/TI preserves CPU results across AVC HEVC AV1 containers and cancels active workers',{timeout:180000},async t=>{
  const dir=await directory();
  for(const [codec,extra] of [['libx264',['-preset','ultrafast']],['libx265',['-preset','ultrafast']],['libaom-av1',['-cpu-used','8']]]){
    const file=path.join(dir,codec+'.mkv');await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=24:duration=4,setfield=prog,setparams=range=full:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v',codec,...extra,'-color_range','pc','-color_trc','bt709',file],{signal:t.signal});
    const stream=(await probe(file)).raw.streams[0],frames=await scan(file,0),serial=await measureSiti(file,stream,{signal:t.signal,sitiWorkers:1},frames),parallel=await measureSiti(file,stream,{signal:t.signal,sitiWorkers:3},frames);
    assert.deepEqual(parallel.points,serial.points);assert.equal(parallel.execution.fallbackReason,undefined);
    const controller=new AbortController();controller.abort();await assert.rejects(measureSiti(file,stream,{signal:controller.signal,sitiWorkers:3},frames),/取消/);
    const active=new AbortController();setTimeout(()=>active.abort(),100);await assert.rejects(measureSiti(file,stream,{signal:active.signal,sitiWorkers:3},frames),/取消|abort/i);
  }
});
