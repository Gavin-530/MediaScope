import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {availableParallelism,freemem,tmpdir} from 'node:os';
import {readFile,writeFile,access,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {MAX_ANALYSIS_FRAMES,validateSitiDimensions} from './public/analysis-limits.js';
import {FF,run,decodeThreadCount,checkAnalysisMemory} from './engine.mjs';
import {sitiInput,sitiConfiguration,createSitiCalculator,createSitiLut,sitiFrameLayout,sitiGpuParameters,sitiTimestamp,validateSitiPoints,validateSitiSceneStarts,sitiFormat,sitiRawBytes} from './public/siti.js';

const workerFile=fileURLToPath(import.meta.url),helper=fileURLToPath(new URL('./gpu/siti-opencl.ps1',import.meta.url));
let gpuBridge,gpuPool,gpuQueue=Promise.resolve();
function error(message,phase,cause){return Object.assign(new Error(message,cause?{cause}:undefined),{sitiPhase:phase});}
function cancelled(signal){return signal?.reason?.sitiPhase?signal.reason:error('任务已取消','cancelled');}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});promise.catch(()=>{});return {promise,resolve,reject};}
async function waitSignal(promise,signal){
  if(!signal)return promise;if(signal.aborted)throw cancelled(signal);
  let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(cancelled(signal));signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,stopped]);}finally{signal.removeEventListener('abort',abort);}
}
async function write(stream,bytes){await new Promise((resolve,reject)=>stream.write(bytes,e=>e?reject(e):resolve()));}
const closedInput=e=>['EPIPE','EOF','ERR_STREAM_DESTROYED','ERR_STREAM_WRITE_AFTER_END'].includes(e.code);
async function writeWorker(child,bytes){try{await write(child.stdin,bytes);}catch(e){if(closedInput(e))await child.sitiDone;throw e;}}
const exists=file=>access(file).then(()=>true,()=>false);
async function prepareGpu(ctx){
  for(;;){
    if(ctx.signal?.aborted)throw cancelled(ctx.signal);
    gpuBridge??=(async()=>{
      const source=await readFile(new URL('./gpu/SitiOpenCl.cs',import.meta.url)),hash=createHash('sha256').update(source).digest('hex');
      // Short compiler paths; retain the full source identity beside the executable.
      const exe=path.join(tmpdir(),`ms-siti-${hash.slice(0,24)}.exe`),temporary=path.join(tmpdir(),`ms-${randomUUID().slice(0,8)}.exe`);
      const valid=async()=>await exists(exe)&&(await readFile(exe+'.sha256','utf8').catch(()=>''))===hash;
      if(await valid())return exe;
      let retained=false;
      try{
        await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-OutputPath',temporary],ctx);
        try{await rename(temporary,exe);await writeFile(exe+'.sha256',hash);}catch(e){
          if(!await valid()){
            // Windows scanners/file brokers may deny publication while the compiled file itself is usable.
            if(!['EPERM','EACCES','EBUSY'].includes(e.code)||!await exists(temporary))throw e;
            retained=true;return temporary;
          }
        }return exe;
      }finally{if(!retained)await unlink(temporary).catch(()=>{});}
    })().catch(e=>{gpuBridge=undefined;throw error(e.message,'gpu-initialization',e);});
    const prepared=gpuBridge,exe=await prepared;
    if(await exists(exe))return exe;
    if(gpuBridge===prepared)gpuBridge=undefined;
  }
}
function validGpuInfo(p){if(!p?.device||p.metrics!=='PQ-Sobel-TI-fp64'||!Number.isFinite(p.selfTestMaxError)||p.selfTestMaxError<0)throw error('GPU 自检结果无效','gpu-initialization');return p;}

class GpuSession{
  constructor(exe,ctx){
    this.exe=exe;this.sequence=0;this.ready=deferred();this.closed=deferred();this.dead=false;this.stderr='';
    this.child=spawn(exe,['serve'],{windowsHide:true,cwd:ctx.cwd});
    const started=performance.now(),command={exe,args:['serve'],cwd:ctx.cwd??process.cwd(),scope:'process',operation:'startup',exitCode:null};ctx.commands?.push(command);
    this.child.stderr.on('data',b=>{this.stderr=(this.stderr+b).slice(-16000);});
    this.child.on('error',e=>this.fail(error(e.message,'gpu-initialization',e)));
    this.child.stdin.on('error',e=>{if(!closedInput(e))this.fail(error(e.message,'gpu',e));});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{try{
      const p=JSON.parse(line);
      if(p.event==='ready'){
        if(p.protocol!==1)throw error('GPU 会话协议不一致','gpu-initialization');
        this.info=validGpuInfo(p);command.elapsedSeconds=(performance.now()-started)/1000;this.ready.resolve(p);return;
      }
      const request=this.current;
      if(!request||p.id!==request.id)throw error('GPU 会话请求序号不一致','gpu');
      if(p.event==='error')throw error(p.message,p.phase==='input'?'input':'gpu');
      if(p.event==='probe'){validGpuInfo(p);request.complete=true;request.done.resolve(p);}
      else if(p.event==='configured'){validGpuInfo(p);request.onInfo?.(p);}
      else if(p.event==='done'){request.complete=true;request.done.resolve(p);}
      else request.onPoint?.({frame:p.frame,si:p.si,ti:p.ti});
    }catch(e){this.fail(e.sitiPhase?e:error(e.message,'gpu',e));}});
    this.child.on('close',code=>{
      command.exitCode=code;this.dead=true;clearTimeout(this.idle);
      const failure=this.failure??error(this.stderr||`GPU 工作进程退出 ${code}`,'gpu');
      this.ready.reject(failure);this.current?.done.reject(failure);this.closed.resolve();if(gpuPool===this)gpuPool=undefined;
    });
  }
  reference(active){this.child[active?'ref':'unref']();for(const stream of this.child.stdio)stream?.[active?'ref':'unref']?.();}
  fail(e){this.failure??=e;this.dead=true;if(gpuPool===this)gpuPool=undefined;this.ready.reject(this.failure);this.current?.done.reject(this.failure);this.child.kill();}
  async request(operation,header,payload,ctx,callbacks={}){
    this.reference(true);clearTimeout(this.idle);
    const id=++this.sequence,done=deferred(),started=performance.now();this.current={id,done,...callbacks};
    const command={exe:this.exe,args:['serve'],cwd:ctx.cwd??process.cwd(),scope:'request',operation,transport:'stdin-v1',requestId:id,sessionPid:this.child.pid,exitCode:null};ctx.commands?.push(command);
    done.promise.then(()=>{command.exitCode=0;command.elapsedSeconds=(performance.now()-started)/1000;},()=>{command.exitCode=1;command.elapsedSeconds=(performance.now()-started)/1000;});
    try{await write(this.child.stdin,Buffer.from(operation==='probe'?`P\t${id}\n`:`M\t${id}\t${header.join('\t')}\n`));if(payload)await write(this.child.stdin,payload);}
    catch(e){if(closedInput(e))await done.promise;throw error(e.message,'gpu',e);}
    return {done:done.promise,stream:this.child.stdin};
  }
  finish(){
    this.current=null;if(this.dead)return;this.reference(false);
    this.idle=setTimeout(()=>{if(!this.current)this.fail(error('GPU 空闲资源已释放','gpu'));},60000);this.idle.unref();
  }
}
export async function closeSitiGpu(){const session=gpuPool;gpuPool=undefined;if(session){session.reference(true);session.fail(error('GPU 工作进程已释放','gpu'));await session.closed.promise;}}
process.once('exit',()=>gpuPool?.child.kill());
async function withGpu(ctx,body){
  const previous=gpuQueue,gate=deferred();gpuQueue=gate.promise;let entered=false,session,abort;
  try{
    await waitSignal(previous,ctx.signal);entered=true;if(ctx.signal?.aborted)throw cancelled(ctx.signal);
    const initialization=new AbortController(),initialSignal=ctx.signal?AbortSignal.any([ctx.signal,initialization.signal]):initialization.signal;
    const timer=setTimeout(()=>initialization.abort(error('GPU 初始化超过 30 秒','gpu-initialization')),30000);
    const initializeAbort=()=>session?.fail(cancelled(initialSignal));initialSignal.addEventListener('abort',initializeAbort,{once:true});
    abort=()=>{if(!session?.current?.complete)session?.fail(cancelled(ctx.signal));};ctx.signal?.addEventListener('abort',abort,{once:true});
    try{
      if(!gpuPool||gpuPool.dead){const exe=await prepareGpu({...ctx,signal:initialSignal});if(initialSignal.aborted)throw cancelled(initialSignal);gpuPool=new GpuSession(exe,ctx);}
      session=gpuPool;session.reference(true);clearTimeout(session.idle);await waitSignal(session.ready.promise,initialSignal);
    }finally{clearTimeout(timer);initialSignal.removeEventListener('abort',initializeAbort);}
    return await body(session);
  }catch(e){if(session&&!session.current?.complete)session.fail(e.sitiPhase?e:error(e.message,'gpu',e));throw e;}
  finally{
    ctx.signal?.removeEventListener('abort',abort);session?.finish();
    if(entered)gate.resolve();else previous.finally(()=>gate.resolve());
  }
}
export function sitiWorkerCount(stream,count,requested=4){
  if(!Number.isSafeInteger(count)||count<60)return 1;const pixels=stream.width*stream.height;if(!(pixels>0))return 1;
  const format=sitiFormat(stream.pix_fmt),rawBytes=format?sitiRawBytes(format,stream.width,stream.height):0;
  const maxBlock=format?.family==='rgb'?16:8,perWorker=Math.max(pixels*80,pixels*36+rawBytes*(maxBlock+3))+64*1024*1024;
  return Math.max(1,Math.min(8,availableParallelism(),Math.floor(freemem()*.25/perWorker),Math.floor(count/30),requested));
}
export async function sitiGpuCapability(ctx={}){
  if(ctx.signal?.aborted)throw cancelled(ctx.signal);
  if(process.platform!=='win32')return {available:false,reason:'GPU SI/TI 当前需要 Windows OpenCL GPU。'};
  if(gpuPool?.info&&!gpuPool.dead&&gpuPool.current)return {available:true,...gpuPool.info,busy:true,reusedContext:true};
  try{return await withGpu(ctx,async session=>{const request=await session.request('probe',null,null,ctx),p=await waitSignal(request.done,ctx.signal);return {available:true,...p,reusedContext:true};});}
  catch(e){if(ctx.signal?.aborted)throw e;return {available:false,reason:e.message};}
}
export function sitiGpuRequest(input,w,h,count,sceneStarts=[0]){
  const f=input.format,l=sitiFrameLayout(input,w,h),rgb=f.family==='rgb',table=rgb?sitiGpuParameters(input,w,h):createSitiLut(input);
  return {header:[w,h,count,sceneStarts.join(','),f.storage,input.depth,f.shift,f.endian==='be'?0:1,l.bytes,f.alpha?l.alpha:-1,rgb?2:1,l.stride,l.red,l.green,l.blue,table.length],payload:Buffer.from(table.buffer),bytes:l.bytes};
}

function processFailure(stderr,fallbackPhase){
  for(const line of stderr.trim().split('\n').reverse())try{const p=JSON.parse(line);if(p.sitiPhase&&p.message)return error(p.message,p.sitiPhase);}catch{}
  return error(stderr||'SI/TI 子进程异常退出',fallbackPhase);
}
async function measureRun(file,stream,input,ctx,frames,{gpu=false,workers=1,attempt}={}){
  if(ctx.signal?.aborted)throw cancelled(ctx.signal);
  if(gpu&&(process.platform!=='win32'||!frames?.length))throw error('GPU 需要 Windows OpenCL 和完整帧扫描','gpu-initialization');
  const {width,height,pix_fmt:format}=stream,n=width*height,layout=sitiFrameLayout(input,width,height),rawBytes=layout.bytes;
  const cpuBlockFrames=input.format.family==='rgb'&&workers>1?Math.ceil(frames.length/(workers*Math.ceil(frames.length/(workers*16)))):8;
  try{validateSitiDimensions(width,height);}catch(e){throw error(e.message,'input',e);}
  const hostBytes=gpu?rawBytes*3+n*8+64*1024*1024:n*36;
  if(hostBytes>freemem()*.25)throw error('SI/TI 主机内存预算不足',gpu?'gpu-initialization':'cpu');
  const sceneStarts=ctx.sitiSceneStarts??[0],starts=new Set(sceneStarts),configuration=sitiConfiguration(input),controller=new AbortController();
  const signal=ctx.signal?AbortSignal.any([ctx.signal,controller.signal]):controller.signal;
  const pending=[],timestamps=[],points=[],next=Array(workers).fill(0),began=performance.now();let failure,timeBase,info,metadataCount=0,observedRange,observedTransfer,observedMatrix,observedPrimaries,received=0,gpuTiming;
  const fail=e=>{failure??=e.sitiPhase?e:error(e.message,gpu?'gpu':'cpu',e);controller.abort(failure);};
  function launch(exe,args,phase,onLine){
    const command={exe,args,cwd:ctx.cwd??process.cwd()},started=performance.now();ctx.commands?.push(command);
    const child=spawn(exe,args,{windowsHide:true,cwd:ctx.cwd,signal});let stderr='',spawnError;
    const completion=new Promise((resolve,reject)=>{
      child.on('error',e=>{spawnError??=error(e.message,phase,e);if(!signal.aborted)fail(spawnError);});
      child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
      child.on('close',code=>{command.elapsedSeconds=(performance.now()-started)/1000;command.exitCode=code;if(spawnError||code!==0)reject(spawnError??processFailure(stderr,phase));else resolve();});
    });child.sitiDone=completion;pending.push(completion.catch(fail));
      child.stdin.on('error',e=>{if(!closedInput(e)&&!signal.aborted)fail(error(e.message,phase,e));});
    if(onLine)createInterface({input:child.stdout}).on('line',line=>{try{onLine(JSON.parse(line));}catch(e){fail(e.sitiPhase?e:error(e.message,phase,e));}});
    return child;
  }
  function point(p,lane=0){
    if(received%16384===0)try{checkAnalysisMemory();}catch(e){throw error(e.message,'validation',e);}
    const local=next[lane]++,expected=gpu||workers===1?received:(Math.floor(local/cpuBlockFrames)*workers+lane)*cpuBlockFrames+local%cpuBlockFrames;
    if(p.frame!==expected||!Number.isFinite(p.si)||p.si<0||(starts.has(p.frame)?p.ti!==null:!Number.isFinite(p.ti)||p.ti<0)||p.frame>=MAX_ANALYSIS_FRAMES||frames&&p.frame>=frames.length)throw error('SI/TI 帧计算结果无效',gpu?'gpu':'cpu');
    points[p.frame]=p;received++;attempt.framesComputed=received;attempt.timeToFirstPointSeconds??=(performance.now()-began)/1000;
    ctx.onSitiPoint?.(received);if(received===1||received%30===0||received===frames?.length)ctx.update?.({detail:`P.910 ${gpu?'GPU':`CPU${workers>1?' '+workers+' 路':''}`} 已测量 ${received} 帧`,completed:received,total:frames?.length??null,unit:'帧'});
  }
  async function execute(session){
    let receiver,request,timer;const calculators=[],queued=new Set(),laneWrites=Array(workers).fill(Promise.resolve());
    try{
      if(gpu){
        const prepared=sitiGpuRequest(input,width,height,frames.length,sceneStarts),configured=performance.now();
        timer=setTimeout(()=>fail(error('GPU 配置或自检超过 30 秒','gpu-initialization')),30000);
        request=await session.request('measure',prepared.header,prepared.payload,{...ctx,signal},{onPoint:p=>{try{point(p);}catch(e){fail(e);}},onInfo:p=>{info=p;clearTimeout(timer);attempt.configurationSeconds=(performance.now()-configured)/1000;}});
        pending.push(request.done.then(p=>{if(p.frames!==received||!Number.isFinite(p.gpuUploadComputeReadSeconds)||!Number.isFinite(p.inputWaitSeconds))throw error('GPU 完成记录无效','gpu');gpuTiming=p;}).catch(fail));
      }else for(let lane=0;lane<workers;lane++)calculators.push(launch(process.execPath,[workerFile,'--worker',String(width),String(height),sceneStarts.join(','),JSON.stringify(input),workers>1?'blocks':'measure',String(lane),String(workers),String(cpuBlockFrames)],'cpu',p=>point(p,lane)));
      const decoder=launch(FF,['-hide_banner','-nostdin','-nostats','-v','info','-xerror','-copyts','-noauto_conversion_filters','-noautorotate','-threads:v',String(decodeThreadCount(ctx.decodeThreads)),'-i',file,'-map',`0:${stream.index}`,'-vf',(input.deinterlace?'bwdif=mode=send_frame:parity=auto:deint=interlaced,':'')+'showinfo=checksum=0','-an','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1'],'decode');
      createInterface({input:decoder.stderr}).on('line',line=>{try{
        if(!line.includes('showinfo'))return;
        const base=/config in time_base:\s*(\d+\/\d+)/.exec(line);if(base){if(timeBase!==undefined&&timeBase!==base[1])throw error('SI/TI 输入时间基改变','validation');timeBase=base[1];return;}
        const m=/\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:[^\s]+.*?fmt:(\S+).*?s:(\d+)x(\d+).*?i:(\S+)/.exec(line);
        if(m){if(Number(m[1])!==timestamps.length||m[3]!==format||Number(m[4])!==width||Number(m[5])!==height||m[6]!=='P')throw error('SI/TI 输入帧序号、格式或逐行声明改变','validation');timestamps.push(sitiTimestamp(m[2],timeBase));attempt.timeToFirstDecodedFrameSeconds??=(performance.now()-began)/1000;}
        const range=/color_range:(\S+)/.exec(line),transfer=/color_trc:(\S+)/.exec(line);
        if(range&&stream.color_range&&range[1]!==stream.color_range||transfer&&stream.color_transfer&&transfer[1]!==stream.color_transfer)throw error('SI/TI 输入范围或传递函数与轨道声明不一致','input');
        if(range&&transfer){if(observedRange!==undefined&&(range[1]!==observedRange||transfer[1]!==observedTransfer))throw error(`SI/TI 输入范围或传递函数在帧间改变（第 ${timestamps.length} 帧：${observedRange}/${observedTransfer} → ${range[1]}/${transfer[1]}）`,'input');observedRange=range[1];observedTransfer=transfer[1];metadataCount++;}
        if(input.matrix&&range&&transfer){const space=/color_space:(\S+)/.exec(line),prim=/color_primaries:(\S+)/.exec(line);if(!space||!prim||stream.color_space&&space[1]!==stream.color_space||stream.color_primaries&&prim[1]!==stream.color_primaries||observedMatrix!==undefined&&(space[1]!==observedMatrix||prim[1]!==observedPrimaries))throw error('SI/TI RGB 矩阵或色原色与轨道声明不一致、缺失或在帧间改变','input');observedMatrix=space[1];observedPrimaries=prim[1];}
      }catch(e){fail(e.sitiPhase?e:error(e.message,'validation',e));}});
      // A bounded queue feeds small contiguous blocks, reusing preprocessed predecessors within each block.
      let current=Buffer.allocUnsafe(rawBytes),previous=Buffer.allocUnsafe(rawBytes),offset=0,frame=0;
      receiver=new Writable({write(chunk,encoding,callback){(async()=>{
        let position=0;while(position<chunk.length){
          if(signal.aborted)throw cancelled(signal);const count=Math.min(rawBytes-offset,chunk.length-position);chunk.copy(current,offset,position,position+count);offset+=count;position+=count;
          if(offset===rawBytes){
            if(frame>=MAX_ANALYSIS_FRAMES||frames&&frame>=frames.length)throw error('SI/TI 解码帧数超出预扫描','validation');
            if(gpu)try{await write(request.stream,current);}catch(e){if(closedInput(e))await request.done;throw e;}
            else{
              const lane=workers>1?Math.floor(frame/cpuBlockFrames)%workers:0,calculator=calculators[lane];
              if(workers===1)await writeWorker(calculator,current);
              else{
                const raw=Buffer.from(current),predecessor=frame%cpuBlockFrames===0?Buffer.from(frame===0?current:previous):null;
                let queuedWrite;queuedWrite=laneWrites[lane].then(async()=>{
                  if(signal.aborted)throw cancelled(signal);
                  if(predecessor)await writeWorker(calculator,predecessor);await writeWorker(calculator,raw);
                }).catch(fail).finally(()=>queued.delete(queuedWrite));
                laneWrites[lane]=queuedWrite;queued.add(queuedWrite);
                if(queued.size>=workers*cpuBlockFrames)await Promise.race(queued);
              }
            }
            frame++;offset=0;[current,previous]=[previous,current];
          }
        }
      })().then(()=>callback(),callback);},final(callback){
        (async()=>{await decoder.sitiDone;if(offset||frames&&frame!==frames.length)throw error('SI/TI 原始帧截断或帧数与预扫描不一致','validation');await Promise.all(laneWrites);if(failure)throw failure;for(const calculator of calculators)calculator.stdin.end();})().then(()=>callback(),callback);
      }});
      pending.push(new Promise(resolve=>{receiver.on('finish',resolve);receiver.on('error',e=>{fail(e);resolve();});receiver.on('close',resolve);}));
      const stop=()=>receiver.destroy(cancelled(signal));signal.addEventListener('abort',stop,{once:true});receiver.on('close',()=>signal.removeEventListener('abort',stop));
      // A rejected frame unpipes the receiver; keep draining so child 'close' can settle.
      receiver.on('close',()=>decoder.stdout.resume());
      decoder.stdout.pipe(receiver);await Promise.all(pending);if(failure)throw failure;
      if(gpu&&!info||timestamps.length!==received||metadataCount!==received)throw error('SI/TI 解码、计算帧数或逐帧色彩记录不一致','validation');
      const result=points;for(let i=0;i<result.length;i++)result[i].t=timestamps[i];
      try{validateSitiSceneStarts(sceneStarts,result.length);validateSitiPoints(result,frames,{sceneStarts});}catch(e){throw error(e.message,'validation',e);}
      return {points:result,execution:{mode:gpu?'gpu':workers>1?'frame-parallel':'serial',device:gpu?'gpu':'cpu',requestedDevice:ctx.sitiDevice??'cpu',workers,implementation:`MediaScope P.910 ${input.domain.toUpperCase()} ${gpu?'GPU':'CPU'}`,method:configuration.profile,configuration,decode:'FFmpeg software',decodePasses:1,decodeThreads:decodeThreadCount(ctx.decodeThreads),inputBytesPerFrame:rawBytes,preprocessingDevice:gpu?'gpu':'cpu',metricsDevice:gpu?'gpu':'cpu',
        ...(workers>1?{frameDispatch:'round-robin blocks with exact predecessor',blockFrames:cpuBlockFrames,overlapFrames:1}:{}),...(gpu?{gpuName:info.device,driver:info.driver,backend:info.backend,selfTestMaxError:info.selfTestMaxError,precision:input.format.family==='rgb'?'fp64 GPU RGB preprocessing and metrics':'fp64 shared LUT preprocessing and GPU metrics',sessionPid:session.child.pid,buffersReused:info.buffersReused,validation:{selfTest:'passed',absoluteTolerance:1e-8,relativeTolerance:1e-10,toleranceSource:'MediaScope engineering threshold, not an ITU guarantee'},timing:{gpuUploadComputeReadSeconds:gpuTiming.gpuUploadComputeReadSeconds,inputWaitSeconds:gpuTiming.inputWaitSeconds,scope:'GPU upload, preprocessing, metrics and readback; input wait overlaps decoder'}}:{})}};
    }catch(e){fail(e.sitiPhase?e:session?.failure??error(e.message,gpu?'gpu':'cpu',e));throw failure;}
    finally{clearTimeout(timer);receiver?.destroy();controller.abort(failure);if(failure&&session&&(!session.current?.complete||failure.sitiPhase?.startsWith('gpu')))session.fail(failure);await Promise.all([...pending,...laneWrites]);}
  }
  if(gpu)return withGpu({...ctx,signal},async session=>{attempt.reusedContext=session.sequence>0;attempt.gpuReadySeconds=(performance.now()-began)/1000;return execute(session);});
  return execute();
}

export async function measureSiti(file,stream,ctx={},frames=null){
  if(ctx.signal?.aborted)throw cancelled(ctx.signal);
  if(frames&&(!Array.isArray(frames)||!frames.length||frames.length>MAX_ANALYSIS_FRAMES))throw error('SI/TI 单轨支持 1–2,000,000 帧','input');
  validateSitiSceneStarts(ctx.sitiSceneStarts,frames?.length??null);
  if(!['cpu','gpu',undefined].includes(ctx.sitiDevice))throw error('SI/TI 计算设备无效','input');
  let input;try{input=sitiInput(stream,ctx.sitiSettings);}catch(e){throw error(e.message,'input',e);}
  const configured=ctx.sitiWorkers??Number(process.env.MEDIASCOPE_SITI_WORKERS??4),requestedWorkers=Number.isInteger(configured)&&configured>0?Math.min(8,configured):4,setting=ctx.sitiWorkers==null?'auto':'manual',attempts=[];
  async function attempt(gpu,workers=1){
    const record={device:gpu?'gpu':'cpu',workers,outcome:'running',framesComputed:0},started=performance.now();attempts.push(record);
    ctx.update?.({detail:gpu?'准备 GPU SI/TI；软件解码，双精度计算':`测量 SI/TI（CPU ${workers} 路；共用一次解码）`,completed:0,total:frames?.length??null,unit:'帧'});
    try{const value=await measureRun(file,stream,input,ctx,frames,{gpu,workers,attempt:record});record.outcome='passed';return value;}
    catch(e){record.outcome=ctx.signal?.aborted?'cancelled':'failed';record.phase=e.sitiPhase??(gpu?'gpu':'cpu');record.reason=e.message;e.sitiAttempts=attempts;throw e;}
    finally{record.elapsedSeconds=(performance.now()-started)/1000;}
  }
  let result,gpuFailure;
  if(ctx.sitiDevice==='gpu')try{result=await attempt(true);}catch(e){
    if(ctx.signal?.aborted||e.sitiPhase==='cancelled')throw e;
    if(!['gpu','gpu-initialization'].includes(e.sitiPhase))throw e;
    gpuFailure=e.message;ctx.update?.({detail:'GPU 执行失败，回退相同配置的 CPU：'+e.message,completed:0,total:frames?.length??null,unit:'帧'});
  }
  if(!result){
    const workers=sitiWorkerCount(stream,frames?.length,requestedWorkers);
    try{result=await attempt(false,workers);}catch(e){
      if(ctx.signal?.aborted||e.sitiPhase==='cancelled'||workers===1||e.sitiPhase!=='cpu')throw e;
      ctx.update?.({detail:'CPU 并行执行失败，回退串行：'+e.message,completed:0,total:frames?.length??null,unit:'帧'});result=await attempt(false);result.execution.fallbackReason=e.message;
    }
    if(workers===1&&requestedWorkers>1)result.execution.parallelReason='帧数、CPU 或内存预算不满足多路计算条件';
  }
  result.execution={...result.execution,requestedWorkers,setting,attempts,...(gpuFailure?{gpuFallbackReason:gpuFailure}:{})};
  ctx.update?.({detail:`SI/TI 已完成 ${result.points.length} 帧（${result.execution.device.toUpperCase()}）`,completed:result.points.length,total:result.points.length,unit:'帧'});return result;
}

if(process.argv[2]==='--worker'&&process.argv[1]===workerFile){
  try{
    const [width,height,boundaries,input,mode,laneText='0',workersText='1',blockText='8']=process.argv.slice(3),calculator=createSitiCalculator(Number(width),Number(height),JSON.parse(input));
    const sceneStarts=boundaries.split(',').map(Number);validateSitiSceneStarts(sceneStarts);const starts=new Set(sceneStarts),lane=Number(laneText),workers=Number(workersText);
    const blocked=mode==='blocks',blockFrames=Number(blockText),raw=Buffer.allocUnsafe(calculator.bytes*(blocked?2:1));let offset=0,frame=0;
    for await(const chunk of process.stdin){
      let position=0;while(position<chunk.length){const boundary=blocked&&frame%blockFrames===0,target=calculator.bytes*(boundary?2:1),count=Math.min(target-offset,chunk.length-position);chunk.copy(raw,offset,position,position+count);offset+=count;position+=count;
        if(offset===target){const globalFrame=blocked?(Math.floor(frame/blockFrames)*workers+lane)*blockFrames+frame%blockFrames:frame,point=calculator.measure(raw.subarray(boundary?calculator.bytes:0,target),starts.has(globalFrame),boundary?raw.subarray(0,calculator.bytes):null);point.frame=globalFrame;frame++;if(!process.stdout.write(JSON.stringify(point)+'\n'))await once(process.stdout,'drain');offset=0;}
      }
    }
    if(offset)throw error('SI/TI 原始分量帧被截断','input');if(!blocked)validateSitiSceneStarts(sceneStarts,frame);
  }catch(e){process.stderr.write(JSON.stringify({sitiPhase:e.sitiPhase??'input',message:e.message})+'\n');process.exitCode=1;}
}
