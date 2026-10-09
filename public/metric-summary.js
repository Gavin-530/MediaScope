// Read FFmpeg's internal aggregate output, never reconstruct it from rounded frames.
export function parseMetricSummary(metric,raw) {
  const fail=()=>{throw Error(`${String(metric).toUpperCase()} 官方汇总缺失或异常，结果不予采纳`)};
  if(!['psnr','ssim'].includes(metric)||typeof raw!=='string')fail();
  const match=raw.match(metric==='psnr'?/^PSNR (.+) average:(\S+) min:(\S+) max:(\S+)$/:/^SSIM (.+) All:(\S+) \((\S+)\)$/);
  if(!match)fail();
  const tokens=match[1].match(metric==='psnr'?/[yrgbuva]:\S+/g:/[YRGBUVA]:\S+ \(\S+\)/g);
  if(!tokens?.length||tokens.join(' ')!==match[1])fail();
  if(metric==='ssim'&&[...raw.matchAll(/\(([^)]+)\)/g)].some(m=>!/^(?:-?\d+(?:\.\d+)?|inf)$/.test(m[1])))fail();
  const read=text=>{
    if(!/^(?:-?\d+(?:\.\d+)?|inf)$/.test(text))fail();
    const value=Number(text==='inf'?'Infinity':text);
    if(!Number.isFinite(value)&&!(metric==='psnr'&&value===Infinity))fail();
    return value===Infinity?'Infinity':value;
  };
  const components=Object.fromEntries(tokens.map(token=>{const [,key,value]=token.match(/^([a-z]):([^\s]+)/i);return [key.toLowerCase(),read(value)]}));
  if(!['y','yuv','yuva','rgb','rgba'].includes(Object.keys(components).join(''))||tokens.length!==Object.keys(components).length)fail();
  const summary={raw,pooled:read(match[2]),components};
  if(metric==='psnr'){
    summary.min=read(match[3]);summary.max=read(match[4]);
    if(Number(summary.min)>Number(summary.pooled)||Number(summary.pooled)>Number(summary.max))fail();
  }
  return summary;
}
