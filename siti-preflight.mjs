import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import {FF,decodeThreadCount,mediaSignature,checkAnalysisMemory} from './engine.mjs';
import {MAX_ANALYSIS_FRAMES,validateSitiDimensions} from './public/analysis-limits.js';
import {sitiInput,sitiClipEligible,createSitiRangeReader,sitiTimestamp} from './public/siti.js';

// Independent luma range preflight for the same native software decode path as
// the formal SI/TI measurement. It never starts the SI/TI calculator or GPU.
const ERROR_CODE='SITI_PREFLIGHT';
function failure(message,code=ERROR_CODE,cause){return Object.assign(Error(message,cause?{cause}:undefined),{code});}
function cancelled(){return failure('SI/TI 亮度范围预检已取消','SITI_PREFLIGHT_CANCELLED');}
function decoderError(stderr){
  const lines=stderr.trim().split('\n').filter(line=>line&&!line.includes('showinfo')&&!line.includes('config in time_base'));
  return (lines.slice(-6).join('\n')||stderr.trim()).slice(-2000);
}
export function sitiPreflightEligibility(stream,settings){
  let input;
  try{input=sitiInput(stream,settings);}catch(e){return {applicable:false,reason:e.message};}
  if(!sitiClipEligible(input))return {applicable:false,reason:'仅逐行、有限范围 8/10/12-bit SDR 亮度输入可执行范围预检'};
  return {applicable:true,input};
}

export function validateSitiPreflightEvidence(value){
  const fail=()=>{throw Error('SI/TI 亮度预检证据无效')};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['status','signature','framesScanned','checkedAt','track','settingsKey'].includes(k)))fail();
  if(value.status!=='out-of-range'||typeof value.signature!=='string'||!value.signature||!Number.isSafeInteger(value.framesScanned)||value.framesScanned<1||!Number.isSafeInteger(value.track)||value.track<0||typeof value.settingsKey!=='string'||!value.settingsKey||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt)))fail();
  return value;
}

// Short-named pass over the scanned frames only. After an early pixel stop the
// outcome itself is already decided, so a frame beyond the scanned count only
// means decoding continued past the hit frame; that must not change the hit.
function verificationArguments(file,stream,ctx,frames){
  return ['-hide_banner','-nostdin','-nostats','-v','info','-xerror','-copyts','-noauto_conversion_filters','-noautorotate','-threads:v',String(decodeThreadCount(ctx.decodeThreads)),'-i',file,'-map',`0:${stream.index}`,'-vf','showinfo=checksum=0','-an','-f','null','-frames:v',String(frames),'-'];
}
async function runVerification(command,frames){
  const child=spawn(command.exe,command.args,{windowsHide:true,cwd:command.cwd}),lines=createInterface({input:child.stderr}),started=performance.now();
  const observed=new Map();let failed=null,count=0,extra=0,timeBase;
  lines.on('line',line=>{
    if(failed||!line.includes('showinfo'))return;
    try{
      const base=/config in time_base:\s*(\d+\/\d+)/.exec(line);
      if(base){timeBase??=base[1];return}
      const m=/\bn:\s*(\d+)\s/.exec(line);
      if(m){if(Number(m[1])!==count)throw failure('SI/TI 预检复核帧序不一致','SITI_PREFLIGHT_VALIDATION');count++;if(count>frames){extra++;child.kill();return;}}
      if(extra)return;
      const range=/color_range:(\S+)/.exec(line),transfer=/color_trc:(\S+)/.exec(line);
      if(!range||!transfer)return;
      const index=count-1;
      if(index<0||index>=frames)throw failure('SI/TI 预检复核色彩记录超出已扫描帧','SITI_PREFLIGHT_VALIDATION');
      const first=observed.values().next().value;
      if(observed.has(index)&&(observed.get(index)[0]!==range[1]||observed.get(index)[1]!==transfer[1])||first&&index>0&&(first[0]!==range[1]||first[1]!==transfer[1]))throw failure('SI/TI 预检输入范围或传递函数在帧间改变','SITI_PREFLIGHT_INPUT');
      observed.set(index,[range[1],transfer[1]]);
    }catch(e){if(!failed){failed=String(e.code??'').startsWith('SITI_PREFLIGHT')?e:failure(e.message,'SITI_PREFLIGHT_VALIDATION',e);child.kill();}}
  });
  const code=await new Promise(resolve=>{
    child.on('error',e=>{failed??=failure(e.message,'SITI_PREFLIGHT_DECODE',e)});
    child.on('close',resolve);
  });
  command.exitCode=code;command.elapsedSeconds=(performance.now()-started)/1000;
  lines.close();
  if(failed)throw failed;
  if(!extra&&code!==0)throw failure('SI/TI 预检提前结束后复核解码未能复现已扫描帧，不能确认格式与色彩声明完整','SITI_PREFLIGHT_VALIDATION');
  if(observed.size!==frames)throw failure('SI/TI 预检复核帧数或色彩记录不完整','SITI_PREFLIGHT_VALIDATION');
  const [range,transfer]=observed.values().next().value;
  return {frames:observed.size,range,transfer,timeBase:timeBase??null,scope:'短文件名独立解码按序输出全部已扫描帧的格式与色彩记录；命中帧的像素在上一步已按原始码值核验。'};
}
function decoderArguments(file,stream,ctx){
  return ['-hide_banner','-nostdin','-nostats','-v','info','-xerror','-copyts','-noauto_conversion_filters','-noautorotate','-threads:v',String(decodeThreadCount(ctx.decodeThreads)),'-i',file,'-map',`0:${stream.index}`,'-vf','showinfo=checksum=0','-an','-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1','-f','rawvideo','pipe:1'];
}

// Resolves after one complete track decode (or the first valid frame with an
// out-of-range luma sample). Early termination is reported as out-of-range, not
// as EOF or success; every other stop is an explicit failure.
export async function preflightSitiLuma(file,stream,ctx={}){
  if(ctx.signal?.aborted)throw cancelled();
  const plan=sitiPreflightEligibility(stream,ctx.sitiSettings);
  if(!plan.applicable)throw failure(`SI/TI 亮度范围预检不适用：${plan.reason}`,'SITI_PREFLIGHT_NOT_APPLICABLE');
  const {width,height,pix_fmt:format}=stream;
  try{validateSitiDimensions(width,height);}catch(e){throw failure(e.message,'SITI_PREFLIGHT_INPUT',e);}
  const input=plan.input,reader=createSitiRangeReader(input,width,height),rawBytes=reader.bytes;
  const started=performance.now(),signature=await mediaSignature(file);
  const args=decoderArguments(file,stream,ctx),command={exe:FF,args,scope:'preflight',operation:'luma-range',cwd:ctx.cwd??process.cwd()},commands=[command];
  ctx.commands?.push(command);
  let aborted=false,spawnError=null,validationFailure=null,stderr='',hit=null,frames=0,offset=0,timeBase,metadataCount=0,observedRange,observedTransfer;
  const timestamps=[];
  const child=spawn(FF,args,{windowsHide:true,cwd:ctx.cwd});
  const fail=e=>{if(!validationFailure){const code=String(e.code??'').startsWith('SITI_PREFLIGHT')?e.code:'SITI_PREFLIGHT_VALIDATION';validationFailure=failure(e.message,code,e);}child.kill();};
  const completion=new Promise(resolve=>{
    child.on('error',e=>{spawnError??=failure(e.message,'SITI_PREFLIGHT_DECODE',e);});
    child.on('close',code=>{command.exitCode=code;command.elapsedSeconds=(performance.now()-started)/1000;resolve(code);});
  });
  const onAbort=()=>{aborted=true;child.kill();};
  ctx.signal?.addEventListener('abort',onAbort,{once:true});
  const lines=createInterface({input:child.stderr}),linesClosed=new Promise(resolve=>lines.once('close',resolve));
  lines.on('line',line=>{
    stderr=(stderr+line+'\n').slice(-16000);
    if(hit||aborted||validationFailure)return;
    try{
      if(!line.includes('showinfo'))return;
      const base=/config in time_base:\s*(\d+\/\d+)/.exec(line);
      if(base){if(timeBase!==undefined&&timeBase!==base[1])throw failure('SI/TI 预检输入时间基改变','SITI_PREFLIGHT_VALIDATION');timeBase=base[1];return;}
      const m=/\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:[^\s]+.*?fmt:(\S+).*?s:(\d+)x(\d+).*?i:(\S+)/.exec(line);
      if(m){
        if(Number(m[1])!==timestamps.length||m[3]!==format||Number(m[4])!==width||Number(m[5])!==height||m[6]!=='P')throw failure('SI/TI 预检输入帧序号、格式或逐行声明改变','SITI_PREFLIGHT_VALIDATION');
        timestamps.push(sitiTimestamp(m[2],timeBase));
      }
      const range=/color_range:(\S+)/.exec(line),transfer=/color_trc:(\S+)/.exec(line);
      if(range&&stream.color_range&&range[1]!==stream.color_range||transfer&&stream.color_transfer&&transfer[1]!==stream.color_transfer)throw failure('SI/TI 预检输入范围或传递函数与轨道声明不一致','SITI_PREFLIGHT_INPUT');
      if(range&&transfer){if(observedRange!==undefined&&(range[1]!==observedRange||transfer[1]!==observedTransfer))throw failure(`SI/TI 预检输入范围或传递函数在帧间改变（第 ${timestamps.length} 帧：${observedRange}/${observedTransfer} → ${range[1]}/${transfer[1]}）`,'SITI_PREFLIGHT_INPUT');observedRange=range[1];observedTransfer=transfer[1];metadataCount++;}
    }catch(e){fail(e);}
  });
  const current=Buffer.allocUnsafe(rawBytes);
  let stopReason=null;
  try{
    for await(const chunk of child.stdout){
      if(aborted||validationFailure)break;
      let position=0;
      while(position<chunk.length){
        const count=Math.min(rawBytes-offset,chunk.length-position);
        chunk.copy(current,offset,position,position+count);offset+=count;position+=count;
        if(offset!==rawBytes)continue;
        if(frames>=MAX_ANALYSIS_FRAMES)throw failure('SI/TI 亮度范围预检帧数超过单轨支持上限','SITI_PREFLIGHT_LIMIT');
        if(frames%16384===0)checkAnalysisMemory();
        const scan=reader.scan(current);
        frames++;offset=0;
        ctx.update?.({framesScanned:frames,completed:frames,total:null,unit:'帧'});
        if(scan.outside){
          hit={frame:frames-1,code:scan.firstOutOfRange.code,sample:scan.firstOutOfRange.sample,frameMin:scan.min,frameMax:scan.max};
          stopReason='hit';child.kill();break;
        }
      }
      if(stopReason||aborted||validationFailure)break;
    }
  }catch(e){fail(e);}
  const code=await completion;
  await linesClosed;
  ctx.signal?.removeEventListener('abort',onAbort);
  if(aborted)throw cancelled();
  if(validationFailure)throw validationFailure;
  if(spawnError)throw spawnError;
  if(hit){
    // Second phase: a short-named null-output decode independently confirms
    // frame count, format and declared colour of every scanned frame. The hit
    // frame itself is established from its validated raw pixels; its own
    // metadata line may not be flushed when decoding stops. A frame-level
    // declaration change before the hit is rejected.
    const verifyCommand={exe:FF,args:verificationArguments(file,stream,ctx,frames),scope:'preflight',operation:'metadata-verify',cwd:ctx.cwd??process.cwd()};
    ctx.commands?.push(verifyCommand);
    const verified=await runVerification(verifyCommand,frames);
    if(await mediaSignature(file)!==signature)throw failure('源文件在预检期间发生变化','SITI_PREFLIGHT_CHANGED');
    return {...result('out-of-range'),metadataVerification:verified};
  }
  if(code!==0)throw failure(decoderError(stderr)||`SI/TI 亮度范围预检解码进程退出 ${code}`,'SITI_PREFLIGHT_DECODE');
  if(offset)throw failure('SI/TI 预检原始帧截断或读取不完整','SITI_PREFLIGHT_VALIDATION');
  if(!frames)throw failure('未获取到可核验的视频帧','SITI_PREFLIGHT_EMPTY');
  if(timestamps.length!==frames||metadataCount!==frames)throw failure('SI/TI 预检帧数与逐帧格式、色彩元数据不一致','SITI_PREFLIGHT_VALIDATION');
  if(await mediaSignature(file)!==signature)throw failure('源文件在预检期间发生变化','SITI_PREFLIGHT_CHANGED');
  return result('in-range');

  function result(status){
    return {status,framesScanned:frames,firstOutOfRange:hit,nominalRange:{min:reader.lo,max:reader.hi},
      observedColor:{range:observedRange??null,transfer:observedTransfer??null},
      input:{pixelFormat:format,width,height,bitDepth:input.depth,range:input.range,transfer:input.domain,layout:input.format.layout},
      signature,elapsedSeconds:(performance.now()-started)/1000,commands,
      scope:status==='in-range'?'完整解码并逐帧核验；所有亮度码值均位于标称黑白端点内（端点包含在有效区间）。':'在有效帧上发现标称黑白端点外的亮度码值；只证明存在越界，不保证其余画面或全部 SI/TI 输入条件符合。'};
  }
}
