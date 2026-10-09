// Official v0 models available without downloading or replacing the media runtime.
// https://github.com/Netflix/vmaf/blob/v3.0.0/resource/doc/models.md
export const vmafModels = {
  'vmaf_v0.6.1': {label:'HDTV · 1080p / 3H',width:1920,height:1080,distanceH:3,enhancementGain:true},
  'vmaf_4k_v0.6.1': {label:'4KTV · 2160p / 1.5H',width:3840,height:2160,distanceH:1.5,enhancementGain:true},
  'vmaf_v0.6.1neg': {label:'NEG 编码器比较 · 1080p / 3H',width:1920,height:1080,distanceH:3,enhancementGain:false},
};
export function vmafModel(version='vmaf_v0.6.1') {
  if(!Object.hasOwn(vmafModels,version))throw Error('VMAF 模型无效；请选择软件列出的官方模型');
  return {version,...vmafModels[version]};
}
export function vmafInputReason(s) {
  // Native formats advertised by the pinned FFmpeg libvmaf filter. Color
  // metadata and model applicability are recorded, never used as a whitelist.
  if(!/^yuv(?:420|422|444)p(?:(?:10|12|16)le)?$/.test(s.pix_fmt??''))return `当前 FFmpeg libvmaf 不接受原生 ${s.pix_fmt??'未知格式'}；支持平面 YUV 420/422/444 的 8/10/12/16-bit，不自动转换。`;
  return null;
}
export const unknownColorValue=value=>value==null||value===''||['unknown','unspecified','reserved','N/A'].includes(value);
export function vmafConfiguration(stream,version,libraryVersion,pairing,conditions={}) {
  const model=vmafModel(version),matchesDisplay=stream.width===model.width&&stream.height===model.height;
  const evaluation={crossDepth:conditions.crossDepth===true,metadataUncertain:conditions.metadataUncertain===true,
    interlaced:conditions.interlaced===true||(!unknownColorValue(stream.field_order)&&stream.field_order!=='progressive')};
  const notes=[`模型观看条件：${model.label}；H 为显示屏高度。尺寸或色彩标签吻合不构成感知适用性验证。`];
  if(!matchesDisplay)notes.push(`当前按 ${stream.width}×${stream.height} 原生栅格计算，未缩放至模型显示分辨率；相对比较也不保证主观质量排序。`);
  const hdr=['smpte2084','arib-std-b67'].includes(stream.color_transfer),sdr=['bt709','gamma22','gamma28','smpte170m','smpte240m','iec61966-2-1','bt2020-10','bt2020-12'].includes(stream.color_transfer);
  if(hdr)notes.push('输入声明为 PQ / HLG HDR；本次记录官方 v0 模型对编码值的输出，未经 HDR 感知适用性验证，不代表 HDR 显示质量。');
  else if(!sdr)notes.push(`输入传递函数为 ${unknownColorValue(stream.color_transfer)?'未声明':stream.color_transfer}；不推断为 SDR、HDR 或相机 Log。模型对该信号的感知适用性未确认，不自动应用 LUT 或显示变换。`);
  if(evaluation.metadataUncertain||[stream.color_range,stream.color_primaries,stream.color_space].some(unknownColorValue))notes.push('输入色彩声明不完整；计算原生样本，不补写标签，不能仅由缺省标签证明两路信号解释一致。');
  if(evaluation.interlaced)notes.push('输入含隔行画面；直接计算解码帧，不去隔行或按场评分，模型的隔行观看适用性未确认。');
  if(evaluation.crossDepth)notes.push('已按显式选择将 8-bit 码值精确乘 4，与 10-bit 样本在同一域计算；包含位深量化与压缩的总差异，不保证主观质量排序。');
  if(pairing==='playback-sample')notes.push('输入经过显式播放采样；分数仅评价记录的采样帧序列，未经帧率转换观看适用性验证，不覆盖未采样画面。');
  const preprocessing=[...(evaluation.crossDepth?['8-bit samples × 4 into 10-bit']:[]),...(pairing==='playback-sample'?['explicit FFmpeg fps playback sampling']:[])].join('; ')||'none';
  return {configurationVersion:2,implementation:'FFmpeg libvmaf',libraryVersion,model,pool:'mean',nSubsample:1,nThreads:2,
    clipping:'official model default',transform:false,pairing,
    input:{width:stream.width,height:stream.height,pixelFormat:stream.pix_fmt,range:stream.color_range??null,primaries:stream.color_primaries??null,transfer:stream.color_transfer??null,matrix:stream.color_space??null,chromaLocation:stream.chroma_location??null,fieldOrder:stream.field_order??null},
    preprocessing,matchesDisplay,evaluation,interpretation:notes.join(' '),
    source:'https://github.com/Netflix/vmaf/blob/v3.0.0/resource/doc/models.md'};
}
export function parseVmafLog(raw,frames) {
  const log=JSON.parse(raw),valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
  if(!Number.isSafeInteger(frames)||frames<1||!log||typeof log.version!=='string'||!log.version||!Array.isArray(log.frames)||log.frames.length!==frames||
    log.frames.some((f,i)=>f?.frameNum!==i||!valid(f.metrics?.vmaf)))throw Error('VMAF 官方日志版本、逐帧索引或分数异常，结果不予采纳');
  const values=log.frames.map(f=>f.metrics.vmaf),summary=log.pooled_metrics?.vmaf;
  if(!summary||!['mean','min','max'].every(k=>valid(summary[k]))||summary.min>summary.mean||summary.mean>summary.max||
    Math.abs(summary.mean-values.reduce((s,v)=>s+v,0)/frames)>0.000002||
    summary.min!==values.reduce((m,v)=>Math.min(m,v),Infinity)||
    summary.max!==values.reduce((m,v)=>Math.max(m,v),-Infinity))throw Error('VMAF 官方汇总与逐帧日志不一致，结果不予采纳');
  return {values,summary,libraryVersion:log.version};
}
