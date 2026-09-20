import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,compare,bitDepthPlan,alignment,scan} from '../engine.mjs';

const dir=path.resolve('test-work/bitdepth'),mode='bt709-limited-8-10';
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(()=>mkdir(dir,{recursive:true}));
const base={width:512,height:32,pix_fmt:'yuv420p',field_order:'progressive',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709',chroma_location:'left'};

test('cross-depth opt-in rejects uncertain interpretations and all cross-sampling',()=>{
 const ten={...base,pix_fmt:'yuv420p10le'},f=[{t:0,duration:1}];
 assert.throws(()=>alignment(base,ten,f,f),/pix_fmt/);
 assert.equal(alignment(base,ten,f,f,mode).frames,1);
 assert.throws(()=>bitDepthPlan(base,ten,'automatic'),/模式无效/);
 for(const change of [{pix_fmt:'yuv422p10le'},{pix_fmt:'yuv420p12le'},{color_range:'pc'},{color_range:undefined},{color_transfer:'smpte2084'},{color_transfer:'arib-std-b67'},{color_space:undefined},{color_primaries:undefined},{field_order:'tt'},{field_order:undefined},{chroma_location:undefined},{chroma_location:'center'}]){
  assert.throws(()=>bitDepthPlan(base,{...ten,...change},mode));
 }
 assert.throws(()=>alignment(base,{...ten,width:256},f,f,mode),/width/);
 assert.throws(()=>alignment(base,ten,f,[{t:0,duration:0.5}],mode),/持续时间/);
});

// Build the oracle without any FFmpeg conversion: cover every byte value on
// each plane, spatial patterns, nominal endpoints, neutral chroma and headroom.
async function fixture(sampling,depth,delta=0){
 const y=512*32,c=y/(sampling==='420'?4:sampling==='422'?2:1),count=y+2*c;
 const bytes=Buffer.alloc(count*(depth===8?1:2)*2);
 for(let frame=0;frame<2;frame++)for(let i=0;i<count;i++){
  const code=(i*17+frame*29)%256;
  const v=depth===8?code:code*4+(i>=y&&i<y+c?delta:0);
  if(depth===8)bytes[frame*count+i]=v;else bytes.writeUInt16LE(v,2*(frame*count+i));
 }
 const pix=`yuv${sampling}p${depth===8?'':'10le'}`,raw=path.join(dir,`${pix}-${delta}.yuv`),file=raw+'.mkv';
 await writeFile(raw,bytes);
 await run(FF,['-v','error','-y','-f','rawvideo','-pixel_format',pix,'-video_size','512x32','-framerate','2','-i',raw,'-vf','setfield=prog,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','ffv1','-level','3','-pix_fmt',pix,'-chroma_sample_location','left',file]);
 return file;
}

test('exact 8/10-bit comparison: all codes, both directions, 420/422/444 and analytic chroma error',async()=>{
 for(const sampling of ['420','422','444']){
  const eight=await fixture(sampling,8),ten=await fixture(sampling,10),changed=await fixture(sampling,10,1);
  await assert.rejects(()=>compare(ten,eight,0,0,['psnr'],context()),/pix_fmt/);
  for(const [reference,candidate]of [[ten,eight],[eight,ten]]){
   const ctx=context(),result=await compare(reference,candidate,0,0,['psnr','ssim','vmaf'],ctx,mode);
   assert.equal(result.metrics.psnr.pooled,'Infinity');assert.equal(result.metrics.ssim.pooled,1);
   assert.deepEqual(result.metrics.psnr.components,{y:'Infinity',u:'Infinity',v:'Infinity'});
   assert.equal(result.normalization.verification.passed,true);assert.match(result.skippedMetrics.vmaf,/跨位深/);
   assert.equal(result.profile.bitDepth,10);assert.ok(ctx.commands.some(x=>x.args.includes('-noauto_conversion_filters')));
  }
  const result=await compare(changed,eight,0,0,['psnr','ssim'],context(),mode);
  assert.equal(result.metrics.psnr.components.y,'Infinity');assert.equal(result.metrics.psnr.components.v,'Infinity');
  assert.ok(Math.abs(result.metrics.psnr.components.u-20*Math.log10(1023))<0.02);
  const weight=sampling==='420'?1/6:sampling==='422'?1/4:1/3;
  assert.ok(Math.abs(result.metrics.psnr.pooled-10*Math.log10(1023**2/weight))<0.02);
  // FFmpeg rounds All to 6 decimals: a tiny chroma-only error can print 1.000000.
  assert.ok(result.metrics.ssim.components.u<1);
  await assert.rejects(()=>compare(ten,eight,0,0,['vmaf'],context(),mode),/跨位深/);
 }
});

test('cross-depth scan refuses actual interlaced frames',async()=>{
 const file=path.join(dir,'interlaced.mkv');
 await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=s=96x64:r=2:d=1,setfield=tff','-c:v','ffv1',file]);
 await assert.rejects(()=>scan(file,0,{...context(),requireProgressive:true}),/逐行帧/);
});
