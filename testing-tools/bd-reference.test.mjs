import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fixtures} from './helpers/fixtures.mjs';
import {jvetCases} from './helpers/jvet-reference.mjs';
import {bdNumericAcceptance} from './helpers/bd-precision.mjs';
import {bdRate} from '../public/bd-rate.js';
import {trialBdRate,rowLabel} from '../public/trial-model.js';
import {validateBdMeasurement} from '../public/bd-reference.js';
import {measureBdPoint} from '../bd-measure.mjs';
import {FF,run,probe,video,compare,scanSegment} from '../engine.mjs';
import {trial} from '../analysis.mjs';
import {makePortable,parsePortable} from '../public/portable.js';
import {validateReport} from '../public/report.js';

const root=path.resolve('.build/testing-work/bd-reference');
const close=(a,b,tol=1e-10)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);
const colors=['-color_range','tv','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-chroma_sample_location','left'];
async function context(name){await mkdir(root,{recursive:true});return {cwd:await mkdtemp(path.join(root,name+'-')),commands:[],update:()=>{}};}
async function longMeasurementContext(ctx,minimumLength){
  let cwd=path.join(ctx.cwd,`long-${minimumLength}`);
  const targetLength=Math.max(minimumLength,cwd.length+32);
  while(cwd.length<targetLength){
    const remaining=targetLength-cwd.length;
    if(remaining===1){cwd+='p';continue;}
    cwd=path.join(cwd,'p'.repeat(Math.min(40,remaining-1)));
  }
  assert.ok(cwd.startsWith(ctx.cwd+path.sep));
  await mkdir(cwd,{recursive:true});
  await writeFile(path.join(cwd,'control.txt'),'preserve');
  return {...ctx,cwd};
}

test('[bd-rate] 801 original JVET workbook cells: 780 numerical answers and 21 original errors',async()=>{
  const cases=jvetCases(await fixtures.read('bd-rate/JVET-O0003-v1.zip'));
  assert.equal(cases.length,801);
  let valid=0,invalid=0,maxError=0;
  for(const c of cases){
    const result=bdRate(c.anchor,c.test);
    if(typeof c.answer==='string'){
      assert.equal(c.answer,'#VALUE!');assert.equal(result.ok,false);invalid++;
    }else{
      assert.equal(result.ok,true,JSON.stringify(c));
      const delta=Math.abs(result.percent-c.answer*100);maxError=Math.max(maxError,delta);
      assert.ok(delta<=bdNumericAcceptance.absolutePercentagePoints,JSON.stringify({workbook:c.workbook,sheet:c.sheet,cell:c.coordinate,delta}));valid++;
      close((1+result.percent/100)*(1+bdRate(c.test,c.anchor).percent/100),1,1e-12);
    }
  }
  assert.equal(valid,780);assert.equal(invalid,21);
  const ctx=await context('jvet');await writeFile(path.join(ctx.cwd,'bd-reference.json'),JSON.stringify({outcome:'passed',source:'JVET-O0003-v1 (original cached answers, not Excel recalculation)',valid,invalid,maxErrorPercentagePoints:maxError,tolerancePercentagePoints:bdNumericAcceptance.absolutePercentagePoints,acceptanceCriterion:bdNumericAcceptance}));
});

async function knownPixels(depth,range='tv',chromaOnly=false){
  const ctx=await context(`known-${depth}-${range}-${chromaOnly}`),width=128,height=64,frames=4,step=depth===8?1:2,
    count=width*height,perFrame=count*1.5,peak=depth===8?255:1020,scale=depth===8?1:4,
    differences=chromaOnly?[0,0,0,0]:[0,1,4,16];
  const original=Buffer.alloc(perFrame*frames*step),candidate=Buffer.alloc(original.length);
  for(let f=0;f<frames;f++)for(let i=0;i<perFrame;i++){
    const y=i<count,difference=y?differences[f]:chromaOnly?f+1:2,
      value=(y?80+(i%31):120+(i%13))*scale,offset=(f*perFrame+i)*step;
    if(step===1){original[offset]=value;candidate[offset]=value+difference;}
    else{original.writeUInt16LE(value,offset);candidate.writeUInt16LE(value+difference,offset);}
  }
  const pix=depth===8?'yuv420p':'yuv420p10le',refRaw=path.join(ctx.cwd,'reference.yuv'),testRaw=path.join(ctx.cwd,'candidate.yuv'),
    ref=path.join(ctx.cwd,'reference.mkv'),encoded=path.join(ctx.cwd,'candidate.mkv');
  await writeFile(refRaw,original);await writeFile(testRaw,candidate);
  const tags=[...colors];tags[1]=range;
  const codec=depth===8&&range==='tv'?'h264':'hevc';
  const lossless=codec==='h264'?['-c:v','libx264','-preset','ultrafast','-crf','0']:['-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:log-level=error:pools=1'];
  for(const [raw,file,opts] of [[refRaw,ref,depth===8&&range==='pc'?lossless:['-c:v','ffv1','-level','3']],[testRaw,encoded,lossless]])
    await run(FF,['-v','error','-f','rawvideo','-pixel_format',pix,'-video_size',`${width}x${height}`,'-framerate','2','-i',raw,'-vf',`setfield=prog,setparams=range=${range==='tv'?'limited':'full'}:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,...opts,'-pix_fmt','+'+pix,...tags,file],ctx);
  const info=await probe(ref,ctx),stream=video(info,0),segment=await scanSegment(info,0,0,2,ctx),
    comparison=await compare(ref,encoded,0,0,['psnr','ssim'],{...ctx,referenceSegment:segment}),
    measured=await measureBdPoint(ref,encoded,stream,comparison,segment,ctx);
  assert.equal(measured.status,'ok',measured.reason);
  assert.equal(measured.referenceSha256,createHash('sha256').update(original).digest('hex'));
  assert.equal(measured.candidateSha256,createHash('sha256').update(candidate).digest('hex'));
  for(const [key,n] of [['y',count],['u',count/4],['v',count/4]]){
    const deltas=key==='y'?differences:chromaOnly?[1,2,3,4]:[2,2,2,2];
    assert.deepEqual(measured.components[key].sse,deltas.map(d=>n*d*d));
    // Independent closed form for spatially constant error, not rounded FFmpeg logs.
    const expected=deltas.reduce((sum,d)=>sum+(d===0?999.99:20*Math.log10(peak/d)),0)/frames;
    close(measured.components[key].mean,expected);
  }
  const basic=path.join(ctx.cwd,'independent.'+codec);
  await run(FF,['-v','error','-i',encoded,'-map','0:v:0','-c','copy','-bsf:v',codec+'_mp4toannexb','-f',codec,basic],ctx);
  const bytes=await readFile(basic);assert.equal(measured.rate.bytes,bytes.length);
  assert.equal(measured.rate.sha256,createHash('sha256').update(bytes).digest('hex'));close(measured.rate.kbps,bytes.length*8/2/1000);
  const basicRaw=path.join(ctx.cwd,'independent-basic.yuv');
  await run(FF,['-v','error','-i',basic,'-c:v','rawvideo','-pix_fmt','+'+stream.pix_fmt,'-fps_mode','passthrough','-f','rawvideo',basicRaw],ctx);
  assert.equal(createHash('sha256').update(await readFile(basicRaw)).digest('hex'),measured.candidateSha256);
  assert.ok(!(await readdir(ctx.cwd)).some(f=>f.startsWith('bd-bitstream-')));
  for(const mutate of [m=>m.peak++,m=>m.components.y.mean+=.01,m=>m.components.u.sse[0]++,m=>m.rate.kbps++,m=>m.rate.frameRate='0/1',m=>m.referenceSha256='unknown']){
    const bad=structuredClone(measured);mutate(bad);assert.throws(()=>validateBdMeasurement(bad,frames));
  }
  await writeFile(path.join(ctx.cwd,'bd-measurement.json'),JSON.stringify({outcome:'passed',measured,oracle:{differences,depth,range,chromaOnly},existingPooled:comparison.metrics.psnr.pooled}));
  return {ctx,ref,stream,segment,comparison,encoded,measured};
}

for(const depth of [8,10])for(const range of ['tv','pc'])
  test(`[bd-rate] exact integer pixel oracle ${depth}-bit ${range}: frame mean, peak, zero MSE and bitstream bytes`,()=>knownPixels(depth,range));
test('[bd-rate] chroma-only damage retains perfect Y and independent U/V errors',()=>knownPixels(10,'tv',true));

test('[bd-rate] long measurement directories preserve exact results and clean only their scratch files',async()=>{
  for(const depth of [8,10]){
    const k=await knownPixels(depth);
    // Match CI's 246-character parent (266-character temporary directory).
    for(const minimumLength of [230,246]){
      const longCtx=await longMeasurementContext(k.ctx,minimumLength),{cwd}=longCtx;
      const measured=await measureBdPoint(k.ref,k.encoded,k.stream,k.comparison,k.segment,longCtx);
      assert.deepEqual(measured,k.measured);
      assert.equal(await readFile(path.join(cwd,'control.txt'),'utf8'),'preserve');
      assert.deepEqual(await readdir(cwd),['control.txt']);
    }
  }
});

for(const encoder of ['libx265','libaom-av1'])for(const depth of [8,10])
test(`[bd-rate] ${encoder} ${depth}-bit actual trial matches independent decoded integer SSE and elementary bytes`,async()=>{
  const ctx=await context(`codec-${encoder}-${depth}`),source=path.join(ctx.cwd,'source.mkv'),pix=depth===8?'yuv420p':'yuv420p10le';
  await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=s=96x64:r=4:d=1,format=${pix},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,'-c:v','ffv1','-level','3',...colors,source],ctx);
  const report=await trial({file:source,stream:0,start:0,duration:1,encoder,presets:['ultrafast'],cpuUsed:8,crfs:[28],metrics:['psnr'],depthMode:'native',keepFiles:true},ctx);
  const row=report.rows[0],m=row.bdRateMeasurement;assert.equal(m.status,'ok',m.reason);
  const raw=[];
  for(const [i,file] of [source,path.join(ctx.cwd,row.id+'.mkv')].entries()){
    const out=path.join(ctx.cwd,`decoded-${i}.yuv`);
    await run(FF,['-v','error','-noauto_conversion_filters','-i',file,'-map','0:v:0','-c:v','rawvideo','-pix_fmt','+'+pix,'-fps_mode','passthrough','-f','rawvideo',out],ctx);
    raw.push(await readFile(out));
  }
  const step=depth===8?1:2,count=96*64,perFrame=count*1.5,means={};
  for(const [key,begin,n] of [['y',0,count],['u',count,count/4],['v',count*1.25,count/4]]){
    const exact=[],psnr=[];
    for(let f=0;f<4;f++){
      let sse=0n;
      for(let i=0;i<n;i++){
        const offset=(f*perFrame+begin+i)*step,values=raw.map(b=>step===1?b[offset]:b.readUInt16LE(offset)),d=BigInt(values[0])-BigInt(values[1]);
        sse+=d*d;
      }
      exact.push(Number(sse));psnr.push(sse===0n?999.99:20*Math.log10(depth===8?255:1020)-10*Math.log10(Number(sse)/n));
    }
    assert.deepEqual(m.components[key].sse,exact);means[key]=psnr.reduce((a,b)=>a+b,0)/4;close(m.components[key].mean,means[key]);
  }
  assert.equal(m.referenceSha256,createHash('sha256').update(raw[0]).digest('hex'));
  assert.equal(m.candidateSha256,createHash('sha256').update(raw[1]).digest('hex'));
  const format=encoder==='libx265'?'hevc':'obu',file=path.join(ctx.cwd,'independent.'+format);
  await run(FF,['-v','error','-i',path.join(ctx.cwd,row.id+'.mkv'),'-map','0:v:0','-c:v','copy',...(format==='hevc'?['-bsf:v','hevc_mp4toannexb']:[]),'-f',format,file],ctx);
  const bytes=await readFile(file);assert.equal(m.rate.bytes,bytes.length);assert.equal(m.rate.sha256,createHash('sha256').update(bytes).digest('hex'));
  const basicRaw=path.join(ctx.cwd,'basic-decoded.yuv');
  await run(FF,['-v','error','-i',file,'-c:v','rawvideo','-pix_fmt','+'+pix,'-fps_mode','passthrough','-f','rawvideo',basicRaw],ctx);
  assert.equal(createHash('sha256').update(await readFile(basicRaw)).digest('hex'),m.candidateSha256);
  close(m.rate.kbps,bytes.length*8/1000);
  await writeFile(path.join(ctx.cwd,'bd-measurement.json'),JSON.stringify({outcome:'passed',row,independentMean:means,commands:ctx.commands}));
});

test('[bd-rate] HEVC decoded-picture-hash is rejected and scratch data is cleaned',async()=>{
  const k=await knownPixels(10),file=path.join(k.ctx.cwd,'checksum.mkv');
  await run(FF,['-v','error','-i',k.ref,'-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:hash=1:log-level=error:pools=1',...colors,file],k.ctx);
  const comparison=await compare(k.ref,file,0,0,['psnr'],{...k.ctx,referenceSegment:k.segment});
  const longCtx=await longMeasurementContext(k.ctx,246);
  await assert.rejects(()=>measureBdPoint(k.ref,file,k.stream,comparison,k.segment,longCtx),/decoded_picture_hash/);
  assert.equal(await readFile(path.join(longCtx.cwd,'control.txt'),'utf8'),'preserve');
  assert.deepEqual(await readdir(longCtx.cwd),['control.txt']);
});

test('[bd-rate] unsupported metadata, cross-depth, VFR and cancellation cannot become reference results',async()=>{
  const k=await knownPixels(8);
  for(const [stream,comparison,segment] of [
    [{...k.stream,color_transfer:'smpte2084'},k.comparison,k.segment],
    [k.stream,{...k.comparison,normalization:{...k.comparison.normalization,crossDepth:true}},k.segment],
    [k.stream,k.comparison,{...k.segment,frames:k.segment.frames.map((f,i)=>({...f,t:f.t+(i===2?.1:0)}))}],
    [{...k.stream,pix_fmt:'yuv422p'},k.comparison,k.segment],
  ]) assert.equal((await measureBdPoint(k.ref,k.encoded,stream,comparison,segment,k.ctx)).status,'unavailable');
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>measureBdPoint(k.ref,k.encoded,k.stream,k.comparison,k.segment,{...k.ctx,signal:controller.signal}));
});

test('[bd-rate] real SDR trial, strict adapter, legacy compatibility and tamper-detecting JSON round trip',async()=>{
  const ctx=await context('trial'),source=path.join(ctx.cwd,'source.mkv');
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=s=128x96:r=12:d=2,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','ffv1',...colors,source],ctx);
  const result=await trial({file:source,stream:0,start:.25,duration:1,encoder:'libx264',presets:['ultrafast','fast'],crfs:[18,22,26,30,36],metrics:['psnr','ssim'],depthMode:'native'},ctx);
  const report={...result,type:'trial',createdAt:'2026-10-22T00:00:00Z',producer:{applicationVersion:'0.2.14'},commands:ctx.commands},
    [a,b]=[...new Set(report.rows.map(rowLabel))],forward=trialBdRate(report.rows,a,b,'psnr');
  assert.equal(forward.ok,true,JSON.stringify(forward));assert.equal(forward.conditions.fullCtc,false);
  assert.equal(forward.points.anchor[0].quality,report.rows[0].bdRateMeasurement.components.y.mean);
  close((1+forward.percent/100)*(1+trialBdRate(report.rows,b,a,'psnr').percent/100),1,1e-12);
  assert.equal(trialBdRate(report.rows,a,b,'ssim').ok,false);
  assert.equal(trialBdRate(report.rows,a,b,'ssim','exploratory').ok,true);
  assert.equal(trialBdRate(report.rows.filter(r=>r.crf!==18&&r.crf!==22),a,b,'psnr').ok,false);
  const saved={anchor:a,test:b,metric:'psnr',profile:'reference',result:forward};
  report.bdRateComparisons=[saved];
  const wire=makePortable({results:[{entryId:'bd-rate',report}],applicationVersion:'0.2.14'});
  const restored=parsePortable(JSON.stringify(wire)).results[0].report;
  assert.deepEqual(restored,JSON.parse(JSON.stringify(report)));
  const different=structuredClone(report);different.rows[0].bdRateMeasurement.referenceSha256='a'.repeat(64);
  assert.equal(trialBdRate(different.rows,a,b,'psnr').ok,false);
  for(const mutate of [r=>r.bdRateComparisons[0].result.percent+=.0001,r=>r.rows[0].bdRateMeasurement.components.y.mean+=.01,
    r=>r.rows[0].bdRateMeasurement.rate.bytes++,r=>r.bdRateComparisons[0].result.reference.numericalReference='unverified',
    r=>r.bdRateComparisons[0].result.percent=[r.bdRateComparisons[0].result.percent]]){
    const bad=structuredClone(report);mutate(bad);assert.throws(()=>validateReport(bad));
  }
  const subTolerance=structuredClone(report);subTolerance.bdRateComparisons[0].result.percent+=.5e-9;
  assert.doesNotThrow(()=>validateReport(subTolerance));
  const beyondTolerance=structuredClone(report);beyondTolerance.bdRateComparisons[0].result.percent+=2e-9;
  assert.throws(()=>validateReport(beyondTolerance));
  const old=structuredClone(report);delete old.bdRateComparisons;for(const row of old.rows)delete row.bdRateMeasurement;
  assert.deepEqual(validateReport(old),old);assert.equal(trialBdRate(old.rows,a,b,'psnr').ok,false);
  assert.equal(trialBdRate(old.rows,a,b,'psnr','exploratory').ok,true);
  const unequal=trialBdRate(report.rows.filter((r,i)=>i!==0),a,b,'psnr');
  assert.equal(unequal.ok,true,JSON.stringify(unequal));assert.deepEqual(unequal.pointCounts,[4,5]);
  await writeFile(path.join(ctx.cwd,'bd-trial-report.json'),JSON.stringify({outcome:'passed',report}));
});
