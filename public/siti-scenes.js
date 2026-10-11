export function distribution(values){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{min:a[0],mean:a.reduce((s,x)=>s+x,0)/a.length,p05:a[Math.floor((a.length-1)*.05)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1),count:a.length}:null}

// Display-frame indices are zero based in saved data; the UI presents them from 1.
// Undefined means cuts have not been confirmed. [0] explicitly confirms one scene.
export function validateSitiSceneStarts(starts,count=null){
  if(starts===undefined)return;
  if(!Array.isArray(starts)||!starts.length||starts.length>2048||starts[0]!==0||starts.some((x,i)=>!Number.isSafeInteger(x)||x<0||x>=500000||i>0&&x<=starts[i-1]||count!==null&&x>=count))throw Error('SI/TI 场景起始帧须从第 1 帧开始、严格递增且位于视频内（最多 2048 个场景）');
}

export function sitiSceneSummary(points,starts){
  validateSitiSceneStarts(starts,points.length);
  const scenes=starts?.map((start,index)=>{
    const end=starts[index+1]??points.length,part=points.slice(start,end);
    return {index,startFrame:start,endFrame:end-1,frameCount:part.length,startTime:part[0].t,lastTime:part.at(-1).t,si:distribution(part.map(p=>p.si)),ti:distribution(part.slice(1).map(p=>p.ti))};
  })??[];
  return {sceneAnalysis:{version:1,mode:starts?'confirmed':'unconfirmed',starts:starts??null},scenes,
    si:scenes.length>1?null:distribution(points.map(p=>p.si)),ti:scenes.length>1?null:distribution(points.slice(1).map(p=>p.ti))};
}

export function validateSitiSceneResult(content,frames){
  const fail=()=>{throw Error('SI/TI 场景、逐帧值或统计与报告不一致')};
  const {sceneAnalysis:a,points}=content;
  if(a?.version!==1||!['confirmed','unconfirmed'].includes(a.mode)||!Array.isArray(points)||!points.length||points.length!==frames.length)fail();
  if(a.mode==='unconfirmed'&&a.starts!==null)fail();
  const starts=a.mode==='confirmed'?a.starts:undefined;
  validateSitiSceneStarts(starts,points.length);
  if(a.mode==='confirmed'&&starts===undefined)fail();
  const first=new Set(starts??[0]);
  for(const [i,p] of points.entries()){
    const t=frames[i]?.t,rounding=0.0000005+4*Number.EPSILON*Math.max(1,Math.abs(p.t),Math.abs(t));
    if(p.frame!==i||!Number.isFinite(p.t)||!Number.isFinite(t)||Math.abs(p.t-t)>rounding||!Number.isFinite(p.si)||p.si<0||(first.has(i)?p.ti!==null:!Number.isFinite(p.ti)||p.ti<0))fail();
  }
  const expected=sitiSceneSummary(points,starts);
  const sameStats=(actual,wanted)=>wanted===null?actual===null:actual&&Object.keys(wanted).every(k=>actual[k]===wanted[k]);
  if(!sameStats(content.si,expected.si)||!sameStats(content.ti,expected.ti)||!Array.isArray(content.scenes)||content.scenes.length!==expected.scenes.length)fail();
  for(const [i,s] of expected.scenes.entries())for(const [k,v] of Object.entries(s)){
    const actual=content.scenes[i]?.[k];
    if(k==='si'||k==='ti'){if(!sameStats(actual,v))fail()}else if(actual!==v)fail();
  }
}
