import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {availableParallelism} from 'node:os';

const home=path.dirname(fileURLToPath(import.meta.url));
const bundled=name=>existsSync(path.join(home,'runtime',name+'.exe'))?path.join(home,'runtime',name+'.exe'):name;
export const FF = process.env.FFMPEG_PATH || bundled('ffmpeg');
export const FP = process.env.FFPROBE_PATH || bundled('ffprobe');
export function decodeThreadCount(requested){const fallback=Math.max(1,Math.min(12,availableParallelism()));return Number.isInteger(requested)&&requested>=1&&requested<=32?requested:fallback}
export async function run(exe,args,ctx={},line) {
  if(ctx.signal?.aborted) throw Error('任务已取消');
  const command={exe,args,cwd:ctx.cwd??process.cwd()},started=performance.now();
  ctx.commands?.push(command);
  return new Promise((resolve,reject)=>{
    const p=spawn(exe,args,{windowsHide:true,cwd:ctx.cwd,signal:ctx.signal});
    let out='',err='',failure;
    if(line){const rl=createInterface({input:p.stdout});rl.on('line',s=>{try{line(s)}catch(e){failure=e;p.kill();}})}
    else p.stdout.on('data',b=>{out+=b;if(out.length>32*1024*1024){failure=Error('探测输出超过安全上限');p.kill();}});
    p.stderr.on('data',b=>{err=(err+b).slice(-16000)});
    if(ctx.stderrLine){const rl=createInterface({input:p.stderr});rl.on('line',s=>{try{ctx.stderrLine(s)}catch(e){failure=e;p.kill()}})}
    p.on('error',reject);p.on('close',code=>{command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;failure?reject(failure):code===0&&!(args.includes('error')&&err.trim())?resolve(out):reject(Error(err||`进程退出 ${code}`));});
  });
}
export function normalizeMediaPath(file){
  if(typeof file!=='string')throw Error('请输入本机文件的绝对路径');
  let value=file.replace(/[\u200e\u200f\u202a-\u202e\u2060\ufeff]/g,'').trim();
  const pairs=[['"','"'],["'","'"],['“','”'],['‘','’']];
  for(const [left,right] of pairs)if(value.startsWith(left)&&value.endsWith(right)){value=value.slice(left.length,-right.length).trim();break}
  value=value.replace(/^([a-zA-Z])：(?=[\\/])/,'$1:');
  if(!path.isAbsolute(value))throw Error('请输入本机文件的绝对路径');
  return path.normalize(value);
}
export async function probe(file,ctx={}){
  file=normalizeMediaPath(file);
  const s=await stat(file);if(!s.isFile())throw Error('路径不是文件');
  const raw=JSON.parse(await run(FP,['-v','error','-show_format','-show_streams','-show_chapters','-of','json',file],ctx));
  let frameSample=null;
  if(raw.streams.some(s=>s.codec_type==='video'))frameSample=JSON.parse(await run(FP,['-v','error','-select_streams','v','-read_intervals','%+#32','-show_frames','-show_entries','frame=stream_index,color_range,color_space,color_transfer,color_primaries:frame_side_data','-of','json',file],ctx));
  return {file,size:s.size,mtime:s.mtime.toISOString(),raw,frameSample,frameSampleScope:'开头最多 32 个读取包范围内的解码帧附加数据；仅抽样，不代表全片 HDR 动态元数据覆盖。'};
}
export function video(info,index){const s=info.raw.streams.find(s=>s.index===Number(index)&&s.codec_type==='video');if(!s)throw Error('请选择有效的视频轨道');return s}
export async function scan(file,index,ctx={}){
  const frames=[];
  await run(FP,['-v','error','-threads',String(decodeThreadCount(ctx.decodeThreads)),'-select_streams',String(index),'-show_frames','-show_entries','frame=pts,best_effort_timestamp,best_effort_timestamp_time,duration_time,pkt_duration_time,pkt_size,pict_type,key_frame,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,chroma_location,interlaced_frame','-of','compact=p=0:nk=0',file],ctx,line=>{
    const o=Object.fromEntries(line.split('|').map(x=>{const p=x.indexOf('=');return [x.slice(0,p),x.slice(p+1)]}));
    if(!('key_frame' in o))return;
    if(ctx.requireProgressive&&o.interlaced_frame!=='0')throw Error(`第 ${frames.length+1} 帧不是明确的逐行帧，拒绝跨位深比较。`);
    if(ctx.comparisonStream)for(const k of ['width','height','pix_fmt','color_range','color_space','color_transfer','color_primaries','chroma_location']){
      const expected=ctx.comparisonStream[k];
      const normalize=v=>v==null||['unknown','unspecified','N/A'].includes(v)?'unknown':String(v);
      if(o[k]!==undefined&&!(k==='chroma_location'&&ctx.assumedChromaLocation&&normalize(o[k])==='unknown')&&normalize(expected)!==normalize(o[k]))throw Error(`第 ${frames.length+1} 帧 ${k} 与轨道声明不一致；禁止中途改变格式或色彩解释。`);
    }
    if(frames.length>=500000)throw Error('首版单轨支持最多 500,000 帧；本次未完成，不生成完整分析结论');
    const num=k=>o[k]!==undefined&&o[k]!=='N/A'?Number(o[k]):null;
    frames.push({pts:o.pts??o.best_effort_timestamp??null,t:num('best_effort_timestamp_time'),duration:num('duration_time')??num('pkt_duration_time'),bytes:num('pkt_size'),type:o.pict_type||'?',key:o.key_frame==='1'});
    if(frames.length===1||frames.length%100===0)ctx.update?.({detail:`已读取 ${frames.length.toLocaleString()} 帧`,completed:frames.length,total:ctx.expectedFrames??null,unit:'帧'});
  });
  if(!frames.length)throw Error('未获取到视频帧');
  ctx.update?.({detail:`已核验 ${frames.length.toLocaleString()} 帧`,completed:frames.length,total:frames.length,unit:'帧'});
  return frames;
}
export async function packets(file,index,ctx={}){
  const bins=new Map();let bytes=0,missing=0,count=0;
  await run(FP,['-v','error','-select_streams',String(index),'-show_packets','-show_entries','packet=pts_time,dts_time,size','-of','compact=p=0:nk=0',file],ctx,line=>{
    const o=Object.fromEntries(line.split('|').map(x=>x.split('=')));if(!o.size)return;
    const n=Number(o.size);bytes+=n;count++;
    const t=Number(o.pts_time==='N/A'||o.pts_time===undefined?o.dts_time:o.pts_time);
    if(!Number.isFinite(t)){missing++;return}const bin=Math.floor(t);bins.set(bin,(bins.get(bin)||0)+n);
  });
  return {bytes,count,missing,bins:[...bins].sort((a,b)=>a[0]-b[0]).map(([second,b])=>({second,mbps:b*8/1e6}))};
}
export function summarize(frames){
  const types={},gops=[];let lastKey=null,nonIncreasing=0,missingTimes=0;
  frames.forEach((f,i)=>{types[f.type]=(types[f.type]||0)+1;if(f.t===null)missingTimes++;if(i&&f.t!==null&&frames[i-1].t!==null&&f.t<=frames[i-1].t)nonIncreasing++;if(f.key){if(lastKey!==null)gops.push(i-lastKey);lastKey=i;}});
  return {count:frames.length,types,missingTimes,nonIncreasing,keyIntervals:gops,first:frames[0].t,last:frames.at(-1).t};
}
export function validateComparableStreams(a,b,mode='native'){
  const plan=bitDepthPlan(a,b,mode);
  for(const k of ['width','height','pix_fmt','color_range','color_space','color_transfer','color_primaries','chroma_location'])if(!(k==='pix_fmt'&&plan.crossDepth)&&a[k]!==b[k])throw Error(`无法直接比较：${k} 不一致（${a[k]??'未知'} / ${b[k]??'未知'}）。不自动转换。`);
  return plan;
}
const chromaLocations=new Set(['left','center','topleft','top','bottomleft','bottom']);
export function resolveChromaAssumptions(reference,candidate,requested){
  if(requested===undefined)return {reference,candidate,assumptions:[]};
  if(!requested||typeof requested!=='object'||Array.isArray(requested)||Object.keys(requested).some(k=>!['reference','candidate'].includes(k)))throw Error('色度位置确认参数无效');
  const assumptions=[];
  const resolve=(stream,side)=>{
    const value=requested[side];
    if(value===undefined)return stream;
    if(!chromaLocations.has(value))throw Error(`${side==='reference'?'参考':'候选'}视频的确认色度位置无效`);
    if(stream.chroma_location!=null&&!['unknown','unspecified','N/A'].includes(stream.chroma_location))throw Error(`${side==='reference'?'参考':'候选'}视频已声明色度位置，不能用用户确认覆盖`);
    assumptions.push({side,declared:stream.chroma_location??null,assumed:value,source:'用户确认；未由文件或软件验证'});
    return {...stream,chroma_location:value};
  };
  const resolvedReference=resolve(reference,'reference'),resolvedCandidate=resolve(candidate,'candidate');
  if(!assumptions.length)throw Error('请选择至少一路未声明的色度位置');
  return {reference:resolvedReference,candidate:resolvedCandidate,assumptions};
}
export function alignment(a,b,fa,fb,mode='native',timingMode='strict'){
  validateComparableStreams(a,b,mode);
  if(!['strict','ordinal-confirmed'].includes(timingMode))throw Error('时间对齐模式无效');
  if(fa.length!==fb.length)throw Error(`帧数不同：${fa.length} / ${fb.length}，请提供已对齐的文件`);
  if(fa.some(f=>!Number.isFinite(f.t))||fb.some(f=>!Number.isFinite(f.t)))throw Error('缺少有效时间戳，无法验证各路帧序');
  let maxRelativeDifferenceSeconds=0,firstTimestampMismatchFrame=null;
  for(let i=0;i<fa.length;i++){
    if(i&&(fa[i].t<=fa[i-1].t||fb[i].t<=fb[i-1].t))throw Error('存在非递增时间戳');
    const difference=Math.abs((fa[i].t-fa[0].t)-(fb[i].t-fb[0].t));
    maxRelativeDifferenceSeconds=Math.max(maxRelativeDifferenceSeconds,difference);
    if(difference>0.0001){
      firstTimestampMismatchFrame??=i+1;
      if(timingMode==='strict')throw Error(`第 ${i+1} 帧相对时间戳不同；禁止自动补帧或丢帧比较`);
    }
  }
  const da=fa.at(-1).duration,db=fb.at(-1).duration;
  const lastDurationDifferenceSeconds=Number.isFinite(da)&&Number.isFinite(db)?Math.abs(da-db):null;
  if(timingMode==='strict'&&lastDurationDifferenceSeconds!=null&&lastDurationDifferenceSeconds>0.0001)throw Error('末帧持续时间不一致');
  return {frames:fa.length,startOffset:fb[0].t-fa[0].t,toleranceSeconds:0.0001,pairing:timingMode,maxRelativeDifferenceSeconds,firstTimestampMismatchFrame,lastDurationDifferenceSeconds,note:timingMode==='strict'?'已校验相对时间戳和帧数；不代表画面内容相同。必须由用户确认相同剪辑、裁切与画面顺序。':'按解码显示帧序号逐一配对；已核验帧数和各路时间戳递增，未要求两路时间轴一致。用户确认无丢帧、重复帧或重排；软件不能仅凭帧数证明内容逐帧对应。'};
}
function rationalValue(value){
  const match=/^(\d+)\/(\d+)$/.exec(value??'');
  if(!match||Number(match[2])===0)return null;
  const rate=Number(match[1])/Number(match[2]);
  return Number.isFinite(rate)&&rate>0?{text:value,value:rate}:null;
}
function rateValue(value){
  const rate=rationalValue(value);
  if(!rate)return null;
  return rate.value>=1&&rate.value<=120?rate:null;
}
export function playbackAlignment(reference,candidate,refFrames,candidateFrames){
  if(refFrames.length<2||candidateFrames.length<2)throw Error('播放采样模式要求两路至少各有 2 帧');
  for(const [label,frames] of [['参考',refFrames],['候选',candidateFrames]])for(let i=0;i<frames.length;i++){
    if(!Number.isFinite(frames[i].t))throw Error(`${label}视频第 ${i+1} 帧缺少有效时间戳`);
    if(i&&frames[i].t<=frames[i-1].t)throw Error(`${label}视频存在非递增时间戳`);
  }
  const gridFor=(stream,frames)=>{
    const timebase=rationalValue(stream.time_base);
    if(!timebase)return null;
    const ranked=[stream.avg_frame_rate,stream.r_frame_rate].map(rateValue).filter(Boolean).map(rate=>{
      const period=1/rate.value;
      let maximum=0;
      for(let i=0;i<frames.length;i++)maximum=Math.max(maximum,Math.abs(frames[i].t-frames[0].t-i*period));
      return {rate,period,maximum,tolerance:Math.max(0.000002,Math.min(period*0.1,timebase.value*1.5))};
    }).sort((a,b)=>a.maximum-b.maximum);
    return ranked.find(x=>x.maximum<=x.tolerance)??null;
  };
  // Retain the candidate grid when both files qualify, matching earlier reports.
  const candidateGrid=gridFor(candidate,candidateFrames),referenceGrid=gridFor(reference,refFrames);
  const gridSide=candidateGrid?'candidate':referenceGrid?'reference':null;
  if(!gridSide)throw Error('两路视频均未核验为稳定 CFR，无法建立固定播放采样网格');
  const chosen=candidateGrid??referenceGrid;
  const sampledSide=gridSide==='candidate'?'reference':'candidate';
  const gridFrames=gridSide==='candidate'?candidateFrames:refFrames;
  const sampledFrames=gridSide==='candidate'?refFrames:candidateFrames;
  const sampledStream=gridSide==='candidate'?reference:candidate;
  const last=sampledFrames.at(-1),lastDuration=Number.isFinite(last.duration)&&last.duration>0?last.duration:null;
  const streamDuration=Number(sampledStream.duration);
  const coveredUntil=last.t-sampledFrames[0].t+(lastDuration??(Number.isFinite(streamDuration)&&streamDuration>0?Math.max(0,streamDuration-(last.t-sampledFrames[0].t)):0));
  const finalSample=(gridFrames.length-1)*chosen.period;
  if(finalSample>coveredUntil+chosen.tolerance)throw Error(`${sampledSide==='reference'?'参考':'候选'}视频的可核实播放时段不足以覆盖 CFR 末个采样时刻`);
  let sourceIndex=0,previousIndex=-1,repeatedSamples=0;
  const used=new Set(),estimatedSampledFrameIndices=[];
  for(let i=0;i<gridFrames.length;i++){
    const at=i*chosen.period;
    while(sourceIndex+1<sampledFrames.length&&sampledFrames[sourceIndex+1].t-sampledFrames[0].t<=at+0.0000005)sourceIndex++;
    if(sourceIndex===previousIndex)repeatedSamples++;
    estimatedSampledFrameIndices.push(sourceIndex);
    used.add(sourceIndex);previousIndex=sourceIndex;
  }
  return {frames:gridFrames.length,pairing:'playback-sample',gridSide,gridRate:chosen.rate.text,gridRateHz:chosen.rate.value,sampledSide,sampledFrames:sampledFrames.length,maxGridErrorSeconds:chosen.maximum,cfrToleranceSeconds:chosen.tolerance,sampledEndSeconds:coveredUntil,estimatedSampledFrameIndices,estimatedRepeatedSamples:repeatedSamples,estimatedUnrepresentedSampledFrames:sampledFrames.length-used.size,sampling:`各路首帧设为 0；以${gridSide==='candidate'?'候选':'参考'} CFR 网格采样${sampledSide==='reference'?'参考':'候选'}，FFmpeg fps round=up，保持上一已出现画面，不插帧；超出 CFR 帧数的输出截断。帧索引映射、重复与未采样计数由时间戳估计。`,note:'自定义播放时间轴画面差异；不是 ITU 标准化观看质量评分，也不证明真实播放器的呈现行为。'};
}
export function comparisonProfile(s){
  const match=/^yuv(420|422|444)p(?:(10|12)le)?$/.exec(s.pix_fmt??'');
  if(!match)throw Error(`尚未验证的比较像素格式：${s.pix_fmt??'未知'}；目前支持原生平面 YUV 420/422/444 的 8/10/12-bit，不自动转换。`);
  const hdr=['smpte2084','arib-std-b67'].includes(s.color_transfer);
  const reason=hdr?'HDR 仅计算编码值域 PSNR / SSIM；SDR VMAF 模型不适用。':
    [s.color_transfer,s.color_space,s.color_primaries].some(v=>v!=='bt709')?'VMAF v0.6.1 仅用于明确标记 BT.709 的 SDR 视频。':
    s.color_range!=='tv'?'VMAF 当前仅验证有限范围（tv）输入。':null;
  return {pixelFormat:s.pix_fmt,subsampling:match[1],bitDepth:Number(match[2]??8),
    signal:hdr?(s.color_transfer==='smpte2084'?'HDR PQ':'HDR HLG'):'SDR / 其他传递函数',
    primaries:s.color_primaries??'未知',transfer:s.color_transfer??'未知',matrix:s.color_space??'未知',range:s.color_range??'未知',
    domain:'原生 YUV 编码值域；无缩放、位深转换、色彩转换或色调映射',vmafReason:reason};
}
export function bitDepthPlan(a,b,mode='native'){
  if(!['native','bt709-limited-8-10'].includes(mode))throw Error('比较模式无效');
  if(mode==='native'||a.pix_fmt===b.pix_fmt)return {mode:'native',crossDepth:false,referenceFilter:'',candidateFilter:''};
  const pa=comparisonProfile(a),pb=comparisonProfile(b);
  if(pa.subsampling!==pb.subsampling)throw Error('禁止跨采样比较：两文件必须同为 420、422 或 444');
  if(![pa.bitDepth,pb.bitDepth].includes(8)||![pa.bitDepth,pb.bitDepth].includes(10))throw Error('跨位深模式仅支持 8-bit 与 10-bit');
  if([a,b].some(s=>s.color_range!=='tv'||s.color_space!=='bt709'||s.color_transfer!=='bt709'||s.color_primaries!=='bt709'))throw Error('跨位深模式仅支持明确 BT.709 SDR 有限范围；拒绝 HDR、全范围或未知色彩标签');
  if([a,b].some(s=>s.field_order!=='progressive'))throw Error('跨位深模式要求两路明确为逐行视频');
  const locations={left:[0,128],center:[128,128],topleft:[0,0],top:[128,0],bottomleft:[0,256],bottom:[128,256]};
  if(pa.subsampling!=='444'&&(!locations[a.chroma_location]||a.chroma_location!==b.chroma_location))throw Error('跨位深模式要求已知且相同的色度采样位置');
  const [h,v]=locations[a.chroma_location]??[0,0],target=`yuv${pa.subsampling}p10le`;
  const filter=`scale=w=iw:h=ih:flags=neighbor+bitexact:in_range=tv:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709:sws_dither=none:in_h_chr_pos=${h}:out_h_chr_pos=${h}:in_v_chr_pos=${v}:out_v_chr_pos=${v},format=${target},`;
  return {mode,crossDepth:true,referenceFilter:pa.bitDepth===8?filter:'',candidateFilter:pb.bitDepth===8?filter:'',
    sourceFormats:{reference:a.pix_fmt,candidate:b.pix_fmt},targetFormat:target,bitDepth:10,
    mapping:'Y10 = 4 × Y8; Cb10 = 4 × Cb8; Cr10 = 4 × Cr8',psnrPeak:1023,
    basis:'ITU-R BT.709-6 §4.6（8/10-bit 量化码值）；本工具的总编码值差异流程，非标准认证',
    source:'https://www.itu.int/rec/R-REC-BT.709-6-201506-I',
    interpretation:'仅报告总编码值差异；无法由两个最终文件拆分量化、抖动和压缩各自的损失。PSNR 峰值为 1023（非亮度合法范围跨度 876），整体 MSE 按分量样本数加权。SSIM 为 10-bit 域结果，不代表色带或主观质量评分；日志保留 6 位小数，极小误差可能显示为 1，应结合 PSNR 判断。'};
}
async function verifyBitDepthMapping(plan,ctx){
  // Check every 8-bit code, all planes and spatially varying data on the actual runtime.
  // Refuse to publish scores if this build's scaler does anything other than x4.
  const make=(format,m)=>`nullsrc=s=512x32:r=1:d=1,format=${format},geq=lum='${m}*mod(X+Y*W,256)':cb='${m}*mod(3*X+Y*W,256)':cr='${m}*mod(5*X+7*Y*W,256)',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
  const sourceFormat=plan.targetFormat.replace('10le',''),filter=plan.referenceFilter||plan.candidateFilter;
  await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-f','lavfi','-i',make(sourceFormat,1),'-f','lavfi','-i',make(plan.targetFormat,4),'-filter_complex',`[0:v]${filter}null[p];[p][1:v]psnr=stats_file=bitdepth-check.log:shortest=1:repeatlast=0[out]`,'-map','[out]','-frames:v','1','-f','null','-'],ctx);
  const raw=await readFile(path.join(ctx.cwd,'bitdepth-check.log'),'utf8');
  if(!['avg','y','u','v'].every(k=>new RegExp(`psnr_${k}:inf(?:\\s|$)`).test(raw)))throw Error('当前 FFmpeg 未通过 8→10-bit 全码值精确映射校验，拒绝生成跨位深结果');
  return {passed:true,codes:'0–255',planes:['Y','Cb','Cr'],expected:'每个样本精确乘 4',raw};
}
export function bitDepthReductionFilter(stream){
  const eight={...stream,pix_fmt:stream.pix_fmt.replace('10le','')};
  const plan=bitDepthPlan(eight,stream,'bt709-limited-8-10');
  if(!plan.crossDepth)throw Error('降位深输入必须为 10-bit');
  // Quantize explicitly before the scaler: exact multiples of 4 eliminate
  // scaler rounding ambiguity. No dither; preserve footroom and headroom.
  return `lutyuv=y='floor(val/4)*4':u='floor(val/4)*4':v='floor(val/4)*4',${plan.referenceFilter.replace(`format=${stream.pix_fmt},`,`format=${eight.pix_fmt}`)}`;
}
export async function verifyBitDepthReduction(stream,ctx){
  const filter=bitDepthReductionFilter(stream),eight=stream.pix_fmt.replace('10le','');
  const make=(format,expr)=>`nullsrc=s=512x32:r=1:d=1,format=${format},geq=lum='${expr}':cb='${expr}':cr='${expr}',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`;
  await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-f','lavfi','-i',make(stream.pix_fmt,'mod(X+Y*W,1024)'),'-f','lavfi','-i',make(eight,'floor(mod(X+Y*W,1024)/4)'),'-filter_complex',`[0:v]${filter}[d];[d][1:v]psnr=stats_file=bitdepth-reduction-check.log:shortest=1:repeatlast=0[out]`,'-map','[out]','-frames:v','1','-f','null','-'],ctx);
  const raw=await readFile(path.join(ctx.cwd,'bitdepth-reduction-check.log'),'utf8');
  if(!['avg','y','u','v'].every(k=>new RegExp(`psnr_${k}:inf(?:\\s|$)`).test(raw)))throw Error('当前 FFmpeg 未通过 10→8-bit 截断量化自检');
  return {passed:true,codes:'0–1023',mapping:'floor(code10 / 4)',dither:'none',raw};
}
// Explicitly scoped to immutable, task-owned references. Never cache user media globally.
const comparisonSessions=new WeakMap();
export function createComparisonSession(files){
  const token={};comparisonSessions.set(token,{files:new Set(files.map(normalizeMediaPath)),entries:new Map()});return token;
}
async function referenceEntry(file,ctx){
  const session=comparisonSessions.get(ctx.comparisonSession),normalized=normalizeMediaPath(file);
  if(!session?.files.has(normalized))return {info:await probe(file,ctx),scans:new Map()};
  const s=await stat(normalized,{bigint:true}),signature=[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
  let entry=session.entries.get(normalized);
  if(entry&&entry.signature!==signature)throw Error('实验参考文件在任务期间发生变化，拒绝复用验证结果');
  if(!entry){entry={signature,info:await probe(file,ctx),scans:new Map()};session.entries.set(normalized,entry)}
  return entry;
}
export async function compare(ref,candidate,ri,ci,metrics,ctx,mode='native'){
  if(!['strict','ordinal-confirmed','playback-sample'].includes(ctx.timingMode??'strict'))throw Error('时间对齐模式无效');
  if(ctx.progressPlan==='compare')ctx.update({stage:'读取并校验两个文件',detail:'读取参考文件与候选文件元数据',phaseIndex:1,phaseCount:6,completed:0,total:2,unit:'个文件'});
  const entry=await referenceEntry(ref,ctx),r=entry.info,c=await probe(candidate,ctx);
  const {reference:rs,candidate:cs,assumptions:chromaAssumptions}=resolveChromaAssumptions(video(r,ri),video(c,ci),ctx.chromaAssumptions);
  if(ctx.progressPlan==='compare')ctx.update({stage:'读取并校验两个文件',detail:'两个文件元数据已读取',phaseIndex:1,phaseCount:6,completed:2,total:2,unit:'个文件'});
  if(ctx.expectedCandidatePixelFormat&&cs.pix_fmt!==ctx.expectedCandidatePixelFormat)throw Error('编码输出位深与实验请求不一致，拒绝采纳结果');
  if(!Array.isArray(metrics)||!metrics.length||metrics.some(m=>!['psnr','ssim','vmaf'].includes(m)))throw Error('指标选择无效');
  const normalization=validateComparableStreams(rs,cs,mode);
  const profile=comparisonProfile(rs),candidateProfile=comparisonProfile(cs),skippedMetrics={};
  const vmafReason=normalization.crossDepth?'跨位深模式尚未验证 VMAF 的感知适用性；仅提供 PSNR / SSIM。':profile.vmafReason??candidateProfile.vmafReason;
  if(metrics.includes('vmaf')&&vmafReason){
    if(metrics.every(m=>m==='vmaf'))throw Error(vmafReason);
    skippedMetrics.vmaf=vmafReason;
  }
  ctx.update(ctx.progressPlan==='compare'?{stage:'核验参考文件帧序',detail:'逐帧读取参考文件',phaseIndex:2,phaseCount:6,completed:0,total:null,unit:'帧'}:'检查参考文件逐帧时间戳与格式');
  const scanKey=JSON.stringify([Number(ri),normalization.crossDepth,rs.chroma_location]);
  let rf=entry.scans.get(scanKey);
  if(!rf){rf=await scan(ref,ri,{...ctx,comparisonStream:rs,assumedChromaLocation:chromaAssumptions.some(x=>x.side==='reference'),requireProgressive:normalization.crossDepth});entry.scans.set(scanKey,rf)}
  const playback=ctx.timingMode==='playback-sample';
  ctx.update(ctx.progressPlan==='compare'?{stage:'核验候选文件帧序',detail:'逐帧读取候选文件',phaseIndex:3,phaseCount:6,completed:0,total:playback?null:rf.length,unit:'帧'}:'检查候选文件逐帧时间戳与格式');const cf=await scan(candidate,ci,{...ctx,comparisonStream:cs,assumedChromaLocation:chromaAssumptions.some(x=>x.side==='candidate'),requireProgressive:normalization.crossDepth,expectedFrames:playback?null:rf.length});
  const aligned=playback?playbackAlignment(rs,cs,rf,cf):alignment(rs,cs,rf,cf,mode,ctx.timingMode??'strict'),results={};
  const measuredFrames=aligned.frames,measurementTimes=playback&&aligned.gridSide==='candidate'?cf:rf;
  if(ctx.progressPlan==='compare')ctx.update({stage:'验证比较域',detail:normalization.crossDepth?'验证本机精确位深映射':'原生格式无需数值映射',phaseIndex:4,phaseCount:6,completed:normalization.crossDepth?0:1,total:1,unit:'项校验'});
  if(normalization.crossDepth){
    if(ctx.progressPlan!=='compare')ctx.update('验证本机 8→10-bit 全码值映射');normalization.verification=await verifyBitDepthMapping(normalization,ctx);
    profile.pixelFormat=normalization.targetFormat;profile.bitDepth=10;
    profile.domain='BT.709 有限范围统一 10-bit 编码值域；8-bit 精确乘 4；无采样、色彩或色调映射';
    profile.vmafReason=vmafReason;
  }
  const activeMetrics=[...new Set(metrics)].filter(metric=>!skippedMetrics[metric]);
  const filterFor=metric=>metric==='vmaf'?`libvmaf=model=version=vmaf_v0.6.1:log_fmt=json:log_path=${metric}.log:n_threads=2:shortest=1:repeatlast=0`:`${metric}=stats_file=${metric}.log:shortest=1:repeatlast=0`;
  // Keep the single-metric path as the compatibility baseline. Split only after
  // identical normalization and ordinal timestamps; never enable auto conversion.
  const groups=ctx.separateMetrics?activeMetrics.map(m=>[m]):[activeMetrics];
  for(const [groupIndex,group] of groups.entries()){
    const label=`计算 ${group.map(m=>m.toUpperCase()).join(' / ')}`;
    ctx.update(ctx.progressPlan==='compare'?{stage:'计算逐帧质量指标',detail:label,phaseIndex:5,phaseCount:6,completed:groupIndex*measuredFrames,total:groups.length*measuredFrames,unit:'帧次'}:label);
    const sampleFilter=`setpts=PTS-STARTPTS,fps=fps=${aligned.gridRate}:start_time=0:round=up:eof_action=pass,trim=end_frame=${measuredFrames},`;
    const candidateInput=`[0:${ci}]${playback&&aligned.sampledSide==='candidate'?sampleFilter:''}${normalization.candidateFilter}settb=AVTB,setpts=N*1000000[d]`;
    const referenceInput=`[1:${ri}]${playback&&aligned.sampledSide==='reference'?sampleFilter:''}${normalization.referenceFilter}settb=AVTB,setpts=N*1000000[r]`;
    const inputs=`${candidateInput};${referenceInput}`;
    const graph=group.length===1?`${inputs};[d][r]${filterFor(group[0])}[out0]`:
      `${inputs};[d]split=${group.length}${group.map((_,i)=>`[d${i}]`).join('')};[r]split=${group.length}${group.map((_,i)=>`[r${i}]`).join('')};${group.map((m,i)=>`[d${i}][r${i}]${filterFor(m)}[out${i}]`).join(';')}`;
    const outputs=group.flatMap((_,i)=>['-map',`[out${i}]`,'-fps_mode','passthrough','-an','-sn','-f','null','-']);
    await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',candidate,'-noautorotate','-i',ref,'-filter_complex',graph,...outputs,'-progress','pipe:1','-stats_period','0.25'],ctx,line=>{
      const value=Number(line.match(/^frame=(\d+)/)?.[1]);
      if(Number.isFinite(value))ctx.update?.({...(ctx.progressPlan==='compare'?{stage:'计算逐帧质量指标',phaseIndex:5,phaseCount:6}:{}),detail:label,completed:groupIndex*measuredFrames+Math.min(value,measuredFrames),total:groups.length*measuredFrames,unit:'帧次'});
    });
  }
  ctx.update?.({...(ctx.progressPlan==='compare'?{stage:'计算逐帧质量指标',phaseIndex:5,phaseCount:6}:{}),detail:'质量指标计算完成，正在校验日志',completed:groups.length*measuredFrames,total:groups.length*measuredFrames,unit:'帧次'});
  for(const metric of activeMetrics){
    const log=`${metric}.log`;
    const raw=await readFile(path.join(ctx.cwd,log),'utf8');
    const lines=metric==='vmaf'?null:raw.trim().split(/\r?\n/);
    const values=metric==='vmaf'?JSON.parse(raw).frames.map(f=>f.metrics.vmaf):lines.map(l=>{const v=l.match(metric==='psnr'?/psnr_avg:([^\s]+)/:/All:([^\s]+)/)?.[1];return v==='inf'?Infinity:Number(v)});
    if(values.length!==measuredFrames||values.some(v=>!Number.isFinite(v)&&!(metric==='psnr'&&v===Infinity)))throw Error(`${metric} 输出帧数或数据异常，结果不予采纳`);
    const sorted=[...values].sort((a,b)=>a-b),p05=sorted[Math.floor((values.length-1)*.05)];
    // PSNR is pooled in the MSE domain, never averaged directly in dB.
    const pooled=metric==='psnr'?-10*Math.log10(values.reduce((s,v)=>s+10**(-v/10),0)/values.length):values.reduce((s,v)=>s+v,0)/values.length;
    const safe=v=>Number.isFinite(v)?v:'Infinity';
    const windows=new Map();values.forEach((v,i)=>{const t=Math.floor(measurementTimes[i].t-measurementTimes[0].t),w=windows.get(t)||{start:t,first:i,last:i,count:0,sum:0,min:Infinity};w.last=i;w.count++;w.sum+=metric==='psnr'?10**(-v/10):v;w.min=Math.min(w.min,v);windows.set(t,w)});
    const worst=[...windows.values()].map(w=>({start:w.start,first:w.first,last:w.last,count:w.count,min:safe(w.min),value:metric==='psnr'?-10*Math.log10(w.sum/w.count):w.sum/w.count})).sort((a,b)=>a.value-b.value).slice(0,5).map(w=>({...w,value:safe(w.value)}));
    results[metric]={pooled:safe(pooled),p05:safe(p05),min:safe(sorted[0]),values:values.map(safe),worst,raw,model:metric==='vmaf'?'vmaf_v0.6.1':undefined};
    if(metric!=='vmaf'){
      results[metric].components={};
      for(const component of ['y','u','v']){
        const key=metric==='psnr'?`psnr_${component}`:component.toUpperCase();
        const pattern=new RegExp(`(?:^|\\s)${key}:([^\\s]+)`);
        const channel=lines.map(l=>Number(l.match(pattern)?.[1]?.replace(/^inf$/,'Infinity')));
        if(channel.length!==measuredFrames||channel.some(v=>!Number.isFinite(v)&&!(metric==='psnr'&&v===Infinity)))throw Error(`${metric} ${component} 分量日志异常`);
        results[metric].components[component]=safe(metric==='psnr'?-10*Math.log10(channel.reduce((s,v)=>s+10**(-v/10),0)/channel.length):channel.reduce((s,v)=>s+v,0)/channel.length);
      }
    }
  }
  return {reference:r,candidate:c,alignment:aligned,profile,normalization,chromaAssumptions,skippedMetrics,metrics:results,sizeRatio:c.size/r.size,warnings:[...chromaAssumptions.map(x=>`${x.side==='reference'?'参考':'候选'}视频未明确报告色度位置；按用户确认的 ${x.assumed} 计算。该位置未经文件或软件验证，结果依赖此假设。`),...(playback?['播放采样模式使用各路首帧为同一时刻的假设；PSNR / SSIM / VMAF 只评价已核验 CFR 网格上的画面，不覆盖网格之间短暂出现的画面。','重复与未采样帧数量根据时间戳和采样规则估计，不代表已核实编码器的真实取帧映射；VMAF 不是帧率转换的标准化观看质量评分。']:[]),...(normalization.crossDepth?[normalization.interpretation]:[]),'指标为逐帧等权统计，非时长加权。','未知色彩标签不证明色彩解释正确。','PSNR / SSIM 评价解码后的编码值，不等同于 HDR 感知质量；不评价 Dolby Vision / HDR10+ 动态元数据的显示效果。','不同位深、采样或色彩空间的分数不能直接横向比较。','VMAF v0.6.1 不衡量色度损失，不能代替 YUV PSNR / SSIM。','参考文件若本身有损，结果仅表示相对该参考的差异。']};
}
