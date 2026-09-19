import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const home=path.dirname(fileURLToPath(import.meta.url));
const bundled=name=>existsSync(path.join(home,'runtime',name+'.exe'))?path.join(home,'runtime',name+'.exe'):name;
export const FF = process.env.FFMPEG_PATH || bundled('ffmpeg');
export const FP = process.env.FFPROBE_PATH || bundled('ffprobe');
export async function run(exe,args,ctx={},line) {
  if(ctx.signal?.aborted) throw Error('任务已取消');
  ctx.commands?.push({exe,args,cwd:ctx.cwd??process.cwd()});
  return new Promise((resolve,reject)=>{
    const p=spawn(exe,args,{windowsHide:true,cwd:ctx.cwd,signal:ctx.signal});
    let out='',err='',failure;
    if(line){const rl=createInterface({input:p.stdout});rl.on('line',s=>{try{line(s)}catch(e){failure=e;p.kill();}})}
    else p.stdout.on('data',b=>{out+=b;if(out.length>32*1024*1024){failure=Error('探测输出超过安全上限');p.kill();}});
    p.stderr.on('data',b=>{err=(err+b).slice(-16000)});
    if(ctx.stderrLine){const rl=createInterface({input:p.stderr});rl.on('line',s=>{try{ctx.stderrLine(s)}catch(e){failure=e;p.kill()}})}
    p.on('error',reject);p.on('close',code=>failure?reject(failure):code===0&&!(args.includes('error')&&err.trim())?resolve(out):reject(Error(err||`进程退出 ${code}`)));
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
  await run(FP,['-v','error','-select_streams',String(index),'-show_frames','-show_entries','frame=pts,best_effort_timestamp,best_effort_timestamp_time,duration_time,pkt_duration_time,pkt_size,pict_type,key_frame','-of','compact=p=0:nk=0',file],ctx,line=>{
    const o=Object.fromEntries(line.split('|').map(x=>{const p=x.indexOf('=');return [x.slice(0,p),x.slice(p+1)]}));
    if(!('key_frame' in o))return;
    if(frames.length>=500000)throw Error('首版单轨支持最多 500,000 帧；本次未完成，不生成完整分析结论');
    const num=k=>o[k]!==undefined&&o[k]!=='N/A'?Number(o[k]):null;
    frames.push({pts:o.pts??o.best_effort_timestamp??null,t:num('best_effort_timestamp_time'),duration:num('duration_time')??num('pkt_duration_time'),bytes:num('pkt_size'),type:o.pict_type||'?',key:o.key_frame==='1'});
    if(frames.length%500===0)ctx.update?.(`已解码 ${frames.length.toLocaleString()} 帧`);
  });
  if(!frames.length)throw Error('未获取到视频帧');
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
export function alignment(a,b,fa,fb){
  for(const k of ['width','height','pix_fmt','color_range','color_space','color_transfer','color_primaries','chroma_location'])if(a[k]!==b[k])throw Error(`无法直接比较：${k} 不一致（${a[k]??'未知'} / ${b[k]??'未知'}）。首版不自动转换。`);
  if(fa.length!==fb.length)throw Error(`帧数不同：${fa.length} / ${fb.length}，请提供已对齐的文件`);
  if(fa.some(f=>f.t===null)||fb.some(f=>f.t===null))throw Error('缺少时间戳，无法验证对齐');
  for(let i=0;i<fa.length;i++){
    if(i&&(fa[i].t<=fa[i-1].t||fb[i].t<=fb[i-1].t))throw Error('存在非递增时间戳');
    if(Math.abs((fa[i].t-fa[0].t)-(fb[i].t-fb[0].t))>0.0001)throw Error(`第 ${i+1} 帧相对时间戳不同；禁止自动补帧或丢帧比较`);
  }
  const da=fa.at(-1).duration,db=fb.at(-1).duration;
  if(da!=null&&db!=null&&Math.abs(da-db)>0.0001)throw Error('末帧持续时间不一致');
  return {frames:fa.length,startOffset:fb[0].t-fa[0].t,toleranceSeconds:0.0001,note:'已校验相对时间戳和帧数；不代表画面内容相同。必须由用户确认相同剪辑、裁切与画面顺序。'};
}
export async function compare(ref,candidate,ri,ci,metrics,ctx){
  const r=await probe(ref,ctx),c=await probe(candidate,ctx),rs=video(r,ri),cs=video(c,ci);
  if(!Array.isArray(metrics)||!metrics.length||metrics.some(m=>!['psnr','ssim','vmaf'].includes(m)))throw Error('指标选择无效');
  if(metrics.includes('vmaf')&&[rs,cs].some(s=>['smpte2084','arib-std-b67'].includes(s.color_transfer)))throw Error('HDR 首版仅提供编码值域的 PSNR / SSIM；不使用 SDR VMAF 模型评价 HDR');
  if(metrics.includes('vmaf')&&[rs,cs].some(s=>s.color_transfer!=='bt709'||s.color_space!=='bt709'||s.color_primaries!=='bt709'))throw Error('首版 VMAF 仅接受明确标记为 BT.709 的 SDR 视频');
  ctx.update('检查参考文件逐帧时间戳');const rf=await scan(ref,ri,ctx);
  ctx.update('检查候选文件逐帧时间戳');const cf=await scan(candidate,ci,ctx);
  const aligned=alignment(rs,cs,rf,cf),results={};
  for(const metric of [...new Set(metrics)]){
    ctx.update(`计算 ${metric.toUpperCase()}`);
    const log=`${metric}.log`;
    const filter=metric==='vmaf'?`libvmaf=model=version=vmaf_v0.6.1:log_fmt=json:log_path=${log}:n_threads=2:shortest=1:repeatlast=0`:`${metric}=stats_file=${log}:shortest=1:repeatlast=0`;
    // After validating the original timeline, assign identical ordinal timestamps.
    // This prevents sub-tolerance rounding differences from selecting a neighbouring frame.
    await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',candidate,'-noautorotate','-i',ref,'-filter_complex',`[0:${ci}]settb=AVTB,setpts=N*1000000[d];[1:${ri}]settb=AVTB,setpts=N*1000000[r];[d][r]${filter}[out]`,'-map','[out]','-fps_mode','passthrough','-an','-sn','-f','null','-'],ctx);
    const raw=await readFile(path.join(ctx.cwd,log),'utf8');
    const values=metric==='vmaf'?JSON.parse(raw).frames.map(f=>f.metrics.vmaf):raw.trim().split(/\r?\n/).map(l=>{const v=l.match(metric==='psnr'?/psnr_avg:([^\s]+)/:/All:([^\s]+)/)?.[1];return v==='inf'?Infinity:Number(v)});
    if(values.length!==rf.length||values.some(Number.isNaN))throw Error(`${metric} 输出帧数或数据异常，结果不予采纳`);
    const sorted=[...values].sort((a,b)=>a-b),p05=sorted[Math.floor((values.length-1)*.05)];
    // PSNR is pooled in the MSE domain, never averaged directly in dB.
    const pooled=metric==='psnr'?-10*Math.log10(values.reduce((s,v)=>s+10**(-v/10),0)/values.length):values.reduce((s,v)=>s+v,0)/values.length;
    const safe=v=>Number.isFinite(v)?v:'Infinity';
    const windows=new Map();values.forEach((v,i)=>{const t=Math.floor(rf[i].t-rf[0].t),w=windows.get(t)||{start:t,first:i,last:i,count:0,sum:0,min:Infinity};w.last=i;w.count++;w.sum+=metric==='psnr'?10**(-v/10):v;w.min=Math.min(w.min,v);windows.set(t,w)});
    const worst=[...windows.values()].map(w=>({start:w.start,first:w.first,last:w.last,count:w.count,min:safe(w.min),value:metric==='psnr'?-10*Math.log10(w.sum/w.count):w.sum/w.count})).sort((a,b)=>a.value-b.value).slice(0,5).map(w=>({...w,value:safe(w.value)}));
    results[metric]={pooled:safe(pooled),p05:safe(p05),min:safe(sorted[0]),values:values.map(safe),worst,raw,model:metric==='vmaf'?'vmaf_v0.6.1':undefined};
  }
  return {reference:r,candidate:c,alignment:aligned,metrics:results,sizeRatio:c.size/r.size,warnings:['指标为逐帧等权统计，非时长加权。','未知色彩标签不证明色彩解释正确。','PSNR / SSIM 评价解码后的编码值，不等同于 HDR 感知质量。','参考文件若本身有损，结果仅表示相对该参考的差异。']};
}
