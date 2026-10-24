// Explicit, expensive qualification run; not repeated in every general CI run.
// All media, observations and reports stay inside the current project .build.
import {mkdir,mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {FF,FP,run,probe} from '../engine.mjs';
import {analyzeRepeats} from '../repeat.mjs';

const root=path.resolve('.build/repeat-resources');await mkdir(root,{recursive:true});
const dir=await mkdtemp(path.join(root,'run-')),sha=b=>createHash('sha256').update(b).digest('hex');
const sourceFiles=['repeat.mjs','engine.mjs','public/repeat-model.js','public/analysis-limits.js','testing-tools/repeat-resource.mjs'];
const identity=await Promise.all(sourceFiles.map(async name=>({path:name,sha256:sha(await readFile(name))})));
const toolFiles=await Promise.all([process.execPath,FF,FP].map(async file=>({file,sha256:sha(await readFile(file))})));
const evidence={startedAt:new Date().toISOString(),host:{platform:process.platform,release:os.release(),cpu:os.cpus()[0]?.model,logicalProcessors:os.availableParallelism(),totalMemory:os.totalmem()},identity,tools:toolFiles,versions:{node:process.version,ffmpeg:(await run(FF,['-version'])).split('\n')[0],ffprobe:(await run(FP,['-version'])).split('\n')[0]},cases:[],outcome:'running'};
let phase='initializing';const observations=[],progress=[];
const sampler=setInterval(()=>observations.push({at:new Date().toISOString(),phase,...process.memoryUsage()}),1000);sampler.unref();
let processSampler;
if(process.platform==='win32'){
  const script=`$ErrorActionPreference='Stop'; while(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { $items=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe') } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ @{id=$p.Id;name=$p.ProcessName;workingSet=$p.WorkingSet64;peakWorkingSet=$p.PeakWorkingSet64} } }); @{at=[DateTime]::UtcNow.ToString('o');items=$items} | ConvertTo-Json -Compress -Depth 4; Start-Sleep -Seconds 2 }`;
  processSampler=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let pending='';processSampler.stdout.on('data',b=>{pending+=b;const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)if(line.trim()){try{observations.push({...JSON.parse(line),phase,kind:'child-process'})}catch(e){evidence.samplerError=e.message}}});
  processSampler.stderr.on('data',b=>{evidence.samplerError=String(b)});processSampler.on('error',e=>{evidence.samplerError=e.message});
}
try{
  for(const [name,width,height,duration] of [['1080p120-30m',1920,1080,1800],['4k120-10m',3840,2160,600]]){
    const file=path.join(dir,name+'.mkv'),ctx={commands:[],decodeThreads:4,update:value=>{
      progress.push({at:new Date().toISOString(),phase,...value});
    }};
    phase=name+'/encode';console.log(phase);const begun=performance.now();
    const seed=path.join(dir,name+'-seed.mp4');
    await run(FF,['-hide_banner','-nostdin','-v','error','-y','-f','lavfi','-i',`color=black:size=${width}x${height}:rate=120:duration=1`,'-an','-c:v','libx264','-preset','ultrafast','-qp','0','-g','120','-threads:v','4','-pix_fmt','yuv420p',seed],ctx);
    // Loop packet copies to prepare long real input efficiently. The analyzer still
    // decodes and fingerprints every one of the 216,000 / 72,000 display frames.
    await run(FF,['-hide_banner','-nostdin','-v','error','-y','-stream_loop',String(duration-1),'-i',seed,'-map','0:v:0','-an','-c','copy',file],ctx);
    const encodeSeconds=(performance.now()-begun)/1000,stream=(await probe(file,ctx)).raw.streams[0];
    assert.equal(stream.pix_fmt,'yuv420p');assert.equal(stream.width,width);assert.equal(stream.height,height);
    phase=name+'/analyze';console.log(phase);const start=performance.now(),r=await analyzeRepeats(file,stream,ctx);
    const elapsedSeconds=(performance.now()-start)/1000;
    const expected=sha(Buffer.concat([Buffer.alloc(width*height,16),Buffer.alloc(width*height/2,128)]));
    assert.equal(r.frames.length,duration*120);assert.ok(r.frames.every(f=>f.sha256===expected));assert.equal(r.exact.duplicates,r.frames.length-1);assert.equal(r.exact.runs.length,1);assert.equal(r.timeline.status,'complete');assert.ok(r.timeline.grids.some(g=>g.rate==='120/1'&&g.status==='compatible'));
    const report=path.join(dir,name+'.json.gz');await writeFile(report,gzipSync(Buffer.from(JSON.stringify({result:r,commands:ctx.commands}))));
    evidence.cases.push({name,width,height,durationSeconds:duration,rate:120,frames:r.frames.length,expectedHash:expected,encodeSeconds,elapsedSeconds,sourceBytes:(await stat(file)).size,report:path.basename(report),reportSha256:sha(await readFile(report)),commands:ctx.commands});
    console.log(JSON.stringify({name,frames:r.frames.length,elapsedSeconds,peakNodeRss:Math.max(...observations.filter(x=>x.rss).map(x=>x.rss))}));
    phase=name+'/cancel';const controller=new AbortController();let requestedAt=null;
    await assert.rejects(()=>analyzeRepeats(file,stream,{signal:controller.signal,decodeThreads:4,update:value=>{if(value.detail==='原始帧证据读取完成'){requestedAt=performance.now();setTimeout(()=>controller.abort(),250);}}}),e=>controller.signal.aborted);
    evidence.cases.at(-1).cancelLatencySeconds=(performance.now()-requestedAt)/1000;
    assert.ok(evidence.cases.at(-1).cancelLatencySeconds<10,'cancelled child must terminate promptly');
    await writeFile(path.join(dir,'observations.json.gz'),gzipSync(Buffer.from(JSON.stringify({observations,progress}))));
    await writeFile(path.join(dir,'resource.json'),JSON.stringify(evidence,null,2));
  }
  assert.equal(evidence.samplerError,undefined);assert.ok(observations.some(x=>x.kind==='child-process'&&x.items.length),'observe actual child memory');
  evidence.outcome='passed';
}catch(e){evidence.outcome='failed';evidence.error=e.stack;process.exitCode=1;}
finally{
  clearInterval(sampler);processSampler?.kill();
  if(processSampler)await new Promise(resolve=>processSampler.exitCode!==null?resolve():processSampler.once('close',resolve));
  evidence.finishedAt=new Date().toISOString();evidence.observationMethod='Node RSS/heap/external every 1 second; owned FFmpeg/FFprobe WorkingSet64 and PeakWorkingSet64 every 2 seconds via Windows process queries. Sampling may miss short peaks; reports are synthetic static lossless input qualification, not general throughput guarantees.';
  await writeFile(path.join(dir,'observations.json.gz'),gzipSync(Buffer.from(JSON.stringify({observations,progress}))));
  await writeFile(path.join(dir,'resource.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({directory:dir,outcome:evidence.outcome,error:evidence.error}));
}
