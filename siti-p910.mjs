import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {availableParallelism,freemem} from 'node:os';
import {FF} from './engine.mjs';
import {sitiTimestamp,validateSitiPoints} from './siti-validation.mjs';
import {validateSitiSceneStarts} from './public/siti-scenes.js';
import {sitiP910Input,SITI_EXTENDED_PROFILE,sitiInterpretationIssues,sitiVersion3Fields} from './public/siti-settings.js';
import {createSitiRawReader} from './public/siti-formats.js';
import {createSitiPhysicalReader,sitiPhysicalFields} from './public/siti-physical.js';

export const SITI_P910_PROFILE='P910-2023-SDR-BT1886-text-v1';
export const SITI_P910_REFERENCE={project:'VQEG/siti-tools',tag:'v0.3.0',commit:'e172805cd6b7f0783e54e10d4cc543fb660138e6',sourceSha256:'231e4524b1bfca6b90d4b91fc86f9c89d65621cb2f256714a59506ba6cbf091c'};

// Resolve native luma and the declared transfer/display/preprocessing interpretation.
export function sitiP910Eligible(stream,settings){return sitiP910Input(stream,settings)!==null}
export function sitiP910Configuration(depth,range,input=null){
  if(![8,9,10,12,14,16].includes(depth)||!['tv','pc'].includes(range))throw Error('P.910 位深或亮度范围无效');
  const domain=input?.domain??'sdr',hlg=input?.hlg;
  const result={profile:input?.profile??([8,10].includes(depth)?SITI_P910_PROFILE:SITI_EXTENDED_PROFILE),standard:'ITU-T P.910 (10/2023)',clauses:['7.8.1','7.8.2','7.8.3','7.8.4','B.1','B.2'],domain:'PQ',inputBitDepth:depth,inputRange:range,
    standardDocumentSha256:'f1cdfc13ccdea8f76ffd05759b937b60ee164911bd2051711e291dfdf010099c',
    eotf:'ITU-R BT.1886 (03/2011) Annex 1 reference EOTF',gamma:2.4,whiteCdM2:300,blackCdM2:0.01,
    pq:'ITU-R BT.2100-2 (07/2018) Table 4 inverse EOTF',normalizationDivisor:2**depth-1,
    limitedRangeScaling:'(x - 16/255) / (235/255 - 16/255)',outputMultiplier:2**depth-1,
    outputScaling:'P.910 7.8.1.5 literal equation, b = input bit depth',firstTi:null,precision:'float64, two-pass population variance; unrounded samples',
    eotfSelection:'BT.1886 Annex 1 reference equation discussed in Appendix 1; optional CRT approximation not selected',
    inputRangePolicy:'reject codes outside declared legal range; MediaScope conservative input policy, not a P.910 clipping requirement',
    aggregationScope:'whole sequence reference; scene boundaries unconfirmed unless provided separately',
    reference:SITI_P910_REFERENCE,referenceAgreement:'Sobel/TI operators only; declared EOTF and output scaling differ from VQEG defaults',
    assessment:'declared-interpretation',interpretationIssues:sitiInterpretationIssues(depth,range,domain,input?.deinterlace)};
  if(input){
    Object.assign(result,{configurationVersion:2,inputDomain:domain,input:structuredClone(input),preprocessing:input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced':'native luma; none',comparison:{crossBitDepth:false,crossResolution:false,crossFrameRate:false}});
    if(domain==='pq')Object.assign(result,{eotf:'PQ preserved after normalization and range scaling; BT.2100-2 EOTF / inverse EOTF identity',gamma:null,whiteCdM2:null,blackCdM2:null,eotfSelection:'VQEG PQ passthrough interpretation; not the literal P.910 7.8.1.3/4 concatenation',pq:'already PQ; no second PQ encoding'});
    if(domain==='hlg')Object.assign(result,{eotf:'BT.2100-2 Table 5 HLG reference EOTF applied to achromatic luma',gamma:hlg.gamma,whiteCdM2:hlg.whiteCdM2,blackCdM2:hlg.blackCdM2,eotfSelection:'explicit HLG display assumption; parameters are not P.910 mandatory defaults'});
    if(input.version===3)Object.assign(result,sitiVersion3Fields(input));
    if(input.version===4)Object.assign(result,sitiPhysicalFields(input));
  }
  return result;
}
function populationStd(values){
  let sum=0,correction=0;
  for(const value of values){const y=value-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  const mean=sum/values.length;sum=0;correction=0;
  for(const value of values){const d=value-mean,y=d*d-correction,t=sum+y;correction=(t-sum)-y;sum=t}
  return Math.sqrt(sum/values.length);
}
export function createSitiP910Lut(depth,range,input=null){
  const configuration=sitiP910Configuration(depth,range,input);
  const max=2**depth-1,factor=2**(depth-8),minCode=range==='tv'?16*factor:0,maxCode=range==='tv'?235*factor:max;
  const table=new Float64Array(max+1);table.fill(NaN);
  const blackRoot=configuration.blackCdM2**(1/2.4),gain=configuration.whiteCdM2**(1/2.4)-blackRoot;
  for(let code=minCode;code<=maxCode;code++){
    let v=code/max;
    if(range==='tv')v=input?.scale==='reference-255'?(code-minCode)/(maxCode-minCode):(v-16/255)/(235/255-16/255);
    // BT.1886 Annex 1: a * max(V+b,0)^gamma. Do not substitute an affine gamma curve.
    if(input?.domain==='pq'){table[code]=v;continue}
    let luminance=Math.max(gain*v+blackRoot,0)**2.4;
    if(input?.domain==='hlg'){
      const {whiteCdM2,blackCdM2,gamma}=input.hlg,beta=Math.sqrt(3*(blackCdM2/whiteCdM2)**(1/gamma));
      const signal=Math.max(0,(1-beta)*v+beta),a=0.17883277,b=1-4*a,c=.5-a*Math.log(4*a);
      const linear=signal<=.5?signal*signal/3:(Math.exp((signal-c)/a)+b)/12;
      luminance=whiteCdM2*linear**gamma;
    }
    const y=(luminance/10000)**(2610/16384);
    table[code]=((3424/4096+(2413/128)*y)/(1+(2392/128)*y))**(2523/32);
  }
  return table;
}
export function createSitiP910Calculator(width,height,depth,range,input=null){
  const configuration=sitiP910Configuration(depth,range,input);
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width*height>33554432)throw Error('P.910 帧尺寸无效');
  const count=width*height,max=configuration.outputMultiplier,reader=input?.version===4?createSitiPhysicalReader(input,width,height):input?.version===3?createSitiRawReader(input,width,height):null,bytes=reader?.bytes??count*(depth===8?1:2),table=reader?null:createSitiP910Lut(depth,range,input);
  let current=new Float64Array(count),previous=new Float64Array(count),frame=0;
  const gradient=new Float64Array((width-2)*(height-2)),motion=new Float64Array(count);
  return {bytes,configuration,preprocess(raw,out){if(!reader)throw Error('SI/TI 该配置不使用原始分量预处理');reader.read(raw,out)},measure(raw,sceneStart=false){
    if(raw.length!==bytes)throw Error('P.910 原生亮度帧长度无效');
    const temporal=frame>0&&!sceneStart;
    if(reader)reader.read(raw,current);
    for(let i=0;i<count;i++){
      const code=reader?null:depth===8?raw[i]:raw[i*2]+raw[i*2+1]*256,value=reader?current[i]:table[code];
      if(!Number.isFinite(value))throw Error(`P.910 第 ${frame+1} 帧亮度码值 ${code} 超出声明范围；本阶段不自动裁剪或改判范围`);
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
  const input=sitiP910Input(stream,ctx.sitiSettings);
  if(!input)throw Error('P.910 需要受支持的原生亮度、明确范围和传递函数；HDR 参数或隔行处理须明确选择');
  validateSitiSceneStarts(ctx.sitiSceneStarts);
  const sceneStarts=[0,...(ctx.sitiSceneStarts??[]).filter(x=>x>from&&(end===null||x<=end)).map(x=>x-from)],starts=new Set(sceneStarts);
  if(gpu&&(process.platform!=='win32'||!frames?.length))throw Error('P.910 GPU 需要 Windows OpenCL GPU 和完整帧扫描');
  const {width,height,pix_fmt:format}=stream,{depth,range}=input;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width*height>33554432||width*height*36>freemem()*.25)throw Error('P.910 尺寸或内存预算不受支持');
  const configuration=sitiP910Configuration(depth,range,input.profile===SITI_P910_PROFILE?null:input),controller=new AbortController(),signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
  const pending=[],timestamps=[],points=[];let failure,timeBase,frameRate,pipeFailure,info,timer,observedRange,observedTransfer,observedMatrix,observedPrimaries,metadataCount=0;
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
  const device=gpu?'GPU':'CPU',domain=input.domain.toUpperCase();
  ctx.update?.({detail:gpu?`初始化 P.910 ${domain} GPU 并执行双精度数值自检`:`测量 P.910（10/2023）${domain} SI/TI（CPU）`,completed:0,total:frames?.length??null,unit:'帧'});
  if(gpu)timer=setTimeout(()=>fail(Error('P.910 GPU 初始化超过 30 秒')),30000);
  try{
    const exe=gpu?'powershell.exe':process.execPath;
    const args=gpu?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./gpu/siti-opencl.ps1',import.meta.url)),'-Mode','measure','-Profile','p910','-Width',String(width),'-Height',String(height),'-Depth',String(depth),'-FullRange',range==='pc'?'1':'0','-SceneStarts',sceneStarts.join(',')]:
      [fileURLToPath(new URL('./siti-p910-worker.mjs',import.meta.url)),String(width),String(height),String(depth),range,sceneStarts.join(','),JSON.stringify(input.profile===SITI_P910_PROFILE?null:input)];
    if(gpu)args.push('-CalculationDomain',input.version===4?'pq':input.domain,'-WhiteCdM2',String(configuration.whiteCdM2??300),'-BlackCdM2',String(configuration.blackCdM2??.01),'-SystemGamma',String(configuration.gamma??2.4),'-ProfileName',configuration.profile,'-RawMode',input.version===4?'2':input.version===3?'1':'0','-ReferenceScale',input.scale==='reference-255'?'1':'0','-OutputMultiplier',String(configuration.outputMultiplier));
    const calculator=launch(exe,args,line=>{
      const p=JSON.parse(line);
      if(gpu&&!info){
        if(!p.device||p.method!==configuration.profile||!Number.isFinite(p.selfTestMaxError)||p.selfTestMaxError<0)throw Error('P.910 GPU 自检结果无效');
        info=p;clearTimeout(timer);return;
      }
      if(p.frame!==points.length||!Number.isFinite(p.si)||p.si<0||(starts.has(p.frame)?p.ti!==null:!Number.isFinite(p.ti)||p.ti<0)||points.length>=500000)throw Error(`P.910 ${device} 帧结果无效`);
      points.push(p);const count=points.length,total=frames?.length??null;
      ctx.onSitiPoint?.(count);
      if(count===1||count%30===0||count===total)ctx.update?.({detail:`P.910 ${domain} ${device} 已测量 ${count} 帧`,completed:count,total,unit:'帧'});
    });calculator.stdin.on('error',e=>{if(e.code==='EPIPE')pipeFailure??=e;else fail(e)});
    if(gpu&&input.version!==4){const table=createSitiP910Lut(depth,range,input.profile===SITI_P910_PROFILE?null:input),header=Buffer.alloc(table.length*8);for(let i=0;i<table.length;i++)header.writeDoubleLE(table[i],i*8);calculator.stdin.write(header)}
    const select=end===null?(from?`select='gte(n,${from})',`:''):`select='between(n,${from},${end})',`;
    // Deinterlace before select so segment overlap includes the filter's neighbours.
    const filter=(input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced,':'')+select+'showinfo=checksum=0'+(input.version>=3||format.startsWith('gray')?'':',extractplanes=y');
    const decoder=launch(FF,['-hide_banner','-nostdin','-v','info','-xerror','-copyts','-noauto_conversion_filters','-noautorotate','-i',file,'-map',`0:${stream.index}`,'-vf',filter,'-an','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1']);
    createInterface({input:decoder.stderr}).on('line',line=>{try{
      if(!line.includes('showinfo'))return;
      const base=/config in time_base:\s*(\d+\/\d+)/.exec(line);
      if(base){if(timeBase!==undefined&&timeBase!==base[1])throw Error('P.910 输入时间基改变');timeBase=base[1];frameRate=/frame_rate:\s*(\d+\/\d+)/.exec(line)?.[1]??null;return}
      const m=/\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:[^\s]+.*?fmt:(\S+).*?s:(\d+)x(\d+).*?i:(\S+)/.exec(line);
      if(m){
        if(Number(m[1])!==timestamps.length||m[3]!==format||Number(m[4])!==width||Number(m[5])!==height||m[6]!=='P')throw Error('P.910 输入帧序号、格式或逐行声明改变');
        timestamps.push(sitiTimestamp(m[2],timeBase));
      }
      const r=/color_range:(\S+)/.exec(line),trc=/color_trc:(\S+)/.exec(line);
      if(r&&stream.color_range&&r[1]!==stream.color_range||trc&&stream.color_transfer&&trc[1]!==stream.color_transfer)throw Error('P.910 输入亮度范围或传递函数与轨道声明不一致');
      if(r&&trc){
        if(observedRange!==undefined&&(r[1]!==observedRange||trc[1]!==observedTransfer))throw Error('P.910 输入亮度范围或传递函数在帧间改变');
        observedRange=r[1];observedTransfer=trc[1];metadataCount++;
      }
      if(input.version>=3&&input.matrix&&r&&trc){
        const space=/color_space:(\S+)/.exec(line),prim=/color_primaries:(\S+)/.exec(line);
        if(!space||!prim||stream.color_space&&space[1]!==stream.color_space||stream.color_primaries&&prim[1]!==stream.color_primaries||observedMatrix!==undefined&&(space[1]!==observedMatrix||prim[1]!==observedPrimaries))throw Error('P.910 RGB 矩阵或色原色与轨道声明不一致、缺失逐帧记录或在帧间改变');
        observedMatrix=space[1];observedPrimaries=prim[1];
      }
    }catch(e){fail(e)}});
    if(gpu&&input.version>=3){
      const processor=launch(process.execPath,[fileURLToPath(new URL('./siti-p910-worker.mjs',import.meta.url)),String(width),String(height),String(depth),range,sceneStarts.join(','),JSON.stringify(input),'preprocess']);
      processor.stdin.on('error',e=>{if(e.code==='EPIPE')pipeFailure??=e;else fail(e)});
      decoder.stdout.pipe(processor.stdin);processor.stdout.pipe(calculator.stdin);
    }else decoder.stdout.pipe(calculator.stdin);
    await Promise.all(pending);if(failure)throw failure;if(pipeFailure)throw pipeFailure;
    if(gpu&&!info||timestamps.length!==points.length||metadataCount!==points.length)throw Error(`P.910 ${device} 解码、计算帧数或逐帧色彩记录不一致`);
    const result=points.map((p,i)=>({...p,t:timestamps[i]}));validateSitiSceneStarts(sceneStarts,result.length);validateSitiPoints(result,frames,{firstTi:null,sceneStarts});
    if(input.deinterlace)configuration.preprocessingEvidence={filter:configuration.preprocessing,outputFrameRate:frameRate,outputTimeBase:timeBase,width,height,outputFrameCount:result.length};
    return {points:result,execution:{mode:gpu?'gpu':'serial',device:gpu?'gpu':'cpu',requestedDevice:ctx.sitiDevice??'cpu',workers:1,implementation:`MediaScope P.910 ${input.domain.toUpperCase()} ${device}`,method:configuration.profile,configuration,
      ...(gpu?{gpuName:info.device,driver:info.driver,backend:info.backend,selfTestMaxError:info.selfTestMaxError,decode:'FFmpeg software',precision:input.version>=3?'float64 host preprocessing; fp64 GPU metrics / two-pass population variance / unrounded output':'fp64 preprocessing / metrics / two-pass population variance / unrounded output',validation:{selfTest:'passed',absoluteTolerance:1e-8,relativeTolerance:1e-10,toleranceSource:'MediaScope engineering threshold, not an ITU guarantee'}}:{})}};
  }finally{clearTimeout(timer);controller.abort();await Promise.all(pending)}
}

export function measureSitiP910Cpu(file,stream,ctx={},frames=null){return measureSitiP910Run(file,stream,ctx,frames)}

export async function measureSitiP910(file,stream,ctx={},frames=null){
  validateSitiSceneStarts(ctx.sitiSceneStarts,frames?.length??null);
  const configured=ctx.sitiWorkers??Number(process.env.MEDIASCOPE_SITI_WORKERS??4),requestedWorkers=Number.isInteger(configured)&&configured>0?Math.min(8,configured):4,setting=ctx.sitiWorkers==null?'auto':'manual';
  let gpuFailure,result;
  if(ctx.sitiDevice==='gpu'){
    try{result=await measureSitiP910Run(file,stream,ctx,frames,{gpu:true})}
    catch(e){if(ctx.signal?.aborted)throw e;gpuFailure=e.message;ctx.update?.({detail:'P.910 GPU 不可用，回退相同配置的 CPU：'+e.message,completed:0,total:frames?.length??null,unit:'帧'})}
  }
  if(!result){
    const pixels=stream.width*stream.height,memoryLimit=Math.floor(freemem()*.25/(pixels*80+64*1024*1024));
    const workers=frames?.length>=60?Math.max(1,Math.min(requestedWorkers,availableParallelism(),memoryLimit,Math.floor(frames.length/30))):1;
    if(workers>1){
      const controller=new AbortController(),signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
      const size=Math.ceil(frames.length/workers),counts=Array(workers).fill(0);
      ctx.update?.({detail:`测量 P.910 SI/TI（${workers} 路 CPU 帧级并行）`,completed:0,total:frames.length,unit:'帧'});
      const parts=await Promise.allSettled(Array.from({length:workers},(_,i)=>{
        const start=i*size,from=Math.max(0,start-1),end=i===workers-1?null:Math.min(start+size,frames.length)-1;
        return measureSitiP910Run(file,stream,{...ctx,signal,update:undefined,onSitiPoint:count=>{
          counts[i]=Math.max(0,count-(i?1:0));const completed=counts.reduce((a,b)=>a+b,0);
          if(completed===1||completed%30===0||completed===frames.length)ctx.update?.({detail:`P.910 CPU 已测量 ${completed} / ${frames.length} 帧`,completed,total:frames.length,unit:'帧'});
        }},frames.slice(from,end===null?undefined:end+1),{from,end}).then(value=>({start,value})).catch(e=>{controller.abort();throw e});
      }));
      if(ctx.signal?.aborted)throw Error('任务已取消');
      try{
        const points=[];
        for(const part of parts){
          if(part.status==='rejected')throw part.reason;
          const {start,value}=part.value;
          if(start){const overlap=value.points[0],previous=points.at(-1);if(!previous||overlap.t!==previous.t||overlap.si!==previous.si)throw Error('P.910 CPU 并行重叠帧校验失败')}
          for(const p of value.points.slice(start?1:0))points.push({...p,frame:points.length});
        }
        validateSitiPoints(points,frames,{firstTi:null,sceneStarts:ctx.sitiSceneStarts});
        result={points,execution:{...parts[0].value.value.execution,mode:'frame-parallel',workers,overlapFrames:1}};
      }catch(e){
        ctx.update?.({detail:'P.910 CPU 并行校验未通过，回退串行：'+e.message,completed:0,total:frames.length,unit:'帧'});
        result=await measureSitiP910Run(file,stream,ctx,frames);result.execution.fallbackReason=e.message;
      }
    }else{
      result=await measureSitiP910Run(file,stream,ctx,frames);
      if(requestedWorkers>1)result.execution.parallelReason='帧数、CPU 或内存预算不满足多路计算条件';
    }
  }
  result.execution={...result.execution,requestedWorkers,setting,...(gpuFailure?{gpuFallbackReason:gpuFailure}:{})};
  if(result.execution.configuration.input?.deinterlace){
    const span=result.points.at(-1).t-result.points[0].t;
    result.execution.configuration.preprocessingEvidence={...result.execution.configuration.preprocessingEvidence,outputFrameCount:result.points.length,outputAverageFps:result.points.length>1&&span>0?(result.points.length-1)/span:null};
  }
  ctx.update?.({detail:`P.910 SI/TI 已完成 ${result.points.length} 帧`,completed:result.points.length,total:result.points.length,unit:'帧'});
  return result;
}
