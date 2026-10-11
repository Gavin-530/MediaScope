// These checks apply equally to CPU, GPU and recovered SI/TI results.
export function sitiTimestamp(pts,timeBase){
  const base=/^(\d+)\/(\d+)$/.exec(timeBase??'');
  const ticks=/^-?\d+$/.test(String(pts))?Number(pts):NaN;
  const numerator=base?Number(base[1]):NaN,denominator=base?Number(base[2]):NaN;
  if(!Number.isSafeInteger(ticks)||!Number.isSafeInteger(numerator)||numerator<=0||!Number.isSafeInteger(denominator)||denominator<=0)throw Error('SI/TI 整数 PTS 或时间基无效');
  const t=ticks*(numerator/denominator);
  if(!Number.isFinite(t))throw Error('SI/TI 帧时间戳无效');
  return t;
}

export function validateSitiPoints(points,frames=null,{firstTi=0,sceneStarts=[]}={}){
  if(!Array.isArray(points)||!points.length||points.length>500000)throw Error('SI/TI 结果帧数无效');
  if(frames!==null&&(!Array.isArray(frames)||points.length!==frames.length))throw Error('SI/TI 结果帧数与预扫描不一致');
  const starts=new Set(sceneStarts);
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(!p||p.frame!==i)throw Error(`SI/TI 第 ${i+1} 帧序号无效`);
    if(!Number.isFinite(p.t))throw Error(`SI/TI 第 ${i+1} 帧时间戳无效`);
    const noFirstTi=firstTi===null&&(i===0||starts.has(i));
    if(!Number.isFinite(p.si)||p.si<0||!noFirstTi&&(!Number.isFinite(p.ti)||p.ti<0))throw Error(`SI/TI 第 ${i+1} 帧指标无效`);
    if(i===0&&p.ti!==firstTi)throw Error(firstTi===null?'P.910 首帧没有 TI 值':'SI/TI 首帧 TI 必须为零');
    if(noFirstTi&&p.ti!==null)throw Error('P.910 场景首帧没有 TI 值');
    if(frames!==null){
      const expected=frames[i]?.t;
      if(!Number.isFinite(expected))throw Error(`SI/TI 预扫描第 ${i+1} 帧时间戳无效`);
      // FFprobe prints seconds to six decimal places. Account only for that
      // half-microsecond rounding and floating-point arithmetic, not frame drift.
      const rounding=0.0000005+4*Number.EPSILON*Math.max(1,Math.abs(p.t),Math.abs(expected));
      if(Math.abs(p.t-expected)>rounding)throw Error(`SI/TI 第 ${i+1} 帧时间戳与预扫描不一致`);
    }
  }
}
