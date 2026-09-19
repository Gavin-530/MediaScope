import {plot,gopOverview} from './charts.js';
const $=s=>document.querySelector(s),token=$('meta[name=token]').content;
let current=null,report=null,infoPath=null,hasVideo=false,charts=[];
const esc=v=>String(v??'未报告').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=3)=>typeof v==='number'?v.toLocaleString('zh-CN',{maximumFractionDigits:d}):v??'未报告';
const size=v=>v==null?'未报告':v>=1073741824?`${fmt(v/1073741824)} GiB`:v>=1048576?`${fmt(v/1048576)} MiB`:v>=1024?`${fmt(v/1024)} KiB`:`${v} B`;
const clean=v=>v.trim().replace(/^"|"$/g,'');
async function api(url,options={}){const r=await fetch('/api/'+url,{...options,headers:{'Content-Type':'application/json','X-MediaScope-Token':token}}),d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d}
function message(text,error=false){$('#task').classList.remove('hidden');$('#task').classList.toggle('error',error);$('#task-label').textContent=error?'任务未完成':'分析任务';$('#task-message').textContent=text;$('#cancel').classList.toggle('hidden',!current)}
function busy(value){for(const id of ['inspect','analyze','compare','trial'])$('#'+id).disabled=value||(id==='analyze'&&(!infoPath||!hasVideo));$('#import-report').disabled=value}
async function launch(data){try{busy(true);current=(await api('jobs',{method:'POST',body:JSON.stringify(data)})).id;message('任务已开始');poll()}catch(e){message(e.message,true);busy(false)}}
async function poll(){try{const j=await api('jobs/'+current);message(j.message,j.status==='error');if(j.status==='running'){setTimeout(poll,900);return}const id=current;current=null;busy(false);$('#cancel').classList.add('hidden');if(j.status==='done'){report=await api('jobs/'+id+'/report');render(report)}}catch(e){current=null;busy(false);message(e.message,true)}}
$('#cancel').onclick=async()=>{try{await api('jobs/'+current,{method:'DELETE'})}catch(e){message(e.message,true)}};
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('selected',t===b));for(const mode of ['inspect','compare','trial'])$('#'+mode+'-panel').classList.toggle('hidden',b.dataset.mode!==mode)});
$('#file').oninput=()=>{infoPath=null;$('#analyze').disabled=true};
$('#inspect').onclick=()=>launch({type:'inspect',file:clean($('#file').value)});
$('#analyze').onclick=()=>launch({type:'analyze',file:infoPath,stream:Number($('#stream').value),complexity:$('#complexity').checked});
$('#compare').onclick=()=>launch({type:'compare',reference:clean($('#reference').value),candidate:clean($('#candidate').value),refStream:Number($('#refStream').value),candidateStream:Number($('#candidateStream').value),metrics:[...document.querySelectorAll('[name=metric]:checked')].map(x=>x.value),confirm:$('#confirm').checked});
$('#trial').onclick=()=>launch({type:'trial',file:clean($('#trial-file').value),stream:Number($('#trial-stream').value),start:Number($('#trial-start').value),duration:Number($('#trial-duration').value),encoder:$('#trial-encoder').value,crfs:$('#trial-crfs').value.split(/[,，\s]+/).filter(Boolean).map(Number),metrics:$('#trial-vmaf').checked?['psnr','ssim','vmaf']:['psnr','ssim'],keepFiles:$('#trial-keep').checked});
$('#export').onclick=()=>download(JSON.stringify(report,null,2),'MediaScope-'+report.type+'.json','application/json');
$('#import-report').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>256*1024*1024)throw Error('报告超过 256 MiB 导入上限');const data=JSON.parse(await f.text());if(!String(data.schema).startsWith('MediaScope/')||!['inspect','analyze','compare','trial'].includes(data.type))throw Error('不是有效的 MediaScope 报告');report=data;render(report);message('已打开保存的报告（没有重新分析原文件）')}catch(err){message(err.message,true)}e.target.value=''};
function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function cards(items){$('#summary').innerHTML=items.map(([k,v])=>`<div class="card"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}
function section(title,html){return `<section class="section"><h3>${esc(title)}</h3>${html}</section>`}
function table(headers,rows){return `<div class="table-wrap"><table><thead><tr>${headers.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
function raw(data,title='展开证据 / 原始数据'){return `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`}
function notices(items){return (items||[]).map(w=>`<p class="notice">${esc(w)}</p>`).join('')}
function draw(id,data,options){const host=$('#'+id);if(host){const p=plot(host,data,options);if(p)charts.push(p);return p}}
function render(r){charts.forEach(c=>c.dispose?.());charts=[];$('#result').classList.remove('hidden');$('#result-title').textContent=r.type==='compare'?'质量对比报告':r.type==='trial'?'片段率失真实验':'媒体分析报告';if(r.type==='compare')return renderComparison(r);if(r.type==='trial')return renderTrial(r);renderMedia(r)}
function metadataHTML(r){
  const data=r.metadata;if(!data)return raw({frameSample:r.frameSample,scope:r.frameSampleScope},'旧版报告附加数据（重新分析可获得去重摘要）');
  return `<p class="hint">${esc(data.note)} ${esc(data.scope)}</p>`+(data.items.length?data.items.map(item=>`<div class="evidence"><strong>${esc(item.name)}</strong><span>${esc(item.sources.join('、'))} · ${item.occurrences} 次相同记录</span>${raw(item.value,'查看此项数据')}</div>`).join(''):'<p class="hint">本次探测范围未报告附加数据；不能据此认定全片不存在。</p>');
}
function renderMedia(r){
  const streams=r.raw.streams,videos=streams.filter(s=>s.codec_type==='video');infoPath=r.file;hasVideo=!!videos.length;$('#file').value=r.file;
  $('#stream').innerHTML=videos.map(s=>`<option value="${s.index}">${s.index} · ${esc(s.codec_name)} · ${s.width} × ${s.height}</option>`).join('');if(r.stream!==undefined)$('#stream').value=r.stream;$('#analyze').disabled=!hasVideo;
  $('#trial-file').value=r.file;$('#trial-stream').value=r.stream??videos[0]?.index??0;
  cards([['文件大小',size(r.size)],['容器时长',r.raw.format.duration?`${fmt(Number(r.raw.format.duration))} s`:'未报告'],['轨道数',streams.length],['容器',r.raw.format.format_name]]);
  let html=`<p class="path">${esc(r.file)}</p>`;
  html+=section('轨道清单',table(['索引 / 类型','编码 / 标记','视频 / 音频属性','时长 / 起始秒','语言 / 默认'],streams.map(s=>[`${s.index} / ${s.codec_type}`,`${s.codec_name??'?'} / ${s.codec_tag_string??'?'}`,s.codec_type==='video'?`${s.width}×${s.height} · ${s.pix_fmt} · fps ${s.avg_frame_rate}`:s.codec_type==='audio'?`${s.sample_rate} Hz · ${s.channels} ch · ${s.channel_layout??'布局未报告'} · ${s.sample_fmt}`:'详见原始数据',`${s.duration??'?'} / ${s.start_time??'?'}`,`${s.tags?.language??'未标记'} / ${s.disposition?.default?'是':'否'}`])));
  for(const s of videos)html+=section(`视频 #${s.index} · 色彩与编码声明`,table(['属性','文件报告值'],[['Profile / 原始 Level 值',`${s.profile??'?'} / ${s.level??'?'}`],['像素格式 / 有效位深',`${s.pix_fmt??'?'} / ${s.bits_per_raw_sample??'参考像素格式'}`],['色原色 / 传递函数',`${s.color_primaries??'未报告'} / ${s.color_transfer??'未报告'}`],['矩阵 / 范围 / 色度位置',`${s.color_space??'未报告'} / ${s.color_range??'未报告'} / ${s.chroma_location??'未报告'}`],['时间基 / 声明帧率 / 平均帧率',`${s.time_base} / ${s.r_frame_rate} / ${s.avg_frame_rate}`]])+`<p class="hint">以上为声明值，不能证实实际画面色彩正确。附加数据已统一去重，见“元数据证据”。</p>`);
  if(r.frames){
    const gops=r.coding?.gops||legacyGops(r.frames);cards([['显示帧数',r.frames.length],['视频包数据量',size(r.packets.bytes)],['GOP / 关键帧区间',gops.length],['非递增时间戳',r.summary.nonIncreasing]]);
    html+=section('帧结构与 GOP',`<p class="hint">显示顺序视图。I / P / B 是预测类型；IDR / CRA / BLA 是码流访问类型，二者不混用。GOP 以随机访问/关键帧区间呈现，不据此猜测开放或闭合。</p><div id="gop-overview"></div><div class="pager"><button id="gop-prev" class="secondary">上一 GOP</button><label>GOP #<input id="gop-index" type="number" min="0" max="${gops.length-1}" value="0"></label><button id="gop-next" class="secondary">下一 GOP</button><span id="gop-info"></span></div><div id="frame-plot"></div><div id="frame-detail" class="frame-detail"></div><details><summary>逐帧列表 / CSV</summary><div class="pager"><button id="prev" class="secondary">上一页</button><span id="page"></span><button id="next" class="secondary">下一页</button><button id="csv" class="secondary">导出帧 CSV</button></div><div id="frames"></div></details>`);
    if(r.coding?.codec==='av1')html+=section('AV1 编码帧 / 显示事件',`<p>新编码帧 ${r.coding.counts.encoded} · 隐藏帧 ${r.coding.counts.hidden} · SHOW_EXISTING ${r.coding.counts.showExisting} · 显示事件 ${r.coding.counts.shown}</p><p class="hint">按码流编码顺序列出所有帧头事件，包含 KEY / INTER / INTRA_ONLY / SWITCH、隐藏帧和 SHOW_EXISTING。H=隐藏、S=显示已有帧、V=新帧直接显示。点击色带查看结构字段、刷新掩码与参考槽。OBU 负载字节不一定等于完整图像大小。</p><div id="av1-plot"></div><label>编码事件 #<input id="av1-index" type="number" min="0" max="${r.coding.events.length-1}" value="0"></label><div id="av1-detail"></div>${raw(r.coding.sequences,'AV1 序列头（去重）')}`);
    html+=section('视频码率 · 1 秒窗口',`<div id="bitrate"></div><p class="hint">平均 ${fmt(r.packets.averageMbps)} Mbps · 缺少时间戳 ${r.packets.missing} 包。放大显示不会将 1 秒窗口改成更细的测量。</p>`);
    const audio=(r.tracks||[]).filter(t=>t.type==='audio');if(audio.length)html+=section('音轨码率 · 1 秒窗口',audio.map(t=>`<h4>音轨 #${t.index} · ${esc(t.codec)} · 平均 ${fmt((t.averageMbps??0)*1000)} kbps</h4><div id="audio-${t.index}"></div>`).join(''));
    if(r.tracks)html+=section('体积构成',table(['轨道','压缩包数据量','占文件比例','包数'],r.tracks.map(t=>[`#${t.index} ${t.type} / ${t.codec}`,size(t.bytes),`${fmt(t.bytes/r.size*100)}%`,t.count]).concat([['容器及未归属差额',size(r.overheadBytes),'—','—']]))+'<p class="hint">差额按文件大小减去所有轨道包大小计算；特殊容器的重复引用可能使其为负，不等同于精确 box 大小。PCM 多音轨的体积不能算作视频可压缩空间。</p>');
    if(r.content?.available)html+=section('SI/TI 内容复杂度',table(['指标','均值','P95','最大值'],[['SI / 空间细节',fmt(r.content.si.mean),fmt(r.content.si.p95),fmt(r.content.si.max)],['TI / 帧间变化',fmt(r.content.ti?.mean),fmt(r.content.ti?.p95),fmt(r.content.ti?.max)]])+`<h4>SI</h4><div id="si"></div><h4>TI</h4><div id="ti"></div>`+notices(r.content.notes));else if(r.content)html+=notices([r.content.reason]);
    html+=notices(r.warnings);
  }
  html+=section('元数据证据 · 去重与来源',metadataHTML(r));html+=section('原始探测与复现记录',raw({file:r.file,tools:r.tools,commands:r.commands,raw:r.raw}));$('#details').innerHTML=html;
  if(r.frames){
    initFrames(r);draw('bitrate',r.packets.bins.map(p=>[p.second,p.mbps]),{unit:'Mbps'});
    for(const t of (r.tracks||[]).filter(t=>t.type==='audio'))draw('audio-'+t.index,t.bins.map(p=>[p.second,p.mbps*1000]),{unit:'kbps'});
    if(r.content?.available){draw('si',r.content.points.map(p=>[p.t,p.si]),{unit:'SI'});draw('ti',r.content.points.map(p=>[p.t,p.ti]),{unit:'TI'})}
  }
}
function legacyGops(frames){const starts=frames.map((f,i)=>i===0||f.key?i:null).filter(x=>x!==null);return starts.map((start,i)=>({index:i,start,end:(starts[i+1]??frames.length)-1,count:(starts[i+1]??frames.length)-start,label:frames[start].key?'KEY_FLAG':'前置片段'}))}
function initFrames(r){
  const gops=r.coding?.gops||legacyGops(r.frames),fdata=r.frames.map((f,i)=>[i,f.bytes??0,f]);
  const detail=p=>{const f=p[2],packet=r.coding?.packets?.[f.packetIndex];$('#frame-detail').innerHTML=table(['显示帧','时间','预测类型','访问类型','关键帧标记','包字节'],[[p[0],`${fmt(f.t,6)} s`,f.type,f.special??'旧版未解析',f.key?'是':'否',f.bytes??'未报告']])+raw(packet??f,'码流包 / 单帧证据')};
  const ribbon=draw('frame-plot',fdata,{unit:'包字节',axis:'显示帧',frames:true,initial:[0,gops[0].end+1],onPick:detail,describe:p=>`帧 ${p[0]} · ${fmt(p[2].t,6)} s · ${p[2].type} / ${p[2].special??'未解析'} · ${size(p[2].bytes)}`});
  let selected=0;const overview=gopOverview($('#gop-overview'),gops,r.frames.length,i=>select(i));charts.push(overview);
  const select=i=>{selected=Math.max(0,Math.min(gops.length-1,Math.round(i)||0));const g=gops[selected];$('#gop-index').value=selected;$('#gop-info').textContent=`${g.label} · 帧 ${g.start}–${g.end} · ${g.count} 帧${g.boundary?' · '+g.boundary:''}`;$('#gop-prev').disabled=selected===0;$('#gop-next').disabled=selected===gops.length-1;ribbon.setRange(g.start,g.end+1);overview.select(selected);detail(fdata[g.start])};
  $('#gop-prev').onclick=()=>select(selected-1);$('#gop-next').onclick=()=>select(selected+1);$('#gop-index').onchange=e=>select(Number(e.target.value));select(0);
  let page=0;const drawPage=()=>{$('#page').textContent=`${page+1} / ${Math.ceil(r.frames.length/100)}`;$('#prev').disabled=page===0;$('#next').disabled=(page+1)*100>=r.frames.length;$('#frames').innerHTML=table(['帧','时间 s','预测类型','码流访问类型','关键帧','包字节'],r.frames.slice(page*100,page*100+100).map((f,i)=>[page*100+i,f.t,f.type,f.special??'未解析',f.key?'是':'否',f.bytes]))};$('#prev').onclick=()=>{page--;drawPage()};$('#next').onclick=()=>{page++;drawPage()};$('#csv').onclick=()=>download('frame,time_s,prediction,access_type,key,packet_bytes,duration_s\n'+r.frames.map((f,i)=>[i,f.t,f.type,f.special??'',f.key?1:0,f.bytes,f.duration].join(',')).join('\n'),'frames.csv','text/csv');drawPage();
  if(r.coding?.codec==='av1'){
    const events=r.coding.events;const eventDetail=p=>{const e=events[p[0]];$('#av1-index').value=e.id;$('#av1-detail').innerHTML=table(['事件 / 编码包','类型 / 可见性','显示帧','Order hint','刷新掩码','引用槽 → 编码事件'],[[`${e.id} / ${e.packet}`,`${e.kind} / ${e.hidden?'隐藏':'显示'}`,e.displayIndex??'不直接输出',e.orderHint,e.refreshFlags==null?'未报告':'0x'+e.refreshFlags.toString(16),e.showExisting?`显示槽 ${e.showSlot} → 事件 ${e.sourceEvent??'未知'}`:(e.referenceSlots||[]).map((s,i)=>`${s}→${e.referenceEvents?.[i]??'未知'}`).join(', ')]])+raw(e,'结构相关帧头字段与引用证据')};
    draw('av1-plot',events.map(e=>[e.id,e.obuPayloadBytes??0,{type:e.hidden?'H':e.showExisting?'S':'V',special:e.kind,key:e.kind==='KEY'}]),{unit:'OBU 负载字节',axis:'编码事件',frames:true,initial:[0,Math.min(60,Math.max(1,events.length))],onPick:eventDetail,describe:p=>{const e=events[p[0]];return `事件 ${e.id} · 包 ${e.packet} · ${e.kind} · ${e.hidden?'隐藏':'显示'} · order_hint ${e.orderHint??'未知'}`}});if(events.length)eventDetail([0]);$('#av1-index').onchange=e=>eventDetail([Math.max(0,Math.min(events.length-1,Math.round(Number(e.target.value))||0))]);
  }
}
function renderComparison(r){
  cards([['参考文件',size(r.reference.size)],['候选文件',size(r.candidate.size)],['总文件体积比',`${fmt(r.sizeRatio*100)}%`],['匹配显示帧',r.alignment.frames]]);
  let html=`<p class="path">参考：${esc(r.reference.file)}<br>候选：${esc(r.candidate.file)}</p>`+notices([r.alignment.note]);
  if(r.videoSize)html+=section('仅视频数据量',table(['参考视频包','候选视频包','候选 / 参考'],[[size(r.videoSize.reference),size(r.videoSize.candidate),`${fmt(r.videoSize.candidate/r.videoSize.reference*100)}%`]])+'<p class="hint">此比例排除了音轨与容器体积，便于评价视频编码的实际节省。</p>');
  for(const [key,m]of Object.entries(r.metrics))html+=section(key.toUpperCase(),table(['整体值','P05','最低帧','统计方式'],[[fmt(m.pooled,5),fmt(m.p05,5),fmt(m.min,5),key==='psnr'?'MSE 域汇总 / dB':key==='vmaf'?m.model:'逐帧均值']])+`<div id="metric-${key}"></div>`+(m.worst?'<h4>最低质量的 1 秒区间（相对参考起点）</h4>'+table(['起点 / 秒','帧范围','区间整体值','最低帧值'],m.worst.map(w=>[w.start,`${w.first}–${w.last}`,fmt(w.value,5),fmt(w.min,5)])):'')+'<p class="hint">最低区间用于定位复查，不自动判定画面不可接受。末尾区间可能不足 1 秒。</p>');
  html+=notices(r.warnings)+section('复现记录',raw({tools:r.tools,commands:r.commands,alignment:r.alignment}));$('#details').innerHTML=html;for(const [k,m]of Object.entries(r.metrics))draw('metric-'+k,m.values.map((v,i)=>[i,v==='Infinity'?null:v]),{unit:k==='psnr'?'dB':k,axis:'显示帧'});
}
function renderTrial(r){
  cards([['片段起点',`${r.experiment.start} s`],['请求片段长度',`${r.experiment.duration} s`],['实际显示帧',r.experiment.actualFrames],['编码器',r.experiment.encoder]]);
  let html=`<p class="path">${esc(r.source.file)}</p>`+section('率失真采样点',table(['CRF','视频包体积','平均 Mbps','PSNR / dB','SSIM','VMAF','编码秒 / fps'],r.rows.map(x=>[x.crf,size(x.videoBytes),fmt(x.videoMbps),fmt(x.metrics.psnr?.pooled),fmt(x.metrics.ssim?.pooled,6),fmt(x.metrics.vmaf?.pooled),`${fmt(x.encodeSeconds)} / ${fmt(x.encodeFps)}`])));
  html+=section('片段质量与体积',`<label>纵轴指标<select id="rd-metric">${r.experiment.metrics.map(m=>`<option>${esc(m)}</option>`).join('')}</select></label><div id="rd"></div><p class="hint">每个点对应一个真实 CRF 实验，连线仅辅助观察，不是未测参数的预测。</p>`)+notices(r.warnings)+section('实验文件与复现记录',`<p class="hint">${r.experiment.retainedFiles.length?'已保留实验文件：'+esc(r.experiment.retainedFiles.join('；')):'实验视频已自动清理；报告保留数据与运行参数。'}</p>`+raw({experiment:r.experiment,tools:r.tools,commands:r.commands}));$('#details').innerHTML=html;
  let rd;const update=()=>{rd?.dispose();const metric=$('#rd-metric').value,data=[...r.rows].sort((a,b)=>a.videoBytes-b.videoBytes).map(x=>[x.videoBytes/1024,typeof x.metrics[metric]?.pooled==='number'?x.metrics[metric].pooled:null,x]);rd=draw('rd',data,{unit:metric,axis:'视频包 KiB',describe:p=>`CRF ${p[2].crf} · ${size(p[2].videoBytes)} · ${metric} ${fmt(p[2].metrics[metric]?.pooled,6)}`})};$('#rd-metric').onchange=update;update();
}
api('status').then(s=>{$('#environment').textContent=s.versions.ffmpeg;for(const box of document.querySelectorAll('[name=metric]'))if(!s.metrics.includes(box.value)){box.checked=false;box.disabled=true}const active=s.jobs.find(j=>j.status==='running');if(active){current=active.id;busy(true);poll()}}).catch(e=>message(e.message,true));
