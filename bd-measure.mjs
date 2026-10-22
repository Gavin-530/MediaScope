// BD-rate-only measurement. Existing compare metrics and packet rates are untouched.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {FF, run, segmentInput, segmentFilter, assertSegmentUnchanged} from './engine.mjs';
import {bdProfile, bdReference, bdPsnr, bdMean, validateBdMeasurement} from './public/bd-reference.js';

export function bdMeasurementReason(stream, comparison, segment) {
  if (!['yuv420p','yuvj420p','yuv420p10le'].includes(stream.pix_fmt) || stream.width % 2 || stream.height % 2)
    return '严格 BD-rate 暂仅验证原生 SDR YUV420 8/10-bit 偶数尺寸。';
  if (comparison.normalization.crossDepth) return '严格 BD-rate 不接受跨位深归一化；请选择保持源位深。';
  if (comparison.alignment.pairing !== 'strict' || comparison.normalization.metadataGaps.length || comparison.chromaAssumptions.length)
    return '严格 BD-rate 需要已核验的帧配对及完整色彩标签。';
  if (['color_primaries','color_transfer','color_space'].some(k => stream[k] !== 'bt709') ||
      !['tv','pc'].includes(stream.color_range) || !stream.chroma_location || stream.chroma_location === 'unspecified')
    return '严格 BD-rate 目前只验证明确声明的 BT.709 SDR 与有限/全范围。';
  if (!['h264','hevc','av1'].includes(comparison.candidate.raw.streams.find(s => s.codec_type === 'video')?.codec_name))
    return '严格 BD-rate 的基本码流统计不支持此编码器。';
  try { bdFrameRate(stream, segment); } catch (e) { return e.message; }
  return null;
}
function bdFrameRate(stream, segment) {
  const text = stream.r_frame_rate, match = /^(\d+)\/(\d+)$/.exec(text ?? ''), fps = match ? Number(match[1]) / Number(match[2]) : NaN;
  if (!Number.isFinite(fps) || fps <= 0 || !Number(match[2])) throw Error('严格 BD-rate 需要有效 CFR 帧率。');
  // Source timestamps can be quantized by a container tick. Do not mistake this for VFR.
  const tolerance = Math.max(segment.timeBase, 1e-6) + 1e-6;
  const errors = segment.frames.map((f,i) => Math.abs(f.t - segment.frames[0].t - i / fps));
  const maximum = errors.reduce((a,b)=>Math.max(a,b),0);
  if (tolerance > .01 || maximum > tolerance) throw Error('严格 BD-rate 不接受未验证的 VFR 或不一致的帧率/时间轴。');
  return {frameRate:text, timestampToleranceSeconds:tolerance, maxTimestampErrorSeconds:maximum};
}
function decoder(args, frameBytes, ctx) {
  const command = {exe:FF,args,cwd:ctx.cwd}, started = performance.now();
  ctx.commands?.push(command);
  const child = spawn(FF,args,{cwd:ctx.cwd,windowsHide:true,signal:ctx.signal});
  let stderr = '', failure;
  child.stderr.on('data',b => { stderr = (stderr + b).slice(-16000); });
  const done = new Promise((resolve,reject) => {
    child.on('error',e => {failure ??= e;});
    child.on('close',code => {
      command.elapsedSeconds = (performance.now()-started)/1000; command.exitCode = code;
      failure ? reject(failure) : code === 0 && !stderr.trim() ? resolve() : reject(Error(stderr || 'BD-rate 解码失败'));
    });
  });
  // A process may fail while its peer is being read. Handle rejection immediately.
  done.catch(() => {});
  async function* frames() {
    let frame = Buffer.allocUnsafe(frameBytes), filled = 0;
    for await (const chunk of child.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(frameBytes-filled,chunk.length-offset);
        chunk.copy(frame,filled,offset,offset+count); filled += count; offset += count;
        if (filled === frameBytes) { yield frame; frame = Buffer.allocUnsafe(frameBytes); filled = 0; }
      }
    }
    await done;
    if (filled) throw Error('BD-rate 原始帧被截断');
  }
  return {frames:frames(),done,stop:() => child.kill()};
}
function rejectPictureHash(bytes, codec) {
  if (codec === 'av1') return;
  // Reject decoded_picture_hash SEI rather than silently count validation bytes.
  const starts = [];
  for (let i=0;i+3<bytes.length;i++) if (bytes[i]===0 && bytes[i+1]===0 && bytes[i+2]===1) starts.push(i);
  for (let n=0;n<starts.length;n++) {
    const begin=starts[n]+3, end=n+1<starts.length?starts[n+1]:bytes.length;
    const type=codec==='hevc'?(bytes[begin]>>1)&63:bytes[begin]&31;
    if (!(codec==='hevc'?[39,40]:[6]).includes(type)) continue;
    const rbsp=[];
    for (let i=begin+(codec==='hevc'?2:1);i<end;i++) {
      if (bytes[i]===3 && i>=2 && bytes[i-1]===0 && bytes[i-2]===0) continue;
      rbsp.push(bytes[i]);
    }
    for (let i=0;i<rbsp.length && rbsp[i]!==128;) {
      let payload=0,size=0;
      while(rbsp[i]===255){payload+=255;i++;} payload+=rbsp[i++];
      while(rbsp[i]===255){size+=255;i++;} size+=rbsp[i++];
      if (!Number.isFinite(payload) || !Number.isFinite(size) || i+size>rbsp.length) throw Error('BD-rate SEI 结构无法核验');
      if (codec==='hevc' && payload===132) throw Error('基本码流含 decoded_picture_hash 校验数据，严格 BD-rate 拒绝计入码率');
      i+=size;
    }
  }
}
async function bitstreamEvidence(file, codec, signal) {
  const hash=createHash('sha256');let bytes=0,zeros=0,started=false,sei=null;
  const append=value=>{
    if(sei===null)return;
    if(sei.length>=1024*1024)throw Error('BD-rate SEI 超出已验证的解析预算');
    sei.push(value);
  };
  const finish=()=>{if(sei!==null)rejectPictureHash(Buffer.from(sei),codec);sei=null;};
  for await(const chunk of createReadStream(file,{signal})) {
    bytes+=chunk.length;hash.update(chunk);
    if(codec==='av1')continue;
    for(const value of chunk) {
      if(value===0){zeros++;continue;}
      if(value===1&&zeros>=2){finish();started=true;zeros=0;continue;}
      if(started){
        // The first NAL header determines whether this NAL needs parsing.
        const type=codec==='hevc'?(value>>1)&63:value&31;
        if((codec==='hevc'?[39,40]:[6]).includes(type))sei=[0,0,1];
        started=false;
      }
      if(sei!==null)for(let i=0;i<zeros;i++)append(0);
      zeros=0;append(value);
    }
  }
  finish();
  if(!Number.isSafeInteger(bytes)||bytes<1)throw Error('BD-rate 基本码流为空或字节计数溢出');
  return {bytes,sha256:hash.digest('hex')};
}
export async function measureBdPoint(reference, candidate, stream, comparison, segment, ctx) {
  const reason = bdMeasurementReason(stream,comparison,segment);
  if (reason) return {status:'unavailable',version:1,reason};
  await assertSegmentUnchanged(segment);
  const signature=async()=>{const s=await stat(candidate,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
  const candidateIdentity=await signature();
  const depth=stream.pix_fmt==='yuv420p10le'?10:8, step=depth===8?1:2, samples=stream.width*stream.height;
  if (!Number.isSafeInteger(samples*(2**depth-1)**2)) throw Error('BD-rate 整数 SSE 超出精确范围');
  const counts={y:samples,u:samples/4,v:samples/4}, frameBytes=samples*1.5*step;
  const common=['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters'];
  const output=['-an','-sn','-c:v','rawvideo','-threads','1','-pix_fmt','+'+stream.pix_fmt,'-fps_mode','passthrough','-f','rawvideo','pipe:1'];
  const ref=decoder([...common,...segmentInput(reference,segment),'-map',`0:${stream.index}`,'-vf',segmentFilter(segment)+'null',...output],frameBytes,ctx);
  const test=decoder([...common,'-noautorotate','-i',candidate,'-map','0:v:0',...output],frameBytes,ctx);
  const rh=createHash('sha256'),th=createHash('sha256'),components=Object.fromEntries(Object.entries(counts).map(([k,n])=>[k,{samples:n,sse:[]}]));
  let frames=0;
  try {
    for (;;) {
      const [a,b]=await Promise.all([ref.frames.next(),test.frames.next()]);
      if (a.done || b.done) {if(a.done!==b.done)throw Error('BD-rate 原始帧数不一致');break;}
      if (frames>=comparison.alignment.frames) throw Error('BD-rate 解码帧数超过已核验范围');
      rh.update(a.value); th.update(b.value);
      let offset=0;
      for (const [key,count] of Object.entries(counts)) {
        let sse=0;
        for (let i=0;i<count;i++,offset+=step) {
          const x=step===1?a.value[offset]:a.value.readUInt16LE(offset), y=step===1?b.value[offset]:b.value.readUInt16LE(offset);
          if (x>=2**depth || y>=2**depth) throw Error('BD-rate 样本超出位深范围');
          sse+=(x-y)**2;
        }
        components[key].sse.push(sse);
      }
      frames++; if(frames%16===0)ctx.update?.({detail:'BD-rate：核验逐帧整数误差',completed:frames,total:comparison.alignment.frames,unit:'帧'});
    }
    await Promise.all([ref.done,test.done]);
  } finally {ref.stop();test.stop();await Promise.allSettled([ref.done,test.done]);}
  if(frames!==comparison.alignment.frames)throw Error('BD-rate 解码帧数与已核验帧数不一致');
  const peak=255*2**(depth-8);
  for(const c of Object.values(components)) {c.mean=bdMean(c.sse.map(s=>bdPsnr(s,c.samples,peak)));c.zeroFrames=c.sse.filter(s=>s===0).length;}
  const codec=comparison.candidate.raw.streams.find(s=>s.codec_type==='video').codec_name;
  const format=codec==='av1'?'obu':codec, frameRate=bdFrameRate(stream,segment);
  const scratch=await mkdtemp(path.join(ctx.cwd,'bd-bitstream-'));
  let rate;
  try {
    const file=path.join(scratch,'point.'+format);
    await run(FF,[...common,'-i',candidate,'-map','0:v:0','-an','-sn','-c:v','copy',...(codec==='av1'?[]:['-bsf:v',codec+'_mp4toannexb']),'-f',format,file],ctx);
    const evidence=await bitstreamEvidence(file,codec,ctx.signal);
    const [n,d]=frameRate.frameRate.split('/').map(Number),fps=n/d;
    rate={codec,format:codec==='av1'?'low-overhead OBU':'Annex B',...evidence,
      frames,...frameRate,duration:frames/fps,kbps:evidence.bytes*8*fps/frames/1000,checksumPolicy:'reject-decoded-picture-hash'};
  } finally {
    if (!path.resolve(scratch).startsWith(path.resolve(ctx.cwd)+path.sep)) throw Error('BD-rate 临时目录越界');
    await rm(scratch,{recursive:true,force:true});
  }
  await assertSegmentUnchanged(segment);
  if(await signature()!==candidateIdentity)throw Error('BD-rate 候选文件在像素与码率测量期间发生变化');
  return validateBdMeasurement({version:1,status:'ok',profile:bdProfile,input:{width:stream.width,height:stream.height,pixelFormat:stream.pix_fmt,
    range:stream.color_range,primaries:stream.color_primaries,transfer:stream.color_transfer,matrix:stream.color_space,chromaLocation:stream.chroma_location},
    frames,peak,zeroMse:bdReference.zeroMse,pairing:'strict',components,referenceSha256:rh.digest('hex'),candidateSha256:th.digest('hex'),rate},frames);
}
