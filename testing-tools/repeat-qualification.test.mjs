import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {auditOfficialRepeat} from './helpers/repeat-official.mjs';
import {auditRepeatLayouts} from './helpers/repeat-upstream.mjs';
import {repeatLayouts,componentLabels,canonicalLayout} from './helpers/repeat-layouts.mjs';
import {oracleComponents,oracleDifference,writeOracleValue} from './helpers/repeat-oracle.mjs';
import {NativeSampleComparison,nativeDifference} from '../repeat-samples.mjs';
import {repeatFrameFormat} from '../public/repeat-model.js';
import {verifyRepeatPadding,analyzeRepeats,MAX_REPEAT_FRAME_BYTES} from '../repeat.mjs';
import {repeatCsvParts} from '../public/repeat-csv.js';
import {maxPortableBytes} from '../public/portable.js';
import {createHash} from 'node:crypto';
import {FF,run,probe} from '../engine.mjs';

async function directory(){await mkdir('.build/testing-work',{recursive:true});return mkdtemp(path.resolve('.build/testing-work/repeat-analysis-'));}

test('[repeat-analysis] locked NIST SHA256 vectors and exact upstream freezedetect FATE case pass product integration',{timeout:120000},async t=>{
  const r=await auditOfficialRepeat(await directory(),{commands:[],signal:t.signal});
  assert.equal(r.outcome,'passed');
  assert.deepEqual(r.checks.slice(0,2).map(c=>c.cases.length),[65,64]);
  assert.equal(r.checks[2].outerChecks.length,100);assert.equal(r.checks[2].innerChecks,500);
  assert.equal(r.checks[3].cases.length,7);
  assert.equal(r.checks[4].frames,251);assert.equal(r.checks[4].exactReferenceTextMatched,true);
});

test('[repeat-analysis] CSV includes every record at the exact UTF8 byte limit and rejects one byte beyond it',{timeout:30000},async()=>{
  // Serialization protocol data, not measured video or a source classification.
  const r={configurationVersion:1,timeBase:'1/25',hashTimeBase:'1/25',source:{pixelFormat:'gray',signature:'a'.repeat(64)},exact:{runs:[]},timeline:{intervals:[]},freeze:{events:[]},frames:[]};
  const count=256,bytes=parts=>{let size=0;for(const part of parts)size+=Buffer.byteLength(part);return size;};
  r.freeze.events=[{kind:''}];
  const emptyParts=[...repeatCsvParts(r,'freeze')],header=Buffer.byteLength(emptyParts[0]),fixed=Buffer.byteLength(emptyParts[1]);
  let remaining=maxPortableBytes-header-count*fixed;
  r.freeze.events=Array.from({length:count},()=>{const length=Math.min(1000000,remaining);remaining-=length;return {kind:'x'.repeat(length)};});assert.equal(remaining,0);
  const digest=createHash('sha256');let actual=0,records=0;
  for(const part of repeatCsvParts(r,'freeze')){actual+=Buffer.byteLength(part);digest.update(part);records++;}
  assert.equal(actual,256000000);assert.equal(records,count+1);
  r.freeze.events.at(-1).kind+='x';assert.throws(()=>bytes(repeatCsvParts(r,'freeze')),/CSV 超过256MB/);
  r.freeze.events=[{kind:'开始,"\r\n结束',value:null,frame:0,filterPts:'0'}];
  const quoted=[...repeatCsvParts(r,'freeze')].join('');assert.ok(quoted.startsWith('\uFEFF'));assert.ok(quoted.includes('"开始,""\r\n结束"'));assert.ok(quoted.endsWith('\r\n'));
  await writeFile(path.join(await directory(),'csv-capacity.json'),JSON.stringify({outcome:'passed',limitBytes:actual,records,sha256:digest.digest('hex'),overLimitBytes:actual+1,overLimitRejected:true,unicodeQuoted:true}));
});

test('[repeat-analysis] native byte budget rejects the first byte over the declared frame limit before decoding',async()=>{
  const dir=await directory(),file=path.join(dir,'budget.nut');
  await run(FF,['-v','error','-y','-f','lavfi','-i','color=s=8x8:r=1:d=1','-c:v','rawvideo',file]);
  const stream=(await probe(file)).raw.streams[0];assert.equal(MAX_REPEAT_FRAME_BYTES,134217728);
  const commands=[];
  // Explicit API-boundary parameters, not a claim that this tiny clip has those dimensions.
  await assert.rejects(analyzeRepeats(file,{...stream,pix_fmt:'gray',width:MAX_REPEAT_FRAME_BYTES+1,height:1},{commands}),/原生帧字节/);
  assert.equal(commands.length,0);
  await writeFile(path.join(dir,'byte-budget.json'),JSON.stringify({outcome:'passed',limit:MAX_REPEAT_FRAME_BYTES,firstRejectedBytes:MAX_REPEAT_FRAME_BYTES+1,decoderStarted:false}));
});

test('[repeat-analysis] cancellation during interval aggregation and final validation never returns a complete result',{timeout:30000},async()=>{
  const dir=await directory(),file=path.join(dir,'cooperative.nut');
  await run(FF,['-v','error','-y','-f','lavfi','-i','color=s=8x8:r=120','-frames:v','20000','-c:v','ffv1','-threads:v','1',file]);
  const stream=(await probe(file)).raw.streams[0],cases=[];
  for(const stage of ['汇总精确重复区间','核对原始时间网格','核对持续样本不变区间','复核完整重复分析证据']){
    const controller=new AbortController(),commands=[];let requested=false;
    await assert.rejects(analyzeRepeats(file,stream,{commands,signal:controller.signal,update:value=>{
      if(value.detail===stage){requested=true;controller.abort();}
    }}),()=>requested&&controller.signal.aborted);
    assert.ok(commands.every(c=>c.exitCode===0),'decoding is drained before cancellable aggregation');
    cases.push({stage,requested,completeResultReturned:false,commands});
  }
  await writeFile(path.join(dir,'aggregation-cancel.json'),JSON.stringify({outcome:'passed',scope:'Actual 20000-frame video; abort at each cooperative aggregation stage',cases}));
});

test('[repeat-analysis] complete runtime layout intersection matches native upstream or lossless equivalence and every enabled freeze layout',{timeout:180000},async t=>{
  const r=await auditRepeatLayouts(await directory(),{commands:[],signal:t.signal});
  assert.equal(r.outcome,'passed');
  assert.deepEqual(r.summary,{layouts:103,pairsPerLayout:7,integerReferencePassed:103,nativeMetricsPassed:46,nativeUnsupported:57,losslessAdapterPassed:57,freezeNativeLayoutsPassed:51});
});

test('[repeat-analysis] every code value in every component round trips through equivalent layouts with exact integer difference relations',{timeout:180000},async()=>{
  const cases=[];
  for(const name of repeatLayouts()){
    const bits=Number(/(9|10|12|14|16)(?:le|be)$/.exec(name)?.[1]??8),peak=2**bits-1;
    // Odd dimensions give even the smallest 4:2:0 component a full code domain.
    const side=2*Math.ceil(Math.sqrt(peak+1))-1;
    const source=oracleComponents(name,side,side),targetName=canonicalLayout(name,bits),target=oracleComponents(targetName,side,side);
    const srcLabels=componentLabels(name),dstLabels=componentLabels(targetName),scale=2**(target.bits-source.bits);
    assert.ok(scale>=1);
    const a=Buffer.alloc(source.bytes),b=Buffer.alloc(source.bytes),mappedA=Buffer.alloc(target.bytes),mappedB=Buffer.alloc(target.bytes);
    const components=[];
    for(const [ci,component]of source.components.entries()){
      const destination=target.components[dstLabels.indexOf(srcLabels[ci])],seen=new Uint8Array(peak+1);
      assert.equal(destination.width,component.width);assert.equal(destination.height,component.height);
      let samples=0;
      for(let y=0;y<component.height;y++)for(let x=0;x<component.width;x++){
        const value=samples++%(peak+1),other=peak-value,p=component.addresses[y][x],q=destination.addresses[y][x];
        writeOracleValue(a,p,value,source);writeOracleValue(b,p,other,source);
        writeOracleValue(mappedA,q,value*scale,target);writeOracleValue(mappedB,q,other*scale,target);
        assert.equal(component.read(a,p),value);assert.equal(component.read(b,p),other);
        assert.equal(destination.read(mappedA,q)/scale,value);assert.equal(destination.read(mappedB,q)/scale,other);
        seen[value]=1;
      }
      assert.ok(seen.every(v=>v===1),name+' '+srcLabels[ci]+' full code domain');
      components.push({component:srcLabels[ci],distinctCodes:seen.length,samples,roundTrip:'exact'});
    }
    const sourceFormat=repeatFrameFormat(name,side,side),targetFormat=repeatFrameFormat(targetName,side,side);
    for(const [bytes,format]of [[a,sourceFormat],[b,sourceFormat],[mappedA,targetFormat],[mappedB,targetFormat]]){
      // Check odd byte chunk boundaries as well as the independent sample reads.
      for(let at=0;at<bytes.length;at+=65533)verifyRepeatPadding(bytes.subarray(at,at+65533),at,format);
    }
    const expected=oracleDifference(a,b,source),mappedExpected=oracleDifference(mappedA,mappedB,target);
    assert.deepEqual(nativeDifference(a,b,sourceFormat),expected,name);
    assert.deepEqual(nativeDifference(mappedA,mappedB,targetFormat),mappedExpected,targetName);
    for(let ci=0;ci<components.length;ci++){
      const row=[...expected[ci]];for(const field of [0,2,3])row[field]*=scale;
      assert.deepEqual(mappedExpected[dstLabels.indexOf(srcLabels[ci])],row,name+' exact metric relation');
    }
    const reader=new NativeSampleComparison(sourceFormat);
    assert.deepEqual(reader.push(a),{equalPrevious:null,difference:null});
    assert.deepEqual(reader.push(a),{equalPrevious:true,difference:null});
    assert.deepEqual(reader.push(b),{equalPrevious:false,difference:expected});
    cases.push({format:name,targetFormat:targetName,side,scale,components,integers:expected,mappedIntegers:mappedExpected});
  }
  assert.equal(cases.length,103);
  await writeFile(path.join(await directory(),'full-code-domain.json'),JSON.stringify({outcome:'passed',scope:'Every representable code in every component; exact mapping and integer metrics, not all pairs of arbitrary video frames',cases}));
});
