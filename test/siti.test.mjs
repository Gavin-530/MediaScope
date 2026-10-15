import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {sitiInput,sitiConfiguration,sitiPreprocessedValue,createSitiLut,createSitiCalculator,validateSitiConfiguration,sitiTimestamp,validateSitiPoints,sitiSceneSummary,validateSitiSceneResult,SITI_REFERENCE,SITI_STANDARD_PROFILE} from '../public/siti.js';
import {measureSiti,sitiWorkerCount} from '../siti.mjs';
import {complexity} from '../analysis.mjs';
import {FF,run,probe,scan} from '../engine.mjs';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
const vectors=JSON.parse(await readFile(new URL('./reference/siti/vqeg-pq.json',import.meta.url),'utf8'));
const close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=1e-8+Math.abs(expected)*1e-10,`${label}: ${actual} vs ${expected}`);
const context=c=>({pix_fmt:c.format,color_range:c.range,color_transfer:{sdr:'bt709',srgb:'iec61966-2-1',pq:'smpte2084',hlg:'arib-std-b67'}[c.domain],field_order:'progressive'});
async function directory(){await mkdir('test-work',{recursive:true});return mkdtemp(path.resolve('test-work/siti-p910-'))}
function equivalent(actual,expected,starts=[0]){assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){close(actual[i].si,expected[i].si,'SI '+i);if(starts.includes(i))assert.equal(actual[i].ti,null);else close(actual[i].ti,expected[i].ti,'TI '+i)}}

test('SI/TI matches independent P.910 display and scale references across integer formats',async()=>{
  const source=await readFile(new URL('./reference/siti/vqeg-reference.py',import.meta.url));assert.equal(createHash('sha256').update(source).digest('hex'),SITI_REFERENCE.sourceSha256);
  assert.equal(vectors.reference.commit,SITI_REFERENCE.commit);
  assert.deepEqual(vectors.reference.unmodifiedFunctions,['si','ti']);
  assert.equal(vectors.cases.length,84);assert.equal(vectors.hlgReference.table,5);
  for(const c of vectors.cases){
    const input=sitiInput(context(c),c.settings),calculator=createSitiCalculator(c.width,c.height,input);
    const points=c.frames.map(raw=>calculator.measure(Buffer.from(raw,'base64')));equivalent(points,c.expected);
    const sceneCalculator=createSitiCalculator(c.width,c.height,input);equivalent(c.frames.map((raw,i)=>sceneCalculator.measure(Buffer.from(raw,'base64'),[0,2,4].includes(i))),c.expected,[0,2,4]);
  }
});

test('HLG Table 5 transfer is continuous and monotonic with black lift, display gamma and versioned results',()=>{
  for(const hlg of vectors.hlgCurves){
    const settings={transfer:'hlg',hlg:{whiteCdM2:hlg.whiteCdM2,blackCdM2:hlg.blackCdM2}},input=sitiInput({pix_fmt:'gray10le',color_range:'pc',color_transfer:'arib-std-b67'},settings);
    for(const p of hlg.points)close(sitiPreprocessedValue(p.signal,input),p.pq,'BT.2100 HLG '+hlg.whiteCdM2+' / '+p.signal);
    const table=createSitiLut(input);for(let i=1;i<table.length;i++)assert.ok(table[i]>=table[i-1],`non-monotonic HLG ${hlg.whiteCdM2} at ${i}`);
    assert.equal(sitiConfiguration(input).configurationVersion,7);assert.equal(sitiConfiguration(input).profile,SITI_STANDARD_PROFILE);
    const pivot=(.5-input.hlg.beta)/(1-input.hlg.beta);
    assert.ok(Math.abs(sitiPreprocessedValue(pivot+1e-9,input)-sitiPreprocessedValue(pivot-1e-9,input))<1e-8,'continuous inverse OETF join');
    if(hlg.whiteCdM2===600)assert.ok(input.hlg.gamma<1.2);
    if(hlg.blackCdM2===0)assert.equal(input.hlg.beta,0);
  }
  const c=vectors.cases.find(c=>c.name==='gray10le-hlg-pc-step'),calculator=createSitiCalculator(c.width,c.height,sitiInput(context(c),c.settings));
  calculator.measure(Buffer.from(c.frames[0],'base64'));const point=calculator.measure(Buffer.from(c.frames[1],'base64'));
  close(point.ti,c.expected[1].ti,'one-code HLG TI');assert.ok(point.si<.9);assert.ok(point.ti<.23);
});

test('SI/TI reference display endpoints, native scales and analytic population statistics',()=>{
  for(const curve of vectors.sdrCurves){
    const input=sitiInput({pix_fmt:'gray',color_range:'pc',color_transfer:'bt709'},{transfer:curve.domain});
    for(const p of curve.points)close(sitiPreprocessedValue(p.signal,input),p.pq,curve.domain+' '+p.signal);
    close(curve.points[0].luminance,curve.domain==='sdr'?.01:.2,'display black');
    close(curve.points.at(-1).luminance,curve.domain==='sdr'?300:80,'display white');
  }
  for(const depth of [8,9,10,12,14,16])for(const range of ['pc','tv']){
    const input=sitiInput({pix_fmt:depth===8?'gray':`gray${depth}le`,color_range:range,color_transfer:'smpte2084'}),maximum=2**depth-1,factor=2**(depth-8),lo=range==='tv'?16*factor:0,hi=range==='tv'?235*factor:maximum,table=createSitiLut(input);
    const middle=Math.floor((lo+hi)/2);assert.equal(table[lo],0);assert.equal(table[hi],1);close(table[middle],(middle-lo)/(hi-lo),'native midpoint');
    assert.equal(sitiConfiguration(input).outputMultiplier,maximum);
    const raw=samples=>{const b=Buffer.alloc(samples.length*(depth===8?1:2));samples.forEach((v,i)=>depth===8?b[i]=v:b.writeUInt16LE(v,i*2));return b};
    const black=raw(Array(16).fill(lo)),edge=raw(Array.from({length:16},(_,i)=>i%4===3?hi:lo)),calculator=createSitiCalculator(4,4,input);
    assert.deepEqual(calculator.measure(black),{frame:0,si:0,ti:null});
    const point=calculator.measure(edge);close(point.si,2*maximum,'Sobel edge');close(point.ti,Math.sqrt(3)/4*maximum,'population temporal deviation');
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

test('SI/TI rejects unreferenced inputs, invalid legal codes, padding and partial alpha',()=>{
  const c=vectors.cases.find(c=>c.name==='gray10le-sdr-tv'),stream=context(c);
  for(const settings of [{scale:'literal'},{floatDepth:10},{alpha:{mode:'straight'}},{transfer:'hlg',hlg:{whiteCdM2:1,blackCdM2:1}}])assert.throws(()=>sitiInput(stream,settings));
  assert.throws(()=>sitiInput(stream,{transfer:'hlg',hlg:{whiteCdM2:1000,blackCdM2:900}}),/有效范围/);
  const historicalInput=sitiInput(stream,{transfer:'hlg',hlg:{whiteCdM2:1000,blackCdM2:900}},{historical:true}),history=structuredClone(vectors.historical.find(h=>h.id==='hlg').configuration);
  history.input=historicalInput;history.display={...historicalInput.hlg};
  validateSitiConfiguration({method:history.profile,configuration:history},stream);
  const invalidNew=sitiConfiguration(historicalInput);assert.throws(()=>validateSitiConfiguration({method:invalidNew.profile,configuration:invalidNew},stream),/有效范围/);
  for(const format of ['grayf32le','gbrpf32le','gbrapf32be','xyz12le','unknown'])assert.throws(()=>sitiInput({...stream,pix_fmt:format},c.settings));
  assert.throws(()=>sitiInput({...stream,color_range:'unknown'},undefined),/范围/);
  assert.throws(()=>sitiInput({...stream,field_order:'tt'},c.settings),/隔行/);
  const raw=Buffer.from(c.frames[0],'base64');raw.writeUInt16LE(63);assert.throws(()=>createSitiCalculator(c.width,c.height,sitiInput(stream,c.settings)).measure(raw),/超出声明范围/);
  const padding=vectors.cases.find(c=>c.format==='p010le'),bad=Buffer.from(padding.frames[0],'base64');bad[0]|=1;assert.throws(()=>createSitiCalculator(10,8,sitiInput(context(padding),padding.settings)).measure(bad),/填充位/);
  const alpha=vectors.cases.find(c=>c.format==='rgba'),transparent=Buffer.from(alpha.frames[0],'base64');transparent[3]=128;assert.throws(()=>createSitiCalculator(10,8,sitiInput(context(alpha),alpha.settings)).measure(transparent),/半透明/);
  assert.throws(()=>sitiInput({pix_fmt:'rgb24',color_range:'pc',color_transfer:'bt709',color_space:'bt2020nc',color_primaries:'bt709'}),/矩阵/);
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
    assert.equal(result.available,true,name+': '+result.reason+' / '+fixture.stream.pix_fmt);assert.equal(result.execution.method,SITI_STANDARD_PROFILE);validateSitiConfiguration(result.execution,fixture.stream);
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
