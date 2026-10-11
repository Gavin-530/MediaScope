import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {availableParallelism,freemem} from 'node:os';
import {FF} from './engine.mjs';
import {sitiTimestamp,validateSitiPoints} from './siti-validation.mjs';
import {validateSitiSceneStarts} from './public/siti-scenes.js';

export const SITI_P910_PROFILE='P910-2023-SDR-BT1886-text-v1';
export const SITI_P910_REFERENCE={project:'VQEG/siti-tools',tag:'v0.3.0',commit:'e172805cd6b7f0783e54e10d4cc543fb660138e6',sourceSha256:'231e4524b1bfca6b90d4b91fc86f9c89d65621cb2f256714a59506ba6cbf091c'};

// Only declared BT.709 SDR is selected automatically in this first stage.
export function sitiP910Eligible(stream){
  return /^yuv(420|422)p(10le)?$/.test(stream.pix_fmt)&&['tv','pc'].includes(stream.color_range)&&stream.color_transfer==='bt709'&&
    [undefined,'unknown','progressive'].includes(stream.field_order);
}
export function sitiP910Configuration(depth,range){
  if(![8,10].includes(depth)||!['tv','pc'].includes(range))throw Error('P.910 SDR 位深或亮度范围无效');
  return {profile:SITI_P910_PROFILE,standard:'ITU-T P.910 (10/2023)',clauses:['7.8.1','7.8.2','7.8.3','7.8.4','B.1','B.2'],domain:'PQ',inputBitDepth:depth,inputRange:range,
    standardDocumentSha256:'f1cdfc13ccdea8f76ffd05759b937b60ee164911bd2051711e291dfdf010099c',
    eotf:'ITU-R BT.1886 (03/2011) Annex 1 reference EOTF',gamma:2.4,whiteCdM2:300,blackCdM2:0.01,
    pq:'ITU-R BT.2100-2 (07/2018) Table 4 inverse EOTF',normalizationDivisor:2**depth-1,
    limitedRangeScaling:'(x - 16/255) / (235/255 - 16/255)',outputMultiplier:2**depth-1,
    outputScaling:'P.910 7.8.1.5 literal equation, b = input bit depth',firstTi:null,precision:'float64, two-pass population variance; unrounded samples',
    eotfSelection:'BT.1886 Annex 1 reference equation discussed in Appendix 1; optional CRT approximation not selected',
    inputRangePolicy:'reject codes outside declared legal range; MediaScope conservative input policy, not a P.910 clipping requirement',
    aggregationScope:'whole sequence reference; scene boundaries unconfirmed unless provided separately',
    reference:SITI_P910_REFERENCE,referenceAgreement:'Sobel/TI operators only; declared EOTF and output scaling differ from VQEG defaults'};
}
function populationStd(values){
  let sum=0,correction=0;
  for(const value of values){const y=value-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  const mean=sum/values.length;sum=0;correction=0;
  for(const value of values){const d=value-mean,y=d*d-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  return Math.sqrt(sum/values.length);
}
export function createSitiP910Lut(depth,range){
  const configuration=sitiP910Configuration(depth,range);
  const max=2**depth-1,factor=2**(depth-8),minCode=range==='tv'?16*factor:0,maxCode=range==='tv'?235*factor:max;
  const table=new Float64Array(max+1);table.fill(NaN);
  const blackRoot=configuration.blackCdM2**(1/2.4),gain=configuration.whiteCdM2**(1/2.4)-blackRoot;
  for(let code=minCode;code<=maxCode;code++){
    let v=code/max;
    if(range==='tv')v=(v-16/255)/(235/255-16/255);
    // BT.1886 Annex 1: a * max(V+b,0)^gamma. Do not substitute an affine gamma curve.
    const luminance=Math.max(gain*v+blackRoot,0)**2.4;
    const y=(luminance/10000)**(2610/16384);
    table[code]=((3424/4096+(2413/128)*y)/(1+(2392/128)*y))**(2523/32);
  }
  return table;
}
export function createSitiP910Calculator(width,height,depth,range){
  const configuration=sitiP910Configuration(depth,range);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width*height>33554432)throw Error('P.910 SDR 帧尺寸无效');
  const count=width*height,max=2**depth-1,bytes=count*(depth===8?1:2),table=createSitiP910Lut(depth,range);
  let current=new Float64Array(count),previous=new Float64Array(count),frame=0;
  const gradient=new Float64Array((width-2)*(height-2)),motion=new Float64Array(count);
  return {bytes,configuration,measure(raw,sceneStart=false){
    if(raw.length!==bytes)throw Error('P.910 SDR 原生亮度帧长度无效');
    const temporal=frame>0&&!sceneStart;
    for(let i=0;i<count;i++){
      const code=depth===8?raw[i]:raw[i*2]+raw[i*2+1]*256,value=table[code];
      if(!Number.isFinite(value))throw Error(`P.910 SDR 第 ${frame+1} 帧亮度码值 ${code} 超出声明范围；本阶段不自动裁剪或改判范围`);
      current[i]=value;
      if(temporal)motion[i]=value-previous[i];
    }
    let index=0;
    for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
      const i=y*width+x,tl=current[i-width-1],tr=current[i-width+1],bl=current[i+width-1],br=current[i+width+1];
      const gx=-tl+tr-2*current[i-1]+2*current[i+1]-bl+br;
      const gy=-tl-2*current[i-width]-tr+bl+2*current[i+width]+br;
      gradient[index++]=Math.hypot(gx,gy);
    }
    const point={frame,si:populationStd(gradient)*max,ti:temporal?populationStd(motion)*max:null};
    [previous,current]=[current,previous];frame++;return point;
  }};
}

async function measureSitiP910Run(file,stream,ctx,frames,{gpu=false,from=0,end=null}={}){
  if(ctx.signal?.aborted)throw Error('任务已取消');
  if(!sitiP910Eligible(stream))throw Error('P.910 SDR 需要明确 BT.709 SDR 和亮度范围声明');
  validateSitiSceneStarts(ctx.sitiSceneStarts);
  const sceneStarts=[0,...(ctx.sitiSceneStarts??[]).filter(x=>x>from&&(end===null||x<=end)).map(x=>x-from)],starts=new Set(sceneStarts);
  if(gpu&&(process.platform!=='win32'||!frames?.length))throw Error('P.910 SDR GPU 需要 Windows OpenCL GPU 和完整帧扫描');
  const {width,height,pix_fmt:format}=stream,depth=format.endsWith('10le')?10:8,range=stream.color_range;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width*height>33554432||width*height*36>freemem()*.25)throw Error('P.910 SDR 尺寸或内存预算不受支持');
  const configuration=sitiP910Configuration(depth,range),controller=new AbortController(),signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
  const pending=[],timestamps=[],points=[];let failure,timeBase,pipeFailure,info,timer;
  const fail=e=>{failure??=e;controller.abort()};
  function launch(exe,args,onLine){
    const command={exe,args,cwd:ctx.cwd??process.cwd()},started=performance.now();ctx.commands?.push(command);
    const child=spawn(exe,args,{windowsHide:true,cwd:ctx.cwd,signal});let stderr='',error;
    pending.push(new Promise((resolve,reject)=>{
      child.on('error',e=>{error??=e;fail(e)});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000)});
      child.on('close',code=>{command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;if(error||code!==0)reject(error??Error(stderr||`P.910 子进程退出 ${code}`));else resolve()});
    }).catch(fail));
    if(onLine)createInterface({input:child.stdout}).on('line',line=>{try{onLine(line)}catch(e){fail(e)}});
    return child;
  }
  const device=gpu?'GPU':'CPU';
  ctx.update?.({detail:gpu?'初始化 P.910 SDR GPU 并执行双精度数值自检':'测量 P.910（10/2023）SDR SI/TI（CPU）',completed:0,total:frames?.length??null,unit:'帧'});
  if(gpu)timer=setTimeout(()=>fail(Error('P.910 SDR GPU 初始化超过 30 秒')),30000);
  try{
    const exe=gpu?'powershell.exe':process.execPath;
    const args=gpu?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./gpu/siti-opencl.ps1',import.meta.url)),'-Mode','measure','-Profile','p910','-Width',String(width),'-Height',String(height),'-Depth',String(depth),'-FullRange',range==='pc'?'1':'0','-SceneStarts',sceneStarts.join(',')]:
      [fileURLToPath(new URL('./siti-p910-worker.mjs',import.meta.url)),String(width),String(height),String(depth),range,sceneStarts.join(',')];
    const calculator=launch(exe,args,line=>{
      const p=JSON.parse(line);
      if(gpu&&!info){
        if(!p.device||p.method!==SITI_P910_PROFILE||!Number.isFinite(p.selfTestMaxError)||p.selfTestMaxError<0)throw Error('P.910 SDR GPU 自检结果无效');
        info=p;clearTimeout(timer);return;
      }
      if(p.frame!==points.length||!Number.isFinite(p.si)||p.si<0||(starts.has(p.frame)?p.ti!==null:!Number.isFinite(p.ti)||p.ti<0)||points.length>=500000)throw Error(`P.910 SDR ${device} 帧结果无效`);
      points.push(p);const count=points.length,total=frames?.length??null;
      ctx.onSitiPoint?.(count);
      if(count===1||count%30===0||count===total)ctx.update?.({detail:`P.910 SDR ${device} 已测量 ${count} 帧`,completed:count,total,unit:'帧'});
    });calculator.stdin.on('error',e=>{if(e.code==='EPIPE')pipeFailure??=e;else fail(e)});
    if(gpu){const table=createSitiP910Lut(depth,range),header=Buffer.alloc(table.length*8);for(let i=0;i<table.length;i++)header.writeDoubleLE(table[i],i*8);calculator.stdin.write(header)}
    const select=end===null?(from?`select='gte(n,${from})',`:''):`select='between(n,${from},${end})',`;
    const decoder=launch(FF,['-hide_banner','-nostdin','-v','info','-xerror','-copyts','-noauto_conversion_filters','-noautorotate','-i',file,'-map',`0:${stream.index}`,'-vf',select+'showinfo=checksum=0,extractplanes=y','-an','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1']);
    createInterface({input:decoder.stderr}).on('line',line=>{try{
      if(!line.includes('showinfo'))return;
      const base=/config in time_base:\s*(\d+\/\d+)/.exec(line);
      if(base){if(timeBase!==undefined&&timeBase!==base[1])throw Error('P.910 SDR 输入时间基改变');timeBase=base[1];return}
      const m=/\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:[^\s]+.*?fmt:(\S+).*?s:(\d+)x(\d+).*?i:(\S+)/.exec(line);
      if(m){
        if(Number(m[1])!==timestamps.length||m[3]!==format||Number(m[4])!==width||Number(m[5])!==height||m[6]!=='P')throw Error('P.910 SDR 输入帧序号、格式或逐行声明改变');
        timestamps.push(sitiTimestamp(m[2],timeBase));
      }
      const r=/color_range:(\S+)/.exec(line),trc=/color_trc:(\S+)/.exec(line);
      if(r&&r[1]!==range||trc&&trc[1]!=='bt709')throw Error('P.910 SDR 输入亮度范围或传递函数与轨道声明不一致');
    }catch(e){fail(e)}});
    decoder.stdout.pipe(calculator.stdin);await Promise.all(pending);if(failure)throw failure;if(pipeFailure)throw pipeFailure;
    if(gpu&&!info||timestamps.length!==points.length)throw Error(`P.910 SDR ${device} 解码与计算帧数不一致`);
    const result=points.map((p,i)=>({...p,t:timestamps[i]}));validateSitiSceneStarts(sceneStarts,result.length);validateSitiPoints(result,frames,{firstTi:null,sceneStarts});
    return {points:result,execution:{mode:gpu?'gpu':'serial',device:gpu?'gpu':'cpu',requestedDevice:ctx.sitiDevice??'cpu',workers:1,implementation:`MediaScope P.910 SDR ${device} v1`,method:SITI_P910_PROFILE,configuration,
      ...(gpu?{gpuName:info.device,driver:info.driver,backend:info.backend,selfTestMaxError:info.selfTestMaxError,decode:'FFmpeg software',precision:'fp64 preprocessing / metrics / two-pass population variance / unrounded output',validation:{selfTest:'passed',absoluteTolerance:1e-8,relativeTolerance:1e-10,toleranceSource:'MediaScope engineering threshold, not an ITU guarantee'}}:{})}};
  }finally{clearTimeout(timer);controller.abort();await Promise.all(pending)}
}

export function measureSitiP910Cpu(file,stream,ctx={},frames=null){return measureSitiP910Run(file,stream,ctx,frames)}

export async function measureSitiP910(file,stream,ctx={},frames=null){
  validateSitiSceneStarts(ctx.sitiSceneStarts,frames?.length??null);
  const configured=ctx.sitiWorkers??Number(process.env.MEDIASCOPE_SITI_WORKERS??4),requestedWorkers=Number.isInteger(configured)&&configured>0?Math.min(8,configured):4,setting=ctx.sitiWorkers==null?'auto':'manual';
  let gpuFailure,result;
  if(ctx.sitiDevice==='gpu'){
    try{result=await measureSitiP910Run(file,stream,ctx,frames,{gpu:true})}
    catch(e){if(ctx.signal?.aborted)throw e;gpuFailure=e.message;ctx.update?.({detail:'P.910 SDR GPU 不可用，回退相同配置的 CPU：'+e.message,completed:0,total:frames?.length??null,unit:'帧'})}
  }
  if(!result){
    const pixels=stream.width*stream.height,memoryLimit=Math.floor(freemem()*.25/(pixels*80+64*1024*1024));
    const workers=frames?.length>=60?Math.max(1,Math.min(requestedWorkers,availableParallelism(),memoryLimit,Math.floor(frames.length/30))):1;
    if(workers>1){
      const controller=new AbortController(),signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
      const size=Math.ceil(frames.length/workers),counts=Array(workers).fill(0);
      ctx.update?.({detail:`测量 P.910 SDR SI/TI（${workers} 路 CPU 帧级并行）`,completed:0,total:frames.length,unit:'帧'});
      const parts=await Promise.allSettled(Array.from({length:workers},(_,i)=>{
        const start=i*size,from=Math.max(0,start-1),end=i===workers-1?null:Math.min(start+size,frames.length)-1;
        return measureSitiP910Run(file,stream,{...ctx,signal,update:undefined,onSitiPoint:count=>{
          counts[i]=Math.max(0,count-(i?1:0));const completed=counts.reduce((a,b)=>a+b,0);
          if(completed===1||completed%30===0||completed===frames.length)ctx.update?.({detail:`P.910 SDR CPU 已测量 ${completed} / ${frames.length} 帧`,completed,total:frames.length,unit:'帧'});
        }},frames.slice(from,end===null?undefined:end+1),{from,end}).then(value=>({start,value})).catch(e=>{controller.abort();throw e});
      }));
      if(ctx.signal?.aborted)throw Error('任务已取消');
      try{
        const points=[];
        for(const part of parts){
          if(part.status==='rejected')throw part.reason;
          const {start,value}=part.value;
          if(start){const overlap=value.points[0],previous=points.at(-1);if(!previous||overlap.t!==previous.t||overlap.si!==previous.si)throw Error('P.910 SDR CPU 并行重叠帧校验失败')}
          for(const p of value.points.slice(start?1:0))points.push({...p,frame:points.length});
        }
        validateSitiPoints(points,frames,{firstTi:null,sceneStarts:ctx.sitiSceneStarts});
        result={points,execution:{...parts[0].value.value.execution,mode:'frame-parallel',workers,overlapFrames:1}};
      }catch(e){
        ctx.update?.({detail:'P.910 SDR CPU 并行校验未通过，回退串行：'+e.message,completed:0,total:frames.length,unit:'帧'});
        result=await measureSitiP910Run(file,stream,ctx,frames);result.execution.fallbackReason=e.message;
      }
    }else{
      result=await measureSitiP910Run(file,stream,ctx,frames);
      if(requestedWorkers>1)result.execution.parallelReason='帧数、CPU 或内存预算不满足多路计算条件';
    }
  }
  result.execution={...result.execution,requestedWorkers,setting,...(gpuFailure?{gpuFallbackReason:gpuFailure}:{})};
  ctx.update?.({detail:`P.910 SDR SI/TI 已完成 ${result.points.length} 帧`,completed:result.points.length,total:result.points.length,unit:'帧'});
  return result;
}
