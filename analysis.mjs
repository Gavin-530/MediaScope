import {measureSiti} from './siti.mjs';
import {createBitrateAccumulator} from './public/bitrate-model.js';
import {createAudioPacketDistribution} from './public/distribution-model.js';
import {byteLimit} from './public/units.js';
import {vmafInputReason,vmafModel,unknownColorValue} from './public/vmaf.js';
import {mkdir,unlink,access} from 'node:fs/promises';
import path from 'node:path';
import {FF,FP,run,probe,video,scan,compare,comparisonProfile,scanSegment,segmentInput,segmentFilter,assertSegmentUnchanged,createComparisonSession,bitDepthPlan,bitDepthReductionFilter,verifyBitDepthReduction} from './engine.mjs';

const HEVC={0:'TRAIL_N',1:'TRAIL_R',2:'TSA_N',3:'TSA_R',4:'STSA_N',5:'STSA_R',6:'RADL_N',7:'RADL_R',8:'RASL_N',9:'RASL_R',16:'BLA_W_LP',17:'BLA_W_RADL',18:'BLA_N_LP',19:'IDR_W_RADL',20:'IDR_N_LP',21:'CRA_NUT'};
const AV1_TYPES=['KEY','INTER','INTRA_ONLY','SWITCH'];
const num=v=>v==null||v==='N/A'?null:Number(v);
export function distribution(values){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{min:a[0],mean:a.reduce((s,x)=>s+x,0)/a.length,p05:a[Math.floor((a.length-1)*.05)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1),count:a.length}:null}

// All selected streams share the same absolute PTS-based bins, including explicit empty seconds.
export async function allPackets(file,streams,ctx){
  const curves=ctx.bitrateWindowMs==null?null:new Map(streams.filter(s=>['video','audio'].includes(s.codec_type)).map(s=>[s.index,createBitrateAccumulator(s.time_base,ctx.bitrateWindowMs)]));
  const audioPackets=ctx.audioPacketDistribution===true?new Map(streams.filter(s=>s.codec_type==='audio').map(s=>[s.index,createAudioPacketDistribution(s.time_base)])):null;
  const tracks=new Map(streams.map(s=>[s.index,{index:s.index,codec:s.codec_name,type:s.codec_type,bytes:0,count:0,missing:0,fallbackDts:0,map:new Map(),start:null,end:null}]));let processed=0;
  await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,duration,pts_time,dts_time,duration_time,size'+(audioPackets?',dts':''),'-of','compact=p=0:nk=0',file],ctx,line=>{
    const o=Object.fromEntries(line.split('|').map(x=>x.split('='))),r=tracks.get(Number(o.stream_index));if(!r)return;
    curves?.get(r.index)?.add(o);
    audioPackets?.get(r.index)?.add(o);
    if(!o.size)return;
    const bytes=Number(o.size);r.bytes+=bytes;r.count++;processed++;
    if(processed===1||processed%500===0)ctx.update?.({detail:`已统计 ${processed.toLocaleString()} 个压缩包`,completed:processed,total:null,unit:'个压缩包'});
    let t=num(o.pts_time);if(t===null){t=num(o.dts_time);r.fallbackDts++}if(!Number.isFinite(t)){r.missing++;return}
    const second=Math.floor(t);r.map.set(second,(r.map.get(second)||0)+bytes);r.start=r.start===null?t:Math.min(t,r.start);r.end=Math.max(r.end??t,t+(num(o.duration_time)||0));
  });
  ctx.update?.({detail:`已统计 ${processed.toLocaleString()} 个压缩包`,completed:processed,total:processed,unit:'个压缩包'});
  return [...tracks.values()].map(({map,...r})=>{const keys=[...map.keys()].sort((a,b)=>a-b);if(keys.length&&keys.at(-1)-keys[0]>1000000)throw Error('时间戳跨度异常，无法生成码率图');const bins=[];if(keys.length)for(let s=keys[0];s<=keys.at(-1);s++)bins.push({second:s,mbps:(map.get(s)||0)*8/1e6});return {...r,bins,...(curves?.has(r.index)?{bitrateCurve:curves.get(r.index).finish()}:{}),...(audioPackets?.has(r.index)?{packetDistribution:audioPackets.get(r.index).finish()}:{}),averageMbps:r.end>r.start?r.bytes*8/(r.end-r.start)/1e6:null,windowStats:distribution(bins.map(b=>b.mbps))}});
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

export async function traceStructure(file,stream,ctx){
  if(!['h264','hevc','av1'].includes(stream.codec_name))return {supported:false,warnings:['该编码暂不支持码流头解析，保留解码器帧型与关键帧区间。']};
  const parser=createTraceParser(stream.codec_name);let packets=0;
  await run(FF,['-hide_banner','-nostdin','-loglevel','info','-xerror','-copyts','-i',file,'-map',`0:${stream.index}`,'-c','copy','-bsf:v','trace_headers','-f','null','-'],{...ctx,stderrLine:line=>{parser.line(line);if(line.includes('trace_headers')&&line.replace(/^.*?\]\s*/, '').startsWith('Packet:')){packets++;if(packets===1||packets%250===0)ctx.update?.({detail:`已解析 ${packets.toLocaleString()} 个视频包头`,completed:packets,total:null,unit:'个视频包头'})}}});
  const result=parser.finish();ctx.update?.({detail:`已解析 ${packets.toLocaleString()} 个视频包头`,completed:packets,total:packets,unit:'个视频包头'});return result;
}

export function mapStructure(result,stream,frames){
  if(result.supported===false)return {...result,gops:buildGops(frames)};
  const byPts=new Map();
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

export async function structure(file,stream,frames,ctx){return mapStructure(await traceStructure(file,stream,ctx),stream,frames)}

export function buildGops(frames){
  const starts=[];frames.forEach((f,i)=>{if(i===0||f.key||/^(IDR|CRA|BLA|KEY)/.test(f.special??''))starts.push(i)});
  return starts.map((start,n)=>{const end=(starts[n+1]??frames.length)-1,segment=frames.slice(start,end+1),f=frames[start];return {index:n,start,end,count:end-start+1,time:f.t,endTime:frames[end].t,label:f.special??(f.key?'KEY_FLAG':'前置片段'),key:f.key,bytes:segment.every(x=>x.bytes!=null)?segment.reduce((s,x)=>s+x.bytes,0):null,types:segment.reduce((o,x)=>(o[x.type]=(o[x.type]||0)+1,o),{}),boundary:starts[n+1]!==undefined?'到下一随机访问/关键帧':'文件末尾，右边界未验证'}});
}

export function metadataSummary(info){
  const map=new Map();const add=(item,where)=>{const key=JSON.stringify(item),r=map.get(key);if(r){r.occurrences++;if(!r.sources.includes(where))r.sources.push(where)}else map.set(key,{name:item.side_data_type??'色彩声明',value:item,sources:[where],occurrences:1})};
  for(const s of info.raw.streams)for(const d of s.side_data_list||[])add(d,`轨道 #${s.index}`);
  for(const f of info.frameSample?.frames||[])for(const d of f.side_data_list||[])add(d,`轨道 #${f.stream_index} 开头抽样`);
  return {items:[...map.values()],scope:info.frameSampleScope??'附加数据来自轨道报告；本次未执行帧级附加数据读取。',note:'相同附加数据合并并标明来源；只保留元数据证据，不重复列出每帧相同的色彩标签。'};
}

export async function complexity(file,stream,ctx={},frames=null){
  if(!/^yuv(420|422|444)p(10le)?$/.test(stream.pix_fmt))return {available:false,reason:'SI/TI 本版仅分析原生平面 YUV 8/10-bit；不自动转换其他像素格式。'};
  const {points,execution}=await measureSiti(file,stream,ctx,frames);
  if(!points.length)throw Error('SI/TI 未产生可用结果');
  return {available:true,points,execution,si:distribution(points.map(p=>p.si)),ti:distribution(points.slice(1).map(p=>p.ti)),notes:['SI 表示亮度空间细节；TI 表示相邻帧亮度变化（排除首帧 TI=0 的汇总）。','TI 峰值可能来自运动、剪辑、闪光或噪声，不能直接认定为场景切换。','这些是复杂度描述，不是剩余压缩空间或质量评分。只在相同分辨率、帧率、位深、范围和传递函数下对比。','HDR 结果在编码值域计算，不代表感知亮度复杂度。']};
}

export function trialOptions(input){
  const encoder=input.encoder;
  if(!['libx264','libx265','libaom-av1'].includes(encoder))throw Error('不支持的试编码器');
  const presetNames=['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow','placebo'];
  const depthMode=input.depthMode??'native';if(!['native','both'].includes(depthMode))throw Error('实验位深模式无效');
  if(!Array.isArray(input.crfs))throw Error('CRF 必须为数组');
  const crfs=input.crfs.map(Number);
  if(crfs.length<1||crfs.length>12||new Set(crfs).size!==crfs.length||crfs.some(c=>!Number.isFinite(c)||c<0||c>(encoder==='libaom-av1'?63:51)||(encoder==='libaom-av1'&&!Number.isInteger(c))))throw Error('请提供 1–12 个不重复的有效 CRF；x264/x265 为 0–51，可用小数，AV1 为 0–63 整数');
  const cpuUsed=input.cpuUsed??6;if(!Number.isInteger(cpuUsed)||cpuUsed<0||cpuUsed>8)throw Error('AV1 cpu-used 需为 0–8 整数');
  const presets=encoder==='libaom-av1'?[`cpu-used=${cpuUsed}`]:(input.presets??['medium']);
  if(!Array.isArray(presets)||presets.length<1||presets.length>4||new Set(presets).size!==presets.length||(encoder!=='libaom-av1'&&presets.some(p=>!presetNames.includes(p))))throw Error('请选择 1–4 个不重复的 preset');
  const points=crfs.length*presets.length*(depthMode==='both'?2:1);if(points>64)throw Error('单次实验最多 64 个编码点，请减少 CRF 或 preset');
  const metrics=input.metrics??['psnr','ssim'];if(!Array.isArray(metrics)||!metrics.length||metrics.some(m=>!['psnr','ssim','vmaf'].includes(m)))throw Error('试编码指标无效');
  const model=metrics.includes('vmaf')?vmafModel(input.vmafModel).version:undefined;
  return {encoder,depthMode,crfs,presets,cpuUsed,points,vmafModel:model,metrics,skippedMetrics:{}};
}
export async function trial(input,ctx){
  const options=trialOptions(input),{crfs,presets,cpuUsed,depthMode,metrics}=options;
  const phaseCount=ctx.trialPhaseCount??options.points+2;
  ctx.update?.({stage:'准备实验参考片段',detail:'读取源文件参数',phaseIndex:1,phaseCount,completed:0,total:null,unit:'帧'});
  const info=await probe(input.file,ctx),s=video(info,input.stream),start=Number(input.start),duration=Number(input.duration),encoder=input.encoder;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<1||duration>20)throw Error('实验片段需为 1–20 秒，起点不能为负');
  if(!['libx264','libx265','libaom-av1'].includes(encoder))throw Error('不支持的试编码器');
  const profile=comparisonProfile(s,info.pixelFormats);
  if(s.field_order&&!['unknown','progressive'].includes(s.field_order))throw Error('试编码暂不处理隔行视频');
  if(depthMode==='both'){
    if(!['yuv420p','yuv420p10le'].includes(s.pix_fmt))throw Error('8/10-bit 对照仅支持原生 420 8/10-bit；其他已支持格式请使用保持源位深');
    bitDepthPlan({...s,pix_fmt:'yuv420p'},{...s,pix_fmt:'yuv420p10le'},'bt709-limited-8-10');
  }
  if(metrics.every(m=>m==='vmaf')&&vmafInputReason(s))throw Error(vmafInputReason(s));
  const help=await run(FF,['-hide_banner','-h',`encoder=${encoder}`],ctx),formats=/Supported pixel formats:\s*([^\r\n]+)/.exec(help)?.[1].trim().split(/\s+/);
  const requestedFormats=depthMode==='both'?['yuv420p','yuv420p10le']:[s.pix_fmt];
  for(const pix of requestedFormats)if(!formats?.includes(pix))throw Error(`当前 ${encoder} 不支持原生 ${pix}；拒绝自动转换采样或位深，请选择支持该格式的编码器`);
  const files=[],reference=path.join(ctx.cwd,'reference.mkv');let retained=false;
  ctx={...ctx,vmafModel:options.vmafModel,comparisonSession:createComparisonSession([reference,path.join(ctx.cwd,'input-8bit.mkv'),path.join(ctx.cwd,'input-10bit.mkv')])};
  const register=async file=>{try{await access(file);throw Error('实验目标文件已存在，拒绝覆盖或清理：'+file)}catch(e){if(e.code!=='ENOENT')throw e}files.push(file)};
  try{
    ctx.update({stage:'准备实验参考片段',detail:'直接解码并核验源片段，不创建原生参考缓存',phaseIndex:1,phaseCount,completed:0,total:null,unit:'帧'});
    const segment=await scanSegment(info,s.index,start,duration,ctx);
    const sourceColor=[];for(const [field,flag]of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range'],['chroma_location','-chroma_sample_location']])if(!unknownColorValue(s[field]))sourceColor.push(flag,s[field]);
    const nativeDepth=profile.bitDepth;
    let refStream=s,refFrames=segment.frames;
    const inputs={[nativeDepth]:info.file},depths=depthMode==='both'?[8,10]:[nativeDepth],preparation={sourceDepth:nativeDepth,sourcePixelFormat:s.pix_fmt,reference:depthMode==='both'?'verified-lossless-inputs':'source-segment',selection:{start,duration,inputSeek:'accurate',interval:'[start, start + duration)',timestampOrigin:'first selected frame',timeBase:segment.timeBase,frames:segment.frames.length}};
    if(depthMode==='both'){
      // Preserve the existing explicit depth-conversion experiment. Its cache
      // is verified against the actual source segment, never against itself.
      const fpsParts=(s.avg_frame_rate||'0/1').split('/').map(Number),fps=fpsParts[0]/fpsParts[1];
      if(s.width*s.height*4.5*(fps||60)*duration>8*1024**3)throw Error(`所选片段原始像素预算超过 ${byteLimit(8*1024**3)}，请缩短片段`);
      await register(reference);
      await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters',...segmentInput(info.file,segment),'-map',`0:${s.index}`,'-an','-sn','-vf',segmentFilter(segment)+'null','-c:v','ffv1','-level','3','-pix_fmt','+'+s.pix_fmt,...sourceColor,'-enc_time_base','filter','-fps_mode','passthrough',reference],ctx);
      const proofDir=path.join(ctx.cwd,'metrics-source-reference');await mkdir(proofDir,{recursive:true});
      const proof=await compare(info.file,reference,s.index,0,['psnr'],{...ctx,cwd:proofDir,referenceSegment:segment});
      if(proof.metrics.psnr.values.some(v=>v!=='Infinity')||Object.values(proof.metrics.psnr.components).some(v=>v!=='Infinity'))throw Error('FFV1 参考与源片段的 Y/U/V 解码像素不完全一致');
      preparation.sourceVerification={passed:true,frames:proof.alignment.frames,alignment:proof.alignment,psnr:proof.metrics.psnr};
      refStream=video(proof.candidate,0);refFrames=await scan(reference,0,{...ctx,comparisonStream:refStream,requireProgressive:true});inputs[nativeDepth]=reference;
    }
    ctx.update({stage:'准备并验证比较域',detail:depthMode==='both'?'准备另一位深的无损输入':'保持源文件原生位深',phaseIndex:2,phaseCount,completed:depthMode==='both'?0:1,total:1,unit:'项准备'});
    if(depthMode==='both'){
      const otherDepth=nativeDepth===8?10:8,otherStream={...refStream,pix_fmt:otherDepth===8?'yuv420p':'yuv420p10le'};
      const other=path.join(ctx.cwd,`input-${otherDepth}bit.mkv`);await register(other);
      let filter;
      if(nativeDepth===8)filter=bitDepthPlan(refStream,otherStream,'bt709-limited-8-10').referenceFilter+'null';
      else{preparation.reductionCheck=await verifyBitDepthReduction(refStream,ctx);filter=bitDepthReductionFilter(refStream);}
      ctx.update({stage:'准备并验证比较域',detail:`准备 ${otherDepth}-bit 无损编码输入`,phaseIndex:2,phaseCount,completed:0,total:1,unit:'项准备'});
      await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-i',reference,'-map','0:v:0','-vf',filter,'-c:v','ffv1','-level','3','-pix_fmt',otherStream.pix_fmt,...sourceColor,'-fps_mode','passthrough',other],ctx);
      inputs[otherDepth]=other;
      const preDir=path.join(ctx.cwd,'metrics-preparation');await mkdir(preDir,{recursive:true});
      const baseline=await compare(inputs[10],inputs[8],0,0,['psnr','ssim'],{...ctx,cwd:preDir},'bt709-limited-8-10');
      if(nativeDepth===8&&baseline.metrics.psnr.pooled!=='Infinity')throw Error('8→10-bit 输入准备未保持精确码值映射');
      preparation.mapping=nativeDepth===8?'code10 = code8 × 4（不增加源精度）':'code8 = floor(code10 / 4)（固定截断，无抖动；实验选择，不是唯一标准量化方法）';
      preparation.baseline=baseline.metrics;preparation.normalization=baseline.normalization;
    }
    ctx.update({stage:'准备并验证比较域',detail:'实验输入与比较域已验证',phaseIndex:2,phaseCount,completed:1,total:1,unit:'项准备'});
    const qualityReference=depthMode==='both'?inputs[10]:info.file;
    const rows=[];
    for(const preset of presets)for(const crf of crfs)for(const depth of depths){
      const id=`${depth}bit-${preset.replace('=','-')}-crf-${crf}`;
      const point=rows.length+1,stage=`编码点 ${point} / ${options.points}`;
      ctx.update({stage,detail:`编码 ${encoder} / ${depth}-bit / ${preset} / CRF ${crf}`,phaseIndex:point+2,phaseCount,completed:0,total:refFrames.length,unit:'帧'});const output=path.join(ctx.cwd,id+'.mkv');await register(output);
      const opts=encoder==='libaom-av1'?['-cpu-used',String(cpuUsed),'-b:v','0']:['-preset',preset];
      if(encoder==='libx265')opts.push('-x265-params','log-level=error');
      const color=[];for(const [field,flag]of [['color_primaries','-color_primaries'],['color_transfer','-color_trc'],['color_space','-colorspace'],['color_range','-color_range'],['chroma_location','-chroma_sample_location']])if(!unknownColorValue(refStream[field]))color.push(flag,refStream[field]);
      const pix=depthMode==='both'?(depth===8?'yuv420p':'yuv420p10le'):s.pix_fmt;
      await assertSegmentUnchanged(segment);
      const native=depthMode==='native',encodingInput=native?segmentInput(info.file,segment):['-noautorotate','-i',inputs[depth]];
      const t=performance.now();await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters',...encodingInput,'-map',native?`0:${s.index}`:'0:v:0','-an','-sn',...(native?['-vf',segmentFilter(segment)+'null']:[]),'-c:v',encoder,...opts,'-crf',String(crf),'-pix_fmt','+'+pix,...color,'-enc_time_base','filter','-fps_mode','passthrough','-progress','pipe:1','-stats_period','0.25',output],ctx,line=>{const count=Number(line.match(/^frame=(\d+)/)?.[1]);if(Number.isFinite(count))ctx.update?.({stage,detail:`编码 ${encoder} / ${depth}-bit / ${preset} / CRF ${crf}`,phaseIndex:point+2,phaseCount,completed:Math.min(count,refFrames.length),total:refFrames.length,unit:'帧'})});const elapsed=(performance.now()-t)/1000;
      await assertSegmentUnchanged(segment);
      const metricDir=path.join(ctx.cwd,'metrics-'+id);await mkdir(metricDir,{recursive:true});
      ctx.update({stage,detail:`核验并测量编码点 ${point} / ${options.points}`,phaseIndex:point+2,phaseCount,completed:0,total:refFrames.length,unit:'帧'});
      const comparison=await compare(qualityReference,output,native?s.index:0,0,metrics,{...ctx,cwd:metricDir,referenceSegment:native?segment:undefined,expectedCandidatePixelFormat:pix},depthMode==='both'?'bt709-limited-8-10':'native'),p=(await allPackets(output,comparison.candidate.raw.streams,ctx))[0];
      rows.push({id,crf,encoder,preset,bitDepth:depth,pixelFormat:pix,settings:opts,encodeSeconds:elapsed,encodeFps:refFrames.length/elapsed,videoBytes:p.bytes,videoMbps:p.averageMbps,metrics:comparison.metrics,alignment:comparison.alignment,normalization:comparison.normalization,skippedMetrics:comparison.skippedMetrics,warnings:comparison.warnings});
      ctx.update({stage,detail:`编码点 ${point} / ${options.points} 已完成`,phaseIndex:point+2,phaseCount,completed:1,total:1,unit:'个编码点'});
    }
    if(input.keepFiles===true)retained=true;
    return {source:info,stream:s.index,experiment:{start,duration,actualFrames:refFrames.length,frameTimes:refFrames.map(f=>f.t-refFrames[0].t),encoder,preset:presets.join(', '),presets,crfs,depthMode,depths,points:options.points,preparation,comparisonDomain:depthMode==='both'?'全部结果相对于同一 10-bit 无损参考；PSNR 峰值 1023，8-bit 输出精确乘 4 后测量总差异。':'源文件片段的原生格式参考；直接比较，不创建 FFV1 缓存',retainedFiles:retained?files:[],metrics},skippedMetrics:options.skippedMetrics,rows,warnings:[...new Set(rows.flatMap(row=>row.warnings??[])),'仅代表这一片段及此编码器/预设/CRF，不外推全片大小；相同 CRF 不保证不同位深/预设具有相同质量或码率。',depthMode==='both'?'位深转换前的 FFV1 参考已逐帧核验与源片段的 Y/U/V 像素一致；后续位深转换单独记录，参考并非相机原始信号。':'参考直接来自源文件选中片段的解码像素；无中间参考视频，不代表相机原始信号。',...(depthMode==='both'?['8/10-bit 对照保持采样、色彩标签、分辨率、帧序和所选 preset 相同；编码器内部算法可能随位深改变。','总差异包含位深量化与编码的共同影响；基准分数不能与成片分数直接相减。','8-bit 源升至 10-bit 不会恢复原有精度。SSIM 日志舍入可能掩盖微小误差，需结合 PSNR。']:[]),'试编码只评价像素质量与视频包体积；不承诺保留 Dolby Vision、HDR10+、字幕或音频。','HDR 的指标按编码值计算；VMAF 模型输出不代表已验证的 HDR 感知质量，未评价动态元数据的观看效果。',depthMode==='native'?'编码耗时包含源文件定位、解码、编码、进程启动与文件 I/O；不含前置核验和质量测量。各点顺序运行且只测一次，会受负载、缓存和温度影响，不能据此推断稳定速度优势。':'编码耗时不含无损输入准备和质量测量，包含输入解码、编码、进程启动与文件 I/O；与直接读取源片段的耗时口径不同。各点顺序运行且只测一次，会受负载、缓存和温度影响，不能据此推断稳定速度优势。']};
  }finally{if(!retained)for(const f of files)await unlink(f).catch(()=>{});}
}
