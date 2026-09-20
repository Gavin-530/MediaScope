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
export function trialValue(row,key){
 const v=key==='videoKiB'?row.videoBytes/1024:['psnr','ssim','vmaf'].includes(key)?row.metrics[key]?.pooled:row[key];
 return typeof v==='number'&&Number.isFinite(v)?v:null;
}
export function trialPlotData(rows,xKey,yKey){
 const names=[...new Set(rows.map(rowLabel))],colors=['#80e1c4','#edbe75','#76a9ed','#ed94bb','#ad94e7','#e89876','#a0c975','#a6c8dd'];
 return {series:names.map((name,id)=>({id,name,color:colors[id%colors.length]})),
  data:rows.map(row=>[trialValue(row,xKey),trialValue(row,yKey),row,names.indexOf(rowLabel(row))]).filter(p=>p[0]!==null).sort((a,b)=>a[0]-b[0])};
}
