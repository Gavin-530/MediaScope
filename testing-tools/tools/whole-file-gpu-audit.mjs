// Explicit research experiment. Never substitutes this backend into product analysis.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import os from 'node:os';
import {wholeKernelSource,wholeHostSource} from '../helpers/whole-file-gpu-source.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const argv=process.argv.slice(2),arg=(k,d)=>argv.includes(k)?argv[argv.indexOf(k)+1]:d;
const out=path.resolve(arg('--out',path.join('.build/whole-file-gpu-audit',new Date().toISOString().replace(/[:.]/g,'-'))));
assert.ok(out.startsWith(path.join(root,'.build')+path.sep));
const {FF,FP,probe,run}=await import('../../engine.mjs');
const {analyzeRepeats,repeatFileSignature,repeatContentSha256,verifyRepeatPadding}=await import('../../repeat.mjs');
const {NativeSampleComparison,nativeDifference}=await import('../../repeat-samples.mjs');
const {repeatFrameFormat,repeatRational,repeatExactSummary,repeatTimeline,repeatConstantSegments,repeatFreezeSegments,rationalEvidence}=await import('../../public/repeat-model.js');
const {differenceConfiguration,differenceSummary,SOURCE_CLASSIFICATION,validateDifferenceFrame}=await import('../../public/repeat-difference.js');
const json=async(file,value)=>fs.writeFile(path.join(out,file),JSON.stringify(value,null,2));
const read=async(file)=>JSON.parse(await fs.readFile(path.join(out,file),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function command(exe,args,{timeoutMs=600000,env=process.env}={}){
 const start=performance.now();return new Promise((resolve,reject)=>{
  let stdout='',stderr='',failure;const p=spawn(exe,args,{cwd:root,windowsHide:true,env});const timer=setTimeout(()=>{failure=Error('Owned audit command timeout');p.kill();},timeoutMs);
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>{stderr+=b;if(exe.endsWith('WholeFileGpu.exe'))process.stderr.write(b);});p.once('error',e=>failure=e);p.once('close',exitCode=>{clearTimeout(timer);const r={exe,args,exitCode,stdout,stderr,seconds:(performance.now()-start)/1000};failure?reject(Object.assign(failure,{record:r})):resolve(r);});
 });
}
// FFmpeg n8.1.3 av_ts_make_time_string2 uses fixed decimals and strips zeros.
// Round the exact binary64 value to nearest/even, as default C printf does.
function general(x){
 if(x===0)return '0';const log=Math.floor(Math.log10(Math.abs(x))),p=log<0?-log+5:6,b=Buffer.alloc(8);b.writeDoubleLE(Math.abs(x));const bits=b.readBigUInt64LE(),exponent=Number(bits>>52n&2047n),mantissa=(bits&((1n<<52n)-1n))+(exponent?1n<<52n:0n),e=(exponent||1)-1023-52;
 let n=mantissa*10n**BigInt(p),d=1n;if(e>=0)n<<=BigInt(e);else d<<=BigInt(-e);let q=n/d;const r=n%d;if(r*2n>d||r*2n===d&&q%2n)q++;
 let s=q.toString().padStart(p+1,'0');if(p)s=s.slice(0,-p)+'.'+s.slice(-p);s=s.replace(/\.?0+$/,'');return (x<0?'-':'')+(s||'0');
}
function eventsFor(record,frame,pts,tb){const [flags,start,duration]=record;if(!flags)return [];const a=[];if(flags&1)a.push({kind:'start',value:general(Number(tb.n)/Number(tb.d)*Number(start)),frame,filterPts:pts});if(flags&2)a.push({kind:'duration',value:general(1e-6*Number(duration)),frame,filterPts:pts});if(flags&4)a.push({kind:'end',value:general(Number(tb.n)/Number(tb.d)*Number(pts)),frame,filterPts:pts});return a;}
async function scan(file,stream,ctx){
 const frames=[];const tick=v=>typeof v==='string'&&/^-?\d+$/.test(v)?v:null;
 await run(FP,['-v','error','-threads','12','-select_streams',String(stream.index),'-show_frames','-show_entries','frame=media_type,pts,best_effort_timestamp,duration,pkt_duration,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries','-of','compact=p=0:nk=0',file],ctx,line=>{
  const v=Object.fromEntries(line.split('|').map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));if(v.media_type!=='video')return;
  assert.equal(Number(v.width),stream.width);assert.equal(Number(v.height),stream.height);assert.equal(v.pix_fmt,stream.pix_fmt);
  frames.push({frame:frames.length,pts:tick(v.pts),bestEffortPts:tick(v.best_effort_timestamp),duration:tick(v.duration)??tick(v.pkt_duration),durationSource:tick(v.duration)!==null?'duration':tick(v.pkt_duration)!==null?'pkt_duration':null,interpretation:['color_range','color_space','color_transfer','color_primaries'].map(k=>v[k]??null)});
 });assert.ok(frames.length>0);return frames;
}
function decodeArgs(file,s,gpu=false){
 const hwFmt=s.pix_fmt==='yuv420p'?'nv12':s.pix_fmt==='yuv420p10le'?'p010le':null;
 if(gpu)assert.ok(hwFmt,'NVDEC research adapter only qualifies native yuv420p / yuv420p10le');
 return ['-hide_banner','-nostdin','-v','verbose','-xerror','-copyts','-noautorotate','-noauto_conversion_filters','-reinit_filter','0','-threads:v','12',...(gpu?['-hwaccel','cuda','-hwaccel_output_format','cuda']:['-hwaccel','none']),'-i',file,'-map',`0:${s.index}`,'-an','-sn','-vf',(gpu?'hwdownload,format='+hwFmt+',':'')+'showinfo=checksum=0','-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+(gpu?hwFmt:s.pix_fmt),'-fps_mode','passthrough','-f','rawvideo','pipe:1'];
}
function verifyDecodedPts(stderr,frames){const seen=[...stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g)];assert.equal(seen.length,frames.length,'Actual decoder showinfo must enumerate every frame');for(let i=0;i<frames.length;i++){assert.equal(Number(seen[i][1]),i);assert.equal(seen[i][2],frames[i].pts,'Actual decoded original PTS differs from FFprobe scan at '+i);}}
function descriptors(format){let offset=0,tiles=0;const desc=[];for(const p of format.planes){for(let ch=0;ch<p.components;ch++){desc.push(offset,p.width,p.height,p.components*format.storage,ch*format.storage,tiles);tiles+=Math.ceil(p.width/16)*Math.ceil(p.height/16);}offset+=p.width*p.height*p.components*format.storage;}return {desc,tiles};}
function semantic(r){
 const fields=['status','source','sampleFormat','sourceClassification','differenceConfiguration','differenceSummary','constant','timeBase','gridRates','exact','timeline','freeze'];const x=Object.fromEntries(fields.map(k=>[k,r[k]]));
 const tb=repeatRational(r.hashTimeBase);x.frames=r.frames.map(({hashPts,hashDuration,...f})=>({...f,hashPtsRational:rationalEvidence(BigInt(hashPts)*tb.n,tb.d),hashDurationRational:rationalEvidence(BigInt(hashDuration)*tb.n,tb.d)}));return x;
}
async function cpuStream(file,s,format,frames,ctx){
 const comparison=new NativeSampleComparison(format),events=[],tb=repeatRational(s.time_base);let reference=null,referenceFrame=-1,isFrozen=false,offset=0,count=0;let pixels=Buffer.allocUnsafe(format.bytes);const times={hash:0,difference:0,freeze:0};
 const args=decodeArgs(file,s);const start=performance.now();await new Promise((resolve,reject)=>{
  const p=spawn(FF,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='',failure;
  p.stderr.on('data',b=>error+=b);p.once('error',e=>failure=e);
  p.stdout.on('data',chunk=>{try{let at=0;while(at<chunk.length){const n=Math.min(format.bytes-offset,chunk.length-at);chunk.copy(pixels,offset,at,at+n);offset+=n;at+=n;if(offset<format.bytes)continue;
   assert.ok(count<frames.length);verifyRepeatPadding(pixels,0,format);let t=performance.now();const digest=hash(pixels);times.hash+=(performance.now()-t)/1000;t=performance.now();const cmp=comparison.push(pixels);times.difference+=(performance.now()-t)/1000;
   const frame=frames[count];Object.assign(frame,cmp,{sha256:digest,hashPts:frame.pts,hashDuration:frame.duration??'0',hashBytes:format.bytes});
   t=performance.now();let frozen=false;
   if(reference){let sad=0;if(!reference.equals(pixels)){const d=referenceFrame===count-1?cmp.difference:nativeDifference(reference,pixels,format);sad=d.reduce((n,row)=>n+row[0],0);}frozen=sad/format.samples/2**format.depth<=.001;
    const delta=BigInt(frame.pts)-BigInt(frames[referenceFrame].pts),duration=(delta*tb.n*1000000n+tb.d/2n)/tb.d;let flags=0;if(duration>=2000000n){if(!isFrozen)flags|=1;if(!frozen)flags|=6;isFrozen=frozen;}
    events.push(...eventsFor([flags,frames[referenceFrame].pts,String(duration)],count,frame.pts,tb));
   }
   if(!frozen){reference=Buffer.from(pixels);referenceFrame=count;}times.freeze+=(performance.now()-t)/1000;count++;offset=0;
  }}catch(e){failure=e;p.kill();}});
  p.once('close',code=>{ctx.commands.push({exe:FF,args,elapsedSeconds:(performance.now()-start)/1000,exitCode:code});if(failure)return reject(failure);if(code!==0)return reject(Error(error||'decode failed'));try{verifyDecodedPts(error,frames);resolve();}catch(e){reject(e);}});
 });assert.equal(offset,0);assert.equal(count,frames.length);return {events,metrics:{pipelineSeconds:(performance.now()-start)/1000,cpuComputeSeconds:times}};
}
async function gpuStream(file,s,format,frames,job,ctx){
 const {desc,tiles}=descriptors(format),tb=repeatRational(s.time_base),capacity=Math.max(1,Math.min(job.capacity??512,Math.floor(1024*1024*1024/(format.bytes*3+tiles*32))));
 assert.ok(frames.every((f,i)=>f.pts!==null&&(!i||BigInt(f.pts)>BigInt(frames[i-1].pts))),'GPU freeze prototype requires complete increasing source PTS');
 assert.ok(BigInt(frames.at(-1).pts)-BigInt(frames[0].pts)<(2n**63n-1n)/(tb.n*1000000n),'Exact duration arithmetic must fit signed 64-bit');
 if(format.planes.length>1)assert.equal(format.height%2,0,'GPU freeze current qualification requires even chroma heights');
 const config={ffmpeg:FF,decodeArgs:decodeArgs(file,s,job.mode==='gpu-hw'),device:job.device??0,bytes:format.bytes,capacity,components:desc.length/6,tiles,depth:format.depth,width:format.width,height:format.height,storage:format.storage,shift:format.shift,bigEndian:format.endian==='be'?1:0,paddingMask:format.paddingMask,samples:format.samples,packed:job.mode==='gpu-hw'?1:0,tbN:Number(tb.n),tbD:Number(tb.d),pts:frames.map(f=>f.pts),descriptors:desc};
 const cooperative=job.cpuHashPercent!==undefined;if(cooperative){assert.ok(Number.isInteger(job.cpuHashPercent)&&job.cpuHashPercent>=0&&job.cpuHashPercent<=100);assert.ok(Number.isInteger(job.cpuHashWorkers)&&job.cpuHashWorkers>=1&&job.cpuHashWorkers<=32);Object.assign(config,{cpuHashPercent:job.cpuHashPercent,cpuHashWorkers:job.cpuHashWorkers});}
 const prefix=job.id;await json(prefix+'.gpu-job.json',config);const r=await command(path.join(out,'generated',cooperative?'CooperativeGpu.exe':'WholeFileGpu.exe'),[path.join(out,'generated',cooperative?'cooperative.cl':'whole.cl'),path.join(out,prefix+'.gpu-job.json'),path.join(out,prefix+'.gpu-raw.json')]);await json(prefix+'.gpu-process.json',r);assert.equal(r.exitCode,0,r.stderr);const raw=await read(prefix+'.gpu-raw.json');assert.equal(raw.outcome,'passed',raw.error);assert.ok(raw.device.deviceType&4);assert.ok(raw.kernelEventSeconds>0);assert.equal(raw.frames.length,frames.length);
 if(cooperative){assert.equal(raw.cpuHashFrameCount+raw.gpuHashFrameCount,frames.length);assert.equal(raw.cpuHashPercent,job.cpuHashPercent);}
 verifyDecodedPts(raw.decoderStderr,frames);
 const events=[];for(let i=0;i<frames.length;i++){const g=raw.frames[i],f=frames[i];assert.equal(g.frame,i);Object.assign(f,{sha256:g.sha256,equalPrevious:g.equalPrevious,difference:g.difference,hashPts:f.pts,hashDuration:f.duration??'0',hashBytes:format.bytes});validateDifferenceFrame(f,differenceConfiguration(format),i);events.push(...eventsFor(g.freeze,i,f.pts,tb));}
 ctx.commands.push({exe:FF,args:config.decodeArgs,note:'Executed by OpenCL host, raw output consumed through a bounded pipe',exitCode:raw.decoderExitCode});return {events,metrics:raw,processSeconds:r.seconds};
}
async function worker(job){
 const begin=performance.now(),commands=[],ctx={commands,decodeThreads:12};const file=path.resolve(job.file),start=new Date().toISOString();
 if(job.mode==='production'){const info=await probe(file,ctx),s=info.raw.streams.find(s=>s.codec_type==='video'),r=await analyzeRepeats(file,s,ctx,{freeze:true});return {outcome:'passed',job,start,seconds:(performance.now()-begin)/1000,result:r,commands};}
 const signature=await repeatFileSignature(file),contentSha256=await repeatContentSha256(file),info=await probe(file,ctx),s=info.raw.streams.find(s=>s.codec_type==='video'),format=repeatFrameFormat(s.pix_fmt,s.width,s.height);assert.ok(format);const frames=await scan(file,s,ctx),timeline=repeatTimeline(frames,s.time_base,[s.r_frame_rate,s.avg_frame_rate]);assert.equal(timeline.status,'complete');
 const scanDone=performance.now(),computed=job.mode==='cpu-stream'?await cpuStream(file,s,format,frames,ctx):await gpuStream(file,s,format,frames,job,ctx);
 const exact=repeatExactSummary(frames,true),freeze={status:'complete',noise:.001,durationSeconds:2,events:computed.events,segments:repeatFreezeSegments(computed.events)};
 // The research hash has no encoded-packet time base. Keep its association in
 // the rawvideo encoder's nominal grid using exact nearest-away rescaling;
 // original source timestamps above remain unchanged and independently checked.
 const rate=repeatRational(s.r_frame_rate),tb=repeatRational(s.time_base),hashTimeBase=rate?`${rate.d}/${rate.n}`:s.time_base,htb=repeatRational(hashTimeBase);
 const rescale=x=>{let n=BigInt(x)*tb.n*htb.d,d=tb.d*htb.n;return String(n<0n?-((-n+d/2n)/d):(n+d/2n)/d);};
 for(const f of frames){f.hashPts=rescale(f.pts);f.hashDuration=f.duration===null?'1':rescale(f.duration);}
 const result={configurationVersion:'research-whole-file-gpu-v1',status:'complete',source:{signature,stream:s.index,pixelFormat:s.pix_fmt,width:s.width,height:s.height,contentSha256},sampleFormat:format,algorithm:job.mode==='cpu-stream'?'research-native-CPU-SHA256-difference-freeze':'research-native-OpenCL-SHA256-difference-freeze',hashTimeEvidence:'Exact rescale of independently checked decoded source PTS onto nominal rawvideo grid; not a separate FFmpeg framehash output',sourceClassification:{...SOURCE_CLASSIFICATION},differenceConfiguration:differenceConfiguration(format),differenceSummary:differenceSummary(frames),constant:repeatConstantSegments(frames,s.time_base,exact),timeBase:s.time_base,hashTimeBase,gridRates:[s.r_frame_rate,s.avg_frame_rate],frames,exact,timeline,freeze};
 assert.equal(await repeatFileSignature(file),signature);assert.equal(await repeatContentSha256(file),contentSha256);assert.equal(await repeatFileSignature(file),signature);
 return {outcome:'passed',job,start,seconds:(performance.now()-begin)/1000,scanAndFileHashSeconds:(scanDone-begin)/1000,metrics:computed.metrics,processSeconds:computed.processSeconds,result,commands,partition:{GPU:job.mode.startsWith('gpu')?['native representation adaptation',job.cpuHashPercent===undefined?'SHA-256 preprocessing and compression':'SHA-256 of GPU-assigned complete frames only','direct sample comparison and integer difference statistics','freeze reference SAD and threshold/state transitions']:[],CPU:['demux/decode control','FFprobe original timestamp/format scan','source file integrity','time grid, exact-run and PTS duration aggregation','report formatting and validation',...(job.cpuHashPercent>0?['SHA-256 of CPU-assigned complete frames in parallel with OpenCL queue']:[])],decoder:job.mode==='gpu-hw'?'CUDA/NVDEC required; output downloaded before OpenCL upload':'software decoder; raw bytes piped to computation'}};
}
async function build(){
 await fs.mkdir(path.join(out,'generated'),{recursive:true});await fs.writeFile(path.join(out,'generated/WholeFileGpu.cs'),wholeHostSource);await fs.writeFile(path.join(out,'generated/whole.cl'),wholeKernelSource);
 const r=await command('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/optimize+','/platform:x64','/r:System.Web.Extensions.dll','/out:'+path.join(out,'generated/WholeFileGpu.exe'),path.join(out,'generated/WholeFileGpu.cs')]);await json('build.json',r);assert.equal(r.exitCode,0,r.stdout+r.stderr);console.log('Built research OpenCL whole-file backend.');
}
async function prepare(){
 const inputs=path.join(out,'inputs');await fs.mkdir(inputs,{recursive:true});const files=[];
 for(const [id,name,url]of [['sintel','sintel-trailer.mp4','https://media.w3.org/2010/05/sintel/trailer.mp4'],['bbb1080','bbb-trailer-1080p.mov','https://download.blender.org/peach/trailer/trailer_1080p.mov']]){
  const file=path.join(inputs,name);const s=await fs.stat(file);files.push({id,file,kind:'complete public content file, not an official codec conformance vector',url,bytes:s.size,sha256:await repeatContentSha256(file)});
 }
 for(const depth of [8,10]){
  const w=depth===8?1920:1280,h=depth===8?1080:720,count=270,storage=depth===8?1:2,luma=w*h,chroma=luma/4,size=(luma+2*chroma)*storage,raw=path.join(inputs,'control-'+depth+'.raw'),file=path.join(inputs,'control-'+depth+'.mkv'),fd=await fs.open(raw,'wx'),hashes=[],equal=[];let previous=null;
  try{for(let f=0;f<count;f++){
   const b=Buffer.alloc(size),set=(i,v)=>storage===1?b[i]=v:b.writeUInt16LE(v,i*2);const scale=depth===8?1:4,yy=f<96?16:f<168?16+f*7%200:32,uu=128,vv=128;
   if(storage===1){b.fill(yy,0,luma);b.fill(uu,luma,luma+chroma);b.fill(vv,luma+chroma);}else{for(let i=0;i<luma;i++)set(i,yy*scale);for(let i=luma;i<luma+chroma;i++)set(i,uu*scale);for(let i=luma+chroma;i<luma+2*chroma;i++)set(i,vv*scale);}
   if(f>=80&&f<96){set(luma-1,yy*scale+(f-79));set(luma+chroma-1,uu*scale+((f-80)%3));}
   hashes.push(hash(b));equal.push(previous===null?null:previous.equals(b));await fd.write(b);previous=b;
  }}finally{await fd.close();}
  const args=['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size',`${w}x${h}`,'-framerate','24','-i',raw,'-an',...(depth===8?['-c:v','libx264','-preset','ultrafast','-qp','0','-g','24','-bf','0']:['-c:v','libx265','-preset','ultrafast','-x265-params','lossless=1:pools=1:frame-threads=1:log-level=error:keyint=24:bframes=0']),file];const r=await command(FF,args);await json('control-'+depth+'-encode.json',r);assert.equal(r.exitCode,0,r.stderr);
  await json('control-'+depth+'-oracle.json',{kind:'independent known original bytes; controls are not official conformance vectors',width:w,height:h,depth,count,frameHashes:hashes,equalPrevious:equal,rawSha256:await repeatContentSha256(raw),events:'0..79 exact static,80..95 low single-code/edge changes,96..167 moving global codes,168..269 exact static through EOF'});
  files.push({id:'control'+depth,file,kind:'project-generated known-byte lossless control',bytes:(await fs.stat(file)).size,sha256:await repeatContentSha256(file),oracle:'control-'+depth+'-oracle.json'});
 }
 const extra=arg('--file');if(extra)files.push({id:'user-file',file:path.resolve(extra),kind:'user-selected complete media file',bytes:(await fs.stat(extra)).size,sha256:await repeatContentSha256(extra)});
 await json('inputs.json',{capturedAtUtc:new Date().toISOString(),files});console.log('Prepared '+files.length+' complete inputs.');
}
async function thresholdQualification(){
 await build();const dir=path.join(out,'threshold');await fs.mkdir(dir,{recursive:true});const counts=new Set(Array.from({length:65536},(_,i)=>i+1));
 for(const n of [614880,3110400,1382400,12441600,67108864,134217728])for(const d of [-1,0,1])counts.add(n+d);
 let seed=0x673ac1;for(let i=0;i<10000;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;counts.add(1+(seed>>>0)%134217728);}
 const chunks=[],expected=[];let batch=Buffer.alloc(1024*24),used=0;
 for(const depth of [8,9,10,12,14,16])for(const count of counts){if(count<1||count>(depth===8?134217728:67108864))continue;const max=count*(2**depth-1),at=Math.floor(count*2**depth*.001);for(const sad of new Set([0,1,max,...[-2,-1,0,1,2].map(d=>at+d)])){if(sad<0||sad>max)continue;if(used===1024){chunks.push(batch);batch=Buffer.alloc(1024*24);used=0;}batch.writeBigUInt64LE(BigInt(sad),used*24);batch.writeBigUInt64LE(BigInt(count),used*24+8);batch.writeBigUInt64LE(BigInt(depth),used*24+16);used++;expected.push(sad/count/2**depth<=.001?1:0);}}
 chunks.push(batch.subarray(0,used*24));const file=path.join(dir,'cases.bin');await fs.writeFile(file,Buffer.concat(chunks));const records=[];
 const bits=Buffer.alloc(8);bits.writeDoubleLE(.001);assert.equal(bits.readBigUInt64LE(),0x3f50624dd2f1a9fcn);
 for(const device of [0,1]){const job={device,thresholdCases:file,thresholdOutput:path.join(dir,'device'+device+'.bin')},jp=path.join(dir,'device'+device+'.json'),rp=path.join(dir,'device'+device+'-result.json');await fs.writeFile(jp,JSON.stringify(job));const proc=await command(path.join(out,'generated/WholeFileGpu.exe'),[path.join(out,'generated/whole.cl'),jp,rp]);assert.equal(proc.exitCode,0,proc.stderr);const record=JSON.parse(await fs.readFile(rp,'utf8')),answers=await fs.readFile(job.thresholdOutput);assert.equal(record.outcome,'passed',record.error);assert.equal(answers.length,expected.length*4);for(let i=0;i<expected.length;i++)assert.equal(answers.readUInt32LE(i*4),expected[i],'Threshold boundary case '+i);records.push({device:record.device,comparisons:expected.length,kernelSeconds:record.kernelSeconds,outcome:'passed'});}
 await json('threshold-qualification.json',{outcome:'passed',kind:'project arithmetic/rounding boundary qualification, not official NIST vectors',binary64ThresholdBits:bits.readBigUInt64LE().toString(16),proof:'0.001=M*2^-62, M=4611686018427388 even. Round-to-nearest-even(sad/count) <= 0.001*2^depth iff sad*2^(63-depth) <= count*(2*M+1). Both sides are compared exactly as 128-bit unsigned products; scaling by the binary power is exact in this bounded normal domain.',depths:[8,9,10,12,14,16],counts:counts.size,casesBytes:(await fs.stat(file)).size,casesSha256:await repeatContentSha256(file),records});console.log('Exact integer freeze threshold passed on both actual GPUs: '+expected.length+' cases each.');
}
async function decodeBaseline(){
 const m=await read('inputs.json'),records=[];
 for(const input of m.files){const p=await read(input.id+'-production-0.result.json'),s={index:p.result.source.stream,pix_fmt:p.result.source.pixelFormat};for(const gpu of [false,true]){
  const a=decodeArgs(input.file,s,gpu),v=a.indexOf('-v'),vf=a.indexOf('-vf');a[v+1]='error';if(gpu)a[vf+1]=a[vf+1].replace(',showinfo=checksum=0','');else a.splice(vf,2);a.splice(a.length-3,3,'-progress','pipe:1','-f','null','-');const samples=[];
  for(let rep=0;rep<3;rep++){const r=await command(FF,a);assert.equal(r.exitCode,0,r.stderr);assert.equal(r.stderr.trim(),'');const count=[...r.stdout.matchAll(/^frame=(\d+)/gm)].at(-1);assert.ok(count);assert.equal(Number(count[1]),p.result.frames.length);samples.push(r);}
  records.push({input:input.id,decoder:gpu?'CUDA/NVDEC + required hwdownload':'software, hwaccel none',frames:p.result.frames.length,seconds:stats(samples.map(s=>s.seconds)),commands:samples});console.log(input.id+' standalone decode '+(gpu?'NVDEC':'CPU')+': '+records.at(-1).seconds.median.toFixed(3)+'s');
 }}await json('decode-baseline.json',{outcome:'passed',scope:'Sequential standalone complete decode + rawvideo encoding to null muxer, process startup included. No analysis. CPU/GPU decode cannot be obtained by subtracting this from overlapping analysis pipeline wall time.',records});
}
async function finalize(){
 const s=await read('summary.json'),inputs=await read('inputs.json'),threshold=await read('threshold-qualification.json'),decode=await read('direct-decode-qualification.json'),sha=await read('sha-qualification.json'),baseline=await read('decode-baseline.json');
 for(const r of [s,threshold,decode,sha,baseline])assert.equal(r.outcome,'passed');
 const jobs=[...new Set(s.checks.flatMap(c=>[c.job,c.reference]))];assert.equal(jobs.length,inputs.files.length*6*s.repetitions);
 for(const input of inputs.files)assert.equal(await repeatContentSha256(input.file),input.sha256,'Input differs from preparation manifest');
 for(const id of jobs){const r=await read(id+'.result.json');assert.equal(r.outcome,'passed');const input=inputs.files.find(i=>i.file===r.job.file);assert.equal(r.result.source.contentSha256,input.sha256);}
 assert.equal(await fs.readFile(path.join(out,'generated/whole.cl'),'utf8'),wholeKernelSource,'Generated kernel differs from retained source');assert.equal(await fs.readFile(path.join(out,'generated/WholeFileGpu.cs'),'utf8'),wholeHostSource,'Generated host differs from retained source');
 const sourceFiles=['repeat.mjs','repeat-samples.mjs','engine.mjs','public/repeat-model.js','public/repeat-difference.js','testing-tools/helpers/hash-opencl-source.mjs','testing-tools/helpers/whole-file-gpu-source.mjs','testing-tools/tools/whole-file-gpu-audit.mjs','testing-tools/tools/whole-file-gpu-qualification.mjs','testing-tools/tools/whole-file-gpu-audit.md'];
 const sources=[];for(const name of sourceFiles){const b=await fs.readFile(path.join(root,name)),dest=path.join(out,'source-snapshot',name);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,b);sources.push({file:name,bytes:b.length,sha256:hash(b)});}
 const tools=[];for(const [role,exe]of [['ffmpeg',FF],['ffprobe',FP],['node',process.execPath],['gpuHost',path.join(out,'generated/WholeFileGpu.exe')]])tools.push({role,path:exe,sha256:await repeatContentSha256(exe)});
 s.qualification={thresholdCasesPerGpu:threshold.records[0].comparisons,shaOfficialCasesPerGpu:sha.officialCases,shaCustomBoundaryCasesPerGpu:sha.customBoundaryCases,directDecodeBytes:decode.records.reduce((n,r)=>n+r.validSampleBytesCompared,0),directDecodeFrames:decode.records.reduce((n,r)=>n+r.frames,0),completeFileJobs:jobs.length,strictReferenceComparisons:s.checks.length,allPassed:true};
 s.limitations=s.limitations.map(x=>x.startsWith('Cold process/')?'Analysis wall excludes outer Node startup/imports and final result JSON write; GPU child startup/context/program initialization/allocation are included.':x);
 s.finishedAtUtc=new Date().toISOString();await json('summary.json',s);await json('environment.json',{capturedAtUtc:s.finishedAtUtc,node:process.version,openssl:process.versions.openssl,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),tools,ffmpegVersion:(await command(FF,['-version'])).stdout.split('\n')[0],sources});await report();
 const names=['summary.json','inputs.json','environment.json','REPORT.md','threshold-qualification.json','sha-qualification.json','direct-decode-qualification.json','decode-baseline.json','build.json','generated/whole.cl','generated/WholeFileGpu.cs','generated/WholeFileGpu.exe',...sourceFiles.map(n=>'source-snapshot/'+n)];
 for(const id of jobs)for(const suffix of ['.job.json','.process.json','.result.json',...(id.includes('-gpu-')?['.gpu-job.json','.gpu-process.json','.gpu-raw.json']:[])])names.push(id+suffix);
 for(const input of inputs.files){const rel=path.relative(out,input.file);if(!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel))names.push(rel);if(input.oracle)names.push(input.oracle);}
 for(const sub of ['threshold','vectors','attempt-fp64-required'])for(const entry of await fs.readdir(path.join(out,sub),{withFileTypes:true}).catch(()=>[]))if(entry.isFile())names.push(sub+'/'+entry.name);
 for(const name of ['vf_freezedetect.c','timestamp.c','timestamp.h'])if(await fs.stat(path.join(out,'inputs',name)).catch(()=>null))names.push('inputs/'+name);
 for(const r of sha.records){const device=r.device.name.includes('NVIDIA')?0:1,id='qualification-'+r.id+'-device'+device;for(const suffix of ['.job.json','.process.json','.result.json','.gpu-job.json','.gpu-process.json','.gpu-raw.json'])names.push(id+suffix);}
 const manifest=[];for(const name of new Set(names)){const full=path.resolve(out,name);assert.ok(full.startsWith(out+path.sep));const stat=await fs.stat(full);manifest.push({path:name.replaceAll('\\','/'),bytes:stat.size,sha256:await repeatContentSha256(full)});}await json('result-manifest.json',{kind:'Research evidence integrity index, not an authenticity/certification or recovery-completeness claim',files:manifest});console.log('Finalized '+jobs.length+' complete-file jobs and '+manifest.length+' retained evidence files.');
}
async function execute(job){
 await json(job.id+'.job.json',job);const p=await command(process.execPath,[fileURLToPath(import.meta.url),'--out',out,'--worker',path.join(out,job.id+'.job.json')]);await json(job.id+'.process.json',p);assert.equal(p.exitCode,0,p.stderr);const r=await read(job.id+'.result.json');assert.equal(r.outcome,'passed',r.error);console.log(job.id+': '+r.seconds.toFixed(3)+'s; '+r.result.frames.length+' frames');return r;
}
function stats(a){a=a.toSorted((a,b)=>a-b);return {n:a.length,min:a[0],median:a[Math.floor(a.length/2)],max:a.at(-1)};}
async function compareAndSave(reference,r){
 const a=semantic(reference.result),b=semantic(r.result);if(!isDeepStrictEqual(a,b)){let mismatch=[];for(const k of Object.keys(a))if(!isDeepStrictEqual(a[k],b[k]))mismatch.push(k);await json(r.job.id+'.mismatch.json',{fields:mismatch,reference:reference.job.id,actual:r.job.id});throw Error(r.job.id+' semantic mismatch: '+mismatch.join(', '));}
 return {job:r.job.id,reference:reference.job.id,frameCount:r.result.frames.length,adjacentComparisons:Math.max(0,r.result.frames.length-1),allFrameHashesAndDirectEqualityAndDifferenceFields:true,sourcePtsAndDurationsAndInterpretation:true,hashOutputTimeEvidence:'rationally equal after exact time-base reduction',exactRunsAndConstantAndTimeline:true,allFreezeEventsAndSegments:true,outcome:'passed'};
}
async function batch(){
 const manifest=await read('inputs.json'),repetitions=Number(arg('--repetitions','3')),results=[],checks=[];
 assert.ok(Number.isInteger(repetitions)&&repetitions>=1&&repetitions<=20,'Repetitions must be an integer between 1 and 20');
 assert.equal(await fs.stat(path.join(out,'summary.json')).then(()=>true,()=>false),false,'Use a fresh output directory rather than overwrite a completed audit');
 await build();
 for(const input of manifest.files){
  const base={file:input.file},reference=await execute({...base,id:input.id+'-production-0',mode:'production'});results.push(reference);
  if(input.oracle){const o=await read(input.oracle);assert.deepEqual(reference.result.frames.map(f=>f.sha256),o.frameHashes,'Lossless encode / software decode must preserve independent original bytes');assert.deepEqual(reference.result.frames.map(f=>f.equalPrevious),o.equalPrevious);}
  const modes=[{mode:'cpu-stream'},{mode:'gpu-sw',device:0},{mode:'gpu-hw',device:0},{mode:'gpu-sw',device:1},{mode:'gpu-hw',device:1}];
  for(let rep=0;rep<repetitions;rep++){
   if(rep){const p=await execute({...base,id:input.id+'-production-'+rep,mode:'production'});results.push(p);checks.push(await compareAndSave(reference,p));}
   for(let lane=0;lane<modes.length;lane++){const m=modes[(lane+rep)%modes.length],id=input.id+'-'+m.mode+(m.device!==undefined?'-device'+m.device:'')+'-'+rep;const r=await execute({...base,...m,id});results.push(r);checks.push(await compareAndSave(reference,r));await json('progress.json',{outcome:'running',jobs:results.map(r=>({job:r.job.id,seconds:r.seconds})),checks});}
  }
 }
 const groups=[];for(const input of manifest.files)for(const mode of ['production','cpu-stream','gpu-sw','gpu-hw'])for(const device of mode.startsWith('gpu')?[0,1]:[undefined]){const rs=results.filter(r=>r.job.file===input.file&&r.job.mode===mode&&r.job.device===device);if(!rs.length)continue;groups.push({input:input.id,mode,device:rs[0].metrics?.device?.name??null,seconds:stats(rs.map(r=>r.seconds)),pipelineSeconds:mode==='production'?null:stats(rs.map(r=>r.metrics.pipelineSeconds)),frames:rs[0].result.frames.length,duplicates:rs[0].result.exact.duplicates,exactRuns:rs[0].result.exact.runs.length,constantSegments:rs[0].result.constant.segments.length,freezeSegments:rs[0].result.freeze.segments.length});}
 await json('summary.json',{outcome:'passed',scope:'Complete files, first to last video frame, repeat / native difference / freeze / original-PTS analysis only. Experimental GPU-assisted backend, not every MediaScope module or an all-GPU implementation. No CPU fallback for GPU kernels or requested hardware decode.',repetitions,groups,checks,limitations:['One host; custom unrolled/batched OpenCL implementation, not a vendor-optimized GPU upper bound.','Cold process/context/program initialization included in per-job wall time; pipeline and setup separately recorded.','Operating system file cache not flushed, no thermal/power/affinity isolation; execution order rotated between modes.','Hardware decode uses hwdownload then OpenCL upload; this is not a zero-copy CUDA/OpenCL integration.','CPU and GPU experimental paths share deterministic timestamp/run/report aggregation. GPU numeric evidence is checked against production and CPU-stream evidence.','Public media are content samples, not official codec conformance streams; synthetic controls are separately labeled.']});
 console.log('All complete-file semantic comparisons passed.');await report();
}
async function report(){
 const s=await read('summary.json');let md='# 完整视频 CPU / GPU 分析对照\n\n结论：本次完整文件的重复、原生差异、静止候选和原始 PTS 分析结果一致。NVIDIA 批量研究后端在完整 1080p 预告片上端到端约快 1.8 倍，但在大量完全重复的 8-bit 控制文件上略慢。Intel 核显的收益同样依情景变化。性能结论仅限所测机器、实现和输入。\n\n分析从首帧至 EOF，不截取单帧、不换成整文件单个哈希。GPU 参与样本、摘要和静止筛查计算；CPU 仍负责原始属性探测、文件完整性、时间/区间汇总和报告。不是全部模块或全部计算都转到 GPU。GPU 仅为实验后端，未替换产品分析。\n\n每种模式 '+s.repetitions+' 次；表中为端到端秒数中位数，包含探测、前后源文件摘要、解码、计算、GPU 初始化（如有）和分析结果构造；不含外层 Node 启动/导入、C# 主程序预编译和最终结果写盘。\n\n文件：sintel 为 W3C 托管的完整 Sintel 预告片（854×480，52.208 秒）；bbb1080 为 Blender 官方完整预告片（1920×1080，32.48 秒）。control8 / control10 是另行标记的 270 帧已知原始字节无损控制，分别为 1080p 8-bit 和 720p 10-bit。来源及完整 SHA-256 见 inputs.json。\n\n| 文件 | 模式 | 计算设备 | 帧数 | 总秒数中位数 | 分析管道秒数中位数 |\n|---|---|---|---:|---:|---:|\n';
 for(const g of s.groups)md+=`| ${g.input} | ${g.mode} | ${g.device??'CPU'} | ${g.frames} | ${g.seconds.median.toFixed(3)} | ${g.pipelineSeconds?.median.toFixed(3)??'见原始命令'} |\n`;
 md+='\n逐帧 SHA-256、全部相邻直接比较和七项逐分量差异、原始 PTS/时长/颜色标签、重复区间、PTS ≥2 秒区间、时间网格、全部静止事件与区间均严格对照。摘要输出自己的时间基允许不同，但其时间值需经整数有理数约分后完全一致。算法名称、设备身份和命令必然不同，未冒充生产后端。CPU 继续负责时间戳探测、文件完整性与时间/区间汇总。\n\n';
 for(const g of s.groups.filter(g=>g.mode==='production'))md+=`${g.input}：${g.frames} 帧，精确重复 ${g.duplicates} 次，重复段 ${g.exactRuns} 段，原 PTS ≥2秒 ${g.constantSegments} 段，静止候选 ${g.freezeSegments} 段。\n\n`;
 md+='模式：production 为现有产品 CPU；cpu-stream 为单遍研究 CPU；gpu-sw 为软件解码后 GPU 计算；gpu-hw 为强制 NVIDIA CUDA/NVDEC 解码后 GPU 计算。Intel 的 gpu-hw 也使用 NVIDIA 解码器，随后经主机传给 Intel 核显计算，并非 Intel 硬解。\n\n读等待包含解码/管道/背压的共同作用，不冒称独立解码耗时。GPU 后端同时改变了数据读取遍数，全部收益不能归因于哈希；cpu-stream 是对应控制。温度、功耗、背景负载和系统文件缓存没有实验室控制，三次观察不提供跨设备性能保证。\n\n局限：\n\n'+s.limitations.map(x=>'- '+x).join('\n')+'\n';await fs.writeFile(path.join(out,'REPORT.md'),md);
 if(s.qualification){const q=s.qualification;md+='\n## 额外资格与直接原字节检查\n\n'+q.completeFileJobs+' 次完整文件运行，'+q.strictReferenceComparisons+' 组完整分析语义对照全部通过。软硬解共 '+q.directDecodeFrames+' 帧、'+q.directDecodeBytes+' 字节逐帧直接相等，不依赖哈希相等。新 SHA 内核每块 GPU 重放 '+q.shaOfficialCasesPerGpu+' 条官方原消息和 '+q.shaCustomBoundaryCasesPerGpu+' 个项目边界输入；静止阈值每块 GPU 核对 '+q.thresholdCasesPerGpu+' 个项目算术边界输入。\n\n阈值使用有精确舍入边界证明的整数比较，不以单精度或 CPU 回退代替 GPU 资格检查；时间字符串按 FFmpeg n8.1.3 的实际格式规则逐字符串核对。\n\n研究哈希时间字段由经独立核对的原始 PTS 作整数重标度，不冒称另有 GPU framehash 封装输出。当前输入均为有完整 PTS 的固定布局文件，未认证所有 VFR/损坏/动态格式码流、其他设备或所有 MediaScope 模块。\n\n### 独立解码基线\n\n这些时间是单独顺序执行的完整解码+rawvideo 编码至空封装的进程墙钟，不是从重叠管道中拆出的阶段时间；详见 decode-baseline.json。\n\n';const b=await read('decode-baseline.json');for(const r of b.records)md+=`- ${r.input} / ${r.decoder}: ${r.seconds.median.toFixed(3)} 秒（3 次中位数）。\n`;await fs.writeFile(path.join(out,'REPORT.md'),md);}
}
await fs.mkdir(out,{recursive:true});
if(arg('--worker')){const job=JSON.parse(await fs.readFile(arg('--worker'),'utf8'));try{await json(job.id+'.result.json',await worker(job));}catch(e){await json(job.id+'.result.json',{outcome:'failed',job,error:e.stack});console.error(e);process.exitCode=1;}}
else {const phase=arg('--phase','batch');if(phase==='build')await build();else if(phase==='prepare')await prepare();else if(phase==='threshold')await thresholdQualification();else if(phase==='decode-baseline')await decodeBaseline();else if(phase==='finalize')await finalize();else if(phase==='report')await report();else if(phase==='one'){const job=JSON.parse(await fs.readFile(arg('--job'),'utf8'));const r=await execute(job);console.log(JSON.stringify({seconds:r.seconds,frames:r.result.frames.length,exact:r.result.exact,freeze:r.result.freeze}));}else await batch();}
