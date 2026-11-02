import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {freemem} from 'node:os';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {FF,FP,run,checkAnalysisMemory,decodeThreadCount,normalizeMediaPath,probe,video} from './engine.mjs';
import {MAX_ANALYSIS_FRAMES} from './public/analysis-limits.js';
import {repeatFrameFormat,repeatRational,repeatExactSummarySteps,repeatTimelineSteps,repeatFreezeSegments,repeatConstantSegmentsSteps,validateRepeatAnalysisSteps} from './public/repeat-model.js';
import {differenceConfiguration,differenceSummary,SOURCE_CLASSIFICATION} from './public/repeat-difference.js';
import {NativeSampleComparison} from './repeat-samples.mjs';

export const MAX_REPEAT_FRAME_BYTES=128*1024*1024;
const integer=value=>typeof value==='string'&&value.length<=128&&/^-?\d+$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const tick=value=>integer(value)?value:null;
const freezeFormats=new Set(['yuv420p','yuv422p','yuv444p','yuv420p9le','yuv420p10le','yuv420p12le','yuv420p14le','yuv420p16le',
  'yuv422p9le','yuv422p10le','yuv422p12le','yuv422p14le','yuv422p16le','yuv444p9le','yuv444p10le','yuv444p12le','yuv444p14le','yuv444p16le',
  'gray','gray9le','gray10le','gray12le','gray14le','gray16le','rgb24','bgr24','rgba','bgra','argb','abgr','nv12','nv21',
  'gbrp','gbrp9le','gbrp10le','gbrp12le','gbrp14le','gbrp16le','gbrap','gbrap10le','gbrap12le','gbrap16le',
  'yuva420p','yuva422p','yuva444p','yuva420p10le','yuva422p10le','yuva444p10le','yuva420p16le','yuva422p16le','yuva444p16le']);

export async function repeatFileSignature(file) {
  const s=await stat(file,{bigint:true});
  if(!s.isFile())throw Error('重复分析输入不是文件');
  return createHash('sha256').update([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')).digest('hex');
}
async function unchanged(file,signature) {
  if(await repeatFileSignature(file)!==signature)throw Error('源文件在重复分析期间发生变化；不采用已读取的结果');
}
export async function repeatContentSha256(file,ctx={}){
  const digest=createHash('sha256');let bytes=0,lastUpdate=0;
  for await(const part of createReadStream(file,{signal:ctx.signal})){
    digest.update(part);bytes+=part.length;
    if(performance.now()-lastUpdate>1000){ctx.update?.({detail:'核对完整源文件内容摘要',completed:bytes,total:null,unit:'字节'});lastUpdate=performance.now();}
  }
  return digest.digest('hex');
}
const toolHashes=new Map();
async function toolIdentity(exe,role,ctx){
  const directories=path.isAbsolute(exe)?['']:exe.includes(path.sep)?[process.cwd()]:(process.env.PATH??'').split(path.delimiter);
  let resolved;
  for(const directory of directories){
    for(const suffix of process.platform==='win32'&&!path.extname(exe)?['.exe','']:['']){
      const candidate=path.resolve(directory,exe+suffix);
      if((await stat(candidate).catch(()=>null))?.isFile()){resolved=await realpath(candidate);break;}
    }
    if(resolved)break;
  }
  if(!resolved)throw Error(`无法核对 ${role} 实际工具文件`);
  const signature=await repeatFileSignature(resolved),key=resolved+':'+signature;
  if(!toolHashes.has(key))toolHashes.set(key,await repeatContentSha256(resolved,{signal:ctx.signal}));
  await unchanged(resolved,signature);
  return {role,path:resolved,sha256:toolHashes.get(key)};
}

// Validate storage padding independently of chunk and word boundaries.
export function verifyRepeatPadding(part,offset,format){
  if(!format.paddingMask)return;
  const low=format.paddingMask&255,high=format.paddingMask>>>8;
  for(let i=0;i<part.length;i++){
    const wordByte=(offset+i)%2,mask=format.endian==='le'?(wordByte?high:low):(wordByte?low:high);
    if(part[i]&mask)throw Error('原生样本的非有效填充位不为零；该表示不能用于有效样本指纹');
  }
}

async function repeatScan(file,stream,ctx) {
  const frames=[];let lastUpdate=0;
  await run(FP,['-v','error','-threads',String(decodeThreadCount(ctx.decodeThreads)),'-select_streams',String(stream.index),
    '-show_frames','-show_entries','frame=media_type,pts,best_effort_timestamp,duration,pkt_duration,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries',
    '-of','compact=p=0:nk=0',file],ctx,line=>{
    const values=Object.fromEntries(line.split('|').map(s=>{const p=s.indexOf('=');return[s.slice(0,p),s.slice(p+1)];}));
    if(values.media_type!=='video')return;
    if(frames.length>=MAX_ANALYSIS_FRAMES)throw Error('重复分析达到2,000,000帧上限；本次未完成');
    if(Number(values.width)!==stream.width||Number(values.height)!==stream.height||values.pix_fmt!==stream.pix_fmt)throw Error('重复分析不接受帧间尺寸或像素格式改变');
    if(frames.length%8192===0)checkAnalysisMemory();
    frames.push({frame:frames.length,pts:tick(values.pts),bestEffortPts:tick(values.best_effort_timestamp),
      duration:tick(values.duration)??tick(values.pkt_duration),durationSource:tick(values.duration)!==null?'duration':tick(values.pkt_duration)!==null?'pkt_duration':null,
      interpretation:['color_range','color_space','color_transfer','color_primaries'].map(k=>values[k]??null)});
    if(frames.length===1||performance.now()-lastUpdate>1000){ctx.update?.({detail:'读取原始帧时间与格式证据',completed:frames.length,total:null,unit:'帧'});lastUpdate=performance.now();}
  });
  if(!frames.length)throw Error('未取得可解码的视频帧');
  ctx.update?.({detail:'原始帧证据读取完成',completed:frames.length,total:frames.length,unit:'帧'});
  return frames;
}

// One FFmpeg decode, two rawvideo outputs: official framehash plus native bytes.
// Two bounded native frame buffers, with stream backpressure; no clip-sized cache.
async function fingerprints(file,stream,format,frames,ctx) {
  // A metadata-only range/matrix change can otherwise reinitialize FFmpeg's
  // graph and normalize samples to the first output's colour properties.
  // repeatScan has already rejected actual dimensions/pixel-format changes.
  const args=['-hide_banner','-nostdin','-v','error','-xerror','-copyts','-noautorotate','-noauto_conversion_filters','-reinit_filter','0',
    '-threads:v',String(decodeThreadCount(ctx.decodeThreads)),'-i',file,'-filter_complex',`[0:${stream.index}]split=2[h][r]`,
    '-map','[h]','-an','-sn','-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+format.pixelFormat,'-fps_mode','passthrough','-f','framehash','-hash','sha256','pipe:1',
    '-map','[r]','-an','-sn','-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+format.pixelFormat,'-fps_mode','passthrough','-f','rawvideo','pipe:3'];
  const command={exe:FF,args,cwd:ctx.cwd??process.cwd()},started=performance.now();ctx.commands?.push(command);
  let count=0,rawCount=0,offset=0,current=createHash('sha256'),timeBase=null,dimensions=false,algorithm=false;
  const waiting=new Map(),comparison=new NativeSampleComparison(format);
  await new Promise((resolve,reject)=>{
    let failure,stderr='';
    const child=spawn(FF,args,{cwd:ctx.cwd,signal:ctx.signal,windowsHide:true,stdio:['ignore','pipe','pipe','pipe']});
    const fail=e=>{failure??=e;child.kill();};
    const progress=setInterval(()=>ctx.update?.({detail:'核对原生样本指纹与完整性',completed:Math.min(count,rawCount),total:frames.length,unit:'帧'}),1000);
    progress.unref();
    child.once('error',e=>{failure??=e;});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
    createInterface({input:child.stdout}).on('line',line=>{try{
      if(line.startsWith('#tb 0:')) {timeBase=line.slice(6).trim();if(!repeatRational(timeBase))throw Error('framehash时间基无效');return;}
      if(line.startsWith('#dimensions 0:')) {if(line.slice(14).trim()!==`${format.width}x${format.height}`)throw Error('framehash画面尺寸改变');dimensions=true;return;}
      if(line.startsWith('#hash:')) {if(line.slice(6).trim()!=='SHA256')throw Error('framehash摘要算法不是SHA256');algorithm=true;return;}
      if(!line||line.startsWith('#'))return;
      const parts=line.split(',').map(x=>x.trim());
      if(parts.length!==6||parts[0]!=='0'||!integer(parts[2])||!integer(parts[3])||Number(parts[4])!==format.bytes||!hash(parts[5])||count>=frames.length)throw Error('framehash输出帧、格式或数量无效');
      const frame=frames[count];frame.sha256=parts[5];frame.hashPts=parts[2];frame.hashDuration=parts[3];frame.hashBytes=Number(parts[4]);
      if(waiting.has(count)){if(waiting.get(count)!==frame.sha256)throw Error('官方指纹与原生字节指纹不一致');waiting.delete(count);}
      count++;
      if(count%8192===0)checkAnalysisMemory();
    }catch(e){fail(e);}});
    child.stdio[3].on('data',chunk=>{try{
      let cursor=0;
      while(cursor<chunk.length) {
        if(rawCount>=frames.length)throw Error('原生字节流多于预扫描帧数');
        const length=Math.min(format.bytes-offset,chunk.length-cursor),part=chunk.subarray(cursor,cursor+length);
        verifyRepeatPadding(part,offset,format);
        current.update(part);const compared=comparison.push(part);offset+=length;cursor+=length;
        if(offset===format.bytes) {
          Object.assign(frames[rawCount],compared);
          const digest=current.digest('hex');
          if(frames[rawCount].sha256!==undefined) {if(frames[rawCount].sha256!==digest)throw Error('官方指纹与原生字节指纹不一致');}
          else waiting.set(rawCount,digest);
          if(waiting.size>4096)throw Error('指纹分支同步缓冲达到上限；本次未完成');
          rawCount++;offset=0;current=createHash('sha256');
        }
      }
    }catch(e){fail(e);}});
    child.stdio[3].on('error',fail);
    child.once('close',code=>{
      clearInterval(progress);command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;
      if(failure)return reject(failure);
      if(code!==0||stderr.trim())return reject(Error(stderr||`重复分析进程退出 ${code}`));
      if(!timeBase||!dimensions||!algorithm||offset||count!==frames.length||rawCount!==count||waiting.size)return reject(Error('重复分析输出截断、标头缺失或两路数量不一致'));
      resolve();
    });
  });
  ctx.update?.({detail:'原生样本指纹核对完成',completed:count,total:count,unit:'帧'});
  return timeBase;
}

async function frozen(file,stream,frames,timeline,ctx) {
  if(!freezeFormats.has(stream.pix_fmt))return {status:'unsupported',reason:'当前像素布局未通过原生freezedetect资格验证；未进行格式转换。'};
  if(timeline.status!=='complete')return {status:'unavailable',reason:'原始PTS缺失、无效或非递增，不使用生成时间执行持续静止判断。'};
  const events=[];let frame=null,filterPts=null;
  try {
    await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-copyts','-noautorotate','-noauto_conversion_filters','-reinit_filter','0',
      '-threads:v',String(decodeThreadCount(ctx.decodeThreads)),'-i',file,'-map',`0:${stream.index}`,'-an','-sn',
      '-vf','freezedetect=noise=0.001:duration=2,metadata=mode=print:file=-','-fps_mode','passthrough','-f','null','-'],ctx,line=>{
      const header=/^frame:(\d+)\s+pts:(-?\d+)\s+pts_time:/.exec(line);
      if(header){frame=Number(header[1]);filterPts=header[2];return;}
      const m=/^lavfi\.freezedetect\.freeze_(start|duration|end)=(.+)$/.exec(line);
      if(!m)return;
      if(frame===null||frame>=frames.length||!Number.isFinite(Number(m[2]))||events.length>=frames.length*3)throw Error('持续静止事件缺少有效的帧或时间');
      events.push({kind:m[1],value:m[2],frame,filterPts});
    });
    return {status:'complete',noise:.001,durationSeconds:2,events,segments:repeatFreezeSegments(events)};
  }catch(e) {
    if(ctx.signal?.aborted)throw e;
    return {status:'failed',reason:e.message};
  }
}

async function collectSteps(iterator,ctx,detail){
  let lastUpdate=0;
  for(;;){
    ctx.signal?.throwIfAborted();
    const step=iterator.next();if(step.done)return step.value;
    if(performance.now()-lastUpdate>1000){ctx.update?.({detail,completed:null,total:null,unit:null});lastUpdate=performance.now();}
    await yieldNow();
  }
}
export async function analyzeRepeats(file,stream,ctx={},options={}) {
  if(ctx.signal?.aborted)throw Error('任务已取消');
  const signature=await repeatFileSignature(file),source={signature,stream:stream.index,pixelFormat:stream.pix_fmt,width:stream.width,height:stream.height};
  const format=repeatFrameFormat(stream.pix_fmt,stream.width,stream.height);
  if(!format)return {configurationVersion:1,status:'unsupported',source,reason:'未验证的整数像素布局，或浮点/调色板；不转换为其他格式计算。'};
  if(format.bytes>MAX_REPEAT_FRAME_BYTES||format.bytes*4>freemem()/2)throw Error('原生帧字节或可用内存超过重复分析预算；本次未完成');
  source.contentSha256=await repeatContentSha256(file,ctx);
  const tools=[];for(const [exe,role]of [[FF,'ffmpeg'],[FP,'ffprobe'],[process.execPath,'node']])tools.push(await toolIdentity(exe,role,ctx));
  const frames=await repeatScan(file,stream,ctx);
  await unchanged(file,signature);
  const hashTimeBase=await fingerprints(file,stream,format,frames,ctx);
  const timeBase=repeatRational(stream.time_base)?stream.time_base:null,gridRates=[stream.r_frame_rate,stream.avg_frame_rate].filter(x=>typeof x==='string');
  const exact=await collectSteps(repeatExactSummarySteps(frames,true),ctx,'汇总精确重复区间');
  const timeline=await collectSteps(repeatTimelineSteps(frames,timeBase,gridRates),ctx,'核对原始时间网格');
  ctx.update?.({detail:options.freeze?'核对持续静止候选':'汇总精确重复与原始时间证据',completed:frames.length,total:frames.length,unit:'帧'});
  const freeze=options.freeze?await frozen(file,stream,frames,timeline,ctx):{status:'not-requested'};
  await unchanged(file,signature);
  if(await repeatContentSha256(file,ctx)!==source.contentSha256)throw Error('源文件内容在重复分析期间发生变化；不采用已读取的结果');
  await unchanged(file,signature);
  const constant=await collectSteps(repeatConstantSegmentsSteps(frames,timeBase,exact),ctx,'核对持续样本不变区间');
  const result={configurationVersion:2,status:'complete',source,sampleFormat:format,algorithm:'native-bytes-equal+FFmpeg/rawvideo/framehash/SHA256',
    tools,sourceClassification:{...SOURCE_CLASSIFICATION},differenceConfiguration:differenceConfiguration(format),differenceSummary:differenceSummary(frames),constant,timeBase,hashTimeBase,gridRates,frames,exact,timeline,freeze};
  await collectSteps(validateRepeatAnalysisSteps(result,stream),ctx,'复核完整重复分析证据');
  return result;
}

function bufferedProcess(args,input,ctx,limit) {
  const command={exe:FF,args,cwd:ctx.cwd??process.cwd()},started=performance.now();ctx.commands?.push(command);
  return new Promise((resolve,reject)=>{
    const child=spawn(FF,args,{cwd:ctx.cwd,signal:ctx.signal,windowsHide:true,stdio:[input?'pipe':'ignore','pipe','pipe']});
    let failure,bytes=0,stderr='';const chunks=[];
    child.once('error',e=>{failure??=e;});
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>limit){failure??=Error('复核画面超出缓冲上限');child.kill();}else chunks.push(b);});
    child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
    if(input){child.stdin.on('error',e=>{failure??=e;child.kill();});child.stdin.end(input);}
    child.once('close',code=>{command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;
      if(failure||code!==0||stderr.trim())reject(failure??Error(stderr||`复核进程退出 ${code}`));else resolve(Buffer.concat(chunks));});
  });
}

export async function repeatPreview(input,ctx={}) {
  const file=normalizeMediaPath(input.file);
  if(!hash(input.signature)||!Number.isSafeInteger(input.stream)||input.stream<0||!Number.isSafeInteger(input.frame)||input.frame<0||input.frame>=MAX_ANALYSIS_FRAMES||!Array.isArray(input.hashes)||input.hashes.length!==(input.frame?2:1)||!input.hashes.every(hash))throw Error('原帧复核参数无效');
  await unchanged(file,input.signature);
  if(input.contentSha256!==undefined&&(!hash(input.contentSha256)||await repeatContentSha256(file,ctx)!==input.contentSha256))throw Error('复核源文件内容摘要与报告不一致');
  const info=await probe(file,ctx),stream=video(info,input.stream),format=repeatFrameFormat(stream.pix_fmt,stream.width,stream.height);
  if(!format||format.bytes>MAX_REPEAT_FRAME_BYTES||format.bytes*6>freemem()/2)throw Error('原帧复核格式或内存预算不足');
  const start=Math.max(0,input.frame-1),count=input.hashes.length;
  const raw=await bufferedProcess(['-hide_banner','-nostdin','-v','error','-xerror','-noautorotate','-noauto_conversion_filters','-reinit_filter','0','-i',file,
    '-map',`0:${stream.index}`,'-vf',`select=between(n\\,${start}\\,${input.frame})`,'-frames:v',String(count),'-an','-sn','-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+stream.pix_fmt,'-fps_mode','passthrough','-f','rawvideo','pipe:1'],null,ctx,format.bytes*count);
  if(raw.length!==format.bytes*count)throw Error('原帧复核未取得完整帧');
  const images=[];
  for(let i=0;i<count;i++) {
    const pixels=raw.subarray(i*format.bytes,(i+1)*format.bytes);
    if(createHash('sha256').update(pixels).digest('hex')!==input.hashes[i])throw Error('复核样本与原报告指纹不一致；不显示替代画面');
    const png=await bufferedProcess(['-hide_banner','-v','error','-f','rawvideo','-pixel_format',stream.pix_fmt,'-video_size',`${stream.width}x${stream.height}`,'-framerate','1','-i','pipe:0',
      '-vf',"scale=w='min(1280,iw)':h=-1:flags=bilinear,format=rgb24",'-frames:v','1','-threads:v','1','-c:v','png','-f','image2pipe','pipe:1'],pixels,ctx,16*1024*1024);
    images.push({frame:start+i,sha256:input.hashes[i],image:'data:image/png;base64,'+png.toString('base64')});
  }
  await unchanged(file,input.signature);
  if(input.contentSha256!==undefined&&await repeatContentSha256(file,ctx)!==input.contentSha256)throw Error('复核期间源文件内容发生变化');
  return {images,note:'原帧指纹已核对。预览显式转换为最大宽1280像素的8-bit RGB；无HDR显示校准。显示差分不参与原生分析。'};
}
