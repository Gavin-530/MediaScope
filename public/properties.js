// Presentation of FFprobe evidence. Never rewrite the input or infer signal semantics.
export const videoFields = [
  ['codec_name','编码名称','text'], ['codec_tag_string','编码标记','text'],
  ['profile','Profile','text'], ['level','原始 Level','level'],
  ['width','画面宽度','positive','px'], ['height','画面高度','positive','px'],
  ['coded_width','编码宽度','positive','px'], ['coded_height','编码高度','positive','px'],
  ['sample_aspect_ratio','SAR（采样宽高比）','ratio'], ['display_aspect_ratio','DAR（FFprobe 计算）','ratio'],
  ['pix_fmt','像素格式','text'], ['bits_per_raw_sample','报告有效位数','positive','bit/sample'],
  ['bits_per_coded_sample','报告编码样本位数','positive','bit/sample'],
  ['color_primaries','色原色','enum'], ['color_transfer','传递函数','enum'],
  ['color_space','矩阵','enum'], ['color_range','范围','enum'], ['chroma_location','色度位置','enum'],
  ['field_order','场序','enum'], ['time_base','时间基','ratio','s/tick'],
  ['r_frame_rate','基础帧率（可能为估计）','rate','帧/s'], ['avg_frame_rate','平均帧率','rate','帧/s'],
  ['nb_frames','报告帧数','integer','帧'], ['duration','报告时长','nonnegative','s'],
  ['start_time','报告起点','number','s'], ['bit_rate','报告码率','positive','bit/s'],
];
const enums = {
  color_primaries:['bt709','bt470m','bt470bg','smpte170m','smpte240m','film','bt2020','smpte428','smpte431','smpte432','ebu3213','vgamut'],
  color_transfer:['bt709','bt470m','bt470bg','smpte170m','smpte240m','linear','log100','log316','iec61966-2-4','bt1361e','iec61966-2-1','bt2020-10','bt2020-12','smpte2084','smpte428','arib-std-b67','vlog'],
  color_space:['gbr','bt709','fcc','bt470bg','smpte170m','smpte240m','ycgco','bt2020nc','bt2020c','smpte2085','chroma-derived-nc','chroma-derived-c','ictcp','ipt-c2','ycgco-re','ycgco-ro'],
  color_range:['tv','pc'], chroma_location:['left','center','topleft','top','bottomleft','bottom'],
  field_order:['progressive','tt','bb','tb','bt'],
};
export function propertyValue(value,kind='text',key='') {
  if(value===undefined||value===null)return {state:'missing',text:'未报告'};
  const text=typeof value==='object'?JSON.stringify(value):String(value);
  if(text==='')return {state:'invalid',text:'无效（空字符串）'};
  if(['unknown','unspecified','N/A'].includes(text))return {state:'unknown',text:`未知（${text}）`};
  if(kind==='enum'&&!enums[key]?.includes(text))return {state:'unknown',text:`未知枚举（${text}）`};
  if(kind==='level'&&Number(value)===-99)return {state:'unknown',text:'未知（-99）'};
  if(['ratio','rate'].includes(kind)) {
    const match=/^(-?\d+)[/:](-?\d+)$/.exec(text);
    if(!match||Number(match[2])<=0||Number(match[1])<0)return {state:'invalid',text:`无效（${text}）`};
    if(Number(match[1])===0)return {state:'unknown',text:`未指定（${text}）`};
  } else if(['positive','nonnegative','number','integer','level'].includes(kind)) {
    if(!/^-?\d+(?:\.\d+)?$/.test(text)||!Number.isFinite(Number(value))||
      (kind==='integer'&&!/^\d+$/.test(text))||(['positive','nonnegative'].includes(kind)&&Number(value)<0))return {state:'invalid',text:`无效（${text}）`};
    if(kind==='positive'&&Number(value)===0)return {state:'unknown',text:`未指定（${text}）`};
  }
  return {state:'reported',text};
}
export const sampleFields = ['width','height','pix_fmt','sample_aspect_ratio','color_primaries','color_transfer','color_space','color_range','chroma_location','interlaced_frame','top_field_first','repeat_pict'];
export function summarizeSample(streams,raw,status='ok',error=null) {
  const frames=raw?.frames??[];
  return {status,error,tracks:streams.filter(s=>s.codec_type==='video').map(s=>{
    const selected=frames.map((frame,i)=>({frame,i})).filter(x=>x.frame.stream_index===s.index);
    const times=selected.map(x=>x.frame.best_effort_timestamp_time??x.frame.pts_time).map(v=>propertyValue(v,'number').state==='reported'?Number(v):null).filter(v=>v!==null);
    return {index:s.index,status:status==='failed'?'failed':selected.length?'ok':'empty',count:selected.length,
      timestampBasis:'best_effort_timestamp_time，缺失时使用 pts_time；范围仅为实际样本时间戳最小/最大值，不是覆盖时长',
      firstTime:times.length?Math.min(...times):null,lastTime:times.length?Math.max(...times):null,missingTimestamps:selected.length-times.length,
      fields:Object.fromEntries(sampleFields.map(key=>{
        const groups=new Map();
        for(const {frame,i} of selected){const value=frame[key],id=JSON.stringify(value)??'missing';if(!groups.has(id))groups.set(id,{...(value===undefined?{}:{value}),count:0,frameIndices:[]});const group=groups.get(id);group.count++;group.frameIndices.push(i)}
        const values=[...groups.values()];
        return [key,{values,varies:values.length>1,differsFromTrack:selected.some(x=>x.frame[key]!==s[key])}];
      }))};
  })};
}
export function pixelDescription(descriptor) {
  if(!descriptor)return {state:'missing',text:'未取得对应像素格式描述'};
  const d=descriptor,f=d.flags??{},parts=[];
  parts.push(`${d.nb_components ?? '?'} 个分量；分量位深 ${d.components?.map(c=>`${c.index}: ${c.bit_depth} bit`).join(' / ')??'未报告'}`);
  parts.push(`每像素有效位数 ${d.bits_per_pixel??'未报告'}（不含填充）`);
  if(f.hwaccel===1||f.palette===1)parts.push('硬件/调色板格式；布局详见原始标志');
  else parts.push(f.planar===1?'至少一个分量位于另一平面（不能据此区分平面与半平面）':f.planar===0?'分量均位于第一平面':'平面标志未报告');
  if(f.rgb===1)parts.push('RGB 类布局；色度采样不适用');
  else if(d.nb_components<3)parts.push('色度采样不适用');
  else if(Number.isInteger(d.log2_chroma_w)&&Number.isInteger(d.log2_chroma_h))parts.push(`工具报告的网格参数：log2_chroma_w=${d.log2_chroma_w}，log2_chroma_h=${d.log2_chroma_h}（宽 / ${2**d.log2_chroma_w}，高 / ${2**d.log2_chroma_h}，向上取整；不据此识别分量色彩含义）`);
  parts.push(f.alpha===1?'支持透明通道（不证明图像含透明像素）':f.alpha===0?'无透明通道':'透明标志未报告');
  parts.push('存储宽度、步长和填充位数：此工具未报告');
  return {state:'derived',text:parts.join('；')};
}
