import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import {FF,run,probe,video,scanSegment,segmentInput,segmentFilter} from '../engine.mjs';
import {trial} from '../analysis.mjs';

const root=path.resolve('test-work/trials-expanded');
async function workspace(name){await mkdir(root,{recursive:true});const cwd=await mkdtemp(path.join(root,name+'-'));return {cwd,commands:[],update:()=>{}}}
const color=range=>['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range',range,'-chroma_sample_location','left'];
async function fixture(ctx,pix,range='tv',size='96x64'){
  const file=path.join(ctx.cwd,'source.mkv');
  await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=s=${size}:r=2:d=1,format=${pix},setparams=range=${range}:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,'-c:v','ffv1','-level','3',...color(range),file],ctx);
  return file;
}
const settings={stream:0,start:0,duration:1,encoder:'libx265',presets:['ultrafast'],crfs:[28],metrics:['psnr','ssim','vmaf'],depthMode:'native',keepFiles:true};
async function save(ctx,result,extra={}){await writeFile(path.join(ctx.cwd,'measured-trial.json'),JSON.stringify({outcome:'passed',result,...extra,commands:ctx.commands},null,2))}
function hashes(raw){return raw.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim())}
async function frameHashes(file,index,filter,input,ctx,pix){
  return hashes(await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters',...(input??['-noautorotate','-i',file]),'-map',`0:${index}`,...(filter?['-vf',filter]:[]),'-c:v','rawvideo','-pix_fmt','+'+pix,'-fps_mode','passthrough','-f','framehash','-hash','sha256','-'],ctx));
}

test('native trial preserves 420/422/444 and 8/10/12-bit without an FFV1 reference cache',async()=>{
  const evidence=[];
  for(const chroma of ['420','422','444'])for(const depth of [8,10,12]){
    const ctx=await workspace('native-matrix'),pix=`yuv${chroma}p${depth===8?'':depth+'le'}`,range=depth===10?'pc':'tv',file=await fixture(ctx,pix,range);
    const result=await trial({...settings,file},ctx),row=result.rows[0],output=path.join(ctx.cwd,row.id+'.mkv'),s=video(await probe(output),0);
    assert.equal(row.pixelFormat,pix);assert.equal(row.bitDepth,depth);assert.equal(s.pix_fmt,pix);assert.equal(s.color_range,range);
    assert.equal(result.experiment.preparation.reference,'source-segment');assert.deepEqual(result.experiment.retainedFiles,[output]);
    assert.ok(!(await readdir(ctx.cwd)).includes('reference.mkv'));
    const encodings=ctx.commands.filter(c=>c.args.includes('-crf'));
    assert.equal(encodings.length,1);assert.ok(encodings[0].args.includes('+'+pix));assert.ok(encodings[0].args.includes(file));
    assert.ok(!ctx.commands.some(c=>c.args.includes('reference.mkv')||c.args.includes(path.join(ctx.cwd,'reference.mkv'))));
    assert.equal(row.metrics.vmaf.configuration.input.pixelFormat,pix);assert.equal(row.metrics.vmaf.values.length,2);
    assert.equal(row.metrics.vmaf.pooled,JSON.parse(row.metrics.vmaf.raw).pooled_metrics.vmaf.mean);
    await save(ctx,result);evidence.push({pix,range,frames:result.experiment.actualFrames});
  }
  assert.equal(evidence.length,9);
});

test('4K 422 10-bit native H.265 trial evaluates CRF 18, 23 and 28 with the official 4K model',async()=>{
  const ctx=await workspace('native-4k'),file=path.join(ctx.cwd,'camera-prores.mov');
  // A compressed ProRes source, not an application's FFV1 preparation.
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=s=3840x2160:r=2:d=1,format=yuv422p10le,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','prores_ks','-profile:v','2','-pix_fmt','yuv422p10le',...color('tv'),file],ctx);
  const result=await trial({...settings,file,crfs:[18,23,28],vmafModel:'vmaf_4k_v0.6.1'},ctx);
  assert.deepEqual(result.rows.map(r=>r.crf),[18,23,28]);assert.equal(result.experiment.actualFrames,2);
  for(const row of result.rows){
    const s=video(await probe(path.join(ctx.cwd,row.id+'.mkv')),0);
    assert.equal(s.width,3840);assert.equal(s.height,2160);assert.equal(s.pix_fmt,'yuv422p10le');
    assert.equal(row.bitDepth,10);assert.equal(row.metrics.vmaf.model,'vmaf_4k_v0.6.1');
    assert.equal(row.metrics.vmaf.configuration.matchesDisplay,true);assert.equal(row.metrics.vmaf.values.length,2);
    assert.equal(row.metrics.vmaf.pooled,JSON.parse(row.metrics.vmaf.raw).pooled_metrics.vmaf.mean);
    assert.ok(Number.isFinite(row.metrics.psnr.pooled));assert.ok(Number.isFinite(row.metrics.ssim.pooled));
  }
  assert.ok(!ctx.commands.some(c=>c.args.includes('ffv1')));await save(ctx,result);
});

test('native trial accurate non-keyframe selection matches independently decoded source pixels and official VMAF',async()=>{
  const ctx=await workspace('native-seek'),file=path.join(ctx.cwd,'long-gop.mp4');
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=s=128x96:r=12:d=3,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','libx264','-preset','medium','-g','36','-sc_threshold','0','-pix_fmt','yuv420p',...color('tv'),'-output_ts_offset','5',file],ctx);
  const info=await probe(file),segment=await scanSegment(info,0,0.37,1,ctx);
  const oracle=await frameHashes(file,0,'trim=start=0.37:end=1.37,setpts=PTS-STARTPTS',null,ctx,'yuv420p');
  const selected=await frameHashes(file,0,segmentFilter(segment)+'null',segmentInput(file,segment),ctx,'yuv420p');
  assert.deepEqual(selected,oracle);assert.equal(segment.frames.length,oracle.length);assert.equal(oracle.length,12);
  const result=await trial({...settings,file,start:0.37,encoder:'libx264',crfs:[0]},ctx),output=path.join(ctx.cwd,result.rows[0].id+'.mkv');
  const encoded=await frameHashes(output,0,null,null,ctx,'yuv420p');assert.deepEqual(encoded,oracle);
  assert.equal(result.rows[0].metrics.psnr.pooled,'Infinity');assert.equal(result.rows[0].metrics.ssim.pooled,1);
  assert.equal(result.rows[0].alignment.timestampQuantization.candidateTimeBase,'1/1000');
  assert.ok(result.rows[0].alignment.maxRelativeDifferenceSeconds<=result.rows[0].alignment.toleranceSeconds);
  // Independently decode the entire source and trim it. Pair verified frame
  // indices on an ordinal clock to avoid Matroska's PTS rounding, as the app
  // does only after validation; use the official model/filter unchanged.
  const graph='[0:v]settb=AVTB,setpts=N*1000000[d];[1:v]trim=start=0.37:end=1.37,settb=AVTB,setpts=N*1000000[r];[d][r]libvmaf=model=version=vmaf_v0.6.1:pool=mean:n_subsample=1:n_threads=2:log_fmt=json:log_path=official.json';
  await run(FF,['-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',output,'-noautorotate','-i',file,'-filter_complex',graph,'-fps_mode','passthrough','-f','null','-'],ctx);
  const official=JSON.parse(await readFile(path.join(ctx.cwd,'official.json'),'utf8'));
  assert.deepEqual(result.rows[0].metrics.vmaf.values,official.frames.map(f=>f.metrics.vmaf));
  assert.equal(result.rows[0].metrics.vmaf.pooled,official.pooled_metrics.vmaf.mean);
  await save(ctx,result,{oracle,selected,encoded,official});
});

test('native AV1 trial preserves a nonzero video stream and VFR frame sequence without reference caching',async()=>{
  const ctx=await workspace('native-vfr'),file=path.join(ctx.cwd,'audio-first-vfr.mkv');
  await run(FF,['-v','error','-f','lavfi','-i','sine=duration=2','-f','lavfi','-i','testsrc2=s=96x64:r=10:d=2,format=yuv422p10le,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-map','0:a:0','-map','1:v:0','-vf',"select='not(eq(mod(n,4),1))'",'-c:a','pcm_s16le','-c:v','ffv1','-level','3',...color('tv'),'-fps_mode','passthrough',file],ctx);
  const info=await probe(file);assert.equal(info.raw.streams[0].codec_type,'audio');assert.equal(info.raw.streams[1].pix_fmt,'yuv422p10le');
  const result=await trial({...settings,file,stream:1,start:0.15,encoder:'libaom-av1',cpuUsed:8},ctx),row=result.rows[0];
  const expected=[0,0.1,0.2,0.4,0.5,0.6,0.8,0.9];
  assert.equal(result.experiment.actualFrames,expected.length);assert.ok(result.experiment.frameTimes.every((t,i)=>Math.abs(t-expected[i])<1e-9));
  assert.equal(row.pixelFormat,'yuv422p10le');assert.equal(row.metrics.vmaf.values.length,expected.length);
  assert.equal(row.alignment.pairing,'strict');assert.ok(row.alignment.maxRelativeDifferenceSeconds<=row.alignment.toleranceSeconds);
  const segment=await scanSegment(info,1,0.15,1,ctx);
  const oracle=await frameHashes(file,1,'trim=start=0.15:end=1.15,setpts=PTS-STARTPTS',null,ctx,'yuv422p10le');
  const selected=await frameHashes(file,1,segmentFilter(segment)+'null',segmentInput(file,segment),ctx,'yuv422p10le');
  assert.deepEqual(selected,oracle);assert.equal(selected.length,expected.length);await save(ctx,result,{oracle,selected});
});

test('native trial rejects unsupported encoder formats and changed sources without conversion or deleting retained files',async()=>{
  const ctx=await workspace('native-reject'),file=await fixture(ctx,'yuv422p12le');
  await assert.rejects(()=>trial({...settings,file,encoder:'libx264'},ctx),/不支持原生 yuv422p12le.*拒绝自动转换/);
  assert.ok(!ctx.commands.some(c=>c.args.includes('-crf')));
  await assert.rejects(()=>trial({...settings,file,depthMode:'both'},ctx),/对照仅支持原生 420/);
  const changed=await workspace('native-changed'),copy=path.join(changed.cwd,'source.mkv');await copyFile(file,copy);
  changed.update=p=>{if(p?.stage?.startsWith('编码点 '))appendFileSync(copy,Buffer.from([0]))};
  await assert.rejects(()=>trial({...settings,file:copy},changed),/源文件.*发生变化/);
  assert.ok(!changed.commands.some(c=>c.args.includes('-crf')));
  const retained=await workspace('native-existing'),existing=path.join(retained.cwd,'12bit-ultrafast-crf-28.mkv');await writeFile(existing,'retained candidate');
  await assert.rejects(()=>trial({...settings,file},retained),/已存在/);assert.equal(await readFile(existing,'utf8'),'retained candidate');
});
