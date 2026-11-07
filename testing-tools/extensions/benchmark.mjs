import assert from '../helpers/assert.mjs';
import path from 'node:path';
import {writeFile,readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {FP,run,probe} from '../helpers/subject.mjs';
import {allPackets} from '../helpers/subject.mjs';
import {createBitrateAccumulator,bitrateView} from '../../public/bitrate-model.js';

export async function measure({parameters:p,directory,signal},kind){
  const file=path.resolve(p.file),size=(await stat(file)).size,digest=createHash('sha256');
  for await(const chunk of createReadStream(file)){signal?.throwIfAborted();digest.update(chunk)}
  const input={file,bytes:size,sha256:digest.digest('hex'),provenance:'Caller-supplied media'};
  const commands=[],ctx={signal,cwd:directory,commands},observations=[];
  const info=await probe(file,ctx);
  if(kind==='probe'){
    for(let i=0;i<p.repetitions;i++){
      const before=process.memoryUsage().rss,started=performance.now(),baseline=[];
      await run(FP,['-v','error','-show_format','-show_streams','-show_chapters','-of','json',file],{...ctx,commands:baseline});
      await run(FP,['-v','error','-select_streams','v','-read_intervals','%+#32','-show_frames','-show_entries','frame=stream_index,color_range,color_space,color_transfer,color_primaries:frame_side_data','-of','json',file],{...ctx,commands:baseline});
      const baselineSeconds=(performance.now()-started)/1000,next=performance.now(),supplemented=[];
      const actual=await probe(file,{...ctx,commands:supplemented});assert.equal(actual.frameSampleRead.status,'not-requested');
      assert.ok(supplemented.every(c=>!c.args.includes('-read_intervals')));
      observations.push({baselineSeconds,supplementedSeconds:(performance.now()-next)/1000,nodeRssBeforeBytes:before,nodeRssAfterBytes:process.memoryUsage().rss,commands:baseline,fullCommands:supplemented});
    }
    const memoryInput=path.join(directory,'memory-input.json'),memoryOutput=path.join(directory,'memory-output.json');
    await writeFile(memoryInput,JSON.stringify([...observations[0].commands,...observations[0].fullCommands]));
    execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/helpers/probe-memory.ps1'),'-InputPath',memoryInput,'-OutputPath',memoryOutput],{windowsHide:true,timeout:60000});
    const processes=JSON.parse((await readFile(memoryOutput,'utf8')).replace(/^\uFEFF/,''));
    for(const item of processes){assert.equal(item.exitCode,0);assert.ok(item.observedPeakWorkingSetBytes>0)}
    return {outcome:'passed',input,observations,processes,scope:'Same input/runtime observations; sampled memory lower bounds, no general speed or memory threshold'};
  }
  const packets=[];
  await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,duration,size','-of','compact=p=0:nk=0',file],ctx,line=>{const packet=Object.fromEntries(line.split('|').map(s=>s.split('=')));if(packet.stream_index!==undefined)packets.push({...packet,stream_index:Number(packet.stream_index)})});
  const calculate=window=>{const a=new Map(info.raw.streams.filter(s=>['video','audio'].includes(s.codec_type)).map(s=>[s.index,createBitrateAccumulator(s.time_base,window)]));for(const packet of packets)a.get(packet.stream_index)?.add(packet);return [...a.values()].map(x=>x.finish())};
  const curves={100:calculate(100),1000:calculate(1000)};
  for(let i=0;i<curves[100].length;i++)assert.deepEqual(bitrateView(curves[100][i],1000),bitrateView(curves[1000][i],1000));
  for(let round=0;round<p.repetitions;round++)for(const windowMs of round%2?[1000,100]:[100,1000]){
    const start=performance.now(),actual=await allPackets(file,info.raw.streams,{...ctx,bitrateWindowMs:windowMs}),packetScanMs=performance.now()-start;
    assert.deepEqual(actual.filter(t=>t.bitrateCurve).map(t=>t.bitrateCurve),curves[windowMs]);
    const calc=performance.now();calculate(windowMs);const calculationMs=performance.now()-calc,serialize=performance.now(),text=JSON.stringify(curves[windowMs]);
    observations.push({round,windowMs,packetScanMs,calculationMs,serializationMs:performance.now()-serialize,jsonBytes:Buffer.byteLength(text)});
  }
  return {outcome:'passed',input,observations,commands,scope:'Alternating order, same file and packet list; includes no controlled cross-device throughput claim'};
}
