// Controlled, generated media. These are not official codec conformance vectors.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function auditHashMedia({out,ff,fp,command,json,job,hash}){
 const {analyzeRepeats}=await import('../../repeat.mjs');
 const {probe}=await import('../../engine.mjs');
 const dir=path.join(out,'media');await fs.mkdir(dir,{recursive:true});
 const result={outcome:'running',scope:'Known-byte controls encoded by the actual FFmpeg; strict native-sample comparison, not codec certification or visual/physical display measurement.',cases:[],commands:[],gpuDecode:[],gpuHashJobs:[]};
 const run=async(exe,args,options={})=>{const r=await command(exe,args,{...options,allowFailure:true});result.commands.push(r);if(r.exitCode!==0&&!options.allowFailure)throw Error(r.stderr||r.stdout||'Media command failed');return r;};
 const encode=async(raw,file,fmt,w,h,options)=>run(ff,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',fmt,'-video_size',`${w}x${h}`,'-framerate','24','-i',raw,...options,'-fps_mode','passthrough',file]);
 const decoded=async(file,fmt,name,{gpu=false}={})=>{
  const target=path.join(dir,name+'.raw');
  const args=['-v',gpu?'verbose':'error','-y','-noautorotate','-noauto_conversion_filters',...(gpu?['-hwaccel','cuda','-hwaccel_output_format','cuda']:['-hwaccel','none']),'-i',file,'-map','0:v:0','-an','-sn',...(gpu?['-vf','hwdownload,format='+fmt]:[]),'-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+fmt,'-fps_mode','passthrough','-f','rawvideo',target];
  await run(ff,args);return fs.readFile(target);
 };
 function framesFrom(bytes,size,count){assert.equal(bytes.length,size*count);return Array.from({length:count},(_,i)=>bytes.subarray(i*size,(i+1)*size));}
 function sampleBytes(w,h,depth,frame){
  assert.equal(w%2,0);assert.equal(h%2,0);const b=Buffer.alloc(w*h*3/2*(depth>8?2:1)),peak=2**depth-1;
  // Independent source pattern; repeated pairs, moving luma and chroma content.
  for(let i=0;i<w*h*3/2;i++){const v=(i*13+Math.floor(i/w)*7+Math.floor(frame/2)*31)&peak;if(depth===8)b[i]=v;else b.writeUInt16LE(v,i*2);}return b;
 }
 function fromHardware(bytes,w,h,depth,count){
  const frameSize=w*h*3/2*(depth>8?2:1),out=Buffer.alloc(bytes.length);assert.equal(bytes.length,frameSize*count);
  for(let frame=0;frame<count;frame++){
   const start=frame*frameSize,luma=w*h,chroma=luma/4;
   if(depth===8){bytes.copy(out,start,start,start+luma);for(let i=0;i<chroma;i++){out[start+luma+i]=bytes[start+luma+2*i];out[start+luma+chroma+i]=bytes[start+luma+2*i+1];}}
   else{
    const get=position=>{const value=bytes.readUInt16LE(position);assert.equal(value&63,0,'P010 low non-sample bits must be zero');return value>>>6;};
    for(let i=0;i<luma;i++)out.writeUInt16LE(get(start+2*i),start+2*i);
    for(let i=0;i<chroma;i++){out.writeUInt16LE(get(start+2*luma+4*i),start+2*(luma+i));out.writeUInt16LE(get(start+2*luma+4*i+2),start+2*(luma+chroma+i));}
   }
  }return out;
 }
 const gpuMessages=[];
 try{
  // Validate the layout adapters with independent original samples, before using
  // them to judge a decoder. No scaling, chroma resampling or depth reduction.
  for(const depth of [8,10]){
   const w=258,h=146,source=Buffer.concat([sampleBytes(w,h,depth,0),sampleBytes(w,h,depth,3)]),packed=Buffer.alloc(source.length),size=source.length/2,luma=w*h,chroma=luma/4;
   for(let f=0;f<2;f++){const p=f*size;if(depth===8){source.copy(packed,p,p,p+luma);for(let i=0;i<chroma;i++){packed[p+luma+2*i]=source[p+luma+i];packed[p+luma+2*i+1]=source[p+luma+chroma+i];}}
    else{for(let i=0;i<luma;i++)packed.writeUInt16LE(source.readUInt16LE(p+2*i)<<6,p+2*i);for(let i=0;i<chroma;i++){packed.writeUInt16LE(source.readUInt16LE(p+2*(luma+i))<<6,p+2*luma+4*i);packed.writeUInt16LE(source.readUInt16LE(p+2*(luma+chroma+i))<<6,p+2*luma+4*i+2);}}}
   assert.ok(fromHardware(packed,w,h,depth,2).equals(source));result.cases.push({name:'Independent '+(depth===8?'NV12':'P010')+' adapter round trip',outcome:'passed',width:w,height:h,depth,sampleCount:w*h*3,sourceSha256:hash(source),storageSha256:hash(packed),scope:'Exact byte reordering / 6-bit alignment shift only'});
  }
  const codecs=[{codec:'h264',depth:8,options:['-c:v','libx264','-preset','ultrafast','-qp','0','-g','4','-bf','0']},{codec:'hevc',depth:8,options:['-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:pools=1:frame-threads=1:log-level=error:keyint=4:bframes=0']},{codec:'hevc',depth:10,options:['-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:pools=1:frame-threads=1:log-level=error:keyint=4:bframes=0']},{codec:'av1',depth:8,options:['-c:v','libaom-av1','-cpu-used','8','-crf','0','-b:v','0','-threads','2','-g','4']},{codec:'av1',depth:10,options:['-c:v','libaom-av1','-cpu-used','8','-crf','0','-b:v','0','-threads','2','-g','4']}];
  for(const c of codecs){
   const name=c.codec+'-'+c.depth,w=256,h=144,count=12,format=c.depth===8?'yuv420p':'yuv420p10le',original=Array.from({length:count},(_,i)=>sampleBytes(w,h,c.depth,i)),raw=path.join(dir,name+'-input.raw'),file=path.join(dir,name+'.mkv');
   await fs.writeFile(raw,Buffer.concat(original));await encode(raw,file,format,w,h,c.options);
   const cpu=await decoded(file,format,name+'-software'),cpuFrames=framesFrom(cpu,original[0].length,count);assert.ok(cpu.equals(Buffer.concat(original)),name+' declared lossless must preserve original samples');
   const stream=(await probe(file)).raw.streams[0],r=await analyzeRepeats(file,stream,{commands:[]});assert.equal(r.status,'complete');assert.deepEqual(r.frames.map(f=>f.sha256),original.map(b=>hash(b)));assert.deepEqual(r.frames.map(f=>f.equalPrevious),original.map((b,i)=>i?b.equals(original[i-1]):null));
   result.cases.push({name:name+' software / known-byte lossless / product',outcome:'passed',format,width:w,height:h,frames:count,originalHashes:original.map(b=>hash(b)),product:r});
   const hardwareFmt=c.depth===8?'nv12':'p010le',entry={name,codec:c.codec,depth:c.depth,requested:'CUDA/NVDEC, CUDA frame output required by hwdownload',cpuFallbackAllowed:false,outcome:'running'};result.gpuDecode.push(entry);
   try{
    const gpu=await decoded(file,hardwareFmt,name+'-hardware',{gpu:true}),canonical=fromHardware(gpu,w,h,c.depth,count);entry.storageHashes=framesFrom(gpu,original[0].length,count).map(b=>hash(b));entry.canonicalHashes=framesFrom(canonical,original[0].length,count).map(b=>hash(b));entry.softwareHashes=cpuFrames.map(b=>hash(b));
    assert.ok(canonical.equals(cpu),name+' GPU decoder native samples must match CPU byte-for-byte on this control');entry.outcome='passed';entry.frames=count;entry.width=w;entry.height=h;entry.adapter=hardwareFmt+' to '+format+'; exact sample-preserving reordering/alignment only';
    gpuMessages.push(...framesFrom(canonical,original[0].length,count));
   }catch(e){entry.outcome='failed';entry.error=e.stack;}
   // Compressed packets may differ while reconstructed samples are identical.
   if(c.codec==='h264'){
    const packetInfo=JSON.parse((await run(fp,['-v','error','-select_streams','v:0','-show_packets','-show_data_hash','sha256','-of','json',file])).stdout),frameInfo=JSON.parse((await run(fp,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=pts,pict_type','-of','json',file])).stdout);
    assert.equal(packetInfo.packets.length,count);const examples=[];for(let i=1;i<count;i++)if(r.frames[i].equalPrevious&&packetInfo.packets[i].data_hash!==packetInfo.packets[i-1].data_hash)examples.push({previous:i-1,current:i,previousPacket:packetInfo.packets[i-1],currentPacket:packetInfo.packets[i],previousFrame:frameInfo.frames[i-1],currentFrame:frameInfo.frames[i],decodedSha256:r.frames[i].sha256});
    assert.ok(examples.length>0,'Actual unequal packet hashes with equal decoded samples');result.cases.push({name:'Same file: unequal compressed packet hashes, equal reconstructed sample hashes',outcome:'passed',examples});
    const offsetFile=path.join(dir,'h264-offset.mkv');await run(ff,['-v','error','-y','-copyts','-itsoffset','7','-i',file,'-map','0:v:0','-c','copy',offsetFile]);
    const shifted=await analyzeRepeats(offsetFile,(await probe(offsetFile)).raw.streams[0],{commands:[]});assert.deepEqual(shifted.frames.map(f=>f.sha256),r.frames.map(f=>f.sha256));assert.notEqual(shifted.frames[0].pts,r.frames[0].pts);result.cases.push({name:'Time offset changes file / timestamps while frame sample hashes stay equal',outcome:'passed',originalFileSha256:hash(await fs.readFile(file)),shiftedFileSha256:hash(await fs.readFile(offsetFile)),originalTimeBase:r.timeBase,shiftedTimeBase:shifted.timeBase,originalPts:r.frames.map(f=>f.pts),shiftedPts:shifted.frames.map(f=>f.pts),hashes:r.frames.map(f=>f.sha256)});
   }
  }
  // Actual same-file change of H.264 VUI range, at a new coded sequence.
  // 10-bit is intentional: both ranges retain yuv420p10le in this decoder.
  const w=32,h=32,b=Buffer.alloc(w*h*3);for(let i=0;i<w*h;i++)b.writeUInt16LE(64,i*2);for(let i=w*h;i<w*h*3/2;i++)b.writeUInt16LE(512,i*2);
  const raw=path.join(dir,'range-input.raw');await fs.writeFile(raw,Buffer.concat([b,b]));const segments=[];
  for(const range of ['tv','pc']){const file=path.join(dir,'range-'+range+'.h264');await encode(raw,file,'yuv420p10le',w,h,['-vf',`setparams=range=${range}:colorspace=bt709:color_primaries=bt709:color_trc=bt709`,'-c:v','libx264','-preset','ultrafast','-qp','0','-g','1','-bf','0','-color_range',range,'-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-f','h264']);segments.push(await fs.readFile(file));}
  const rangeFile=path.join(dir,'range-change.h264');await fs.writeFile(rangeFile,Buffer.concat(segments));
  const controls=[];
  for(const reinitialize of [true,false]){
   const file=path.join(dir,reinitialize?'range-default-graph.raw':'range-preserved-graph.raw');
   await run(ff,['-v','error','-y','-noauto_conversion_filters',...(reinitialize?[]:['-reinit_filter','0']),'-i',rangeFile,'-c:v','rawvideo','-threads:v','1','-pix_fmt','+yuv420p10le','-f','rawvideo',file]);
   const bytes=await fs.readFile(file),frames=framesFrom(bytes,b.length,4);controls.push({reinitialize,hashes:frames.map(f=>hash(f)),firstLuma:frames.map(f=>f.readUInt16LE(0))});
  }
  assert.deepEqual(controls[1].hashes,Array(4).fill(hash(b)));
  await json('metadata-normalization-observation.json',{scope:'FFmpeg command A/B control; same source bytes and metadata, only graph reinitialization differs',normalizationObserved:controls[0].hashes.some(h=>h!==hash(b)),expectedSha256:hash(b),controls});
  const info=(await probe(rangeFile)).raw.streams[0],rangeReport=await analyzeRepeats(rangeFile,info,{commands:[]});
  assert.equal(rangeReport.frames.length,4);assert.deepEqual(rangeReport.frames.map(f=>f.sha256),Array(4).fill(hash(b)));assert.equal(new Set(rangeReport.frames.map(f=>f.interpretation[0])).size,2);assert.equal(rangeReport.exact.duplicates,3);
  const rendered=[];for(const [frame,range]of [[0,'tv'],[2,'pc']]){const file=path.join(dir,'render-'+range+'.rgb');await run(ff,['-v','error','-y','-reinit_filter','0','-i',rangeFile,'-vf',`select=eq(n\\,${frame}),scale=in_range=${range}:out_range=pc,format=rgb24`,'-frames:v','1','-c:v','rawvideo','-threads:v','1','-f','rawvideo',file]);rendered.push(await fs.readFile(file));}
  assert.equal(rendered[0].length,w*h*3);assert.equal(rendered[1].length,w*h*3);assert.ok(!rendered[0].equals(rendered[1]));result.cases.push({name:'One actual file: equal native samples / different VUI range / different correctly range-interpreted RGB',outcome:'passed',sampleSha256:hash(b),product:rangeReport,rgbFirstPixels:rendered.map(b=>[...b.subarray(0,3)]),rgbHashes:rendered.map(b=>hash(b)),scope:'Digital render conversion only; not a physical display or perception measurement'});gpuMessages.push(b);
  for(const alg of ['sha256','sha512','sha3-256'])result.gpuHashJobs.push(await job('media-'+alg.replaceAll('-','_'),alg,gpuMessages,{category:'actual-decoded-media-controls'}));
  const jobsPath=path.join(out,'media-gpu-jobs.json');await fs.writeFile(jobsPath,JSON.stringify(result.gpuHashJobs));
  const gpuResultPath=path.join(out,'media-gpu-raw.json');const gpuProcess=await run(path.join(out,'generated/HashAuditGpu.exe'),[path.join(out,'generated/hash-audit.cl'),jobsPath,gpuResultPath],{allowFailure:true});const gpuReport=JSON.parse(await fs.readFile(gpuResultPath));assert.equal(gpuProcess.exitCode,0,JSON.stringify(gpuReport));
  let comparisons=0;for(const device of gpuReport.devices){assert.equal(device.outcome,'executed');assert.ok(device.deviceType&4);for(const entry of device.runs){const j=result.gpuHashJobs.find(j=>j.name===entry.name);for(const m of entry.measurements){assert.deepEqual(m.hashes,j.expected);comparisons+=m.hashes.length;}}}
  result.gpuHash={outcome:'passed',comparisons,devices:gpuReport.devices.map(d=>({name:d.name,driver:d.driver,deviceType:d.deviceType}))};assert.ok(result.gpuDecode.every(c=>c.outcome==='passed'),'One or more actual GPU decoder cases failed; inspect gpuDecode');result.outcome='passed';
 }catch(error){result.outcome='failed';result.error=error.stack;throw error;}
 finally{result.finishedAtUtc=new Date().toISOString();await json('media.json',result);}
 console.log('Controlled media, actual hardware decoder and GPU hash scenarios passed.');
}
