import {mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {FF,FP,run,probe,video,scan,compare} from './engine.mjs';

const HEVC={0:'TRAIL_N',1:'TRAIL_R',2:'TSA_N',3:'TSA_R',4:'STSA_N',5:'STSA_R',6:'RADL_N',7:'RADL_R',8:'RASL_N',9:'RASL_R',16:'BLA_W_LP',17:'BLA_W_RADL',18:'BLA_N_LP',19:'IDR_W_RADL',20:'IDR_N_LP',21:'CRA_NUT'};
const AV1_TYPES=['KEY','INTER','INTRA_ONLY','SWITCH'];
const num=v=>v==null||v==='N/A'?null:Number(v);
export function distribution(values){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{min:a[0],mean:a.reduce((s,x)=>s+x,0)/a.length,p05:a[Math.floor((a.length-1)*.05)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1),count:a.length}:null}

// All selected streams share the same absolute PTS-based bins, including explicit empty seconds.
export async function allPackets(file,streams,ctx){
  const tracks=new Map(streams.map(s=>[s.index,{index:s.index,codec:s.codec_name,type:s.codec_type,bytes:0,count:0,missing:0,fallbackDts:0,map:new Map(),start:null,end:null}]));
  await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts_time,dts_time,duration_time,size','-of','compact=p=0:nk=0',file],ctx,line=>{
    const o=Object.fromEntries(line.split('|').map(x=>x.split('='))),r=tracks.get(Number(o.stream_index));if(!r||!o.size)return;
    const bytes=Number(o.size);r.bytes+=bytes;r.count++;
    let t=num(o.pts_time);if(t===null){t=num(o.dts_time);r.fallbackDts++}if(!Number.isFinite(t)){r.missing++;return}
    const second=Math.floor(t);r.map.set(second,(r.map.get(second)||0)+bytes);r.start=r.start===null?t:Math.min(t,r.start);r.end=Math.max(r.end??t,t+(num(o.duration_time)||0));
  });
  return [...tracks.values()].map(({map,...r})=>{const keys=[...map.keys()].sort((a,b)=>a-b);if(keys.length&&keys.at(-1)-keys[0]>1000000)throw Error('时间戳跨度异常，无法生成码率图');const bins=[];if(keys.length)for(let s=keys[0];s<=keys.at(-1);s++)bins.push({second:s,mbps:(map.get(s)||0)*8/1e6});return {...r,bins,averageMbps:r.end>r.start?r.bytes*8/(r.end-r.start)/1e6:null,windowStats:distribution(bins.map(b=>b.mbps))}});
}

// AV1 specification § Set frame refs: derive the seven references when short signaling is used.
export function av1ShortRefs(last,gold,order,bits,hints){
  if(!Number.isInteger(bits)||bits<1||hints.some(x=>x==null))return null;
  const half=2**(bits-1),mask=2**bits-1,relative=x=>{const d=(x-order)&mask;return d>=half?d-2**bits:d},shift=hints.map(x=>half+relative(x));
  const refs=Array(7).fill(-1),used=Array(8).fill(false);refs[0]=last;refs[3]=gold;used[last]=used[gold]=true;
  const pick=(back,latest)=>{let best=-1;for(let i=0;i<8;i++){if(used[i]||(shift[i]>=half)!==back)continue;if(best<0||(latest?shift[i]>=shift[best]:shift[i]<shift[best]))best=i}return best};
  for(const [idx,back,latest]of [[6,true,true],[4,true,false],[5,true,false],[1,false,true],[2,false,true],[4,false,true],[5,false,true],[6,false,true]])if(refs[idx]<0){const p=pick(back,latest);if(p>=0){refs[idx]=p;used[p]=true}}
  let earliest=0;for(let i=1;i<8;i++)if(shift[i]<shift[earliest])earliest=i;return refs.map(x=>x<0?earliest:x);
}

export function createTraceParser(codec){
  const packets=[],events=[],sequences=[],warnings=new Set(),slots=Array(8).fill(null);let packet=null,obu=null,seq={},header=false;
  const flushObu=()=>{
    if(!obu)return;
    if(obu.obu_type===1){seq={...obu};if(!sequences.some(s=>JSON.stringify(s)===JSON.stringify(seq)))sequences.push(seq);}
    if(header&&packet&&[3,6,7].includes(obu.obu_type)){
      if(events.length>=750000)throw Error('编码帧事件超过 750,000 上限');
      const redundant=obu.obu_type===7,existing=obu.show_existing_frame===1;
      const shownSlot=existing?slots[obu.frame_to_show_map_idx]:null;
      const ft=obu.frame_type??(seq.reduced_still_picture_header?0:existing?shownSlot?.frameType:null);
      const show=existing?true:obu.show_frame===1||seq.reduced_still_picture_header===1;
      let refresh=obu.refresh_frame_flags;
      if(refresh===undefined&&(ft===3||(ft===0&&show)))refresh=255;
      const e={id:events.length,packet:packet.index,pts:packet.pts,kind:redundant?'REDUNDANT':existing?'SHOW_EXISTING':AV1_TYPES[ft]??'UNKNOWN',frameType:ft,hidden:!show,showExisting:existing,showable:obu.showable_frame??(ft!==0&&show?1:0),orderHint:obu.order_hint??shownSlot?.orderHint??null,temporalId:obu.temporal_id??0,spatialId:obu.spatial_id??0,refreshFlags:refresh??null,showSlot:obu.frame_to_show_map_idx??null,sourceEvent:shownSlot?.id??null,obuType:obu.obu_type,obuPayloadBytes:obu.obu_size??null,fields:{...obu}};
      if(!redundant){
        if(obu.frame_refs_short_signaling===1){e.referenceSlots=av1ShortRefs(obu.last_frame_idx,obu.gold_frame_idx,e.orderHint,(seq.order_hint_bits_minus_1??-1)+1,slots.map(s=>s?.orderHint??null));e.referencesDerived=true;if(!e.referenceSlots)warnings.add('部分 AV1 短信令参考槽缺少前置状态，未推断依赖。')}
        else e.referenceSlots=Array.from({length:7},(_,i)=>obu[`ref_frame_idx[${i}]`]).filter(x=>x!==undefined);
        e.referenceEvents=(e.referenceSlots||[]).map(i=>slots[i]?.id??null);
        if(existing&&!shownSlot)warnings.add('存在 show-existing 引用但前置参考槽不可用。');
        if((obu.spatial_id??0)>0)warnings.add('检测到多空间层；保留全部层头字段，参考槽关系仅供检查，未进行跨层解码依赖验证。');
        // Shown key frames (including show-existing of a stored key) reset all eight slots.
        if(existing){if(ft===0&&shownSlot)slots.fill(shownSlot)}else if(refresh!=null){for(let i=0;i<8;i++)if(refresh&(1<<i))slots[i]=e}
      }
      events.push(e);packet.eventIds.push(e.id);
    }
    obu=null;header=false;
  };
  const flushPacket=()=>{flushObu();if(packet){packet.nalTypes=[...new Set(packet.nalTypes)];packets.push(packet);packet=null}};
  const line=s=>{
    if(!s.includes('trace_headers'))return;const text=s.replace(/^.*?\]\s*/, '');
    if(text.startsWith('Packet:')){flushPacket();const pts=text.match(/\bpts (-?\d+)/)?.[1]??null;packet={index:packets.length,pts,bytes:Number(text.match(/Packet: (\d+)/)?.[1]),nalTypes:[],eventIds:[],firstSlices:0,recovery:null};if(packets.length>=500000)throw Error('压缩包超过 500,000 上限');return}
    if(codec==='av1'&&text==='OBU header'){flushObu();obu={};return}
    if(codec==='av1'&&text==='Frame Header'){header=true;return}
    const m=text.match(/^\d+\s+([\w\[\]]+)\s+.*?=\s*(-?\d+)\s*$/);if(!m)return;const k=m[1],v=Number(m[2]);
    if(codec==='av1'){
      // Keep complete structure-related headers, not per-segment coding-tool arrays.
      if(obu&&(obu.obu_type===1||/^(obu_|temporal_id$|spatial_id$|show_|showable_|frame_type$|frame_to_show_|order_hint$|refresh_frame_flags$|ref_frame_idx|ref_order_hint|frame_refs_short|last_frame_idx$|gold_frame_idx$|error_resilient_mode$|base_q_idx$|frame_width_minus_1$|frame_height_minus_1$|render_width_minus_1$|render_height_minus_1$|primary_ref_frame$|current_frame_id$|display_frame_id$|apply_grain$|grain_seed$|film_grain_params_present$|tile_cols_log2$|tile_rows_log2$|uniform_tile_spacing_flag$|use_superres$|coded_denom$)/.test(k)))obu[k]=v;return;
    }
    if(!packet)return;
    if(k==='nal_unit_type')packet.nalTypes.push(v);
    if(k==='first_slice_segment_in_pic_flag'&&v===1||k==='first_mb_in_slice'&&v===0)packet.firstSlices++;
    if(k==='recovery_frame_cnt'||k==='recovery_poc_cnt')packet.recovery={field:k,value:v};
    if(k==='nuh_temporal_id_plus1')packet.temporalId=v-1;
    if(k==='nal_ref_idc')packet.nalRefIdc=v;
    if(k==='slice_pic_order_cnt_lsb'||k==='pic_order_cnt_lsb')packet.pocLsb=v;
  };
  return {line,finish(){flushPacket();return {codec,packets,events,sequences,warnings:[...warnings],scope:'FFmpeg trace_headers 全流头解析；不解析编码块、运动矢量或变换系数。'}}};
}

export async function structure(file,stream,frames,ctx){
  if(!['h264','hevc','av1'].includes(stream.codec_name))return {supported:false,warnings:['该编码暂不支持码流头解析，保留解码器帧型与关键帧区间。'],gops:buildGops(frames)};
  const parser=createTraceParser(stream.codec_name);
  await run(FF,['-hide_banner','-nostdin','-loglevel','info','-xerror','-copyts','-i',file,'-map',`0:${stream.index}`,'-c','copy','-bsf:v','trace_headers','-f','null','-'],{...ctx,stderrLine:parser.line});
  const result=parser.finish(),byPts=new Map();
  for(const p of result.packets){const arr=byPts.get(p.pts)||[];arr.push(p);byPts.set(p.pts,arr)}
  let matched=0;
  for(const [i,f]of frames.entries()){
    const matches=byPts.get(f.pts);if(matches?.length!==1){f.special='未映射';continue}const p=matches[0];f.packetIndex=p.index;
    if(stream.codec_name==='av1'){
      const shown=p.eventIds.map(id=>result.events[id]).filter(e=>!e.hidden&&e.kind!=='REDUNDANT');
      if(shown.length===1){f.special=shown[0].kind;f.eventId=shown[0].id;shown[0].displayIndex=i;matched++}else f.special='多事件 / 未映射';
    }else{
      const vcl=p.nalTypes.filter(n=>stream.codec_name==='hevc'?n<=31:n>=1&&n<=5);
      if(p.firstSlices>1){f.special='多图像包';continue}
      if(stream.codec_name==='hevc')f.special=vcl.map(n=>HEVC[n]??`NAL_${n}`).join('+')||'未知';
      else f.special=vcl.includes(5)?'IDR':vcl.length?'NON_IDR':'未知';
      if(p.recovery)f.recovery=p.recovery;f.temporalId=p.temporalId??null;matched++;
    }
  }
  result.matchedDisplayFrames=matched;result.displayFrames=frames.length;
  if(matched!==frames.length)result.warnings.push(`${frames.length-matched} 个显示帧无法唯一关联编码包，不猜测特殊帧类型。`);
  result.gops=buildGops(frames);result.supported=true;
  if(stream.codec_name==='av1')result.counts={encoded:result.events.filter(e=>!e.showExisting&&e.kind!=='REDUNDANT').length,hidden:result.events.filter(e=>e.hidden&&e.kind!=='REDUNDANT').length,showExisting:result.events.filter(e=>e.showExisting).length,shown:result.events.filter(e=>!e.hidden&&e.kind!=='REDUNDANT').length};
  return result;
}

export function buildGops(frames){
  const starts=[];frames.forEach((f,i)=>{if(i===0||f.key||/^(IDR|CRA|BLA|KEY)/.test(f.special??''))starts.push(i)});
  return starts.map((start,n)=>{const end=(starts[n+1]??frames.length)-1,segment=frames.slice(start,end+1),f=frames[start];return {index:n,start,end,count:end-start+1,time:f.t,endTime:frames[end].t,label:f.special??(f.key?'KEY_FLAG':'前置片段'),key:f.key,bytes:segment.every(x=>x.bytes!=null)?segment.reduce((s,x)=>s+x.bytes,0):null,types:segment.reduce((o,x)=>(o[x.type]=(o[x.type]||0)+1,o),{}),boundary:starts[n+1]!==undefined?'到下一随机访问/关键帧':'文件末尾，右边界未验证'}});
}

export function metadataSummary(info){
  const map=new Map();const add=(item,where)=>{const key=JSON.stringify(item),r=map.get(key);if(r){r.occurrences++;if(!r.sources.includes(where))r.sources.push(where)}else map.set(key,{name:item.side_data_type??'色彩声明',value:item,sources:[where],occurrences:1})};
  for(const s of info.raw.streams)for(const d of s.side_data_list||[])add(d,`轨道 #${s.index}`);
  for(const f of info.frameSample?.frames||[])for(const d of f.side_data_list||[])add(d,`轨道 #${f.stream_index} 开头抽样`);
  return {items:[...map.values()],scope:info.frameSampleScope,note:'相同附加数据合并并标明来源；只保留元数据证据，不重复列出每帧相同的色彩标签。'};
}

export async function complexity(file,stream,ctx){
  if(!/^yuv(420|422|444)p(10le)?$/.test(stream.pix_fmt))return {available:false,reason:'SI/TI 本版仅分析原生平面 YUV 8/10-bit；不自动转换其他像素格式。'};
  const points=[];let point=null;
  const finish=()=>{if(point&&Number.isFinite(point.si)&&Number.isFinite(point.ti)){points.push(point);if(points.length>500000)throw Error('复杂度帧数超过上限')}point=null};
  await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',file,'-map',`0:${stream.index}`,'-vf','siti,metadata=mode=print:file=-','-an','-fps_mode','passthrough','-f','null','-'],ctx,line=>{let m=line.match(/^frame:(\d+)\s+pts:.*?pts_time:([^\s]+)/);if(m){finish();point={frame:Number(m[1]),t:Number(m[2])};return}m=line.match(/^lavfi.siti.(si|ti)=(.+)/);if(m&&point)point[m[1]]=Number(m[2])});finish();
  if(!points.length)throw Error('SI/TI 未产生可用结果');
  return {available:true,points,si:distribution(points.map(p=>p.si)),ti:distribution(points.slice(1).map(p=>p.ti)),notes:['SI 表示亮度空间细节；TI 表示相邻帧亮度变化（排除首帧 TI=0 的汇总）。','TI 峰值可能来自运动、剪辑、闪光或噪声，不能直接认定为场景切换。','这些是复杂度描述，不是剩余压缩空间或质量评分。只在相同分辨率、帧率、位深、范围和传递函数下对比。','HDR 结果在编码值域计算，不代表感知亮度复杂度。']};
}

export async function trial(input,ctx){
  const info=await probe(input.file,ctx),s=video(info,input.stream),start=Number(input.start),duration=Number(input.duration),encoder=input.encoder;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<1||duration>20)throw Error('实验片段需为 1–20 秒，起点不能为负');
  if(!['libx264','libx265','libaom-av1'].includes(encoder))throw Error('不支持的试编码器');
  if(!['yuv420p','yuv420p10le'].includes(s.pix_fmt))throw Error('试编码首版仅接受原生 4:2:0 8/10-bit，避免隐式采样转换');
  if(s.field_order&&!['unknown','progressive'].includes(s.field_order))throw Error('试编码暂不处理隔行视频');
  const crfs=(input.crfs||[]).map(Number);if(crfs.length<2||crfs.length>4||new Set(crfs).size!==crfs.length||crfs.some(c=>!Number.isInteger(c)||c<0||c>(encoder==='libaom-av1'?63:51)))throw Error('请提供 2–4 个不重复的有效整数 CRF');
  const metrics=input.metrics??['psnr','ssim'];if(metrics.some(m=>!['psnr','ssim','vmaf'].includes(m)))throw Error('试编码指标无效');
  if(metrics.includes('vmaf')&&!(s.color_primaries==='bt709'&&s.color_transfer==='bt709'&&s.color_space==='bt709'))throw Error('此片段不满足 SDR BT.709 VMAF 条件，请取消 VMAF');
  const files=[],reference=path.join(ctx.cwd,'reference.mkv');let retained=false;
  try{
    ctx.update('解码实验片段，写入无损参考');files.push(reference);
    // FFV1 preserves decoded sample values. Limit temporary data by requested duration and available frame count.
    const fpsParts=(s.avg_frame_rate||'0/1').split('/').map(Number),fps=fpsParts[0]/fpsParts[1];
    const estimate=s.width*s.height*(s.pix_fmt==='yuv420p10le'?3:1.5)*(fps||60)*duration;
    if(estimate>8*1024**3)throw Error('所选片段原始像素预算超过 8 GiB，请缩短片段');
    const sourceColor=[];for(const [field,flag]of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range'],['chroma_location','-chroma_sample_location']])if(s[field]&&s[field]!=='unknown')sourceColor.push(flag,s[field]);
    await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-ss',String(start),'-accurate_seek','-i',input.file,'-t',String(duration),'-map',`0:${s.index}`,'-an','-sn','-vf','setpts=PTS-STARTPTS','-c:v','ffv1','-level','3',...sourceColor,'-fps_mode','passthrough',reference],ctx);
    const refInfo=await probe(reference,ctx),refStream=video(refInfo,0),refFrames=await scan(reference,0,ctx);if(refFrames.length<2)throw Error('实验片段没有足够的视频帧');
    const rows=[];
    for(const crf of crfs){
      ctx.update(`试编码 ${encoder} / CRF ${crf}`);const output=path.join(ctx.cwd,`crf-${crf}.mkv`);files.push(output);
      const opts=encoder==='libaom-av1'?['-cpu-used','6','-b:v','0']:['-preset','medium'];
      if(encoder==='libx265')opts.push('-x265-params','log-level=error');
      const color=[];for(const [field,flag]of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range'],['chroma_location','-chroma_sample_location']])if(refStream[field]&&refStream[field]!=='unknown')color.push(flag,refStream[field]);
      const t=performance.now();await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-i',reference,'-map','0:v:0','-an','-c:v',encoder,...opts,'-crf',String(crf),'-pix_fmt',refStream.pix_fmt,...color,'-fps_mode','passthrough',output],ctx);const elapsed=(performance.now()-t)/1000;
      const metricDir=path.join(ctx.cwd,`metrics-crf-${crf}`);await mkdir(metricDir,{recursive:true});
      const comparison=await compare(reference,output,0,0,metrics,{...ctx,cwd:metricDir}),pi=await probe(output,ctx),p=(await allPackets(output,pi.raw.streams,ctx))[0];
      rows.push({crf,encoder,settings:opts,encodeSeconds:elapsed,encodeFps:refFrames.length/elapsed,videoBytes:p.bytes,videoMbps:p.averageMbps,metrics:Object.fromEntries(Object.entries(comparison.metrics).map(([k,m])=>[k,{pooled:m.pooled,p05:m.p05,min:m.min,model:m.model}]))});
    }
    if(input.keepFiles===true)retained=true;
    return {source:info,stream:s.index,experiment:{start,duration,actualFrames:refFrames.length,encoder,preset:encoder==='libaom-av1'?'cpu-used=6':'medium',crfs,retainedFiles:retained?files:[],metrics},rows,warnings:['仅代表这一片段及此编码器/预设/CRF，不外推全片大小，不跨编码器比较 CRF 数值。','无损参考来自源文件的解码像素，并非相机原始信号。','试编码只评价像素质量与视频包体积；不承诺保留 Dolby Vision、HDR10+、字幕或音频。','HDR 只比较编码值域 PSNR/SSIM；未评价动态元数据的观看效果。','编码速度含进程启动与文件 I/O，仅代表本机本次实验。']};
  }finally{if(!retained)for(const f of files)await unlink(f).catch(()=>{});}
}
