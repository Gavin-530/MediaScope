import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fork,spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import assert from '../../../helpers/assert.mjs';
export async function observeAnalysis(file,expected,{directory,signal,cancelStage}={}){
signal?.throwIfAborted();
const observations=[],progress=[];
async function execute(file,expected,{cancelAt,requireError}={}){
  const worker=fork(new URL('./repeat-resource-worker.mjs',import.meta.url),[],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',answer,cancelRequestedAt=null,previousBeat=null,maxHeartbeatGapMs=0,phase='start';
  worker.stdout.on('data',b=>stdout+=b);worker.stderr.on('data',b=>stderr+=b);
  const script=`$ErrorActionPreference='Stop'; while(Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue){ $ids=@(${worker.pid})+@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${worker.pid}' | Select-Object -ExpandProperty ProcessId); $items=@($ids | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction SilentlyContinue; if($p){ @{id=$p.Id;name=$p.ProcessName;workingSet=$p.WorkingSet64;peakWorkingSet=$p.PeakWorkingSet64} } }); @{at=[DateTime]::UtcNow.ToString('o');items=$items} | ConvertTo-Json -Compress -Depth 4; Start-Sleep -Milliseconds 500 }`;
  const sampler=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let pending='',samplerError='';sampler.stderr.on('data',b=>samplerError+=b);sampler.on('error',e=>samplerError+=e.message);
  sampler.stdout.on('data',b=>{pending+=b;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line.trim())observations.push({...JSON.parse(line),phase,worker:worker.pid});});
  let cancelTimer,lastPrint=0;
  worker.on('message',m=>{
    if(m.type==='heartbeat'){const now=performance.now();if(previousBeat!==null)maxHeartbeatGapMs=Math.max(maxHeartbeatGapMs,now-previousBeat);previousBeat=now;observations.push({kind:'node',worker:worker.pid,phase,...m});}
    if(m.type==='progress'){
      phase=m.detail;progress.push({worker:worker.pid,receivedAt:Date.now(),...m});
      if(performance.now()-lastPrint>30000){lastPrint=performance.now();console.log(JSON.stringify({phase,completed:m.completed,total:m.total}));}
      if(cancelAt?.(m)&&cancelRequestedAt===null&&!cancelTimer)cancelTimer=setTimeout(()=>{cancelRequestedAt=performance.now();worker.send({type:'cancel'});},100);
    }
    if(m.type==='result')answer=m;
  });
  const onAbort=()=>{if(worker.connected)worker.send({type:'cancel'})};signal?.addEventListener('abort',onAbort,{once:true});worker.send({type:'analyze',file,expected});
  const exit=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('close',(code,signal)=>resolve({code,signal}));});
  const terminatedAt=performance.now();signal?.removeEventListener('abort',onAbort);clearTimeout(cancelTimer);sampler.kill();
  if(sampler.exitCode===null)await new Promise(resolve=>sampler.once('close',resolve));
  assert.equal(samplerError,'','process memory sampler must succeed');assert.ok(answer,'worker must return an actual analysis outcome');assert.equal(exit.code,0,stderr||stdout);
  const samples=observations.filter(x=>x.worker===worker.pid),processes=samples.flatMap(x=>x.items??[]);
  const measured={...answer,worker:worker.pid,maxHeartbeatGapMs:samples.filter(s=>s.kind==='node').length>1?maxHeartbeatGapMs:null,cancelLatencySeconds:cancelRequestedAt===null?null:(terminatedAt-cancelRequestedAt)/1000,
    peakObservedNodeRss:samples.some(s=>s.memory)?Math.max(...samples.filter(s=>s.memory).map(s=>s.memory.rss)):null,
    peakObservedNodeHeap:samples.some(s=>s.memory)?Math.max(...samples.filter(s=>s.memory).map(s=>s.memory.heapUsed)):null,
    peakReportedProcessWorkingSets:[...new Set(processes.map(p=>p.id))].map(id=>({id,name:processes.find(p=>p.id===id).name,peakWorkingSet:Math.max(...processes.filter(p=>p.id===id).map(p=>p.peakWorkingSet))}))};
  if(cancelAt){assert.notEqual(cancelRequestedAt,null);assert.equal(answer.outcome,'cancelled');}
  else if(requireError){assert.equal(answer.outcome,'failed');assert.match(answer.error,requireError);}
  else {assert.equal(answer.outcome,'passed',answer.error);}
  return measured;
}

try{return await execute(file,expected,{cancelAt:cancelStage?m=>cancelStage==='scan'?m.detail==='读取原始帧时间与格式证据':m.detail==='原始帧证据读取完成':undefined})}finally{await writeFile(path.join(directory,'observations.json.gz'),gzipSync(Buffer.from(JSON.stringify({method:'Independent parent clock; worker heartbeat and external Windows process sampling. Sampled peaks are lower bounds, no universal latency guarantee.',observations,progress}))))}
}
