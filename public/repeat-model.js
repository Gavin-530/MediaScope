// Integer sample fingerprints and original timestamp evidence. No colour conversion,
// FPS reconstruction, content-origin inference, or approximate duplicate classifier.
import {MAX_ANALYSIS_FRAMES} from './analysis-limits.js';
import {differenceConfiguration,differenceSummary,validateDifferenceFrame,SOURCE_CLASSIFICATION} from './repeat-difference.js';
import {genericRepeatAlgorithm,validateFrameFingerprint,validFrameDigest} from './repeat-fingerprint.js';
import {validateReportMetadata} from './report-extensions.js';

const integer = value => typeof value === 'string' && value.length <= 128 && /^-?\d+$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const abs = n => n < 0n ? -n : n;
const gcd = (a,b) => { a=abs(a); b=abs(b); while(b)[a,b]=[b,a%b]; return a; };
export function repeatRational(value) {
  const m = /^(\d+)\/(\d+)$/.exec(value ?? '');
  if(!m || m[1].length>32 || m[2].length>32) return null;
  const n=BigInt(m[1]),d=BigInt(m[2]);
  if(n<=0n || d<=0n) return null;
  const g=gcd(n,d); return {n:n/g,d:d/g};
}
export function rationalEvidence(n,d) {
  const g=gcd(n,d); return {numerator:String(n/g),denominator:String(d/g)};
}
export function repeatSeconds(ticks,timeBase) {
  const tb=repeatRational(timeBase);
  if(!tb || !integer(ticks)) return null;
  const value=Number(BigInt(ticks)*tb.n)/Number(tb.d);
  return Number.isFinite(value)?value:null;
}
export function repeatFrameFormat(name,width,height) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1) return null;
  let depth=8,storage=1,alpha=false,shift=0,endian='le',planes=[],m;
  const plane=(w,h,components=1)=>({width:w,height:h,components});
  if((m=/^(yuv|yuva)(420|422|444)p(?:(9|10|12|14|16)(le|be))?$/.exec(name??''))) {
    depth=Number(m[3]??8); storage=depth>8?2:1; endian=m[4]??'le'; alpha=m[1]==='yuva';
    const [sx,sy]=m[2]==='420'?[2,2]:m[2]==='422'?[2,1]:[1,1];
    planes=[plane(width,height),plane(Math.ceil(width/sx),Math.ceil(height/sy)),plane(Math.ceil(width/sx),Math.ceil(height/sy))];
    if(alpha)planes.push(plane(width,height));
  } else if((m=/^gray(?:(9|10|12|14|16)(le|be))?$/.exec(name??''))) {
    depth=Number(m[1]??8);storage=depth>8?2:1;endian=m[2]??'le';planes=[plane(width,height)];
  } else if((m=/^gbr(a)?p(?:(9|10|12|14|16)(le|be))?$/.exec(name??''))) {
    depth=Number(m[2]??8);storage=depth>8?2:1;endian=m[3]??'le';alpha=!!m[1];
    planes=Array.from({length:alpha?4:3},()=>plane(width,height));
  } else if(['rgb24','bgr24','rgba','bgra','argb','abgr'].includes(name)) {
    alpha=name.length===4;planes=[plane(width,height,alpha?4:3)];
  } else if(['nv12','nv21'].includes(name)) {
    planes=[plane(width,height),plane(Math.ceil(width/2),Math.ceil(height/2),2)];
  } else if((m=/^p0(10|12|16)(le|be)$/.exec(name??''))) {
    depth=Number(m[1]);storage=2;shift=16-depth;endian=m[2];
    planes=[plane(width,height),plane(Math.ceil(width/2),Math.ceil(height/2),2)];
  } else return null;
  const samples=planes.reduce((n,p)=>n+p.width*p.height*p.components,0),bytes=samples*storage;
  if(!Number.isSafeInteger(bytes)||bytes<1) return null;
  const used=((2**depth-1)*2**shift)>>>0;
  return {pixelFormat:name,width,height,depth,storage,endian,alpha,shift,planes,samples,bytes,paddingMask:storage===2?(0xffff^used):0};
}

function* runBoundarySteps(frames,start,end) {
  let valid=integer(frames[start].pts),last=valid?BigInt(frames[start].pts):null;
  for(let i=start+1;i<=end;i++) {
    if(i%8192===0)yield;
    if(!integer(frames[i].pts)||last===null||BigInt(frames[i].pts)<=last){valid=false;break;}
    last=BigInt(frames[i].pts);
  }
  let endPts=null,endSource='unknown';
  if(valid) {
    if(end+1<frames.length&&integer(frames[end+1].pts)&&BigInt(frames[end+1].pts)>last) {
      endPts=frames[end+1].pts;endSource='next-original-pts';
    } else if(end===frames.length-1&&integer(frames[end].duration)&&BigInt(frames[end].duration)>0n) {
      endPts=String(last+BigInt(frames[end].duration));endSource='last-ffprobe-duration';
    }
  }
  return {startPts:integer(frames[start].pts)?frames[start].pts:null,endPts,endSource};
}

function finish(iterator){let step;do{step=iterator.next();}while(!step.done);return step.value;}
export function repeatExactSummary(frames,confirmed=false){return finish(repeatExactSummarySteps(frames,confirmed));}
export function* repeatExactSummarySteps(frames,confirmed=false) {
  let duplicates=0,start=null;
  const runs=[];
  const close=function*(end){runs.push({startFrame:start,endFrame:end,frameCount:end-start+1,extraFrames:end-start,...yield* runBoundarySteps(frames,start,end)});start=null;};
  for(let i=1;i<frames.length;i++) {
    if(i%8192===0)yield;
    if(confirmed?frames[i].equalPrevious:frames[i].sha256===frames[i-1].sha256) {duplicates++;if(start===null)start=i-1;}
    else if(start!==null)yield* close(i-1);
  }
  if(start!==null)yield* close(frames.length-1);
  const comparisons=Math.max(0,frames.length-1);
  return {frames:frames.length,comparisons,duplicates,ratio:comparisons?duplicates/comparisons:null,runs};
}

// A lower bound from observed source PTS only. A guessed final duration cannot
// turn a short observation into a confirmed two-second constant interval.
export function repeatConstantSegments(frames,timeBase,exact){return finish(repeatConstantSegmentsSteps(frames,timeBase,exact));}
export function* repeatConstantSegmentsSteps(frames,timeBase,exact) {
  const tb=repeatRational(timeBase),segments=[];let unresolvedRuns=0;
  for(const run of exact.runs){
    let valid=!!tb;
    for(let i=run.startFrame;i<=run.endFrame;i++){
      if(i%8192===0)yield;
      if(!integer(frames[i].pts)||i>run.startFrame&&(!integer(frames[i-1].pts)||BigInt(frames[i].pts)<=BigInt(frames[i-1].pts)))valid=false;
    }
    if(!valid){unresolvedRuns++;continue;}
    const observedEndPts=run.endSource==='next-original-pts'?run.endPts:frames[run.endFrame].pts;
    const observedTicks=BigInt(observedEndPts)-BigInt(run.startPts);
    if(observedTicks*tb.n>=2n*tb.d)segments.push({...run,observedEndPts,observedTicks:String(observedTicks)});
  }
  return {method:'sample-constant-original-pts-v1',minimumSeconds:2,status:!tb||!frames.some(f=>integer(f.pts))?'unavailable':unresolvedRuns?'partial':'complete',unresolvedRuns,segments};
}

export function repeatTimeline(frames,timeBase,rates=[]){return finish(repeatTimelineSteps(frames,timeBase,rates));}
export function* repeatTimelineSteps(frames,timeBase,rates=[]) {
  const tb=repeatRational(timeBase),counts=new Map(),longestIntervals=[];
  let missingPts=0,missingIntervals=0,nonIncreasing=0;
  for(let i=0;i<frames.length;i++) {
    if(i%8192===0)yield;
    if(!integer(frames[i].pts))missingPts++;
    if(i) {
      if(!integer(frames[i].pts)||!integer(frames[i-1].pts)) {missingIntervals++;continue;}
      const ticks=BigInt(frames[i].pts)-BigInt(frames[i-1].pts);
      if(ticks<=0n)nonIncreasing++;
      const key=String(ticks);counts.set(key,(counts.get(key)??0)+1);
      if(ticks>0n&&(longestIntervals.length<20||ticks>BigInt(longestIntervals.at(-1).ticks))){
        longestIntervals.push({frame:i-1,nextFrame:i,ticks:key,startPts:frames[i-1].pts,endPts:frames[i].pts});
        longestIntervals.sort((a,b)=>BigInt(a.ticks)>BigInt(b.ticks)?-1:BigInt(a.ticks)<BigInt(b.ticks)?1:a.frame-b.frame);
        if(longestIntervals.length>20)longestIntervals.pop();
      }
    }
  }
  const intervals=[...counts].sort((a,b)=>BigInt(a[0])<BigInt(b[0])?-1:BigInt(a[0])>BigInt(b[0])?1:0).map(([ticks,count])=>({ticks,count}));
  const unique=[];
  for(const text of rates) {const r=repeatRational(text);if(r&&!unique.some(x=>x.n===r.n&&x.d===r.d))unique.push(r);}
  const grids=[];
  for(const rate of unique){
    const result={rate:`${rate.n}/${rate.d}`,status:'undetermined',maxError:null};
    if(!tb||frames.length<2||missingPts||nonIncreasing||tb.n*rate.n>=tb.d*rate.d){grids.push(result);continue;}
    let maximum=0n;
    for(let i=1;i<frames.length;i++) {
      if(i%8192===0)yield;
      const error=abs((BigInt(frames[i].pts)-BigInt(frames[0].pts))*tb.n*rate.n-BigInt(i)*tb.d*rate.d);
      if(error>maximum)maximum=error;
    }
    grids.push({...result,status:maximum<=tb.n*rate.n?'compatible':'incompatible',maxError:rationalEvidence(maximum,tb.d*rate.n)});
  }
  return {status:!tb||missingPts===frames.length?'unavailable':missingPts||nonIncreasing?'partial':'complete',missingPts,missingIntervals,nonIncreasing,intervals,longestIntervals,grids};
}

export function repeatFreezeSegments(events) {
  const segments=[];let current=null;
  for(const event of events) {
    if(event.kind==='start') {
      if(current)throw Error('持续静止事件重复开始');
      current={start:event.value,end:null,duration:null,detectedAtFrame:event.frame,endDetectedAtFrame:null};segments.push(current);
    } else if(event.kind==='duration') {
      if(!current||current.duration!==null)throw Error('持续静止持续时间缺少对应开始');
      current.duration=event.value;
    } else if(event.kind==='end') {
      if(!current)throw Error('持续静止结束缺少对应开始');
      current.end=event.value;current.endDetectedAtFrame=event.frame;current=null;
    } else throw Error('持续静止事件类型无效');
  }
  return segments;
}

function same(a,b) {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
}
export function validateRepeatAnalysis(value,stream){return finish(validateRepeatAnalysisSteps(value,stream));}
export function* validateRepeatAnalysisSteps(value,stream) {
  const fail=message=>{throw Error(`重复画面报告无效：${message}`);};
  if(!value||![1,2].includes(value.configurationVersion)||!['complete','unsupported'].includes(value.status)||!value.source||typeof value.source.signature!=='string'||!hash(value.source.signature))fail('配置/来源');
  const confirmed=value.configurationVersion===2;
  const generic=Object.hasOwn(value,'fingerprint');
  if(generic){if(!confirmed||value.algorithm!==genericRepeatAlgorithm)fail('摘要配置与方法不一致');validateFrameFingerprint(value.fingerprint);}
  if(value.extensions!==undefined)validateReportMetadata(value.extensions);
  if(!stream||value.source.stream!==stream.index||value.source.pixelFormat!==stream.pix_fmt||value.source.width!==stream.width||value.source.height!==stream.height)fail('轨道/格式');
  if(value.status==='unsupported') {if(typeof value.reason!=='string'||!value.reason||value.frames!==undefined)fail('不支持状态');return;}
  const format=repeatFrameFormat(value.source.pixelFormat,value.source.width,value.source.height);
  if(!format||!same(value.sampleFormat,format)||!generic&&value.algorithm!==(confirmed?'native-bytes-equal+FFmpeg/rawvideo/framehash/SHA256':'FFmpeg/rawvideo/framehash/SHA256'))fail('样本表示');
  if(confirmed&&(!hash(value.source.contentSha256)||!same(value.differenceConfiguration,differenceConfiguration(format))))fail('原生比较配置/内容身份');
  if(!Array.isArray(value.frames)||value.frames.length<1||value.frames.length>MAX_ANALYSIS_FRAMES)fail('显示帧');
  for(const [i,f]of value.frames.entries()) {
    if(i%8192===0)yield;
    if(!f||f.frame!==i||(generic?!validFrameDigest(f.digest,value.fingerprint)||Object.hasOwn(f,'sha256'):!hash(f.sha256)||Object.hasOwn(f,'digest'))||![f.pts,f.bestEffortPts,f.duration].every(x=>x===null||integer(x))||!integer(f.hashPts)||!integer(f.hashDuration)||f.hashBytes!==format.bytes||!['duration','pkt_duration',null].includes(f.durationSource)||(f.duration===null)!==(f.durationSource===null)||!Array.isArray(f.interpretation)||f.interpretation.length!==4||f.interpretation.some(v=>v!==null&&(typeof v!=='string'||v.length>80)))fail(`帧${i}`);
    if(confirmed){validateDifferenceFrame(f,value.differenceConfiguration,i);if(i&&f.equalPrevious&&(generic?f.digest!==value.frames[i-1].digest:f.sha256!==value.frames[i-1].sha256))fail('相等样本摘要不一致');}
  }
  if(value.timeBase!==(repeatRational(stream.time_base)?stream.time_base:null)||!repeatRational(value.hashTimeBase)||!same(value.gridRates,[stream.r_frame_rate,stream.avg_frame_rate].filter(v=>typeof v==='string')))fail('时间基/候选帧率');
  if(!same(value.exact,yield* repeatExactSummarySteps(value.frames,confirmed))||!same(value.timeline,yield* repeatTimelineSteps(value.frames,value.timeBase,value.gridRates)))fail('派生计数/区间/时间统计');
  if(confirmed){
    if(!same(value.differenceSummary,differenceSummary(value.frames))||!same(value.constant,yield* repeatConstantSegmentsSteps(value.frames,value.timeBase,value.exact))||!same(value.sourceClassification,SOURCE_CLASSIFICATION))fail('差异/样本不变区间统计/来源分类资格');
    if(!Array.isArray(value.tools)||value.tools.length<3||value.tools.length>(generic?32:3)||value.tools.some(t=>!t||typeof t.role!=='string'||(generic?!/^[a-z][a-z0-9._/-]{0,79}$/.test(t.role):!['ffmpeg','ffprobe','node'].includes(t.role))||typeof t.path!=='string'||!t.path||!hash(t.sha256))||new Set(value.tools.map(t=>t.role)).size!==value.tools.length||['ffmpeg','ffprobe','node'].some(role=>!value.tools.some(t=>t.role===role)))fail('工具身份');
  }
  const freeze=value.freeze;
  if(!freeze||!['not-requested','complete','unsupported','unavailable','failed'].includes(freeze.status))fail('静止状态');
  if(freeze.status==='complete') {
    if(value.timeline.status!=='complete'||freeze.noise!==.001||freeze.durationSeconds!==2||!Array.isArray(freeze.events)||freeze.events.length>value.frames.length*3)fail('静止配置');
    let previous=-1;
    for(const e of freeze.events) {
      if(e.frame%8192===0)yield;
      if(!e||!Number.isSafeInteger(e.frame)||e.frame<0||e.frame<previous||e.frame>=value.frames.length||!['start','duration','end'].includes(e.kind)||typeof e.value!=='string'||e.value.length>80||!(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(e.value))||!Number.isFinite(Number(e.value))||e.kind==='duration'&&Number(e.value)<0||!integer(e.filterPts))fail('静止事件');
      previous=e.frame;
    }
    if(!same(freeze.segments,repeatFreezeSegments(freeze.events)))fail('静止区间');
  }else if(freeze.status!=='not-requested'&&(typeof freeze.reason!=='string'||!freeze.reason))fail('静止不可用原因');
}
