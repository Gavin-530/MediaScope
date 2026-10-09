import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,compare,probe,video} from '../engine.mjs';
import {trial} from '../analysis.mjs';
import {vmafModels,vmafInputReason,vmafModel,parseVmafLog} from '../public/vmaf.js';

const root=path.resolve('test-work');
async function workspace(){await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'vmaf-official-'))}
function context(cwd){return {cwd,commands:[],update:()=>{}}}
async function fixture(dir,pix,range,signal={}){
  const ref=path.join(dir,'ref.mkv'),candidate=path.join(dir,'candidate.mkv');
  const {primaries='bt709',transfer='bt709',matrix='bt709',field='prog'}=signal;
  const color=['-color_primaries',primaries,'-color_trc',transfer,'-colorspace',matrix,'-color_range',range,'-chroma_sample_location','left'];
  await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=s=96x64:r=4:d=1,format=${pix},setfield=${field},setparams=range=${range}:color_primaries=${primaries}:color_trc=${transfer}:colorspace=${matrix}`,'-c:v','ffv1','-level','3',...color,ref]);
  await run(FF,['-v','error','-i',ref,'-vf',"lutyuv=y='val+7':u='val+3'",'-c:v','ffv1','-level','3',...color,candidate]);
  return {ref,candidate};
}
async function official(dir,ref,candidate,model,ctx){
  // Official documented input order and PTS-STARTPTS, independent of the
  // application's ordinal timestamps, split graph, parser and pooling.
  const graph=`[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf=model=version=${model}:pool=mean:n_subsample=1:n_threads=2:log_fmt=json:log_path=official.json`;
  await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',candidate,'-noautorotate','-i',ref,'-filter_complex',graph,'-fps_mode','passthrough','-f','null','-'],ctx);
  return JSON.parse(await readFile(path.join(dir,'official.json'),'utf8'));
}

test('VMAF matches official FFmpeg frames and pooling across Full/Limited, 420/422/444 and 8/10/12-bit',async()=>{
  const base=await workspace(),evidence=[];
  for(const chroma of ['420','422','444'])for(const depth of [8,10,12])for(const range of ['tv','pc']){
    const pix=`yuv${chroma}p${depth===8?'':depth+'le'}`,dir=path.join(base,pix+'-'+range);await mkdir(dir);
    const {ref,candidate}=await fixture(dir,pix,range),ctx=context(dir);
    const result=await compare(ref,candidate,0,0,['psnr','ssim','vmaf'],ctx);
    const log=await official(dir,ref,candidate,'vmaf_v0.6.1',ctx),m=result.metrics.vmaf;
    assert.deepEqual(m.values,log.frames.map(f=>f.metrics.vmaf));assert.equal(m.pooled,log.pooled_metrics.vmaf.mean);
    assert.deepEqual(m.officialSummary,log.pooled_metrics.vmaf);assert.equal(m.configuration.libraryVersion,log.version);
    assert.equal(m.configuration.input.range,range);assert.equal(m.configuration.preprocessing,'none');
    assert.equal(m.configuration.matchesDisplay,false);assert.match(m.configuration.interpretation,/相对比较/);
    assert.ok(Number.isFinite(result.metrics.psnr.pooled));assert.ok(result.metrics.ssim.pooled<1);
    assert.ok(ctx.commands.filter(c=>c.args.includes('-filter_complex')).every(c=>!c.args.join(' ').includes('scale=')));
    evidence.push({pix,range,metric:m,official:log,commands:ctx.commands});
  }
  await writeFile(path.join(base,'measured-vmaf.json'),JSON.stringify({outcome:'passed',evidence}));
});

test('VMAF official HD, 4K and NEG models retain identity, direction and unmodified default clipping',async()=>{
  const base=await workspace(),{ref,candidate}=await fixture(base,'yuv420p','tv'),evidence=[];
  for(const model of Object.keys(vmafModels)){
    const dir=path.join(base,model);await mkdir(dir);const ctx={...context(dir),vmafModel:model};
    const result=await compare(ref,candidate,0,0,['vmaf'],ctx),log=await official(dir,ref,candidate,model,ctx);
    assert.equal(result.metrics.vmaf.model,model);assert.deepEqual(result.metrics.vmaf.values,log.frames.map(f=>f.metrics.vmaf));
    assert.equal(result.metrics.vmaf.pooled,log.pooled_metrics.vmaf.mean);
    const reverseDir=path.join(dir,'reverse');await mkdir(reverseDir);
    const reverse=await compare(candidate,ref,0,0,['vmaf'],{...context(reverseDir),vmafModel:model});
    const reverseLog=await official(reverseDir,candidate,ref,model,context(reverseDir));
    assert.deepEqual(reverse.metrics.vmaf.values,reverseLog.frames.map(f=>f.metrics.vmaf));
    const identityDir=path.join(dir,'identity');await mkdir(identityDir);
    const identity=await compare(ref,ref,0,0,['vmaf'],{...context(identityDir),vmafModel:model});
    assert.ok(identity.metrics.vmaf.pooled>95); // Self comparison need not be exactly 100.
    evidence.push({model,result,log,reverse,reverseLog,identity,commands:ctx.commands});
  }
  assert.throws(()=>vmafModel('vmaf_v0.6.1:enable_transform=true'),/模型无效/);
  await writeFile(path.join(base,'measured-models.json'),JSON.stringify({outcome:'passed',evidence}));
});

test('VMAF rejects damaged official logs and uses official pooled mean rather than rounded frame average',async()=>{
  const dir=await workspace(),{ref,candidate}=await fixture(dir,'yuv420p','pc');
  const actual=await official(dir,ref,candidate,'vmaf_v0.6.1',context(dir));
  const parsed=parseVmafLog(JSON.stringify(actual),4);assert.deepEqual(parsed.summary,actual.pooled_metrics.vmaf);
  for(const damage of [l=>l.frames.pop(),l=>l.frames[1].frameNum=0,l=>l.frames[0].metrics.vmaf=101,
    l=>l.pooled_metrics.vmaf.mean+=1,l=>l.pooled_metrics.vmaf.min+=1,l=>delete l.version,l=>delete l.pooled_metrics]){
    const log=structuredClone(actual);damage(log);assert.throws(()=>parseVmafLog(JSON.stringify(log),4),/VMAF/);
  }
  const s={pix_fmt:'yuv420p',color_primaries:'bt709',color_space:'bt709',color_transfer:'bt709',color_range:'pc',field_order:'progressive'};
  assert.equal(vmafInputReason(s),null);
  for(const [key,value] of [['color_transfer','smpte2084'],['color_transfer','arib-std-b67'],['color_transfer','log100'],['color_transfer','unknown'],['color_range','unknown'],['color_space','unknown'],['field_order','tt']])assert.equal(vmafInputReason({...s,[key]:value}),null);
  assert.match(vmafInputReason({...s,pix_fmt:'gbrp10le'}),/FFmpeg libvmaf/);
  const synthetic=structuredClone(actual); // Exercise the permitted JSON rounding gap, not a media-quality fixture.
  synthetic.pooled_metrics.vmaf.mean+=0.0000004;
  assert.equal(parseVmafLog(JSON.stringify(synthetic),4).summary.mean,synthetic.pooled_metrics.vmaf.mean);
});

test('VMAF explicit playback sampling records the evaluated sequence without altering PSNR/SSIM',async()=>{
  const dir=await workspace(),{ref}=await fixture(dir,'yuv420p','tv');
  const result=await compare(ref,ref,0,0,['psnr','ssim','vmaf'],{...context(dir),timingMode:'playback-sample'});
  const log=await official(dir,ref,ref,'vmaf_v0.6.1',context(dir));
  assert.deepEqual(result.metrics.vmaf.values,log.frames.map(f=>f.metrics.vmaf));
  assert.equal(result.metrics.vmaf.configuration.pairing,'playback-sample');
  assert.match(result.metrics.vmaf.configuration.preprocessing,/playback sampling/);
  assert.match(result.metrics.vmaf.configuration.interpretation,/未采样画面/);
  assert.equal(result.metrics.psnr.pooled,'Infinity');assert.equal(result.metrics.ssim.pooled,1);
  assert.equal((await compare(ref,ref,0,0,['vmaf'],{...context(dir),timingMode:'playback-sample'})).metrics.vmaf.values.length,4);
});

test('VMAF Full-range native trial uses the selected official NEG model and retains official pooling',async()=>{
  const dir=await workspace(),{ref}=await fixture(dir,'yuv420p10le','pc');
  const result=await trial({file:ref,stream:0,start:0,duration:1,encoder:'libx265',presets:['ultrafast'],crfs:[28],metrics:['psnr','ssim','vmaf'],vmafModel:'vmaf_v0.6.1neg'},context(dir));
  const m=result.rows[0].metrics.vmaf;
  assert.equal(m.model,'vmaf_v0.6.1neg');assert.equal(m.configuration.input.range,'pc');
  assert.equal(m.pooled,JSON.parse(m.raw).pooled_metrics.vmaf.mean);
  await writeFile(path.join(dir,'measured-trial.json'),JSON.stringify({outcome:'passed',result}));
});

test('VMAF Log, PQ, HLG and undeclared metadata match the official engine for all selected models',async()=>{
  const base=await workspace(),evidence=[];
  // Synthetic signal declarations test the computational contract, not camera
  // Log grading or subjective model validation.
  for(const [name,range,signal] of [
    ['log','pc',{transfer:'log100'}],
    ['pq','tv',{primaries:'bt2020',transfer:'smpte2084',matrix:'bt2020nc'}],
    ['hlg','tv',{primaries:'bt2020',transfer:'arib-std-b67',matrix:'bt2020nc'}],
    ['undeclared','unknown',{primaries:'unknown',transfer:'unknown',matrix:'unknown'}],
  ]){
    const dir=path.join(base,name);await mkdir(dir);const {ref,candidate}=await fixture(dir,'yuv422p10le',range,signal);
    for(const model of Object.keys(vmafModels)){
      const ctx={...context(dir),vmafModel:model},result=await compare(ref,candidate,0,0,['psnr','ssim','vmaf'],ctx);
      const log=await official(dir,ref,candidate,model,ctx),m=result.metrics.vmaf;
      assert.deepEqual(m.values,log.frames.map(f=>f.metrics.vmaf));assert.equal(m.pooled,log.pooled_metrics.vmaf.mean);
      assert.deepEqual(result.skippedMetrics,{});assert.equal(m.configuration.preprocessing,'none');
      assert.match(m.configuration.interpretation,/未确认|未经 HDR 感知适用性验证/);
      assert.ok(Number.isFinite(result.metrics.psnr.pooled));assert.ok(result.metrics.ssim.pooled<1);
      evidence.push({name,model,result,official:log,commands:ctx.commands});
    }
  }
  await writeFile(path.join(base,'measured-signals.json'),JSON.stringify({outcome:'passed',evidence}));
});

test('VMAF native 16-bit and interlaced frames match the official engine without display conversion',async()=>{
  const base=await workspace(),evidence=[];
  for(const [pix,signal]of [['yuv420p16le',{}],['yuv422p16le',{}],['yuv444p16le',{}],['yuv420p',{field:'tff'}]]){
    const dir=path.join(base,pix);await mkdir(dir);const {ref,candidate}=await fixture(dir,pix,'tv',signal),ctx=context(dir);
    const result=await compare(ref,candidate,0,0,['psnr','ssim','vmaf'],ctx),log=await official(dir,ref,candidate,'vmaf_v0.6.1',ctx);
    assert.deepEqual(result.metrics.vmaf.values,log.frames.map(f=>f.metrics.vmaf));
    assert.equal(result.metrics.vmaf.pooled,log.pooled_metrics.vmaf.mean);
    assert.equal(result.profile.bitDepth,pix.includes('16le')?16:8);
    if(signal.field)assert.match(result.metrics.vmaf.configuration.interpretation,/隔行/);
    evidence.push({pix,result,official:log,commands:ctx.commands});
  }
  await writeFile(path.join(base,'measured-formats.json'),JSON.stringify({outcome:'passed',evidence}));
});

test('VMAF undeclared 422 10-bit x265 trials run all CRFs and match independent source comparisons',async()=>{
  const dir=await workspace(),{ref}=await fixture(dir,'yuv422p10le','unknown',{primaries:'unknown',transfer:'unknown',matrix:'unknown'}),ctx=context(dir);
  const result=await trial({file:ref,stream:0,start:0,duration:1,encoder:'libx265',presets:['ultrafast'],crfs:[18,23,28],metrics:['psnr','ssim','vmaf'],vmafModel:'vmaf_4k_v0.6.1',keepFiles:true},ctx);
  assert.equal(result.rows.length,3);assert.equal(result.experiment.preparation.reference,'source-segment');
  const source=video(await probe(ref),0);assert.ok(!source.color_transfer||source.color_transfer==='unknown');
  for(const row of result.rows){
    const candidate=path.join(dir,row.id+'.mkv'),s=video(await probe(candidate),0);
    assert.equal(s.pix_fmt,'yuv422p10le');assert.ok(!s.color_transfer||s.color_transfer==='unknown');
    const independentDir=path.join(dir,row.id+'-independent');await mkdir(independentDir);
    const log=await official(independentDir,ref,candidate,'vmaf_4k_v0.6.1',context(independentDir));
    assert.deepEqual(row.metrics.vmaf.values,log.frames.map(f=>f.metrics.vmaf));assert.equal(row.metrics.vmaf.pooled,log.pooled_metrics.vmaf.mean);
    assert.match(row.metrics.vmaf.configuration.interpretation,/未声明/);
  }
  assert.ok(ctx.commands.filter(c=>c.args.includes('libx265')).every(c=>!c.args.includes('-color_trc')&&!c.args.includes('-color_primaries')&&!c.args.includes('-colorspace')));
  await writeFile(path.join(dir,'measured-undeclared-trial.json'),JSON.stringify({outcome:'passed',result,commands:ctx.commands}));
});

test('PSNR and SSIM retain native RGB and grayscale components without the VMAF format whitelist',async()=>{
  const base=await workspace(),evidence=[];
  for(const pix of ['gbrp10le','gray16le']){
    const dir=path.join(base,pix);await mkdir(dir);
    // Materialize the changed plane ourselves. Planar GBR stores G, B, R;
    // rawvideo/NUT avoids introducing a second color filter into the oracle.
    const rgb=pix.startsWith('gbr'),planeSamples=96*64,planes=rgb?3:1,max=rgb?1023:65535;
    const original=Buffer.alloc(4*planeSamples*planes*2),altered=Buffer.alloc(original.length);
    for(let frame=0;frame<4;frame++)for(let plane=0;plane<planes;plane++)for(let i=0;i<planeSamples;i++){
      const offset=((frame*planes+plane)*planeSamples+i)*2,value=(i*17+frame*31+plane*73)%(max+1);
      original.writeUInt16LE(value,offset);altered.writeUInt16LE(plane===(rgb?2:0)?Math.floor(value/2):value,offset);
    }
    const encode=async(name,data)=>{const raw=path.join(dir,name+'.raw'),file=path.join(dir,name+'.nut');await writeFile(raw,data);await run(FF,['-v','error','-f','rawvideo','-pixel_format',pix,'-video_size','96x64','-framerate','4','-i',raw,'-c:v','rawvideo','-f','nut',file]);return file;};
    const file=await encode('native',original),candidate=await encode('changed',altered);
    const ctx=context(dir),result=await compare(file,file,0,0,['psnr','ssim','vmaf'],ctx);
    assert.equal(result.metrics.psnr.pooled,'Infinity');assert.equal(result.metrics.ssim.pooled,1);
    assert.deepEqual(Object.keys(result.metrics.psnr.components),pix.startsWith('gbr')?['r','g','b']:['y']);
    assert.ok(Object.values(result.metrics.ssim.components).every(v=>v===1));
    assert.match(result.skippedMetrics.vmaf,/FFmpeg libvmaf/);
    const changed=await compare(file,candidate,0,0,['psnr','ssim'],ctx),component=pix.startsWith('gbr')?'r':'y';
    assert.ok(Number.isFinite(changed.metrics.psnr.components[component]));assert.ok(changed.metrics.ssim.components[component]<1);
    if(pix.startsWith('gbr'))for(const key of ['g','b']){assert.equal(changed.metrics.psnr.components[key],'Infinity');assert.equal(changed.metrics.ssim.components[key],1)}
    for(const metric of ['psnr','ssim']){
      await run(FF,['-v','error','-noauto_conversion_filters','-i',file,'-i',file,'-filter_complex',`[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]${metric}=stats_file=official-${metric}.log`,'-f','null','-'],ctx);
      assert.equal(result.metrics[metric].raw,await readFile(path.join(dir,`official-${metric}.log`),'utf8'));
      await run(FF,['-v','error','-noauto_conversion_filters','-i',candidate,'-i',file,'-filter_complex',`[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]${metric}=stats_file=official-changed-${metric}.log`,'-f','null','-'],ctx);
      assert.equal(changed.metrics[metric].raw,await readFile(path.join(dir,`official-changed-${metric}.log`),'utf8'));
    }
    evidence.push({pix,result,changed,commands:ctx.commands});
  }
  await writeFile(path.join(base,'measured-rgb-gray.json'),JSON.stringify({outcome:'passed',evidence}));
});

test('VMAF VFR playback sampling matches an independently materialized four-frame oracle',async()=>{
  const dir=await workspace(),width=96,height=64,frameBytes=width*height*3/2;
  const rawFrames=count=>{
    const data=Buffer.alloc(frameBytes*count);
    for(let n=0;n<count;n++)for(let i=0;i<frameBytes;i++)data[n*frameBytes+i]=i<width*height?32+(i%97+n*17)%180:128;
    return data;
  };
  const candidateRaw=rawFrames(6),referenceRaw=rawFrames(4),materializedRaw=Buffer.concat([0,1,2,4].map(n=>candidateRaw.subarray(n*frameBytes,(n+1)*frameBytes)));
  const color=['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left'],commands=[];
  const encode=async(name,data,rate,filter)=>{
    const raw=path.join(dir,name+'.yuv'),file=path.join(dir,name+'.mkv');await writeFile(raw,data);
    await run(FF,['-v','error','-f','rawvideo','-pixel_format','yuv420p','-video_size',`${width}x${height}`,'-framerate',String(rate),'-i',raw,...(filter?['-vf',filter]:[]),'-c:v','ffv1','-level','3',...color,'-enc_time_base','filter','-fps_mode','passthrough',file],{commands});return file;
  };
  const ref=await encode('reference',referenceRaw,4),candidate=await encode('vfr',candidateRaw,6,"settb=1/1000,setpts='eq(N,1)*120+eq(N,2)*300+eq(N,3)*550+eq(N,4)*680+eq(N,5)*900'"),materialized=await encode('materialized',materializedRaw,4);
  const ctx=context(dir),result=await compare(ref,candidate,0,0,['psnr','ssim','vmaf'],{...ctx,timingMode:'playback-sample'});
  const log=await official(dir,ref,materialized,'vmaf_v0.6.1',context(dir));
  assert.equal(result.alignment.gridSide,'reference');assert.equal(result.alignment.frames,4);
  assert.deepEqual(result.metrics.vmaf.values,log.frames.map(f=>f.metrics.vmaf));assert.equal(result.metrics.vmaf.pooled,log.pooled_metrics.vmaf.mean);
  assert.match(result.metrics.vmaf.configuration.preprocessing,/playback sampling/);
  await writeFile(path.join(dir,'measured-sampling.json'),JSON.stringify({outcome:'passed',result,official:log,materializedFrameIndices:[0,1,2,4],commands:[...commands,...ctx.commands]}));
});
