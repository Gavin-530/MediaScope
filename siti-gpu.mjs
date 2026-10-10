import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {freemem} from 'node:os';
import {FF,run} from './engine.mjs';

const helper=fileURLToPath(new URL('./gpu/siti-opencl.ps1',import.meta.url));
const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper];
export async function sitiGpuCapability(ctx={}){
  if(process.platform!=='win32')return {available:false,reason:'GPU SI/TI 当前仅支持 Windows OpenCL GPU。'};
  try{
    const signal=ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    const info=JSON.parse((await run('powershell.exe',[...args,'-Mode','probe'],{...ctx,signal})).trim());
    if(!info.device||!Number.isFinite(info.selfTestMaxError))throw Error('GPU 自检结果无效');
    return {available:true,...info};
  }catch(e){if(ctx.signal?.aborted)throw e;return {available:false,reason:e.message};}
}

export async function measureSitiGpu(file,stream,ctx,frames){
  if(process.platform!=='win32')throw Error('GPU SI/TI 当前仅支持 Windows OpenCL GPU');
  if(ctx.signal?.aborted)throw Error('任务已取消');
  if(!frames?.length)throw Error('GPU SI/TI 需要完整帧扫描');
  const {width,height,pix_fmt:format}=stream,depth=format.endsWith('10le')?10:8,full=stream.color_range==='pc'?1:0;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<3||height<3||width*height>33554432||width*height*24>freemem()*.25)throw Error('GPU SI/TI 尺寸或内存预算不受支持');
  const controller=new AbortController(),signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
  const pending=[],timestamps=[],points=[];let info=null,failure;
  const fail=e=>{failure??=e;controller.abort();};
  function launch(exe,argv,onLine){
    const command={exe,args:argv,cwd:ctx.cwd??process.cwd()},started=performance.now();ctx.commands?.push(command);
    const child=spawn(exe,argv,{windowsHide:true,cwd:ctx.cwd,signal});
    let stderr='',error;
    const completion=new Promise((resolve,reject)=>{
      child.on('error',e=>{error??=e;fail(e)});
      child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000)});
      child.on('close',code=>{
        command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;
        if(error||code!==0){const e=error??Error(stderr||`GPU 子进程退出 ${code}`);fail(e);reject(e)}else resolve();
      });
    });
    // Attach rejection handling before either process can fail.
    pending.push(completion.catch(e=>{fail(e)}));
    if(onLine)createInterface({input:child.stdout}).on('line',line=>{try{onLine(line)}catch(e){fail(e)}});
    return child;
  }
  ctx.update?.({detail:'初始化 GPU SI/TI 并执行数值自检',completed:0,total:frames.length,unit:'帧'});
  const initializationTimer=setTimeout(()=>fail(Error('GPU SI/TI 初始化超过 30 秒')),30000);
  try{
    const gpu=launch('powershell.exe',[...args,'-Mode','measure','-Width',String(width),'-Height',String(height),'-Depth',String(depth),'-FullRange',String(full)],line=>{
      const value=JSON.parse(line);
      if(!info){if(!value.device||!Number.isFinite(value.selfTestMaxError))throw Error('GPU 自检结果无效');info=value;clearTimeout(initializationTimer);return}
      if(value.frame!==points.length||!Number.isFinite(value.si)||!Number.isFinite(value.ti)||value.si<0||value.ti<0||points.length>=frames.length)throw Error('GPU SI/TI 帧结果无效');
      points.push(value);const count=points.length;
      if(count===1||count%30===0||count===frames.length)ctx.update?.({detail:`GPU 已计算 ${count} / ${frames.length} 帧 SI/TI`,completed:count,total:frames.length,unit:'帧'});
    });
    gpu.stdin.on('error',fail);
    const decoder=launch(FF,['-hide_banner','-nostdin','-v','info','-xerror','-noauto_conversion_filters','-noautorotate','-i',file,'-map',`0:${stream.index}`,'-vf','showinfo=checksum=0,extractplanes=y','-an','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1']);
    createInterface({input:decoder.stderr}).on('line',line=>{
      try{
        if(!line.includes('showinfo'))return;
        const m=line.match(/\bn:\s*(\d+)\s+pts:.*?pts_time:([^\s]+).*?fmt:([^\s]+).*?s:(\d+)x(\d+)/);
        if(m){
          if(Number(m[1])!==timestamps.length||!Number.isFinite(Number(m[2]))||m[3]!==format||Number(m[4])!==width||Number(m[5])!==height)throw Error('GPU 输入帧序号、时间戳或格式改变');
          timestamps.push(Number(m[2]));
        }
        const range=line.match(/color_range:([^\s]+)/);
        if(range&&(range[1]==='pc'?1:0)!==full)throw Error('GPU 输入亮度范围与轨道声明不一致');
      }catch(e){fail(e)}
    });
    decoder.stdout.pipe(gpu.stdin);
    await Promise.all(pending);
    if(failure)throw failure;
    if(!info||points.length!==frames.length||timestamps.length!==points.length||points[0].ti!==0)throw Error('GPU SI/TI 帧数或首帧校验失败');
    return {points:points.map((p,i)=>({...p,t:timestamps[i]})),execution:{mode:'gpu',device:'gpu',requestedDevice:'gpu',gpuName:info.device,driver:info.driver,backend:info.backend,selfTestMaxError:info.selfTestMaxError,workers:1,implementation:'MediaScope OpenCL SI/TI v1',decode:'FFmpeg software',precision:'float metrics / fp64 two-pass population variance / 2 decimal output',validation:{selfTest:'passed',absoluteTolerance:0.0005,relativeTolerance:0.000002}}};
  }finally{
    clearTimeout(initializationTimer);
    controller.abort();
    await Promise.all(pending);
  }
}
