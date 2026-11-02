import {mkdir,mkdtemp,writeFile,readFile,stat,open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fork,spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {FF,FP,run} from '../../engine.mjs';
const mode=process.argv[2]??'all';assert.ok(['all','long','boundary'].includes(mode));
const root=path.resolve('.build/repeat-resources');await mkdir(root,{recursive:true});
const dir=await mkdtemp(path.join(root,'run-')),sha=b=>createHash('sha256').update(b).digest('hex');
const sourceFiles=['repeat.mjs','repeat-samples.mjs','engine.mjs','public/repeat-model.js','public/repeat-difference.js','public/analysis-limits.js','testing-tools/repeat-resource.mjs','testing-tools/helpers/repeat-resource-run.mjs','testing-tools/helpers/repeat-resource-worker.mjs'];
const evidence={startedAtUtc:new Date().toISOString(),mode,host:{platform:process.platform,release:os.release(),cpu:os.cpus()[0]?.model,totalMemory:os.totalmem()},
  identity:await Promise.all(sourceFiles.map(async name=>({path:name,sha256:sha(await readFile(name))}))),
  tools:await Promise.all([process.execPath,FF,FP].map(async file=>({file,sha256:sha(await readFile(file))}))),cases:[],outcome:'running'};
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
  const timeout=setTimeout(()=>worker.kill(),3*60*60*1000);timeout.unref();worker.send({type:'analyze',file,expected});
  const exit=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('close',(code,signal)=>resolve({code,signal}));});
  const terminatedAt=performance.now();clearTimeout(timeout);clearTimeout(cancelTimer);sampler.kill();
  if(sampler.exitCode===null)await new Promise(resolve=>sampler.once('close',resolve));
  assert.equal(samplerError,'','process memory sampler must succeed');assert.ok(answer,'worker must return an actual analysis outcome');assert.equal(exit.code,0,stderr||stdout);
  const samples=observations.filter(x=>x.worker===worker.pid),processes=samples.flatMap(x=>x.items??[]);
  const measured={...answer,worker:worker.pid,maxHeartbeatGapMs,cancelLatencySeconds:cancelRequestedAt===null?null:(terminatedAt-cancelRequestedAt)/1000,
    peakObservedNodeRss:Math.max(0,...samples.map(s=>s.memory?.rss??0)),
    peakObservedNodeHeap:Math.max(0,...samples.map(s=>s.memory?.heapUsed??0)),
    peakReportedProcessWorkingSets:[...new Set(processes.map(p=>p.id))].map(id=>({id,name:processes.find(p=>p.id===id).name,peakWorkingSet:Math.max(...processes.filter(p=>p.id===id).map(p=>p.peakWorkingSet))}))};
  if(cancelAt){assert.notEqual(cancelRequestedAt,null);assert.equal(answer.outcome,'cancelled');assert.ok(measured.cancelLatencySeconds<=5,'cancel request to drained worker exit <=5 seconds');}
  else if(requireError){assert.equal(answer.outcome,'failed');assert.match(answer.error,requireError);}
  else {assert.equal(answer.outcome,'passed',answer.error);assert.ok(maxHeartbeatGapMs<=2000,'analyzer event loop must remain responsive within the 2 second engineering target');}
  return measured;
}
async function staticFile(name,width,height,frames,rate=120){
  const file=path.join(dir,name+'.nut');
  await run(FF,['-v','error','-y','-f','lavfi','-i',`color=black:size=${width}x${height}:rate=${rate}`,'-frames:v',String(frames),'-c:v','ffv1','-threads:v','4','-pix_fmt','yuv420p',file]);
  return {file,expected:{frames,duplicates:frames-1,hash:sha(Buffer.concat([Buffer.alloc(width*height,16),Buffer.alloc(width*height/2,128)])),rate:rate+'/1'}};
}
try{
  if(mode!=='long'){
    const boundary=await staticFile('two-million',8,8,2000000);evidence.cases.push({name:'two-million',...await execute(boundary.file,boundary.expected)});
    const over=await staticFile('two-million-plus-one',8,8,2000001);evidence.cases.push({name:'two-million-plus-one',...await execute(over.file,over.expected,{requireError:/2,000,000/})});
    // Exactly 128 MiB native bytes, with a last-sample one-code change.
    const raw=path.join(dir,'128mib.raw'),large=path.join(dir,'128mib.nut'),frame=Buffer.alloc(128*1024*1024),handle=await open(raw,'wx');
    try{await handle.write(frame);frame[frame.length-1]=1;await handle.write(frame);}finally{await handle.close();}
    await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray','-video_size','16384x8192','-framerate','1','-i',raw,'-c:v','rawvideo','-threads:v','1',large]);
    evidence.cases.push({name:'128MiB-native-frame',...await execute(large,{frames:2,duplicates:0,rate:'1/1'})});
    for(const [name,width,height]of [['1080p',1920,1080],['4k',3840,2160],['8k',8192,4320]]){
      const clip=await staticFile(name+'-cancel',width,height,360);
      for(const stage of ['scan','compare'])evidence.cases.push({name:name+'-cancel-'+stage,...await execute(clip.file,clip.expected,{cancelAt:m=>stage==='scan'?m.detail==='读取原始帧时间与格式证据':m.detail==='原始帧证据读取完成'})});
    }
  }
  if(mode!=='boundary')for(const [name,width,height,seconds]of [['1080p120-30m',1920,1080,1800],['4k120-10m',3840,2160,600]]){
    console.log('Prepare '+name);const seed=path.join(dir,name+'-seed.mkv'),file=path.join(dir,name+'.mkv');
    await run(FF,['-v','error','-y','-f','lavfi','-i',`color=black:size=${width}x${height}:rate=120:duration=1`,'-c:v','libx264','-preset','ultrafast','-qp','0','-g','120','-threads:v','4','-pix_fmt','yuv420p',seed]);
    await run(FF,['-v','error','-y','-stream_loop',String(seconds-1),'-i',seed,'-c','copy',file]);
    const expected={frames:seconds*120,duplicates:seconds*120-1,hash:sha(Buffer.concat([Buffer.alloc(width*height,16),Buffer.alloc(width*height/2,128)])),rate:'120/1'};
    console.log('Analyze '+name);evidence.cases.push({name,width,height,seconds,inputBytes:(await stat(file)).size,...await execute(file,expected)});
    await writeFile(path.join(dir,'resource.json'),JSON.stringify(evidence,null,2));
  }
  assert.ok(observations.some(x=>x.items?.some(p=>/ffmpeg|ffprobe/.test(p.name))),'actual child memory observations required');evidence.outcome='passed';
}catch(error){evidence.outcome='failed';evidence.error=error.stack;process.exitCode=1;}
finally{
  evidence.finishedAtUtc=new Date().toISOString();evidence.observationMethod='Independent parent clock and 100 ms worker heartbeat; Windows process WorkingSet64/PeakWorkingSet64 sampled every 500 ms outside analyzer event loop. Sampled maxima are lower bounds. Static lossless synthetic input qualification; no general throughput claim.';
  await writeFile(path.join(dir,'observations.json.gz'),gzipSync(Buffer.from(JSON.stringify({observations,progress}))));await writeFile(path.join(dir,'resource.json'),JSON.stringify(evidence,null,2));
  console.log('BEGIN_REPEAT_RESOURCE_JSON');console.log(JSON.stringify({...evidence,directory:dir}));console.log('END_REPEAT_RESOURCE_JSON');
}
