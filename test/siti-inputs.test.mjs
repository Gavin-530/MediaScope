import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {complexity} from '../analysis.mjs';
import {createSitiP910Calculator,sitiP910Configuration,SITI_P910_REFERENCE} from '../siti-p910.mjs';
import {sitiP910Input,validateSitiConfiguration,validateSitiSettings} from '../public/siti-settings.js';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';
import {FF,run,probe,scan} from '../engine.mjs';
const vectors=JSON.parse(await readFile(new URL('./reference/siti/p910-2023-inputs.json',import.meta.url),'utf8'));
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<=1e-8+Math.abs(b)*1e-10,`${label}: ${a} vs ${b}`);
const streamFor=c=>({pix_fmt:c.format,width:c.width,height:c.height,index:0,field_order:'progressive'});
test('SI/TI RGB float and native-storage calculations match independent NumPy without intermediate quantization',()=>{
  assert.equal(vectors.sourceSha256,SITI_P910_REFERENCE.sourceSha256);
  for(const c of vectors.cases){
    const input=sitiP910Input(streamFor(c),c.settings),calculator=createSitiP910Calculator(c.width,c.height,c.depth,c.range,input);
    for(const [i,frame] of c.frames.entries()){
      const p=calculator.measure(Buffer.from(frame,'base64'));close(p.si,c.expected[i].si,c.name+'/SI');if(i)close(p.ti,c.expected[i].ti,c.name+'/TI');else assert.equal(p.ti,null);
    }
    const config=sitiP910Configuration(c.depth,c.range,input);assert.equal(config.outputMultiplier,c.settings.scale==='reference-255'?255:2**c.depth-1);
    validateSitiConfiguration({method:input.profile,configuration:config},streamFor(c),5);
  }
});
test('SI/TI RGB conflicts, float semantics, invalid samples and transparent alpha are rejected explicitly',()=>{
  const stream={pix_fmt:'rgb24',color_range:'pc',color_transfer:'bt709',color_space:'bt709',color_primaries:'bt2020'};
  assert.equal(sitiP910Input(stream),null);assert.equal(sitiP910Input(stream,{matrix:'bt709'}).matrix.source,'user-confirmed');
  assert.equal(sitiP910Input({...stream,color_space:'gbr',color_primaries:'bt709'}).matrix.source,'stream-primaries');
  assert.equal(sitiP910Input({...stream,color_space:'bt2020c'}),null);
  assert.equal(sitiP910Input({...stream,pix_fmt:'grayf32le'}),null);
  for(const settings of [{scale:'fixed-1023'},{matrix:'guess'},{floatDepth:32},{floatEncoding:'linear'}])assert.throws(()=>validateSitiSettings(settings),/SI\/TI/);
  for(const [fmt,value] of [['grayf32le',NaN],['grayf32le',Infinity],['grayf32le',-.001],['grayf32le',1.001],['rgba',0]]){
    const c=vectors.cases.find(c=>c.format===fmt&&c.settings.scale==='literal'),raw=Buffer.from(c.frames[0],'base64');
    if(fmt==='rgba')raw[3]=value;else raw.writeFloatLE(value);
    const input=sitiP910Input(streamFor(c),c.settings),calc=createSitiP910Calculator(c.width,c.height,c.depth,c.range,input);
    assert.throws(()=>calc.measure(raw),/SI\/TI|P\.910/);
  }
});
test('SI/TI RGB float native storage and reference scale preserve real decoded frames, VFR and parallel scenes',{timeout:180000},async t=>{
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-')),ctx={signal:t.signal};
  const evidence={outcome:'running',cases:[]},save=()=>writeFile(path.join(dir,'input-equivalence.json'),JSON.stringify(evidence,null,2));await save();
  const names=['rgb24-literal','rgb48be-reference-255','gbrp12be-literal','gbrpf32le-literal','gbrpf32le-reference-255-tv','gbrpf32be-reference-255','gray16be-literal','nv12-reference-255','yuv444p12be-reference-255'];
  for(const name of names){
    const c=vectors.cases.find(c=>c.name===name),fixture=await sitiInputFixture(dir,c,{count:name==='gbrpf32le-literal'?63:5},ctx);
    assert.equal(fixture.stream.pix_fmt,c.format,'rawvideo must preserve '+c.format);
    const settings=c.settings,starts=[0,2,4],serial=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:1,sitiSceneStarts:starts},fixture.frames);
    const parallel=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:4,sitiSceneStarts:starts},fixture.frames);
    assert.deepEqual(serial.points,parallel.points);
    for(let i=0;i<5;i++){close(serial.points[i].si,c.expected[i].si,name+'/decoded SI');if(starts.includes(i))assert.equal(serial.points[i].ti,null);else close(serial.points[i].ti,c.expected[i].ti,name+'/decoded TI')}
    validateSitiConfiguration(serial.execution,fixture.stream,fixture.frames.length);
    for(const mutate of [x=>x.input.depth++,x=>x.outputMultiplier++,x=>x.input.scale='other',x=>x.normalizationDivisor=0]){
      const damaged=structuredClone(serial.execution);mutate(damaged.configuration);assert.throws(()=>validateSitiConfiguration(damaged,fixture.stream,fixture.frames.length),/配置/);
    }
    evidence.cases.push({name,stream:fixture.stream,serial,parallel});await save();
  }
  // Raw NUT has no grayscale-float codec tag. Use a real lossless float EXR,
  // explicitly declaring the stored nonlinear values rather than guessing EXR semantics.
  const c=vectors.cases.find(c=>c.name==='grayf32le-literal'),raw=path.join(dir,'float-gray.raw'),file=path.join(dir,'float-gray.exr');
  await writeFile(raw,Buffer.from(c.frames[2],'base64'));
  await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format','grayf32le','-video_size',`${c.width}x${c.height}`,'-i',raw,'-frames:v','1','-c:v','exr','-format','float','-gamma','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);assert.equal(stream.pix_fmt,'grayf32le');
  const result=await complexity(file,stream,{...ctx,sitiSettings:c.settings,sitiSceneStarts:[0]},frames);
  close(result.points[0].si,c.expected[2].si,'EXR gray float SI');assert.equal(result.points[0].ti,null);validateSitiConfiguration(result.execution,stream,1);
  evidence.floatGray={stream,result};
  evidence.outcome='passed';await save();
});
