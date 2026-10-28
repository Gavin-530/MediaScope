import {repeatSeconds} from './repeat-model.js';
import {repeatCsvParts} from './repeat-csv.js';
import {differenceDisplay} from './repeat-difference.js';

const esc=v=>String(v??'未知').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seconds=(ticks,tb)=>{const s=repeatSeconds(ticks,tb);return s===null?'未知':`${s.toLocaleString('zh-CN',{maximumFractionDigits:6})} s`;};
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const cells=values=>values.map(v=>`<td>${esc(v)}</td>`).join('');
const states={partial:'部分可用',unavailable:'无法判断',unsupported:'不支持',failed:'检测失败','not-requested':'本次未选择',compatible:'相容',incompatible:'不相容',undetermined:'不能判断'};
const pager=(name,label)=>`<div class="pager"><button class="secondary" data-page="${name}:-1">上一页</button><span data-page-label="${name}"></span><button class="secondary" data-page="${name}:1">下一页</button><button class="secondary" data-csv="${name}">导出${label} CSV</button></div><div data-rows="${name}"></div>`;
const equalPrevious=(r,f)=>r.configurationVersion===2?f.equalPrevious:r.frames[f.frame-1].sha256===f.sha256;
const bandNames={equal:'逐值相等','one-code':'最大差 1 码值','two-codes':'最大差 2 码值',larger:'最大差超过 2 码值','no-predecessor':'无前帧'};

export function repeatHTML(r){
  if(r.status!=='complete')return `<section class="section" id="repeat-result"><h3>重复帧与时间诊断</h3><p class="notice">不支持：${esc(r.reason)}</p></section>`;
  const x=r.exact,t=r.timeline,f=r.freeze;
  const timing=t.status!=='complete'?states[t.status]:r.frames.length<2?'仅 1 帧，无相邻间隔':`${t.intervals.length} 种间隔`;
  const timingNote=!r.timeBase?'缺少有效时间基，无法换算秒数或核对帧率网格。':t.missingPts===r.frames.length?'所有帧均缺少原始时间戳，无法计算相邻间隔。':r.frames.length<2?'':t.status==='partial'?'原始时间戳有缺失或非递增，不能据此确认完整时间轴。':'原始时间戳完整且严格递增。';
  const exactNote=x.comparisons?'':'仅有一帧，无法比较相邻画面或计算相邻间隔。';
  const constantNote=r.configurationVersion===2&&r.constant.status!=='complete'?` 连续样本不变已确认 ${r.constant.segments.length} 段；${states[r.constant.status]}，${r.constant.unresolvedRuns} 段重复的持续时间未能核定。`:'';
  const normalTiming=!!r.timeBase&&r.frames.length>=2&&t.status==='complete';
  const summary=[exactNote,normalTiming?'':timingNote,constantNote,r.configurationVersion===2?'':'旧版指纹比较，未进行逐值确认。'].filter(Boolean).join(' ');
  const interpretation='正常静止画面也可能产生精确重复，不能据此认定录制故障。';
  const cards=[
    ['分析规模',`${x.frames.toLocaleString('zh-CN')} 帧`,`${x.comparisons.toLocaleString('zh-CN')} 次相邻比较`],
    ['精确重复',`${x.duplicates.toLocaleString('zh-CN')} 次`,x.ratio===null?'比例不可计算':`占相邻比较 ${(x.ratio*100).toLocaleString('zh-CN',{maximumFractionDigits:4})}%`],
    ['连续重复段',`${x.runs.length.toLocaleString('zh-CN')} 段`,r.configurationVersion===2?`原 PTS 证实 ≥2 秒：${r.constant.segments.length.toLocaleString('zh-CN')} 段${r.constant.status==='complete'?'':` · ${states[r.constant.status]}`}`:null,'repeat-constant-summary'],
  ];
  return `<section class="section" id="repeat-result"><h3>重复帧与时间诊断</h3>
    <div class="cards repeat-cards">${cards.map(([k,v,note,id])=>`<div class="card"><span${k==='精确重复'?` title="${esc(interpretation)}"`:''}>${esc(k)}</span><strong>${esc(v)}</strong>${note===null?'':`<span${id?` id="${id}"`:''}>${esc(note)}</span>`}</div>`).join('')}</div>
    <p class="notice" id="repeat-summary">${summary}</p>
    <div class="repeat-overview-heading"><h4>精确重复分布</h4><span class="hint" id="repeat-overview-note"></span>${f.status==='complete'&&f.segments.length?`<span class="repeat-region-key">静止候选 ${f.segments.length} 段</span>`:''}</div><div id="repeat-overview"></div>
    ${f.status==='not-requested'?'':`<div id="repeat-freeze">${f.status==='complete'?`<details id="repeat-freeze-details"><summary>静止候选 · ${f.segments.length?`${f.segments.length} 段`:'未检出'} · 明细与 CSV</summary><p class="hint">画面变化低于阈值 ${f.noise} 且持续至少 ${f.durationSeconds} s 时记为候选，需结合画面复核，不作为精确相等判据。阴影仅标记候选位置，不计入精确重复次数。原始时间戳完整且严格递增时，图表按原始时间展示相邻比较区间；否则按帧序号展示。时间保留检测器输出的精度；定位的是检测事件帧，并非区间起点帧。斜纹表示结束未报告，不据末帧时间补算结束或时长。</p>${pager('segments','静止区间')}<details><summary>检测事件明细与 CSV</summary>${pager('freeze','静止事件')}</details></details>`:`<p class="notice">持续静止候选 · ${states[f.status]}：${esc(f.reason)}</p>`}</div>`}
    <details id="repeat-evidence"><summary>检测明细与导出</summary>
    <details id="repeat-method"><summary>方法与判读依据</summary><p id="repeat-source">原生格式 <strong>${esc(r.source.pixelFormat)}</strong> · <strong>${r.sampleFormat.depth}-bit</strong>${r.sampleFormat.alpha?' · 包含 Alpha':''}</p><p>${r.configurationVersion===2?'精确重复已直接核对全部有效样本逐值相等；SHA-256另用于完整性证据。':'旧方法版本 1：相邻帧有效样本的 SHA-256 相同，未进行逐值确认。'}N 帧比较 N−1 次。该比例不代表录制丢帧率、真实采集帧率或全片唯一画面比例。色彩解释标签不属于样本相等判据。</p><p id="repeat-interpretation">${interpretation}</p><p id="repeat-overview-method"></p><p>编码前是否复用同一画面无法据此判定。</p></details>
    ${r.configurationVersion===2?`<div id="repeat-differences"><h4>相邻帧最大样本差分布</h4><dl class="repeat-metrics">${Object.entries(r.differenceSummary.counts).map(([k,v])=>`<div><dt>${bandNames[k]}</dt><dd>${v.toLocaleString('zh-CN')} 次</dd></div>`).join('')}</dl><p class="hint">按每对相邻帧的最大样本码值差分档，不代表异常等级或视觉差异程度；非零差异不计作精确重复。</p></div>`:''}
    <h4>连续重复段 · ${r.frames.length<2?'无相邻帧可比较':x.runs.length?`${x.runs.length} 段`:'未发现'}</h4><p class="hint">相邻两帧或更多帧${r.configurationVersion===2?'的全部有效样本逐值相等':'的有效样本指纹相同'}，记为一段；帧序号从 0 计。</p>${pager('runs','重复段')}
    ${r.configurationVersion===2?`<h4>连续样本不变区间 · ${r.constant.segments.length} 段</h4><p class="hint">至少 2 秒由已观察的原 PTS 跨度证实；末帧 duration 不能单独把不足 2 秒的观测补成合格区间。与低变化候选可重叠，不相加。</p>${pager('constant','样本不变区间')}`:''}
    <h4>原始时间戳（PTS）与帧间隔 · ${timing}</h4>${normalTiming?`<p class="hint" id="repeat-timing-status">${timingNote}</p>`:''}<p>时间基 ${esc(r.timeBase)}；缺失 PTS ${t.missingPts} 帧；间隔不可计算 ${t.missingIntervals} 次；非递增 ${t.nonIncreasing} 次。</p>
      <p class="hint">网格只核对轨道声明的候选帧率，允许一个源时间刻度的量化误差。相容不证明 CFR 采集，间隔变化也不单独证明 VFR 来源。</p>
      ${t.grids.length?table(['候选帧率','网格核对','最大偏离（精确秒数）'],t.grids.map(g=>`<tr>${cells([g.rate,states[g.status],g.maxError?`${g.maxError.numerator}/${g.maxError.denominator}`:'未知'])}</tr>`)):'<p>轨道未声明有效的候选帧率，未进行网格核对。</p>'}
      ${pager('intervals','PTS 间隔')}<h4>最长呈现间隔（最多 20 项）</h4><p class="hint">按正的源帧 PTS 间隔排序，可定位 VFR 长保持；不设故障阈值，也不把单帧长保持增加为重复记录。</p>
      ${t.longestIntervals.length?table(['本帧','下一帧','间隔','复核'],t.longestIntervals.map(v=>`<tr>${cells([v.frame,v.nextFrame,seconds(v.ticks,r.timeBase)])}<td><button class="secondary" data-frame="${v.frame}">定位</button></td></tr>`)):'<p>没有可排序的正向帧间隔。</p>'}
    <h4>逐帧证据与 CSV · ${r.frames.length} 帧</h4><p class="hint">用于核查具体帧的原始时间戳、与前帧是否相等及样本指纹；CSV 导出全部帧，表格分页显示。</p>${pager('frames','帧证据')}
    <p id="repeat-export-status" role="status"></p></details>
    <details id="repeat-review"><summary>原帧复核</summary><div class="row"><label>显示帧序号（从 0 计）<input id="repeat-frame" type="number" min="0" max="${r.frames.length-1}" value="${Math.min(1,r.frames.length-1)}"></label><button class="secondary" id="repeat-preview">复核本帧与前帧</button><button class="secondary hidden" id="repeat-preview-cancel">取消复核</button></div>
    <p class="hint" id="repeat-preview-status">复核前检查文件身份及原生指纹；原文件须仍在原路径。预览转换为最大宽 1280 的 8-bit RGB，Alpha 不在显示差分内；不进行 HDR 显示校准，细微差异可能无法显示。</p><div id="repeat-preview-images" class="repeat-preview-images"></div></details>
  </section>`;
}

export function initRepeat(container,report,{api,download,draw}){
  const r=report.repeatAnalysis,host=container.querySelector('#repeat-result');if(!host||r.status!=='complete')return;
  const find=s=>host.querySelector(s),page={runs:0,constant:0,intervals:0,segments:0,freeze:0,frames:0},pageSize=50;
  const heads={runs:['起点帧','末帧（含）','段内帧数','额外重复次数','开始时间（原 PTS 换算）','结束时间（不含）','结束依据','复核'],intervals:['原时间刻度差','秒数','次数'],segments:['开始时间（s）','结束时间（s）','持续时间（s）','开始事件报告帧','复核'],freeze:['事件','上游秒数字符串','检测事件帧','滤镜 PTS'],frames:['显示帧','原 PTS','原时间（s）','best_effort PTS','duration','与前帧相等','SHA-256','复核']};
  if(r.configurationVersion===2)heads.frames.splice(6,0,'最大码值差','变化样本数','SAD','归一化均差','最大块归一化均差');
  heads.constant=[...heads.runs.slice(0,-1),'已观察到的原 PTS 跨度','复核'];
  const data={runs:r.exact.runs,constant:r.constant?.segments??[],intervals:r.timeline.intervals,segments:r.freeze.segments??[],freeze:r.freeze.events??[],frames:r.frames};
  const empty={runs:r.frames.length<2?'仅有一帧，无相邻帧可比较。':'未发现相邻帧有效样本完全相同的连续重复段。',intervals:'没有可计算的相邻帧间隔；请查看上方时间戳说明。',segments:`未检出达到当前阈值且持续至少 ${r.freeze.durationSeconds} s 的静止候选；这不排除更短的停顿或其他播放问题。`,freeze:'未产生静止检测事件。'};
  const row=(name,v)=>{
    let values,target=null;
    if(name==='runs'||name==='constant'){values=[v.startFrame,v.endFrame,v.frameCount,v.extraFrames,seconds(v.startPts,r.timeBase),v.endPts===null?'未知 / 开放':seconds(v.endPts,r.timeBase),{'next-original-pts':'下一不同帧的原 PTS','last-ffprobe-duration':'FFprobe末帧duration（可能经工具推断）',unknown:'边界未知'}[v.endSource]];if(name==='constant')values.push(seconds(v.observedTicks,r.timeBase));target=v.startFrame;}
    if(name==='intervals')values=[v.ticks,seconds(v.ticks,r.timeBase),v.count];
    if(name==='segments'){values=[v.start,v.end??'未报告结束（开放区间）',v.duration??'未知',v.detectedAtFrame];target=v.detectedAtFrame;}
    if(name==='freeze')values=[{start:'开始',duration:'持续时长',end:'结束'}[v.kind],v.value,v.frame,v.filterPts];
    if(name==='frames'){
      values=[v.frame,v.pts,seconds(v.pts,r.timeBase),v.bestEffortPts,v.duration,v.frame?equalPrevious(r,v)?'是':'否':'无前帧',v.sha256];target=v.frame;
      if(r.configurationVersion===2){const d=differenceDisplay(v,r.differenceConfiguration);values.splice(6,0,...['maxAbs','changed','sad','mean','maxBlockMean'].map(k=>d?.[k]??'无前帧'));}
    }
    return `<tr>${cells(values)}${target===null?'':`<td><button class="secondary" data-frame="${target}">${name==='segments'?'定位事件帧':'定位'}</button></td>`}</tr>`;
  };
  const paint=name=>{
    const pages=Math.max(1,Math.ceil(data[name].length/pageSize));page[name]=Math.max(0,Math.min(pages-1,page[name]));
    find(`[data-page-label="${name}"]`).textContent=pages>1?`${page[name]+1} / ${pages} 页 · ${data[name].length} 项`:`${data[name].length} 项`;
    find(`[data-rows="${name}"]`).innerHTML=data[name].length?table(heads[name],data[name].slice(page[name]*pageSize,(page[name]+1)*pageSize).map(v=>row(name,v))):`<p>${esc(name==='constant'?'没有由原 PTS 跨度证实达到 2 秒的连续样本不变区间。':empty[name])}</p>`;
    for(const delta of [-1,1])find(`[data-page="${name}:${delta}"]`).hidden=pages===1;
    find(`[data-page="${name}:-1"]`).disabled=page[name]===0;find(`[data-page="${name}:1"]`).disabled=page[name]===pages-1;
  };
  // Populate the shared evidence panel on demand, with at most one page per table.
  const evidence=find('#repeat-evidence');
  evidence.addEventListener('toggle',()=>{if(evidence.open)for(const name of ['runs','constant','frames','intervals'])if(find(`[data-rows="${name}"]`))paint(name);});
  find('#repeat-freeze-details')?.addEventListener('toggle',()=>{if(find('#repeat-freeze-details').open)paint('segments');});
  if(find('[data-rows="freeze"]'))find('[data-rows="freeze"]').closest('details').addEventListener('toggle',()=>{if(find('[data-rows="freeze"]').closest('details').open)paint('freeze');});
  const csv=name=>{
    const rows=data[name],parts=[...repeatCsvParts(r,name)];
    download(parts.join(''),`repeat-${name}.csv`,'text/csv;charset=utf-8');
    find('#repeat-export-status').textContent=`已导出 ${rows.length} 项证据；帧序号从 0 计。`;
  };
  const locate=frame=>{find('#repeat-review').open=true;find('#repeat-frame').value=frame;page.frames=Math.floor(frame/pageSize);paint('frames');find('#repeat-frame').focus();};
  host.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.page){const [name,delta]=button.dataset.page.split(':');page[name]+=Number(delta);paint(name);}
    if(button.dataset.csv)try{csv(button.dataset.csv);}catch(e){find('#repeat-export-status').textContent='CSV 未导出：'+e.message;}
    if(button.dataset.frame!==undefined)locate(Number(button.dataset.frame));
  });
  const width=Math.max(1,Math.ceil(Math.max(1,r.frames.length-1)/2048)),overview=[];
  const timed=!!r.timeBase&&r.timeline.status==='complete'&&r.frames.length>=2;
  const time=frame=>repeatSeconds(r.frames[frame].pts,r.timeBase);
  const regions=timed&&r.freeze.status==='complete'?r.freeze.segments.map((s,index)=>({start:Number(s.start),end:s.end===null?time(r.frames.length-1):Number(s.end),open:s.end===null,source:s,index})):[];
  const regionAt=x=>regions.find(region=>x>=region.start&&(x<region.end||(region.open&&x===region.end)));
  for(let i=1;i<r.frames.length;i++){
    const bin=Math.floor((i-1)/width),end=Math.min(r.frames.length,i+width);
    if(!overview[bin])overview[bin]=[timed?time(i-1):i,0,{startFrame:i,endFrame:end-1,end:timed?time(end-1):end,firstDuplicate:null}];
    if(equalPrevious(r,r.frames[i])){overview[bin][1]++;overview[bin][2].firstDuplicate??=i;}
  }
  const overviewMethod=`每柱统计最多 ${width} 次相邻比较中的精确重复次数；点击可定位。图表分组不改变原始计数。${timed?'横轴为原始 PTS 时间，覆盖相邻帧实际观测区间。':'横轴为显示帧序号，不重建缺失时间。'}${regions.length?'阴影为独立的持续静止候选，不改变纵轴重复次数。':''}`;
  find('#repeat-overview-note').textContent=r.exact.comparisons?`每柱最多 ${width} 次相邻比较`:'';
  find('#repeat-overview-note').title=overviewMethod;
  find('#repeat-overview-method').textContent=overviewMethod;
  draw('repeat-overview',overview,{axis:timed?'原始时间（s）':'显示帧序号（从 0 计）',unit:'重复次数',intervals:true,integerY:true,xEnd:timed?time(r.frames.length-1):r.frames.length,regions,minXSpan:timed?r.timeline.intervals.reduce((min,p)=>Math.min(min,repeatSeconds(p.ticks,r.timeBase)),1):1,describe:(p,{x})=>{
    const region=regionAt(x),s=region?.source;
    return [
    {label:'显示帧区间',value:`${p[2].startFrame}–${p[2].endFrame}`,width:18},
    {label:'精确重复次数',value:p[1],digits:0},
    ...(regions.length?[
      {label:'静止候选',value:region?`${region.index+1} / ${regions.length}`:'无',width:10},
      {label:'开始（s）',value:s?.start??'—',width:18},
      {label:'结束（s）',value:s?s.end??'未报告（开放）':'—',width:20},
      {label:'持续（s）',value:s?s.duration??'未知':'—',width:18},
    ]:[]),
  ];},onPick:(p,{x})=>locate(regionAt(x)?.source.detectedAtFrame??p[2].firstDuplicate??p[2].startFrame)});
  const button=find('#repeat-preview');
  button.onclick=async()=>{
    const frame=Number(find('#repeat-frame').value),status=find('#repeat-preview-status'),images=find('#repeat-preview-images');
    if(!Number.isSafeInteger(frame)||frame<0||frame>=r.frames.length){status.textContent='请输入有效的显示帧序号。';return;}
    const controller=new AbortController(),observer=new MutationObserver(()=>{if(!host.isConnected)controller.abort();});observer.observe(container,{childList:true});
    const cancel=find('#repeat-preview-cancel');cancel.classList.remove('hidden');cancel.onclick=()=>controller.abort();
    button.disabled=true;status.textContent='正在按原始帧序解码并核对指纹…';images.innerHTML='';
    try{
      const result=await api('repeat/preview',{method:'POST',signal:controller.signal,body:JSON.stringify({file:report.file,signature:r.source.signature,contentSha256:r.source.contentSha256,stream:r.source.stream,frame,hashes:r.frames.slice(Math.max(0,frame-1),frame+1).map(f=>f.sha256)})});
      if(!host.isConnected)return;
      status.textContent=result.note+' Alpha 不在显示差分内。';
      for(const value of result.images){
        const figure=document.createElement('figure'),img=new Image(),caption=document.createElement('figcaption');img.alt=`显示帧 ${value.frame} 的显示预览`;
        const bytes=Uint8Array.from(atob(value.image.split(',')[1]),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));
        try{img.src=url;await img.decode();}finally{URL.revokeObjectURL(url);}
        caption.textContent=`帧 ${value.frame} · 原生指纹已核对`;figure.append(img,caption);images.append(figure);
      }
      if(result.images.length===2){
        const [a,b]=images.querySelectorAll('img'),canvas=document.createElement('canvas');canvas.width=a.naturalWidth;canvas.height=a.naturalHeight;
        const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(a,0,0);const left=context.getImageData(0,0,canvas.width,canvas.height);context.drawImage(b,0,0);const right=context.getImageData(0,0,canvas.width,canvas.height);
        for(let i=0;i<left.data.length;i+=4){for(let c=0;c<3;c++)left.data[i+c]=Math.abs(left.data[i+c]-right.data[i+c]);left.data[i+3]=255;}context.putImageData(left,0,0);
        const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent='显示差分 · 8-bit RGB 绝对差（非原生测量）';canvas.setAttribute('aria-label',caption.textContent);figure.append(canvas,caption);images.append(figure);
      }
    }catch(e){if(host.isConnected)status.textContent=controller.signal.aborted?'已取消原帧复核。':'复核未完成：'+e.message;}
    finally{observer.disconnect();button.disabled=false;cancel.classList.add('hidden');cancel.onclick=null;}
  };
}
