import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {complexity} from '../analysis.mjs';
import {createSitiP910Calculator,sitiP910Configuration,SITI_P910_REFERENCE} from '../siti-p910.mjs';
import {sitiP910Input,validateSitiConfiguration,validateSitiSettings} from '../public/siti-settings.js';
import {sitiInputFixture} from './helpers/siti-inputs.mjs';

export const physicalVectors=JSON.parse(await readFile(new URL('./reference/siti/p910-2023-physical.json',import.meta.url),'utf8'));
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<=1e-8+Math.abs(b)*1e-10,`${label}: ${a} vs ${b}`);
const streamFor=c=>({pix_fmt:c.format,width:c.width,height:c.height,index:0,field_order:'progressive'});

test('SI/TI declared physical light and alpha composition match independent NumPy at native storage precision',()=>{
  assert.equal(physicalVectors.sourceSha256,SITI_P910_REFERENCE.sourceSha256);
  for(const c of physicalVectors.cases){
    const input=sitiP910Input(streamFor(c),c.settings);assert.ok(input,c.name);assert.equal(input.version,4);
    const calculator=createSitiP910Calculator(c.width,c.height,c.depth,c.range,input);
    for(const [i,raw] of c.frames.entries()){
      const p=calculator.measure(Buffer.from(raw,'base64'));close(p.si,c.expected[i].si,c.name+'/SI');if(i)close(p.ti,c.expected[i].ti,c.name+'/TI');else assert.equal(p.ti,null);
    }
    const configuration=sitiP910Configuration(c.depth,c.range,input);validateSitiConfiguration({method:input.profile,configuration},streamFor(c),5);
    assert.equal(configuration.outputMultiplier,c.settings.scale==='reference-255'?255:2**c.depth-1);
  }
});

test('SI/TI physical input rejects missing assumptions, wrong units, invalid alpha and malformed premultiplication',()=>{
  const c=physicalVectors.cases.find(x=>x.name==='gbrapf32le-normalized-linear-premultiplied-signal-reference-255'),stream=streamFor(c);
  for(const settings of [{...c.settings,linearDisplay:undefined},{...c.settings,range:'auto'},{...c.settings,transfer:'sdr'},{...c.settings,floatDepth:undefined}])assert.equal(sitiP910Input(stream,settings),null);
  for(const change of [{linearDisplay:{whiteCdM2:10,blackCdM2:10}},{alpha:{mode:'guess',backgroundCdM2:[0,0,0]}},{alpha:{mode:'straight',backgroundCdM2:[0,0,10001]}},{floatEncoding:'absolute-cdm2',linearDisplay:c.settings.linearDisplay}])assert.throws(()=>validateSitiSettings({...c.settings,...change}),/SI\/TI/);
  const input=sitiP910Input(stream,c.settings),n=c.width*c.height;
  for(const mutate of [x=>x.writeFloatLE(NaN),x=>x.writeFloatLE(-.1),x=>x.writeFloatLE(1.001),x=>x.writeFloatLE(1.01,n*3*4),x=>x.writeFloatLE(.1)]){
    const raw=Buffer.from(c.frames[0],'base64');mutate(raw);assert.throws(()=>createSitiP910Calculator(c.width,c.height,c.depth,c.range,input).measure(raw),/SI\/TI/);
  }
  const config=sitiP910Configuration(c.depth,c.range,input);
  for(const mutate of [x=>x.physicalLight.units='nits-guess',x=>x.alphaComposition.backgroundCdM2[0]=20,x=>x.eotf='SDR',x=>x.gamma=2.4,x=>x.lumaDerivation.coefficients[0]=.5,x=>x.outputMultiplier=0]){
    const damaged=structuredClone(config);mutate(damaged);assert.throws(()=>validateSitiConfiguration({method:input.profile,configuration:damaged},stream,5),/配置/);
  }
  const absolute=physicalVectors.cases.find(x=>x.name==='gbrpf32le-absolute-cdm2-opaque-reference-255'),bad=Buffer.from(absolute.frames[0],'base64');bad.writeFloatLE(10001);
  assert.throws(()=>createSitiP910Calculator(absolute.width,absolute.height,absolute.depth,absolute.range,sitiP910Input(streamFor(absolute),absolute.settings)).measure(bad),/SI\/TI/);
});

test('SI/TI physical light and transparent RGB preserve real decoded frames, VFR, parallel scenes and report assumptions',{timeout:180000},async t=>{
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-')),ctx={signal:t.signal};
  const evidence={outcome:'running',cases:[]},save=()=>writeFile(path.join(dir,'physical-equivalence.json'),JSON.stringify(evidence,null,2));await save();
  for(const name of ['grayf32le-normalized-linear-opaque-reference-255','grayf32le-absolute-cdm2-opaque-literal','gbrpf32le-normalized-linear-opaque-reference-255','gbrpf32be-absolute-cdm2-opaque-literal','rgba-sdr-straight-literal','bgra64le-pq-premultiplied-signal-reference-255','gbrapf32le-normalized-linear-premultiplied-signal-reference-255','gbrapf32be-hlg-straight-reference-255']){
    const c=physicalVectors.cases.find(x=>x.name===name),fixture=await sitiInputFixture(dir,c,{count:name.includes('gbrpf32le')?63:5},ctx);
    assert.equal(fixture.stream.pix_fmt,c.format,'native decoder retains '+name);
    const starts=[0,2,4],serial=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:c.settings,sitiWorkers:1,sitiSceneStarts:starts},fixture.frames);
    const parallel=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:c.settings,sitiWorkers:4,sitiSceneStarts:starts},fixture.frames);
    assert.deepEqual(serial.points,parallel.points);validateSitiConfiguration(serial.execution,fixture.stream,fixture.frames.length);
    for(let i=0;i<5;i++){close(serial.points[i].si,c.expected[i].si,name+'/SI');if(starts.includes(i))assert.equal(serial.points[i].ti,null);else close(serial.points[i].ti,c.expected[i].ti,name+'/TI')}
    assert.ok(serial.notes.some(x=>x.includes('独立物理亮度解释')));
    if(c.settings.alpha)assert.deepEqual(serial.execution.configuration.alphaComposition.backgroundCdM2,c.settings.alpha.backgroundCdM2);
    evidence.cases.push({name,stream:fixture.stream,serial,parallel});await save();
  }
  evidence.outcome='passed';await save();
});
