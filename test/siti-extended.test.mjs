import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FF} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
import {createSitiP910Calculator,createSitiP910Lut} from '../siti-p910.mjs';
import {sitiP910Input,validateSitiSettings,validateSitiConfiguration} from '../public/siti-settings.js';
import {extendedSitiFixture,lumaBytes} from './helpers/siti-extended.mjs';

const vectors=JSON.parse(await readFile(new URL('./reference/siti/p910-2023-extended.json',import.meta.url),'utf8'));
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<=1e-8+Math.abs(b)*1e-10,`${label}: ${a} vs ${b}`);
const streamFor=c=>({pix_fmt:`yuv444p${c.depth===8?'':c.depth+'le'}`,color_range:c.range,color_transfer:c.domain==='pq'?'smpte2084':c.domain==='hlg'?'arib-std-b67':'bt709',field_order:'progressive'});

test('SI/TI extended interpretations match independent NumPy across SDR/PQ/HLG, six depths and both ranges',()=>{
  for(const c of vectors.cases){
    const input=sitiP910Input(streamFor(c),c.settings),calculator=createSitiP910Calculator(c.width,c.height,c.depth,c.range,input);
    const lut=createSitiP910Lut(c.depth,c.range,input);assert.equal(lut.length,2**c.depth);
    for(const [i,raw] of c.frames.entries()){
      const p=calculator.measure(lumaBytes(raw,c.depth));close(p.si,c.expected[i].si,c.name+'/SI');if(i)close(p.ti,c.expected[i].ti,c.name+'/TI');else assert.equal(p.ti,null);
    }
    if(c.range==='tv')assert.ok(Number.isNaN(lut[16*2**(c.depth-8)-1]));
  }
});

test('SI/TI extended settings require explicit interpretation and reject invalid display models and report tampering',()=>{
  const stream={pix_fmt:'yuv444p12le',field_order:'progressive'};
  assert.equal(sitiP910Input(stream),null);
  const settings={range:'tv',transfer:'hlg',hlg:{whiteCdM2:1000,blackCdM2:.01,gamma:1.2}};
  assert.equal(sitiP910Input(stream,settings).interpretation.transfer,'user-confirmed');
  for(const changes of [{hlg:{whiteCdM2:0,blackCdM2:0,gamma:1.2}},{hlg:{whiteCdM2:1000,blackCdM2:1000,gamma:1.2}},{hlg:{whiteCdM2:1000,blackCdM2:0,gamma:NaN}},{range:'limited'},{transfer:'log'},{interlaced:'auto'},{hlg:{whiteCdM2:1000,blackCdM2:.01,gamma:1.2,unknown:true}}])assert.throws(()=>validateSitiSettings({...settings,...changes}),/SI\/TI/);
  assert.equal(sitiP910Input({...stream,color_range:'pc',color_transfer:'smpte2084'}),null);
  for(const pix_fmt of ['gbrp12le','xyz12be','grayf32le'])assert.equal(sitiP910Input({...stream,pix_fmt},settings),null);
});

test('SI/TI extended CPU preserves native luma, VFR timestamps, scene resets and explicit metadata overrides',{timeout:180000},async t=>{
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-')),ctx={signal:t.signal};
  const evidence={outcome:'running',cases:[]},save=()=>writeFile(path.join(dir,'extended-equivalence.json'),JSON.stringify(evidence,null,2));await save();
  const names=['sdr-8-tv','sdr-9-pc','sdr-10-tv','sdr-12-pc','sdr-14-tv','sdr-16-pc','pq-10-tv','pq-12-pc','hlg-10-tv','hlg-16-pc'];
  for(const [index,name] of names.entries()){
    const c=vectors.cases.find(c=>c.name===name),fixture=await extendedSitiFixture(dir,c,{gray:index%2===0,count:name==='hlg-16-pc'?63:5},ctx);
    assert.equal(fixture.stream.pix_fmt,fixture.pix);
    const settings=c.domain==='sdr'?undefined:c.settings,starts=[0,2,4];
    const serial=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:1,sitiSceneStarts:starts},fixture.frames);
    const parallel=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:4,sitiSceneStarts:starts},fixture.frames);
    assert.deepEqual(parallel.points,serial.points);assert.equal(serial.points.length,fixture.frames.length);assert.equal(serial.si,null);assert.equal(serial.ti,null);
    for(let i=0;i<5;i++){close(serial.points[i].si,c.expected[i].si,name+'/decoded SI');if(starts.includes(i))assert.equal(serial.points[i].ti,null);else close(serial.points[i].ti,c.expected[i].ti,name+'/decoded TI');}
    validateSitiConfiguration(serial.execution,fixture.stream,serial.points.length);
    const damaged=structuredClone(serial.execution);damaged.configuration.outputMultiplier=255; if(c.depth!==8)assert.throws(()=>validateSitiConfiguration(damaged,fixture.stream,serial.points.length),/配置/);
    await assert.rejects(complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings},fixture.frames.slice(0,-1)),/帧数/);
    evidence.cases.push({name,fixture:{stream:fixture.stream,frames:fixture.frames},serial,parallel});await save();
  }
  const c=vectors.cases.find(c=>c.name==='sdr-12-tv'),unknown=await extendedSitiFixture(dir,c,{unknown:true},ctx);
  const confirmed=await complexity(unknown.file,unknown.stream,{...ctx,sitiSettings:{range:'tv',transfer:'sdr'},sitiSceneStarts:[0]},unknown.frames);
  assert.equal(confirmed.execution.configuration.input.source.transfer,unknown.stream.color_transfer??null);
  assert.equal(confirmed.execution.configuration.input.interpretation.range,'user-confirmed');
  for(let i=0;i<5;i++)close(confirmed.points[i].si,c.expected[i].si,'confirmed missing metadata');
  const other=await extendedSitiFixture(dir,c,{transfer:'smpte170m'},ctx),otherResult=await complexity(other.file,other.stream,ctx,other.frames);
  assert.equal(otherResult.execution.configuration.inputDomain,'sdr');
  const defaultHlg=vectors.cases.find(c=>c.name==='hlg-12-pc'),hlgFixture=await extendedSitiFixture(dir,defaultHlg,{},ctx),hlg=await complexity(hlgFixture.file,hlgFixture.stream,ctx,hlgFixture.frames);
  assert.equal(hlg.execution.configuration.input.hlgParameterSource,'project-confirmed-display-assumption');
  for(let i=0;i<5;i++)close(hlg.points[i].si,defaultHlg.expected[i].si,'default HLG assumption');
  evidence.metadata={unknown:unknown.stream,confirmed,other:otherResult,hlg};evidence.outcome='passed';await save();
});

test('SI/TI explicitly selected BWDIF measures progressive output and records preserved count, time and frame rate',{timeout:90000},async t=>{
  await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-p910-')),ctx={signal:t.signal};
  const c=vectors.cases.find(c=>c.name==='sdr-12-tv'),fixture=await extendedSitiFixture(dir,c,{interlaced:true,count:63},ctx);
  assert.ok(!['unknown','progressive',undefined].includes(fixture.stream.field_order));
  const settings={interlaced:'bwdif'},input=sitiP910Input(fixture.stream,settings);
  const serial=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:1,sitiSceneStarts:[0,30,31,62]},fixture.frames);
  const parallel=await complexity(fixture.file,fixture.stream,{...ctx,sitiSettings:settings,sitiWorkers:4,sitiSceneStarts:[0,30,31,62]},fixture.frames);
  assert.deepEqual(serial.points,parallel.points);assert.equal(serial.execution.configuration.preprocessingEvidence.outputFrameCount,63);
  assert.match(serial.execution.configuration.preprocessingEvidence.outputFrameRate,/^24\/1$/);validateSitiConfiguration(serial.execution,fixture.stream,63);
  const {stdout}=await promisify(execFile)(FF,['-v','error','-noauto_conversion_filters','-noautorotate','-i',fixture.file,'-vf','bwdif=mode=send_frame:parity=auto:deint=interlaced,extractplanes=y','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,maxBuffer:8*1024*1024});
  const calculator=createSitiP910Calculator(c.width,c.height,c.depth,c.range,input);
  for(let i=0;i<63;i++){const expected=calculator.measure(stdout.subarray(i*calculator.bytes,(i+1)*calculator.bytes),[0,30,31,62].includes(i));close(serial.points[i].si,expected.si,'BWDIF output SI');if(expected.ti!==null)close(serial.points[i].ti,expected.ti,'BWDIF output TI');}
  await writeFile(path.join(dir,'deinterlace-equivalence.json'),JSON.stringify({outcome:'passed',stream:fixture.stream,serial,parallel},null,2));
});
