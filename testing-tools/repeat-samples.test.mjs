import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NativeSampleComparison,nativeDifference} from '../repeat-samples.mjs';
import {repeatFrameFormat,repeatExactSummary,repeatConstantSegments,validateRepeatAnalysis} from '../public/repeat-model.js';
import {differenceConfiguration,SOURCE_CLASSIFICATION} from '../public/repeat-difference.js';
import {analyzeRepeats,repeatContentSha256,repeatPreview} from '../repeat.mjs';
import {oracleComponents,oracleDifference,writeOracleValue} from './helpers/repeat-oracle.mjs';
import {FF,probe,run} from '../engine.mjs';
let dir;before(async()=>{await mkdir('.build/testing-work',{recursive:true});dir=await mkdtemp(path.resolve('.build/testing-work/repeat-analysis-'));});
const hash=b=>createHash('sha256').update(b).digest('hex');
function formats(){
  const values=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','gbrap','nv12','nv21'];
  for(const group of ['yuv420p','yuv422p','yuv444p','yuva420p','yuva422p','yuva444p'])values.push(group);
  for(const depth of [9,10,12,14,16])for(const endian of ['le','be'])for(const group of ['yuv420p','yuv422p','yuv444p','gray','gbrp'])values.push(group+depth+endian);
  for(const sampling of ['420','422','444'])for(const depth of [9,10,16,...(sampling==='420'?[]:[12])])for(const endian of ['le','be'])values.push(`yuva${sampling}p${depth}${endian}`);
  for(const depth of [10,12,14,16])for(const endian of ['le','be'])values.push(`gbrap${depth}${endian}`);
  for(const depth of [10,12,16])for(const endian of ['le','be'])values.push(`p0${depth}${endian}`);
  return values;
}
test('[repeat-analysis] direct samples and component block integers match independent oracle for 103 layouts and all corners',async()=>{
  const cases=[];
  for(const name of formats()){
    const layout=oracleComponents(name,35,33),format=repeatFrameFormat(name,35,33),a=Buffer.alloc(layout.bytes),peak=2**layout.bits-1;
    assert.equal(format.bytes,layout.bytes);
    for(const c of layout.components)for(const row of c.addresses)for(const p of row)writeOracleValue(a,p,Math.floor(peak/2),layout);
    const versions=[a,a];
    for(const c of layout.components)for(const [x,y]of [[0,0],[c.width-1,0],[0,c.height-1],[c.width-1,c.height-1]]){
      const b=Buffer.from(a);writeOracleValue(b,c.addresses[y][x],Math.floor(peak/2)+1,layout);versions.push(b,b);
    }
    const ramp=Buffer.from(a);
    for(const c of layout.components)for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)writeOracleValue(ramp,c.addresses[y][x],(x*97+y*31)% (peak+1),layout);
    versions.push(ramp,Buffer.alloc(layout.bytes),Buffer.alloc(layout.bytes));
    const reader=new NativeSampleComparison(format),actual=[];
    for(const frame of versions){let out;for(let p=0;p<frame.length;p+=67)out=reader.push(frame.subarray(p,p+67));actual.push(out);}
    const expected=versions.map((b,i)=>({equalPrevious:i?b.equals(versions[i-1]):null,difference:i&&!b.equals(versions[i-1])?oracleDifference(versions[i-1],b,layout):null}));
    assert.deepEqual(actual,expected,name);
    assert.deepEqual(nativeDifference(a,a,format),oracleDifference(a,a,layout),name+' all-zero component evidence');
    cases.push({format:name,configuration:differenceConfiguration(format),pairs:actual});
  }
  assert.equal(cases.length,103);
  await writeFile(path.join(dir,'direct-samples.json'),JSON.stringify({outcome:'passed',oracle:'independent scalar component addresses and complete tile enumeration',cases}));
});

test('[repeat-analysis] constant state uses observed PTS and exact predicate survives a forced digest collision',async()=>{
  const f=(pts,equalPrevious,duration=null)=>({pts,equalPrevious,duration,sha256:'0'.repeat(64)});
  const collision=[f('0',null),f('1',false),f('2',true)];
  assert.equal(repeatExactSummary(collision,true).duplicates,1);
  assert.equal(repeatExactSummary(collision).duplicates,2,'version 1 retains fingerprint meaning');
  const summarize=frames=>repeatConstantSegments(frames,'1/10',repeatExactSummary(frames,true));
  assert.equal(summarize([f('0',null),f('10',true,'100')]).segments.length,0,'guessed tail duration cannot qualify');
  assert.equal(summarize([f('0',null),f('10',true),f('20',false)]).segments.length,1,'next original PTS closes two seconds');
  const open=summarize([f('0',null),f('20',true)]).segments[0];assert.equal(open.endPts,null);assert.equal(open.observedTicks,'20');
  assert.equal(summarize([f('0',null),f(null,true),f('30',true)]).unresolvedRuns,1);
  assert.equal(summarize([f(null,null),f(null,true)]).status,'unavailable');
  assert.equal(summarize([f('0',null),f('0',true)]).unresolvedRuns,1);
  assert.equal(repeatConstantSegments(collision,null,repeatExactSummary(collision,true)).status,'unavailable');
  await writeFile(path.join(dir,'constant-state.json'),JSON.stringify({outcome:'passed',collision,open}));
});

test('[repeat-analysis] ambiguous source histories remain unclassified and numerical bands are not reuse labels',async()=>{
  const format=repeatFrameFormat('gray10le',19,17),layout=oracleComponents('gray10le',19,17),a=Buffer.alloc(layout.bytes),b=Buffer.alloc(layout.bytes);
  for(const c of layout.components)for(const row of c.addresses)for(const p of row){writeOracleValue(a,p,500,layout);writeOracleValue(b,p,501,layout);}
  // Observation A: one held source image with a +1 reconstruction error in frame 2.
  // Observation B: two genuinely different source images decoded losslessly.
  // Both produce exactly [a,b]. A function of these observations cannot distinguish origins.
  const heldWithError=[a,b],realChange=[Buffer.from(a),Buffer.from(b)];
  assert.deepEqual(heldWithError,realChange);
  const result=nativeDifference(a,b,format);assert.deepEqual(result,oracleDifference(a,b,layout));
  assert.equal(result[0][2],1);assert.equal(SOURCE_CLASSIFICATION.defaultEnabled,false);assert.equal(SOURCE_CLASSIFICATION.status,'not-qualified');
  await writeFile(path.join(dir,'source-ambiguity.json'),JSON.stringify({outcome:'passed',observedHashes:[hash(a),hash(b)],measurements:result,qualification:SOURCE_CLASSIFICATION,holdout:{status:'not-qualified',sourceDisjointDatasetAvailable:false,precision:null,recall:null},scope:'Constructive non-identifiability case; not a statistical accuracy or real-world frequency claim.'}));
});

test('[repeat-analysis] native MSAD cross-check and file identity agree with independent integer evidence',async()=>{
  const cases=[];
  for(const name of ['gray','gray10le','gray12le','gray16le','yuv420p','yuv420p10le','yuv444p16le','gbrap10le']){
    const w=35,h=33,layout=oracleComponents(name,w,h),a=Buffer.alloc(layout.bytes),b=Buffer.alloc(layout.bytes),peak=2**layout.bits-1;
    for(const c of layout.components)for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
      writeOracleValue(a,c.addresses[y][x],0,layout);writeOracleValue(b,c.addresses[y][x],(x+y)%2?peak:1,layout);
    }
    const frames=[a,a,b,b],raw=path.join(dir,name+'.raw'),file=path.join(dir,name+'.nut'),ctx={commands:[]};await writeFile(raw,Buffer.concat(frames));
    await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',name,'-video_size',`${w}x${h}`,'-framerate','1','-i',raw,'-c:v','rawvideo','-threads:v','1',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],r=await analyzeRepeats(file,stream,ctx);
    assert.equal(r.source.contentSha256,hash(await readFile(file)));assert.equal(await repeatContentSha256(file),r.source.contentSha256);
    const expected=oracleDifference(a,b,layout);assert.deepEqual(r.frames[2].difference,expected);
    const comparisonArgs=['-noauto_conversion_filters','-i',file,'-filter_complex','[0:v]split[a][b];[a]trim=end_frame=3,setpts=N/TB[x];[b]trim=start_frame=1,setpts=N/TB[y];[x][y]msad=shortest=1:repeatlast=0,metadata=mode=print:file=-','-fps_mode','passthrough','-f','null','-'];
    const defaultUpstream=await run(FF,['-v','error',...comparisonArgs],ctx);
    const upstream=await run(FF,['-v','error','-cpuflags','0','-filter_complex_threads','1',...comparisonArgs],ctx);
    const events=[];let current;
    for(const line of upstream.split(/\r?\n/)){
      if(line.startsWith('frame:')){current={};events.push(current);}
      const match=/^lavfi\.msad\.msad\.([^.]+)=(.+)$/.exec(line);if(match)current[match[1]]=Number(match[2]);
    }
    assert.equal(events.length,3,upstream);
    const channels=name.startsWith('yuv')?['Y','U','V']:name.startsWith('gbr')?['G','B','R','A']:['Y'];
    expected.forEach((row,i)=>{const answer=row[0]/(layout.components[i].width*layout.components[i].height*peak);assert.ok(Math.abs(events[1][channels[i]]-answer)<=0.00000051,`${name} ${channels[i]} ${events[1][channels[i]]} vs ${answer}`);});
    const legacy=structuredClone(r);legacy.configurationVersion=1;legacy.algorithm='FFmpeg/rawvideo/framehash/SHA256';
    for(const key of ['differenceConfiguration','differenceSummary','constant','sourceClassification','tools'])delete legacy[key];delete legacy.source.contentSha256;
    for(const frame of legacy.frames){delete frame.equalPrevious;delete frame.difference;}validateRepeatAnalysis(legacy,stream);
    const tampered=structuredClone(r);tampered.frames[2].difference[0][0]=-1;assert.throws(()=>validateRepeatAnalysis(tampered,stream));
    await assert.rejects(()=>repeatPreview({file,signature:r.source.signature,contentSha256:'0'.repeat(64),stream:0,frame:1,hashes:r.frames.slice(0,2).map(f=>f.sha256)}),/内容摘要/);
    cases.push({format:name,expected,upstream,defaultUpstream,result:r,commands:ctx.commands});
  }
  await writeFile(path.join(dir,'msad-identity.json'),JSON.stringify({outcome:'passed',qualifiedReference:{cpuFlags:0,filterComplexThreads:1,scope:'Eight listed native planar layouts; default SIMD/thread configuration is recorded but not accepted as an oracle.'},absoluteTolerance:0.00000051,reason:'six fractional digits in upstream metadata plus float metadata rounding (values in [0,1])',cases}));
});

test('[repeat-analysis] cursor subtitle slow changes noise and scene cuts stay nonzero with independent source-time state',async()=>{
  const layout=oracleComponents('gray10le',35,33),format=repeatFrameFormat('gray10le',35,33),base=Buffer.alloc(layout.bytes);
  for(const row of layout.components[0].addresses)for(const p of row)writeOracleValue(base,p,500,layout);
  const cases=[];
  for(const kind of ['cursor','subtitle','slow-one-code','noise','scene-cut']){
    const b=Buffer.from(base),c=layout.components[0];
    for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
      const value=kind==='cursor'?(x===34&&y===32?501:500):kind==='subtitle'?(y>=30?510:500):kind==='slow-one-code'?501:kind==='noise'?500+(x*17+y*31)%3-1:1000;
      writeOracleValue(b,c.addresses[y][x],value,layout);
    }
    const reader=new NativeSampleComparison(format);reader.push(base);const actual=reader.push(b);
    assert.equal(actual.equalPrevious,false);assert.deepEqual(actual.difference,oracleDifference(base,b,layout));cases.push({kind,...actual});
  }
  await writeFile(path.join(dir,'content-states.json'),JSON.stringify({outcome:'passed',scope:'Controlled code-domain content patterns, not real-world prevalence or source-origin accuracy',cases}));
});

test('[repeat-analysis] v2 moving 1080p 4K and exact 8K boundaries preserve evidence and bounded cancellation',async()=>{
  const cases=[];
  for(const [name,width,height,frames,source]of [['1080p-static',1920,1080,240,'color'],['1080p-moving',1920,1080,90,'testsrc2'],['4K-moving',3840,2160,30,'testsrc2']]){
    const file=path.join(dir,name+'.mkv'),ctx={commands:[],decodeThreads:4},progress=[];
    await run(FF,['-v','error','-y','-f','lavfi','-i',`${source}=size=${width}x${height}:rate=30`,'-frames:v',String(frames),'-c:v','ffv1','-level','3','-threads:v','4',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0],samples=[];
    const sampler=setInterval(()=>samples.push(process.memoryUsage()),50),cpu=process.cpuUsage(),start=performance.now();let r;
    try{r=await analyzeRepeats(file,stream,{...ctx,update:value=>progress.push(value)});}finally{clearInterval(sampler);}
    const seconds=(performance.now()-start)/1000,cpuUsage=process.cpuUsage(cpu);samples.push(process.memoryUsage());
    assert.equal(r.frames.length,frames);assert.equal(r.differenceSummary.comparisons,frames-1);
    if(source==='color')assert.equal(r.exact.duplicates,frames-1);else assert.equal(r.differenceSummary.counts.equal,0);
    const controller=new AbortController();let requestedAt;
    await assert.rejects(()=>analyzeRepeats(file,stream,{signal:controller.signal,update:v=>{if(v.detail==='原始帧证据读取完成'){setTimeout(()=>{requestedAt=performance.now();controller.abort();},30);}}}),()=>controller.signal.aborted);
    const cancelSeconds=(performance.now()-requestedAt)/1000;assert.ok(cancelSeconds<10);assert.ok(progress.length>0);
    cases.push({name,width,height,frames,seconds,cpuUsage,peakObservedNodeRss:Math.max(...samples.map(s=>s.rss)),cancelSeconds,summary:r.differenceSummary,commands:ctx.commands,observation:'50ms Node process sampling can miss short peaks; no general throughput promise'});
  }
  const width=8192,height=4320,a=Buffer.alloc(width*height*2),b=Buffer.alloc(a.length);a.writeUInt16LE(257);b.writeUInt16LE(258);
  const file=path.join(dir,'8k.nut'),raw=path.join(dir,'8k.raw'),ctx={commands:[]};await writeFile(raw,Buffer.concat([a,b]));
  await run(FF,['-v','error','-y','-f','rawvideo','-pixel_format','gray16le','-video_size',`${width}x${height}`,'-framerate','1','-i',raw,'-c:v','rawvideo','-threads:v','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],r=await analyzeRepeats(file,stream,ctx);
  assert.equal(r.exact.duplicates,0);assert.deepEqual(r.frames[1].difference,[[1,1,1,1,256,0,0]]);
  cases.push({name:'8K-gray16-one-LSB',width,height,expected:[[1,1,1,1,256,0,0]],result:r,commands:ctx.commands});
  await writeFile(path.join(dir,'resource-v2.json'),JSON.stringify({outcome:'passed',scope:'Short actual native v2 moving/static runs and two 8K frames; earlier long v1 runs are not v2 throughput qualification',cases}));
});
