import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,utimes} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,compare,createComparisonSession} from '../engine.mjs';

test('shared decoding exactly matches separate metrics, including raw component logs',async()=>{
  await mkdir('test-work',{recursive:true});
  const root=await mkdtemp(path.resolve('test-work/metrics-equivalence-'));
  for(const [pix,trc] of [['yuv420p','bt709'],['yuv420p10le','bt709'],['yuv422p12le','bt709'],['yuv444p10le','smpte2084']]){
    const dir=path.join(root,pix+'-'+trc);await mkdir(dir);
    const ref=path.join(dir,'ref.mkv'),candidate=path.join(dir,'candidate.mkv');
    const color=['-color_primaries','bt709','-color_trc',trc,'-colorspace','bt709','-color_range','tv'];
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=64x48:rate=8:duration=1,format=${pix}`,'-c:v','ffv1',...color,ref]);
    await run(FF,['-v','error','-i',ref,'-vf',"lutyuv=y='val+1'",'-c:v','ffv1',...color,candidate]);
    const context={cwd:dir,commands:[],update:()=>{}};
    const metrics=['psnr','ssim','vmaf'];
    const baseline=await compare(ref,candidate,0,0,metrics,{...context,separateMetrics:true});
    const combined=await compare(ref,candidate,0,0,metrics,context);
    for(const metric of Object.keys(baseline.metrics)){
      const a={...baseline.metrics[metric]},b={...combined.metrics[metric]};
      // libvmaf JSON also contains throughput, which is not a measurement result.
      if(metric==='vmaf'){delete a.raw;delete b.raw}
      assert.deepEqual(b,a,`${pix}/${trc}/${metric}`);
    }
    assert.deepEqual(combined.alignment,baseline.alignment);
    assert.ok(context.commands.every(c=>c.elapsedSeconds>=0&&c.exitCode===0));
  }
});

test('task reference cache preserves results, still checks candidates, rejects changed reference',async()=>{
  await mkdir('test-work',{recursive:true});
  const dir=await mkdtemp(path.resolve('test-work/reference-cache-')),ref=path.join(dir,'ref.mkv');
  await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=4:duration=1','-c:v','ffv1',ref]);
  const ctx={cwd:dir,commands:[],update:()=>{},comparisonSession:createComparisonSession([ref])};
  const a=await compare(ref,ref,0,0,['psnr','ssim'],ctx);
  const count=ctx.commands.length;
  const b=await compare(ref,ref,0,0,['psnr','ssim'],ctx);
  assert.deepEqual(b,a);
  const second=ctx.commands.slice(count);
  assert.equal(second.filter(c=>c.args.includes('-show_frames')&&!c.args.includes('-read_intervals')).length,1,'candidate must still be scanned');
  assert.equal(second.filter(c=>c.args.includes('-show_format')).length,1,'candidate must still be probed');
  await assert.rejects(compare(ref,ref,0,0,['psnr'],{...ctx,expectedCandidatePixelFormat:'yuv420p10le'}),/编码输出位深/);
  await utimes(ref,new Date(),new Date(Date.now()+2000));
  await assert.rejects(compare(ref,ref,0,0,['psnr'],ctx),/参考文件.*变化/);
});

test('VFR cross-depth shared metrics match separate decoding and keep progressive validation',async()=>{
  const dir=await mkdtemp(path.resolve('test-work/vfr-equivalence-'));
  const eight=path.join(dir,'eight.mkv'),ten=path.join(dir,'ten.mkv');
  for(const [file,pix] of [[eight,'yuv420p'],[ten,'yuv420p10le']]){
    await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=64x48:rate=10:duration=1,format=${pix}`,'-vf',"setpts='if(lt(N,5),N,2*N-5)/(10*TB)',setfield=prog,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",'-fps_mode','passthrough','-c:v','ffv1','-level','3','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left',file]);
  }
  const ctx={cwd:dir,commands:[],update:()=>{},comparisonSession:createComparisonSession([ten])};
  await compare(ten,ten,0,0,['psnr'],ctx);
  const count=ctx.commands.length;
  const combined=await compare(ten,eight,0,0,['psnr','ssim'],ctx,'bt709-limited-8-10');
  assert.equal(ctx.commands.slice(count).filter(c=>c.args.includes('-show_frames')&&!c.args.includes('-read_intervals')).length,2,'native validation cannot substitute for progressive validation');
  const separate=await compare(ten,eight,0,0,['psnr','ssim'],{...ctx,separateMetrics:true},'bt709-limited-8-10');
  assert.deepEqual(combined.metrics,separate.metrics);
  assert.deepEqual(combined.alignment,separate.alignment);
});
