export function parseCrfs(text){
 const tokens=text.trim().split(/[,，\s]+/).filter(Boolean),values=[];
 for(const token of tokens){
  if(!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?)?$/.test(token))throw Error('CRF 格式：18,22,26 或 起点:终点:步长，例如 18:30:2');
  const parts=token.split(':').map(Number);
  if(parts.length===1)values.push(parts[0]);
  else{const [start,end,step=1]=parts;if(step<=0||end<start)throw Error('CRF 范围须递增，步长须大于 0');const count=Math.floor((end-start)/step+1e-9)+1;if(count>12)throw Error('最多 12 个 CRF');for(let i=0;i<count;i++)values.push(Number((start+i*step).toFixed(6)));}
  if(values.length>12)throw Error('最多 12 个 CRF');
 }
 if(!values.length||new Set(values).size!==values.length)throw Error('请填写 1–12 个不重复的 CRF');
 return values;
}
export const rowLabel=row=>`${row.bitDepth?row.bitDepth+'-bit':'原生位深'} / ${row.preset??'默认预设'}`;
export const metricLabels={psnr:'PSNR（dB）↑',ssim:'SSIM（无量纲）↑',vmaf:'VMAF（模型分数）↑'};
export const trialSortFields={group:'位深 / preset',crf:'CRF',videoBytes:'视频包体积',videoMbps:'视频码率',psnr:'PSNR',ssim:'SSIM',vmaf:'VMAF',encodeSeconds:'编码耗时',encodeFps:'编码速度'};
export function sortTrialRows(rows,key='group',direction='asc'){
 const value=row=>key==='group'?rowLabel(row):['psnr','ssim','vmaf'].includes(key)?row.metrics[key]?.pooled:row[key];
 const missing=v=>v==null||(key!=='group'&&v!=='Infinity'&&!Number.isFinite(typeof v==='number'?v:Number(v)));
 return rows.map((row,index)=>({row,index,value:value(row)})).sort((a,b)=>{
  const am=missing(a.value),bm=missing(b.value);if(am!==bm)return am?1:-1;if(am&&bm)return a.index-b.index;
  const compared=key==='group'?String(a.value).localeCompare(String(b.value),'zh-CN',{numeric:true}):a.value===b.value?0:a.value==='Infinity'?1:b.value==='Infinity'?-1:Number(a.value)-Number(b.value);
  return (direction==='desc'?-compared:compared)||a.index-b.index;
 }).map(x=>x.row);
}
const colors=['#80e1c4','#edbe75','#76a9ed','#ed94bb','#ad94e7','#e89876','#a0c975','#a6c8dd','#eee69a','#b9bdff','#eea7a7','#a0d8e8'];
export function trialFramePlotData(rows,metric,group,crfs,frameTimes){
 const selected=rows.filter(row=>rowLabel(row)===group&&crfs.includes(row.crf)).sort((a,b)=>a.crf-b.crf);
 const timed=Array.isArray(frameTimes)&&frameTimes.length>0&&frameTimes.every((t,i)=>Number.isFinite(t)&&(i===0||t>frameTimes[i-1]))&&selected.every(row=>!row.metrics[metric]?.values||row.metrics[metric].values.length===frameTimes.length);
 const allCrfs=[...new Set(rows.map(row=>row.crf))].sort((a,b)=>a-b);
 const series=selected.map((row,id)=>({id,name:`CRF ${row.crf}`,color:colors[allCrfs.indexOf(row.crf)%colors.length],dash:allCrfs.indexOf(row.crf)%3===0?[]:allCrfs.indexOf(row.crf)%3===1?[6,3]:[2,3]}));
 const missing=selected.filter(row=>!Array.isArray(row.metrics[metric]?.values)).map(row=>row.crf);
 const data=selected.flatMap((row,id)=>(row.metrics[metric]?.values||[]).map((v,i)=>[timed?frameTimes[i]:i,Number.isFinite(v)?v:null,{frame:i,crf:row.crf,value:v},id])).sort((a,b)=>a[0]-b[0]);
 return {data,series,missing,timed};
}
export function trialValue(row,key){
 const v=key==='videoKiB'?row.videoBytes/1024:['psnr','ssim','vmaf'].includes(key)?row.metrics[key]?.pooled:row[key];
 return typeof v==='number'&&Number.isFinite(v)?v:null;
}
export function trialPlotData(rows,xKey,yKey){
 const names=[...new Set(rows.map(rowLabel))];
 return {series:names.map((name,id)=>({id,name,color:colors[id%colors.length]})),
  data:rows.map(row=>[trialValue(row,xKey),trialValue(row,yKey),row,names.indexOf(rowLabel(row))]).filter(p=>p[0]!==null).sort((a,b)=>a[0]-b[0])};
}
