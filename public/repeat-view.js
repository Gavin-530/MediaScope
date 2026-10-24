import {repeatSeconds} from './repeat-model.js';
import {maxPortableBytes} from './portable.js';

const esc=v=>String(v??'未知').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const seconds=(ticks,tb)=>{const s=repeatSeconds(ticks,tb);return s===null?'未知':`${s.toLocaleString('zh-CN',{maximumFractionDigits:6})} s`;};
const table=(heads,rows)=>`<div class="table-wrap"><table><thead><tr>${heads.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const cells=values=>values.map(v=>`<td>${esc(v)}</td>`).join('');
const states={complete:'已完成',partial:'部分可用',unavailable:'不可用',unsupported:'不支持',failed:'失败','not-requested':'本次未选择',compatible:'相容',incompatible:'不相容',undetermined:'不能判断'};
const pager=(name,label)=>`<div class="pager"><button class="secondary" data-page="${name}:-1">上一页</button><span data-page-label="${name}"></span><button class="secondary" data-page="${name}:1">下一页</button><button class="secondary" data-csv="${name}">导出${label} CSV</button></div><div data-rows="${name}"></div>`;

export function repeatHTML(r){
  if(r.status!=='complete')return `<section class="section" id="repeat-result"><h3>重复帧与时间诊断</h3><p>不支持：${esc(r.reason)}</p></section>`;
  const x=r.exact,t=r.timeline,f=r.freeze;
  return `<section class="section" id="repeat-result"><h3>重复帧与时间诊断</h3>
    <div class="cards">${[['分析帧数',x.frames],['相邻比较次数',x.comparisons],['精确重复次数',x.duplicates],['精确重复比例',x.ratio===null?'不可计算':(x.ratio*100).toLocaleString('zh-CN',{maximumFractionDigits:4})+'%'],['连续重复段',x.runs.length]].map(([k,v])=>`<div class="card"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
    <p class="hint">原生 ${esc(r.source.pixelFormat)} · ${r.sampleFormat.depth}-bit${r.sampleFormat.alpha?' · 包含 Alpha':''}。精确重复指相邻帧有效样本的 SHA-256 相同；N 帧比较 N−1 次。该比例不代表录制丢帧率、真实采集帧率或全片唯一画面比例。色彩解释标签不属于样本相等判据。</p>
    <h4>精确重复分布（按显示帧序号）</h4><p class="hint" id="repeat-overview-note"></p><div id="repeat-overview"></div>
    <details open><summary>连续重复段（帧序号从 0 计）</summary>${pager('runs','重复段')}</details>
    <details><summary>原始 PTS 与间隔诊断 · ${states[t.status]}</summary><p>时间基 ${esc(r.timeBase)}；缺失 PTS ${t.missingPts} 帧；间隔不可计算 ${t.missingIntervals} 次；非递增 ${t.nonIncreasing} 次。</p>
      <p class="hint">网格只核对轨道声明的候选帧率；允许一个源时间刻度的量化误差。相容不证明 CFR 采集，间隔变化也不单独证明 VFR 来源。原始 PTS 与哈希输出时间分别保存。</p>
      ${table(['候选帧率','网格核对','最大偏离（精确秒数）'],t.grids.map(g=>`<tr>${cells([g.rate,states[g.status],g.maxError?`${g.maxError.numerator}/${g.maxError.denominator}`:'未知'])}</tr>`))}
      ${pager('intervals','PTS 间隔')}<h4>最长呈现间隔（最多 20 项）</h4><p class="hint">按正的源帧 PTS 间隔排序，可定位 VFR 长保持；不设故障阈值，也不把单帧长保持增加为重复记录。</p>
      ${table(['本帧','下一帧','间隔','复核'],t.longestIntervals.map(v=>`<tr>${cells([v.frame,v.nextFrame,seconds(v.ticks,r.timeBase)])}<td><button class="secondary" data-frame="${v.frame}">定位</button></td></tr>`))}</details>
    <details><summary>持续静止候选 · ${states[f.status]}</summary>${f.status==='complete'?`<p class="hint">FFmpeg freezedetect：noise=${f.noise}，duration=${f.durationSeconds} s。带阈值的候选，不鉴定故障；事件时间来自上游有限精度字符串。检测事件帧不是起点帧，EOF 开放区间不补结束。</p>${pager('freeze','静止事件')}`:`<p>${esc(f.reason??'本次未选择持续静止候选。')}</p>`}</details>
    <details><summary>逐帧证据与 CSV</summary>${pager('frames','帧证据')}</details>
    <p id="repeat-export-status" role="status"></p>
    <h4>原帧复核（按需解码）</h4><div class="row"><label>显示帧序号（从 0 计）<input id="repeat-frame" type="number" min="0" max="${r.frames.length-1}" value="${Math.min(1,r.frames.length-1)}"></label><button class="secondary" id="repeat-preview">复核本帧与前帧</button><button class="secondary hidden" id="repeat-preview-cancel">取消复核</button></div>
    <p class="hint" id="repeat-preview-status">复核前检查文件身份及原生指纹；原文件须仍在原路径。预览转换为最大宽 1280 的 8-bit RGB，Alpha 不在显示差分内；不进行 HDR 显示校准，细微差异可能无法显示。</p><div id="repeat-preview-images" class="repeat-preview-images"></div>
    <details><summary>方法与证据口径</summary><p>配置 ${r.configurationVersion} · ${esc(r.algorithm)}。完整报告保存逐帧指纹、有效样本描述、原始与输出时间、静止事件和实际命令；CSV 分别导出各证据表。任何预览或显示差分都不参与分析。</p><p>文件身份核查采用设备、文件标识、长度及纳秒修改时间的摘要，用于检测文件变化；不属于文件内容签名或第三方认证。</p></details>
  </section>`;
}

export function initRepeat(container,report,{api,download,draw}){
  const r=report.repeatAnalysis,host=container.querySelector('#repeat-result');if(!host||r.status!=='complete')return;
  const find=s=>host.querySelector(s),page={runs:0,intervals:0,freeze:0,frames:0},pageSize=50;
  const heads={runs:['起点帧','末帧（含）','段内帧数','额外重复次数','开始时间（原 PTS 换算）','结束时间（不含）','结束依据','复核'],intervals:['原时间刻度差','秒数','次数'],freeze:['事件','上游秒数字符串','检测事件帧','滤镜 PTS'],frames:['显示帧','原 PTS','原时间（s）','best_effort PTS','duration','与前帧相等','SHA-256','复核']};
  const data={runs:r.exact.runs,intervals:r.timeline.intervals,freeze:r.freeze.events??[],frames:r.frames};
  const row=(name,v)=>{
    let values,target=null;
    if(name==='runs'){values=[v.startFrame,v.endFrame,v.frameCount,v.extraFrames,seconds(v.startPts,r.timeBase),v.endPts===null?'未知 / 开放':seconds(v.endPts,r.timeBase),{'next-original-pts':'下一不同帧的原 PTS','last-ffprobe-duration':'FFprobe末帧duration（可能经工具推断）',unknown:'边界未知'}[v.endSource]];target=v.startFrame;}
    if(name==='intervals')values=[v.ticks,seconds(v.ticks,r.timeBase),v.count];
    if(name==='freeze')values=[v.kind,v.value,v.frame,v.filterPts];
    if(name==='frames'){values=[v.frame,v.pts,seconds(v.pts,r.timeBase),v.bestEffortPts,v.duration,v.frame?r.frames[v.frame-1].sha256===v.sha256?'是':'否':'无前帧',v.sha256];target=v.frame;}
    return `<tr>${cells(values)}${target===null?'':`<td><button class="secondary" data-frame="${target}">定位</button></td>`}</tr>`;
  };
  const paint=name=>{
    const pages=Math.max(1,Math.ceil(data[name].length/pageSize));page[name]=Math.max(0,Math.min(pages-1,page[name]));
    find(`[data-page-label="${name}"]`).textContent=`${page[name]+1} / ${pages} 页 · ${data[name].length} 项`;
    find(`[data-rows="${name}"]`).innerHTML=table(heads[name],data[name].slice(page[name]*pageSize,(page[name]+1)*pageSize).map(v=>row(name,v)));
    find(`[data-page="${name}:-1"]`).disabled=page[name]===0;find(`[data-page="${name}:1"]`).disabled=page[name]===pages-1;
  };
  // Render optional large tables when expanded, never insert a whole video into the DOM.
  paint('runs');for(const name of ['frames','intervals','freeze'])if(find(`[data-rows="${name}"]`))find(`[data-rows="${name}"]`).closest('details').addEventListener('toggle',()=>{if(find(`[data-rows="${name}"]`).closest('details').open)paint(name);});
  const csv=name=>{
    const rows=data[name],columns=name==='frames'?['frame','pts','bestEffortPts','duration','durationSource','sha256','hashPts','hashDuration','hashBytes','interpretation']:Object.keys(rows[0]??(name==='runs'?{startFrame:0,endFrame:0,frameCount:0,extraFrames:0,startPts:null,endPts:null,endSource:null}:name==='intervals'?{ticks:null,count:0}:{kind:null,value:null,frame:0,filterPts:null}));
    const quote=v=>'"'+String(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):v).replaceAll('"','""')+'"';
    const context={configurationVersion:r.configurationVersion,timeBase:r.timeBase,hashTimeBase:r.hashTimeBase,pixelFormat:r.source.pixelFormat,sourceSignature:r.source.signature},keys=[...Object.keys(context),...columns],parts=['\uFEFF'+keys.map(quote).join(',')+'\r\n'],encoder=new TextEncoder();let bytes=encoder.encode(parts[0]).length;
    for(const value of rows){const row={...context,...value},line=keys.map(k=>quote(row[k])).join(',')+'\r\n';bytes+=encoder.encode(line).length;if(bytes>maxPortableBytes)throw Error('CSV 超过256MB边界，未导出；请缩小分析范围。');parts.push(line);}
    download(parts.join(''),`repeat-${name}.csv`,'text/csv;charset=utf-8');
    find('#repeat-export-status').textContent=`已导出 ${rows.length} 项证据；帧序号从 0 计。`;
  };
  const locate=frame=>{find('#repeat-frame').value=frame;page.frames=Math.floor(frame/pageSize);paint('frames');find('#repeat-frame').focus();};
  host.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.dataset.page){const [name,delta]=button.dataset.page.split(':');page[name]+=Number(delta);paint(name);}
    if(button.dataset.csv)try{csv(button.dataset.csv);}catch(e){find('#repeat-export-status').textContent='CSV 未导出：'+e.message;}
    if(button.dataset.frame!==undefined)locate(Number(button.dataset.frame));
  });
  const width=Math.max(1,Math.ceil(Math.max(1,r.frames.length-1)/2048)),overview=[];
  for(let i=1;i<r.frames.length;i++){
    const bin=Math.floor((i-1)/width);if(!overview[bin])overview[bin]=[i,0,{end:Math.min(r.frames.length,i+width),firstDuplicate:null}];
    if(r.frames[i].sha256===r.frames[i-1].sha256){overview[bin][1]++;overview[bin][2].firstDuplicate??=i;}
  }
  find('#repeat-overview-note').textContent=`每柱统计最多 ${width} 次相邻比较中的精确重复次数；点击可定位。图表分组不改变原始计数。`;
  draw('repeat-overview',overview,{axis:'显示帧序号（从 0 计）',unit:'重复次数',intervals:true,xEnd:r.frames.length,describe:p=>`帧 ${p[0]}–${p[2].end-1}：${p[1]} 次精确重复`,onPick:p=>locate(p[2].firstDuplicate??p[0])});
  const button=find('#repeat-preview');
  button.onclick=async()=>{
    const frame=Number(find('#repeat-frame').value),status=find('#repeat-preview-status'),images=find('#repeat-preview-images');
    if(!Number.isSafeInteger(frame)||frame<0||frame>=r.frames.length){status.textContent='请输入有效的显示帧序号。';return;}
    const controller=new AbortController(),observer=new MutationObserver(()=>{if(!host.isConnected)controller.abort();});observer.observe(container,{childList:true});
    const cancel=find('#repeat-preview-cancel');cancel.classList.remove('hidden');cancel.onclick=()=>controller.abort();
    button.disabled=true;status.textContent='正在按原始帧序解码并核对指纹…';images.innerHTML='';
    try{
      const result=await api('repeat/preview',{method:'POST',signal:controller.signal,body:JSON.stringify({file:report.file,signature:r.source.signature,stream:r.source.stream,frame,hashes:r.frames.slice(Math.max(0,frame-1),frame+1).map(f=>f.sha256)})});
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
