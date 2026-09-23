import {parseReport} from './report.js';
import {plot,gopOverview} from './charts.js';
import {parseCrfs,rowLabel,trialValue,trialPlotData,trialFramePlotData,metricLabels,trialSortFields,sortTrialRows} from './trial-model.js';
const modes=['inspect','compare','trial'],reports={},viewCharts={inspect:[],compare:[],trial:[]};
let activeMode='inspect',renderingMode=null;
const modeOf=r=>r.type==='analyze'?'inspect':r.type;
const $=s=>document.querySelector(/^#(result|result-title|summary|details|export)$/.test(s)?'#'+(renderingMode||activeMode)+'-'+s.slice(1):s),token=$('meta[name=token]').content;
let current=null,report=null,infoPath=null,hasVideo=false,charts=[],importing=false;
const esc=v=>String(v??'未报告').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=3)=>typeof v==='number'?v.toLocaleString('zh-CN',{maximumFractionDigits:d}):v??'未报告';
const size=v=>v==null?'未报告':v>=1073741824?`${fmt(v/1073741824)} GiB`:v>=1048576?`${fmt(v/1048576)} MiB`:v>=1024?`${fmt(v/1024)} KiB`:`${v} B`;
const clean=v=>v.trim().replace(/^"|"$/g,'');
async function api(url,options={}){const r=await fetch('/api/'+url,{...options,headers:{'Content-Type':'application/json','X-MediaScope-Token':token}}),d=await r.json();if(!r.ok)throw Error(d.error||'请求失败');return d}
function progressValue(value){return Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2}):null}
function elapsed(startedAt){const seconds=Math.max(0,Math.floor((Date.now()-new Date(startedAt).getTime())/1000));if(!Number.isFinite(seconds))return '';const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return `已运行 ${h?String(h).padStart(2,'0')+':':''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function message(text,error=false,progress=null,startedAt=null,status=null){
 $('#task').classList.remove('hidden');$('#task').classList.toggle('error',error);$('#task-label').textContent=error?'任务未完成':status==='cancelled'?'任务已取消':status==='done'?'任务完成':'分析任务';$('#task-message').textContent=text;$('#cancel').classList.toggle('hidden',!current);
 const details=$('#task-progress-details'),stage=$('#task-stage'),phase=$('#task-phase');details.classList.toggle('hidden',!progress);stage.classList.toggle('hidden',!progress?.stage);phase.classList.toggle('hidden',!(progress?.phaseIndex!=null&&progress?.phaseCount));
 if(!progress)return;
 stage.textContent=progress.stage||'';phase.textContent=progress.phaseIndex!=null&&progress.phaseCount?`阶段 ${progress.phaseIndex} / ${progress.phaseCount}`:'';
 const determinate=Number.isFinite(progress.completed)&&Number.isFinite(progress.total)&&progress.total>=0,percent=determinate?(progress.total===0?100:Math.max(0,Math.min(100,progress.completed/progress.total*100))):null;
 const count=progressValue(progress.completed),total=progressValue(progress.total);$('#task-count').textContent=count===null?'正在处理':total===null?`已处理 ${count}${progress.unit?' '+progress.unit:''}`:`${count} / ${total}${progress.unit?' '+progress.unit:''}`;$('#task-percent').textContent=percent===null?'总量待核验':`${percent.toFixed(percent<10&&percent%1?1:0)}%`;
 const track=$('#task-progress-track'),bar=$('#task-progress-bar');track.classList.toggle('indeterminate',!determinate);if(!bar.style)bar.style={};bar.style.width=determinate?percent+'%':'';track.ariaValueNow=determinate?String(percent):'';track.ariaValueMax=determinate?'100':'';
 const subtasks=Object.values(progress.subtasks||{});$('#task-subtasks').innerHTML=subtasks.map(item=>{const done=progressValue(item.completed),all=progressValue(item.total);return `<div class="task-subtask"><span>${esc(item.label||'并行任务')}</span><span>${done??'准备中'}${all!==null?' / '+all:''}${item.unit?' '+esc(item.unit):''}</span></div>`}).join('');
 $('#task-elapsed').textContent=startedAt?elapsed(startedAt):'';
}
function busy(value){for(const id of ['inspect','analyze','compare','trial'])$('#'+id).disabled=value||(id==='analyze'&&(!infoPath||!hasVideo));$('#import-report').disabled=value;$('#import-button').disabled=value;document.querySelectorAll('.file-picker').forEach(b=>b.disabled=value)}
async function launch(data){try{busy(true);current=(await api('jobs',{method:'POST',body:JSON.stringify(data)})).id;message('任务已开始');poll()}catch(e){message(e.message,true);busy(false)}}
async function poll(){try{const j=await api('jobs/'+current);message(j.progress?.detail||j.message,j.status==='error',j.progress,j.startedAt,j.status);if(j.status==='running'){setTimeout(poll,900);return}const id=current;current=null;$('#cancel').classList.add('hidden');if(j.status==='done'){const result=await api('jobs/'+id+'/report');render(result,false)}busy(false)}catch(e){current=null;busy(false);message(e.message,true)}}
$('#cancel').onclick=async()=>{try{await api('jobs/'+current,{method:'DELETE'})}catch(e){message(e.message,true)}};
function switchMode(mode){
 activeMode=mode;report=reports[mode]??null;charts=viewCharts[mode];
 document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('selected',t.dataset.mode===mode));
 for(const name of modes){document.querySelector('#'+name+'-panel').classList.toggle('hidden',name!==mode);document.querySelector('#'+name+'-result').classList.toggle('hidden',name!==mode||!reports[name])}
}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchMode(b.dataset.mode));
document.querySelectorAll('.file-picker').forEach(button=>button.onclick=async()=>{button.disabled=true;const label=button.textContent;button.textContent='正在打开…';message('正在打开 Windows 文件选择器；如果没有出现在前台，请查看任务栏。');try{const result=await api('select-file',{method:'POST',body:'{}'});if(result.file){const input=$('#'+button.dataset.target);input.value=result.file;input.dispatchEvent(new Event('input'));message('已选择文件：'+result.file)}else message('已取消选择文件')}catch(e){message(e.message==='Failed to fetch'?'本机分析服务未运行，请重新启动 MediaScope':e.message,true)}finally{button.textContent=label;button.disabled=false}});
$('#file').oninput=()=>{infoPath=null;$('#analyze').disabled=true};
const syncSitiWorkers=()=>{$('#siti-workers').disabled=!$('#complexity').checked};$('#complexity').onchange=syncSitiWorkers;syncSitiWorkers();
$('#inspect').onclick=()=>launch({type:'inspect',file:clean($('#file').value)});
$('#analyze').onclick=()=>launch({type:'analyze',file:infoPath,stream:Number($('#stream').value),complexity:$('#complexity').checked,sitiWorkers:$('#siti-workers').value});
$('#compare').onclick=()=>{
 const input={type:'compare',reference:clean($('#reference').value),candidate:clean($('#candidate').value),refStream:Number($('#refStream').value),candidateStream:Number($('#candidateStream').value),comparisonMode:$('#comparison-mode').value,timingMode:$('#timing-mode').value,metrics:[...document.querySelectorAll('[name=metric]:checked')].map(x=>x.value),confirm:$('#confirm').checked};
 if(input.timingMode==='ordinal-confirmed'){
  if(!$('#timing-confirm').checked){message('请确认两路视频的每个显示帧按顺序一一对应，且没有丢帧、重复帧或重排。',true);return}
  input.timingConfirmed=true;
 }
 if(input.timingMode==='playback-sample'){
  if(!$('#playback-confirm').checked){message('请确认两路首帧对应同一播放时刻，并接受 CFR 一侧作为采样网格的实验性解释。',true);return}
  input.playbackConfirmed=true;
 }
 if($('#chroma-confirm-mode').checked){
  if(!$('#chroma-confirm').checked){message('请先确认色度位置来自可信来源，并了解结果依赖此假设。',true);return}
  input.chromaConfirmed=true;
  input.chromaAssumptions={};
  for(const [side,id] of [['reference','#reference-chroma'],['candidate','#candidate-chroma']])if($(id).value)input.chromaAssumptions[side]=$(id).value;
 }
 launch(input);
};
$('#chroma-confirm-mode').onchange=()=>$('#chroma-assumption-controls').classList.toggle('hidden',!$('#chroma-confirm-mode').checked);
$('#timing-mode').onchange=()=>{$('#timing-confirm-row').classList.toggle('hidden',$('#timing-mode').value!=='ordinal-confirmed');$('#playback-confirm-row').classList.toggle('hidden',$('#timing-mode').value!=='playback-sample')};
function trialInput(){return {type:'trial',file:clean($('#trial-file').value),stream:Number($('#trial-stream').value),start:Number($('#trial-start').value),duration:Number($('#trial-duration').value),encoder:$('#trial-encoder').value,depthMode:$('#trial-depth').value,presets:[...document.querySelectorAll('[name=trial-preset]:checked')].map(x=>x.value),cpuUsed:Number($('#trial-cpu').value),crfs:parseCrfs($('#trial-crfs').value),metrics:$('#trial-vmaf').checked?['psnr','ssim','vmaf']:['psnr','ssim'],keepFiles:$('#trial-keep').checked};}
function trialControls(){
 const av1=$('#trial-encoder').value==='libaom-av1',both=$('#trial-depth').value==='both';
 $('#trial-presets').classList.toggle('hidden',av1);$('#trial-cpu-label').classList.toggle('hidden',!av1);$('#trial-vmaf').disabled=both;if(both)$('#trial-vmaf').checked=false;
 try{const input=trialInput(),p=av1?1:input.presets.length,points=input.crfs.length*p*(both?2:1);$('#trial-count').textContent=`${input.crfs.length} 个 CRF × ${p} 个预设 × ${both?2:1} 种位深 = ${points} 个编码点。${points>64?'超过 64 点上限，请减少选项。':p<1||p>4?'请选择 1–4 个 preset。':'顺序运行，耗时曲线仅代表本机本次实验。'}`;}catch(e){$('#trial-count').textContent=e.message}
}
for(const id of ['trial-encoder','trial-depth','trial-crfs','trial-cpu'])$('#'+id).addEventListener('input',trialControls);
document.querySelectorAll('[name=trial-preset]').forEach(x=>x.addEventListener('change',trialControls));trialControls();
$('#trial').onclick=()=>{try{launch(trialInput())}catch(e){message(e.message,true)}};
for(const mode of modes)document.querySelector('#'+mode+'-export').onclick=()=>{const saved=reports[mode];if(saved)download(JSON.stringify(saved,null,2),'MediaScope-'+saved.type+'.json','application/json')};
$('#import-button').onclick=()=>$('#import-report').click();
$('#import-report').onchange=async e=>{
 const input=e.target,f=input.files[0];if(!f)return;
 if(current||importing){input.value='';return}
 importing=true;busy(true);message('正在读取并校验报告…');
 try{
  if(f.size>256*1024*1024)throw Error('报告超过 256 MiB 导入上限');
  const data=parseReport(await f.text()),previous=reports[modeOf(data)];
  if(current)throw Error('分析任务正在运行，请在任务完成后导入报告');
  try{render(data)}catch(err){if(previous)render(previous);else document.querySelector('#'+modeOf(data)+'-result').classList.add('hidden');throw Error('报告无法完整显示：'+err.message)}
  switchMode(modeOf(data));
  message('已导入 '+f.name+'；使用保存的原始测量数据，无需原媒体文件或重新计算。');
 }catch(err){message(err.message,true)}finally{importing=false;busy(!!current);input.value=''}
};
function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function cards(items){$('#summary').innerHTML=items.map(([k,v])=>`<div class="card"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}
function section(title,html){return `<section class="section"><h3>${esc(title)}</h3>${html}</section>`}
function table(headers,rows){return `<div class="table-wrap"><table><thead><tr>${headers.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
function raw(data,title='展开证据 / 原始数据'){return `<details><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`}
function notices(items){return (items||[]).map(w=>`<p class="notice">${esc(w)}</p>`).join('')}
function draw(id,data,options){const host=$('#'+id);if(host){const p=plot(host,data,options);if(p)charts.push(p);return p}}
function render(r,activate=true){
 const mode=modeOf(r);renderingMode=mode;charts=viewCharts[mode];charts.forEach(c=>c.dispose?.());charts=[];
 try{
  $('#result-title').textContent=r.type==='compare'?'质量对比报告':r.type==='trial'?'片段率失真实验':'媒体分析报告';
  if(r.type==='compare')renderComparison(r);else if(r.type==='trial')renderTrial(r);else renderMedia(r);
  reports[mode]=r;
 }finally{viewCharts[mode]=charts;renderingMode=null;switchMode(activate?mode:activeMode);busy(!!current||importing)}
}
function metadataHTML(r){
  const data=r.metadata;if(!data)return raw({frameSample:r.frameSample,scope:r.frameSampleScope},'旧版报告附加数据（重新分析可获得去重摘要）');
  return `<p class="hint">${esc(data.note)} ${esc(data.scope)}</p>`+(data.items.length?data.items.map(item=>`<div class="evidence"><strong>${esc(item.name)}</strong><span>${esc(item.sources.join('、'))} · ${item.occurrences} 次相同记录</span>${raw(item.value,'查看此项数据')}</div>`).join(''):'<p class="hint">本次探测范围未报告附加数据；不能据此认定全片不存在。</p>');
}
function renderMedia(r){
  const streams=r.raw.streams,videos=streams.filter(s=>s.codec_type==='video');infoPath=r.file;hasVideo=!!videos.length;$('#file').value=r.file;
  $('#stream').innerHTML=videos.map(s=>`<option value="${s.index}">${s.index} · ${esc(s.codec_name)} · ${s.width} × ${s.height}</option>`).join('');if(r.stream!==undefined)$('#stream').value=r.stream;$('#analyze').disabled=!hasVideo;
  if(!$('#trial-file').value){$('#trial-file').value=r.file;$('#trial-stream').value=r.stream??videos[0]?.index??0}
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
    if(r.content?.available){const e=r.content.execution,execution=e?`<p class="hint">SI/TI 执行：${e.mode==='frame-parallel'?`${e.workers} 路帧级并行`:'串行'}；设置 ${e.setting==='auto'?`自动（请求上限 ${e.requestedWorkers} 路）`:`上限 ${e.requestedWorkers} 路`}${e.fallbackReason?`；已回退：${esc(e.fallbackReason)}`:''}。</p>`:'';html+=section('SI/TI 内容复杂度',execution+table(['指标','均值','P95','最大值'],[['SI / 空间细节',fmt(r.content.si.mean),fmt(r.content.si.p95),fmt(r.content.si.max)],['TI / 帧间变化',fmt(r.content.ti?.mean),fmt(r.content.ti?.p95),fmt(r.content.ti?.max)]])+`<h4>SI</h4><div id="si"></div><h4>TI</h4><div id="ti"></div>`+notices(r.content.notes))}else if(r.content)html+=notices([r.content.reason]);
    html+=notices(r.warnings);
  }
  html+=section('元数据证据 · 去重与来源',metadataHTML(r));html+=section('原始探测与复现记录',raw({file:r.file,tools:r.tools,commands:r.commands,raw:r.raw}));$('#details').innerHTML=html;
  if(r.frames){
    if(r.frames.length)initFrames(r);else $('#gop-overview').textContent='报告中没有显示帧';draw('bitrate',r.packets.bins.map(p=>[p.second,p.mbps]),{unit:'Mbps'});
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
  cards([['参考文件',size(r.reference.size)],['候选文件',size(r.candidate.size)],['总文件体积比',`${fmt(r.sizeRatio*100)}%`],[r.alignment.pairing==='playback-sample'?'采样时刻':'匹配显示帧',r.alignment.frames]]);
  let html=`<p class="path">参考：${esc(r.reference.file)}<br>候选：${esc(r.candidate.file)}</p>`+notices([r.alignment.note]);
  if(r.alignment.pairing==='ordinal-confirmed')html+=section('帧序配对与时间轴差异',table(['配对方式','首次超过 0.1 ms 的帧','最大相对时间差','末帧持续时间差'],[['解码显示帧序号',r.alignment.firstTimestampMismatchFrame??'未超过',`${fmt(r.alignment.maxRelativeDifferenceSeconds*1000,3)} ms`,r.alignment.lastDurationDifferenceSeconds==null?'未报告':`${fmt(r.alignment.lastDurationDifferenceSeconds*1000,3)} ms`]])+notices(['时间轴差异已记录；指标按对应帧计算，不代表两路播放时间完全一致。']));
  if(r.alignment.pairing==='playback-sample'){
    const a=r.alignment,modern=!!a.gridSide;
    html+=section('VFR ↔ CFR 播放采样 · 实验性',table(['CFR 网格所在视频 / 帧率','采样视频帧 / 网格帧','CFR 最大偏差 / 容差','采样重复 / 未采样帧（估计）'],[[`${modern?(a.gridSide==='reference'?'参考':'候选'):'候选'} / ${modern?a.gridRate:a.candidateRate} (${fmt(modern?a.gridRateHz:a.candidateRateHz,3)} fps)`,`${fmt(modern?a.sampledFrames:a.sourceFrames)} / ${fmt(a.frames)}`,`${fmt((modern?a.maxGridErrorSeconds:a.maxCandidateGridErrorSeconds)*1000,4)} / ${fmt(a.cfrToleranceSeconds*1000,4)} ms`,`${fmt(a.estimatedRepeatedSamples)} / ${fmt(modern?a.estimatedUnrepresentedSampledFrames:a.estimatedUnrepresentedSourceFrames)}`]])+notices([a.sampling,a.note,'两路首帧对应同一播放时刻由用户确认。指标只覆盖 CFR 网格的采样时刻；完整的估计帧索引映射保存在导出的 JSON 中。']));
  }
  if(r.chromaAssumptions?.length)html+=section('用户确认的色度位置',table(['视频','文件报告值','本次采用值','证据性质'],r.chromaAssumptions.map(x=>[x.side==='reference'?'参考':'候选',x.declared??'未报告',x.assumed,x.source]))+notices(['该位置由用户指定，软件未验证其真实性；指标依赖此假设。']));
  if(r.profile)html+=section('比较域与格式',table(['像素格式','位深 / 采样','信号','原色 / 传递 / 矩阵 / 范围'],[[r.profile.pixelFormat,`${r.profile.bitDepth}-bit / ${r.profile.subsampling}`,r.profile.signal,`${r.profile.primaries} / ${r.profile.transfer} / ${r.profile.matrix} / ${r.profile.range}`]])+notices([r.profile.domain]));
  if(r.normalization?.crossDepth)html+=section('跨位深码值映射',table(['参考原格式','候选原格式','比较格式','映射 / PSNR 峰值'],[[r.normalization.sourceFormats.reference,r.normalization.sourceFormats.candidate,r.normalization.targetFormat,`${r.normalization.mapping} / ${r.normalization.psnrPeak}`]])+notices([r.normalization.basis,r.normalization.verification?.passed?'本机全码值映射校验通过（Y / Cb / Cr，0–255）':'未报告映射验证'])+raw(r.normalization));
  if(r.skippedMetrics)html+=notices(Object.entries(r.skippedMetrics).map(([k,v])=>`${k.toUpperCase()} 未计算：${v}`));
  for(const [key,m]of Object.entries(r.metrics))if(m.components)html+=section(`${key.toUpperCase()} 分量`,table(['Y 亮度','U 色度','V 色度'],[[fmt(m.components.y,5),fmt(m.components.u,5),fmt(m.components.v,5)]]));
  if(r.videoSize)html+=section('仅视频数据量',table(['参考视频包','候选视频包','候选 / 参考'],[[size(r.videoSize.reference),size(r.videoSize.candidate),`${fmt(r.videoSize.candidate/r.videoSize.reference*100)}%`]])+'<p class="hint">此比例排除了音轨与容器体积，便于评价视频编码的实际节省。</p>');
  for(const [key,m]of Object.entries(r.metrics))html+=section(key.toUpperCase(),table(['整体值','P05','最低帧','统计方式'],[[fmt(m.pooled,5),fmt(m.p05,5),fmt(m.min,5),key==='psnr'?'MSE 域汇总 / dB':key==='vmaf'?m.model:'逐帧均值']])+`<div id="metric-${key}"></div>`+(m.worst?'<h4>最低质量的 1 秒区间（相对参考起点）</h4>'+table(['起点 / 秒','帧范围','区间整体值','最低帧值'],m.worst.map(w=>[w.start,`${w.first}–${w.last}`,fmt(w.value,5),fmt(w.min,5)])):'')+'<p class="hint">最低区间用于定位复查，不自动判定画面不可接受。末尾区间可能不足 1 秒。</p>');
  const alignmentEvidence={...r.alignment};delete alignmentEvidence.estimatedSourceFrameIndices;delete alignmentEvidence.estimatedSampledFrameIndices;
  html+=notices(r.warnings)+section('复现记录',raw({tools:r.tools,commands:r.commands,alignment:alignmentEvidence}));$('#details').innerHTML=html;for(const [k,m]of Object.entries(r.metrics))draw('metric-'+k,m.values.map((v,i)=>[i,v==='Infinity'?null:v]),{unit:metricLabels[k],axis:'显示帧序号（从 0 开始）'});
}
function renderTrial(r){
  cards([['片段起点',`${r.experiment.start} s`],['请求片段长度',`${r.experiment.duration} s`],['实际显示帧',r.experiment.actualFrames],['编码器',r.experiment.encoder]]);
  const rows=r.rows.map(x=>({...x,preset:x.preset??r.experiment.preset})),groups=[...new Set(rows.map(rowLabel))],metrics=['psnr','ssim','vmaf'].filter(m=>rows.some(x=>x.metrics[m]));
  let html=`<p class="path">${esc(r.source.file)}</p>`+notices([r.experiment.comparisonDomain??'原生位深参考',...Object.values(r.skippedMetrics??{})]);
  if(r.experiment.preparation?.baseline)html+=section('编码前的位深转换基准',notices([r.experiment.preparation.mapping])+table(['PSNR / dB','SSIM','含义'],[[fmt(r.experiment.preparation.baseline.psnr.pooled,5),fmt(r.experiment.preparation.baseline.ssim.pooled,6),'两种无损输入在统一 10-bit 域的差异；尚未试编码，不与成片分数相减。']]));
  html+=section('实验采样点',`<details id="trial-samples" ${rows.length<=12?'open':''}><summary>查看 ${rows.length} 个实测点</summary><div class="sample-sort"><label>排序参数<select id="sample-sort-key">${Object.entries(trialSortFields).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></label><label>顺序<select id="sample-sort-direction"><option value="asc">升序</option><option value="desc">降序</option></select></label></div><div id="trial-sample-table"></div></details>`);
  html+=section('CRF 参数扫描 · 固定每条曲线的位深与 preset','<div class="trial-chart-grid"><div><h4>① CRF 与质量：PSNR（越高越好）</h4><div id="trial-psnr"></div></div><div><h4>② CRF 与编码耗时（越低越快）</h4><div id="trial-time"></div></div><div><h4>③ CRF 与视频码率（数据开销）</h4><div id="trial-rate"></div></div><div><h4>④ CRF 与质量：SSIM（越高越好）</h4><div id="trial-ssim"></div></div></div><p class="hint">每个圆点是一个 CRF 实测结果，每条线固定一个位深 / preset；连线仅辅助读图，不是拟合或插值预测。横轴 CRF 是编码器参数，无量纲；同 CRF 不保证同质量或码率。耗时仅为本机单次测量，无误差条，不宜据微小差异排名。</p>');
  html+=section('码率—质量与编码成本',`<div class="two"><label>横轴<select id="rd-axis"><option value="videoMbps">视频平均码率（Mbit/s）</option><option value="videoKiB">视频包体积（KiB）</option><option value="encodeSeconds">编码耗时（s）</option><option value="encodeFps">编码速度（frame/s）</option></select></label><label>纵轴指标<select id="rd-metric">${metrics.map(m=>`<option value="${m}">${esc(metricLabels[m])}</option>`).join('')}</select></label></div><div id="rd"></div><p class="hint">码率—质量图：同等质量时越靠左越省码率，同等码率时越高越好；需比较同一参考片段及指标域。成本图仅显示散点：相同质量下比较编码时间或速度。Mbit/s = 10⁶ bit/s；KiB = 1024 B，仅计视频包。PSNR 为 MSE 域汇总，SSIM / VMAF 为逐帧均值。</p>`);
  html+=section('逐帧质量叠加 · 固定位深与 preset，对比 CRF',`<div class="two"><label>固定对比组<select id="trial-group">${groups.map((g,i)=>`<option value="${i}">${esc(g)}</option>`).join('')}</select></label><label>纵轴质量指标<select id="trial-frame-metric">${metrics.map(m=>`<option value="${m}">${esc(metricLabels[m])}</option>`).join('')}</select></label></div><div id="trial-crf-select" class="checks"></div><p id="trial-frame-note" class="hint"></p><div id="trial-frames"></div>`);
  html+=notices(r.warnings)+section('实验文件与复现记录',`<p class="hint">${r.experiment.retainedFiles.length?'已保留实验文件：'+esc(r.experiment.retainedFiles.join('；')):'实验视频已自动清理；报告保留数据与运行参数。'}</p>`+raw({experiment:r.experiment,tools:r.tools,commands:r.commands}));$('#details').innerHTML=html;
  const labels={...metricLabels,videoKiB:'视频包体积（KiB）',videoMbps:'视频平均码率（Mbit/s）',encodeSeconds:'编码耗时（s）↓',encodeFps:'编码速度（frame/s）↑',crf:'CRF（无量纲）'};
  const drawSamples=()=>{$('#trial-sample-table').innerHTML=table(['位深 / preset','CRF','视频包体积','视频码率 / Mbit/s','PSNR / dB','SSIM / 无量纲','VMAF / 模型分数','编码耗时 s / 速度 frame/s'],sortTrialRows(rows,$('#sample-sort-key').value,$('#sample-sort-direction').value).map(x=>[rowLabel(x),x.crf,size(x.videoBytes),fmt(x.videoMbps),fmt(x.metrics.psnr?.pooled),fmt(x.metrics.ssim?.pooled,6),fmt(x.metrics.vmaf?.pooled),`${fmt(x.encodeSeconds)} / ${fmt(x.encodeFps)}`]))};
  const seriesPlot=(id,x,y)=>{const {data,series}=trialPlotData(rows,x,y);return draw(id,data,{series,connect:!['encodeSeconds','encodeFps'].includes(x),unit:labels[y],axis:labels[x],describe:p=>`${rowLabel(p[2])} · CRF ${p[2].crf} · ${labels[y]} ${fmt(['psnr','ssim','vmaf'].includes(y)?p[2].metrics[y]?.pooled:trialValue(p[2],y),6)}`})};
  seriesPlot('trial-psnr','crf','psnr');seriesPlot('trial-time','crf','encodeSeconds');seriesPlot('trial-rate','crf','videoMbps');seriesPlot('trial-ssim','crf','ssim');
  let rd,framePlot;const update=()=>{rd?.dispose();rd=seriesPlot('rd',$('#rd-axis').value,$('#rd-metric').value)};
  let selectedCrfs=[];
  const updateFrames=()=>{
    framePlot?.dispose();const group=groups[Number($('#trial-group').value)||0],metric=$('#trial-frame-metric').value||metrics[0];
    const result=trialFramePlotData(rows,metric,group,selectedCrfs,r.experiment.frameTimes);
    $('#trial-frame-note').textContent=(result.timed?'横轴：相对片段首帧的时间（s），使用保存的参考帧时间戳。':'横轴：片段显示帧序号（从 0 开始）；报告未保存可用时间戳，不估算秒数。')+' 同一参考片段、位深与 preset；仅改变 CRF。悬停可并列读取各曲线；无限值和缺失值留空，不跨空缺连线。'+(result.missing.length?' 未保存逐帧数据的 CRF：'+result.missing.join('、'):'');
    if(!result.data.length){$('#trial-frames').textContent=selectedCrfs.length?'该报告未保存所选指标的逐帧数据。':'请至少选择一个 CRF。';return}
    framePlot=draw('trial-frames',result.data,{series:result.series,markers:false,height:440,axis:result.timed?'相对片段首帧时间（s）':'片段显示帧序号（从 0 开始）',unit:labels[metric],describe:p=>'CRF '+p[2].crf+' · 帧 '+p[2].frame+' · '+labels[metric]+' '+(p[2].value==='Infinity'?'∞':p[2].value==null?'缺失':fmt(p[2].value,6))});
  };
  const updateGroup=()=>{
    selectedCrfs=rows.filter(row=>rowLabel(row)===groups[Number($('#trial-group').value)||0]).map(row=>row.crf).sort((a,b)=>a-b);
    $('#trial-crf-select').innerHTML=selectedCrfs.map(crf=>'<label><input type="checkbox" name="plot-crf" value="'+crf+'" checked>CRF '+crf+'</label>').join('');
    document.querySelectorAll('[name=plot-crf]').forEach(box=>box.onchange=()=>{selectedCrfs=[...document.querySelectorAll('[name=plot-crf]:checked')].map(x=>Number(x.value));updateFrames()});updateFrames();
  };
  $('#sample-sort-key').onchange=drawSamples;$('#sample-sort-direction').onchange=drawSamples;$('#rd-axis').onchange=update;$('#rd-metric').onchange=update;$('#trial-group').onchange=updateGroup;$('#trial-frame-metric').onchange=updateFrames;drawSamples();update();updateGroup();
}
api('status').then(s=>{$('#environment').textContent=s.versions.ffmpeg;for(const box of document.querySelectorAll('[name=metric]'))if(!s.metrics.includes(box.value)){box.checked=false;box.disabled=true}const active=s.jobs.find(j=>j.status==='running');if(active){current=active.id;busy(true);poll()}}).catch(e=>message(e.message,true));
