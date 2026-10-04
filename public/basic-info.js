import { videoFields, propertyValue, summarizeSample } from './properties.js';

// This module only presents the report. It never changes the saved evidence.
const esc = value => String(value ?? '未报告').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const types = {video:'视频',audio:'音频',subtitle:'字幕',attachment:'附件',data:'数据'};
const raw = (value, title) => `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const pairs = rows => `<dl class="property-grid">${rows.map(([key,label,value])=>`<div class="property-pair" data-property="${esc(key)}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
const value = (object, key, kind='text', unit='') => {
  const result = propertyValue(object?.[key], kind, key);
  return result.text + (result.state === 'reported' && unit ? ` ${unit}` : '');
};
const field = (object, key, label, kind='text', unit='') => [key,label,value(object,key,kind,unit)];
const dimensions = (s, x, y) => `${value(s,x,'positive')} × ${value(s,y,'positive')} px`;
const typeName = s => Object.hasOwn(types,s.codec_type) ? types[s.codec_type] : s.codec_type ?? '未知类型';
const trackName = s => `#${s.index} · ${typeName(s)} · ${s.codec_name ?? '编码未报告'}${s.disposition?.attached_pic === 1 ? ' · 附加图像' : ''}${s.disposition?.default === 1 ? ' · 默认' : ''}`;

function componentName(d,c) {
  const n=d.nb_components, index=c.index;
  if (Number.isInteger(n)&&n>=1&&n<=4&&Number.isInteger(index)&&index>=1&&index<=n && d.flags?.hwaccel!==1 && d.flags?.palette!==1) {
    if (d.flags?.alpha===1&&index===n) return 'A';
    if (n>=3&&d.flags?.rgb===1&&index<=3) return ['R','G','B'][index-1];
    if (n>=3&&d.flags?.rgb===0&&index<=3) return ['Y','U','V'][index-1];
    if (n<=2&&d.flags?.rgb===0&&index===1) return 'Y';
  }
  return `分量 ${index ?? '编号未报告'}`;
}
const componentList = d => d?.components?.map(c=>`${componentName(d,c)} ${value(c,'bit_depth','positive','bit')}`).join(' / ') ?? '未报告';
export function componentDepth(descriptor) {
  const components = descriptor?.components;
  if (!components?.length) return '未取得对应像素格式描述';
  const depths = components.map(c=>c.bit_depth);
  if (descriptor.nb_components===components.length && components.every((c,i)=>c.index===i+1) && depths.every(d=>Number.isInteger(d) && d>0) && depths.every(d=>d===depths[0]))
    return `${depths[0]} bit`;
  return componentList(descriptor);
}

function descriptorFor(r, s) {
  return r.pixelFormats?.raw?.pixel_formats?.find(d=>d.name===s.pix_fmt);
}
function sampleFor(r) {
  const hasVideo = r.raw.streams.some(s=>s.codec_type==='video');
  const status = r.frameSampleRead?.status ?? (!hasVideo ? 'not-applicable' : r.frameSample ? 'legacy' : 'unrecorded');
  if (status==='not-requested') return {status,tracks:[],error:null};
  return summarizeSample(r.raw.streams, r.frameSample, status, r.frameSampleRead?.error);
}
function statuses(r) {
  const messages = [];
  if (r.pixelFormats?.status === 'failed') messages.push(`像素格式描述读取失败：${r.pixelFormats.error ?? '原因未保存'}`);
  if (r.frameSampleRead?.status === 'failed') messages.push(`开头样本读取失败：${r.frameSampleRead.error ?? '原因未保存'}`);
  if (!r.frameSampleRead && r.raw.streams.some(s=>s.codec_type==='video'))
    messages.push(r.frameSample ? '旧报告未保存读取状态' : '旧报告未保存抽样结果');
  if (propertyValue(r.size,'integer').state==='reported' && propertyValue(r.raw.format.size,'integer').state==='reported' && Number(r.raw.format.size) !== Number(r.size))
    messages.push(`文件大小来源不同：文件系统 ${r.size} byte；FFprobe ${r.raw.format.size} byte。`);
  return messages.map(message=>`<p class="notice">${esc(message)}</p>`).join('');
}

// Preserve unknown side data without guessing its meaning. Group identical values
// for the selected track; provenance and counts belong to the folded record.
function trackMetadata(r, s) {
  const groups = new Map();
  const add = (item, source) => {
    const key = JSON.stringify(item);
    if (!groups.has(key)) groups.set(key,{name:item.side_data_type ?? '未命名附加数据',value:item,sources:[],count:0});
    const group = groups.get(key); group.count++;
    if (!group.sources.includes(source)) group.sources.push(source);
  };
  for (const item of s.side_data_list ?? []) add(item,'轨道报告');
  for (const frame of r.frameSample?.frames ?? []) if (frame.stream_index===s.index)
    for (const item of frame.side_data_list ?? []) add(item,'开头样本');
  return [...groups.values()];
}
function tagsHTML(tags, excluded=[]) {
  const rows = Object.entries(tags ?? {}).filter(([key])=>!excluded.includes(key));
  return rows.length ? table(['标签','报告值'],rows.map(([key,v])=>[key,typeof v==='object'?JSON.stringify(v):v])) : '';
}
function remainingHTML(object, handled) {
  const rows = Object.entries(object ?? {}).filter(([key])=>!handled.has(key));
  return rows.length ? `<h4>其他报告字段</h4>${table(['字段','原始值'],rows.map(([key,v])=>[key,typeof v==='object'?JSON.stringify(v):v]))}` : '';
}

function pixelDetails(r, s) {
  if (r.pixelFormats?.status === 'failed') return '';
  const d = descriptorFor(r,s);
  if (!d) return '<p class="hint">未取得对应像素格式描述；旧报告可能未保存此信息。</p>';
  const f = d.flags ?? {};
  const layout = f.hwaccel===1 || f.palette===1 ? '硬件 / 调色板格式；详见原始标志' :
    f.planar===1 ? '至少一个分量位于另一平面；不能据此区分平面与半平面' :
    f.planar===0 ? '分量均位于第一平面' : '未报告';
  const chroma = f.rgb===1 ? '不适用（RGB 类布局）' : d.nb_components<3 ? '不适用（少于三个分量）' :
    Number.isInteger(d.log2_chroma_w)&&Number.isInteger(d.log2_chroma_h) ?
      `宽 / ${2**d.log2_chroma_w}，高 / ${2**d.log2_chroma_h}（向上取整；不据此识别分量色彩含义）` : '未报告';
  return `<h4>像素格式解释</h4>${pairs([
    ['components','各分量位深',componentList(d)],
    field(d,'bits_per_pixel','每像素有效位数（不含填充）','positive','bit/pixel'),
    ['chroma-grid','采样网格',chroma],['pixel-layout','布局标志',layout],
    ['alpha','透明通道',f.alpha===1 ? '支持（不证明画面含透明像素）' : f.alpha===0 ? '无透明通道' : '未报告'],
    ['storage','存储宽度 / 步长 / 填充','此工具未报告'],
  ])}<p class="hint">依据当前工具的 ${esc(d.name)} 像素格式描述；与轨道报告有效位数、编码样本位数分别解释。</p>`;
}

function trackHTML(r, s) {
  if (!s) return {main:'<p class="hint">未报告轨道。</p>',extra:''};
  const handled = new Set(['index','codec_type','tags','disposition','side_data_list']);
  let rows;
  if (s.codec_type==='video') {
    rows = [field(s,'codec_name','编码'),['width,height','画面尺寸',dimensions(s,'width','height')],
      field(s,'pix_fmt','像素格式'),['component-depth','分量位深（格式解释）',componentDepth(descriptorFor(r,s))],
      field(s,'avg_frame_rate','平均帧率','rate','帧/s'),
      ['field_order','扫描 / 场序',s.field_order==='progressive' ? '逐行（progressive）' : value(s,'field_order','enum')],
      field(s,'sample_aspect_ratio','SAR（采样宽高比）','ratio'),field(s,'display_aspect_ratio','DAR（工具计算）','ratio'),
      field(s,'color_range','色彩范围','enum')];
  } else if (s.codec_type==='audio') {
    rows = [field(s,'codec_name','编码'),field(s,'sample_rate','采样率','positive','Hz'),field(s,'channels','声道数','integer'),
      field(s,'channel_layout','声道布局'),field(s,'sample_fmt','样本格式'),field(s,'bits_per_sample','报告样本位数','positive','bit/sample'),
      field(s,'bit_rate','轨道报告码率','positive','bit/s')];
  } else {
    rows = [field(s,'codec_name','编码'),['language','语言',value(s.tags,'language')],
      ['filename','名称',value(s.tags,'filename')],['mimetype','媒体类型',value(s.tags,'mimetype')]];
  }
  rows.forEach(([key])=>key.split(',').forEach(k=>handled.add(k)));
  const definitions = s.codec_type==='video' ? videoFields : [
    ['codec_name','编码名称','text'],['codec_tag_string','编码标记','text'],
    ['duration','轨道报告时长','nonnegative','s'],['start_time','轨道报告起点','number','s'],
    ['bit_rate','轨道报告码率','positive','bit/s'],['time_base','时间基','ratio','s/tick']];
  const extras = definitions.filter(([key])=>!handled.has(key)).map(([key,label,kind,unit])=>field(s,key,label,kind,unit));
  definitions.forEach(([key])=>handled.add(key));
  if (!handled.has('language')) extras.push(['language','语言',value(s.tags,'language')]);
  if (s.codec_type==='video') extras.push(['rotate','旋转标签',value(s.tags,'rotate')]);
  const metadata = trackMetadata(r,s);
  const metadataHTML = metadata.length ? `<h4>显示矩阵 / HDR / 其他附加数据</h4>${metadata.map(item=>raw(item.value,item.name)).join('')}` :
    s.codec_type==='video' ? `<p class="hint">轨道报告未提供附加数据；${r.frameSampleRead?.status==='not-requested'?'本次未执行帧级附加数据读取':r.frameSample?'已有开头样本可在原始记录中查看':'当前报告未取得帧级附加数据'}，不能据此认定全片不存在。</p>` : '';
  const disposition = Object.entries(s.disposition ?? {});
  const tags = tagsHTML(s.tags,['language',...(s.codec_type==='video'?['rotate']:[]),...(s.codec_type!=='video'&&s.codec_type!=='audio'?['filename','mimetype']:[])]);
  const extra = `<h4>${esc(trackName(s))} · 详细属性</h4>${pairs(extras)}${s.codec_type==='video' ? pixelDetails(r,s) : ''}` +
    (disposition.length ? `<h4>轨道标志</h4>${table(['标志','报告值'],disposition)}` : '') +
    (tags ? `<h4>轨道标签</h4>${tags}` : '') +
    metadataHTML + remainingHTML(s,handled);
  const sample = sampleFor(r).tracks.find(t=>t.index===s.index);
  const changes = sample ? Object.entries(sample.fields).filter(([key,f])=>f.varies || key in s && f.differsFromTrack).map(([key])=>videoFields.find(f=>f[0]===key)?.[1] ?? key) : [];
  const warning = sample?.status==='empty' ? '<p class="notice">此视频轨道未取得开头样本，无法核对样本属性。</p>' :
    changes.length ? `<p class="notice">开头样本属性存在差异：${esc(changes.join('、'))}。展开“读取核对与原始记录”查看。</p>` : '';
  return {main:`<h4>${esc(trackName(s))}</h4>${pairs(rows)}${warning}`,extra};
}

function evidenceHTML(r) {
  const sample = sampleFor(r);
  const statusText = {ok:'读取完成（仅开头样本）',failed:'读取失败','not-applicable':'不适用（无视频轨道）',legacy:'旧报告未保存读取状态',unrecorded:'旧报告未保存抽样结果'};
  let html = sample.status==='not-requested' ? '<p class="hint">附加数据来自轨道报告；本次未执行帧级附加数据读取。</p>' :
    `<h4>开头样本核对</h4><p>${esc(statusText[sample.status] ?? sample.status)}${sample.error ? `：${esc(sample.error)}` : ''}</p>` +
    `<p class="hint">${esc(r.frameSampleScope ?? '旧报告未保存读取范围')} 样本一致不代表全片一致。</p>`;
  for (const track of sample.tracks) {
    const stream = r.raw.streams.find(s=>s.index===track.index);
    html += `<details><summary>视频 #${track.index} · ${track.count} 个实际样本${track.status==='empty'?'（未取得帧）':''}</summary>` +
      `<p>样本时间戳范围（s）：${esc(track.firstTime ?? '未报告')} 至 ${esc(track.lastTime ?? '未报告')}；缺少时间戳 ${track.missingTimestamps} 帧。</p>` +
      `<p class="hint">${esc(track.timestampBasis)}</p>` + table(['属性','样本值 / 数量','核对结果','原始帧索引'],Object.entries(track.fields).map(([key,f])=>{
        const def = videoFields.find(d=>d[0]===key);
        const comparison = !track.count ? '无样本，无法比较' : `${f.varies?'样本间不同':'样本间未发现差异'}${key in stream ? f.differsFromTrack?'；与轨道报告值不同':'；与轨道报告值相同' : '；轨道未报告此字段'}`;
        return [def?.[1] ?? key,f.values.length ? f.values.map(v=>`${propertyValue(v.value,def?.[2]??'integer',key).text} × ${v.count}`).join('；') : '未取得样本',comparison,f.values.map(v=>v.frameIndices.join(', ')).join('；')];
      })) + '<p class="hint">interlaced_frame：0=逐行标记，1=隔行标记；top_field_first 在逐行样本中不适用。</p></details>';
  }
  const sources = r.raw.streams.flatMap(s=>trackMetadata(r,s).map(item=>[`#${s.index} ${item.name}`,item.sources.join('、'),item.count]));
  if (sources.length) html += `<h4>附加数据来源与次数</h4>${table(['记录','来源','相同记录次数'],sources)}<p class="hint">数据内容归入所属轨道的详细属性；次数仅对应本次读取范围。</p>`;
  const program = r.pixelFormats?.raw?.program_version;
  if (program) html += `<p class="hint">像素格式描述工具：${esc(program.version)}；具体版本、命令及字段保留在原始记录。</p>`;
  html += raw({file:r.file,size:r.size,mtime:r.mtime,tools:r.tools,commands:r.commands,raw:r.raw,pixelFormats:r.pixelFormats,
    frameSampleRead:r.frameSampleRead,frameSampleScope:r.frameSampleScope,frameSample:r.frameSample,metadata:r.metadata},'完整原始探测与复现记录');
  return html;
}

export function basicInfoHTML(r) {
  const streams = r.raw.streams;
  const selected = streams.find(s=>s.index===r.stream) ?? streams.find(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1) ?? streams[0];
  const track = trackHTML(r,selected);
  const f = r.raw.format;
  const counts = new Map(); streams.forEach(s=>counts.set(typeName(s),(counts.get(typeName(s))??0)+1));
  const fileSize = propertyValue(r.size,'integer');
  const main = pairs([
    ['format_name','容器',value(f,'format_name')],['size','文件大小（文件系统）',fileSize.state==='reported' ? `${Number(r.size).toLocaleString('zh-CN')} byte` : fileSize.text],
    field(f,'duration','容器报告时长','nonnegative','s'),['streams','轨道',[...counts].map(([type,count])=>`${count} 路${type}`).join(' · ') || '0'],
    field(f,'bit_rate','容器报告总码率','positive','bit/s'),field(f,'start_time','容器报告起点','number','s')]);
  const fileExtra = pairs([['mtime','文件修改时间',r.mtime ?? '未保存'],['probe-size','文件大小（FFprobe）',value(f,'size','integer','byte')]]);
  const containerOther = remainingHTML(f,new Set(['filename','format_name','size','duration','bit_rate','start_time','tags']));
  const chapters = r.raw.chapters ?? [];
  return `<section class="section basic-info" data-basic-info><h3>文件基本信息</h3><p class="path">${esc(r.file)}</p>${main}${statuses(r)}` +
    `<div class="property-track-picker">${streams.length>1 ? `<label>轨道属性<select data-basic-track aria-label="选择基本属性轨道">${streams.map(s=>`<option value="${s.index}"${s===selected?' selected':''}>${esc(trackName(s))}</option>`).join('')}</select></label>` : ''}</div>` +
    `<div data-track-main aria-live="polite">${track.main}</div>` +
    `<details class="basic-info-extra"><summary>全部属性</summary><div data-track-extra>${track.extra}</div><h4>文件与容器详情</h4>${fileExtra}${containerOther}` +
    (Object.keys(f.tags ?? {}).length ? `<h4>容器标签</h4>${tagsHTML(f.tags)}` : '') +
    (chapters.length ? raw(chapters,`章节 · ${chapters.length} 项`) : '<p class="hint">本次工具未报告章节。</p>') +
    remainingHTML(r.raw,new Set(['format','streams','chapters'])) +
    '<p class="hint">轨道属性来自 FFprobe 解复用、解析与解码器；时长、码率和基础帧率可能包含估计。色彩标签不证明实际色彩正确，基础 / 平均帧率不能判定全片 CFR/VFR，位深不用于推断 HDR。未知字段保留原值。</p></details>' +
    `<details class="basic-info-evidence"><summary>${r.frameSampleRead?.status==='not-requested'?'读取与原始记录':'读取核对与原始记录'}</summary>${evidenceHTML(r)}</details></section>`;
}

export function initBasicInfo(host, r) {
  const root = host.querySelector('[data-basic-info]');
  const picker = root?.querySelector('[data-basic-track]');
  picker?.addEventListener('change',()=>{
    const stream = r.raw.streams.find(s=>String(s.index)===picker.value);
    if (!stream) return;
    const track = trackHTML(r,stream);
    root.querySelector('[data-track-main]').innerHTML = track.main;
    root.querySelector('[data-track-extra]').innerHTML = track.extra;
  });
}
