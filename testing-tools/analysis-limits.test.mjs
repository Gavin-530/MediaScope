import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {MAX_ANALYSIS_FRAMES,MAX_SITI_PIXELS,validateSitiDimensions} from '../public/analysis-limits.js';
import {sitiInput,validateSitiSceneStarts,validateSitiPoints,sitiValuesClose} from '../public/siti.js';
import {measureSiti} from '../siti.mjs';
import {FF,run,probe,scan} from '../engine.mjs';
import {traceStructure,mapStructure,createTraceParser} from '../analysis.mjs';

async function directory(){await mkdir('.build/testing-work',{recursive:true});return mkdtemp(path.resolve('.build/testing-work/siti-p910-'));}

test('[analysis-limits] dimensions, final scene index and CPU/GPU contracts have explicit inclusive boundaries',async()=>{
  assert.equal(MAX_ANALYSIS_FRAMES,2000000);assert.equal(MAX_SITI_PIXELS,35389440);
  for(const [w,h] of [[3,3],[7680,4320],[8192,4320],[4320,8192]])validateSitiDimensions(w,h);
  for(const [w,h] of [[2,3],[8192,4321],[4321,8192],[15360,8640],[NaN,4320],[8192,4.5]])assert.throws(()=>validateSitiDimensions(w,h));
  validateSitiSceneStarts([0,1999999],2000000);
  for(const starts of [[0,2000000],[0,1999999,1999999]])assert.throws(()=>validateSitiSceneStarts(starts,2000000));
  await assert.rejects(measureSiti('unused',{pix_fmt:'gray'}, {},new Array(2000001)),/2,000,000/);
  // Source contract check complements real GPU execution, not a device measurement.
  const source=await readFile(new URL('../gpu/SitiOpenCl.cs',import.meta.url),'utf8');
  assert.match(source,/MaxFrames=2000000, MaxPixels=8192\*4320/);
});

test('[analysis-limits] real trace budget exhaustion keeps decoder GOPs and independent SI/TI',{timeout:60000},async t=>{
  const folder=await directory(),file=path.join(folder,'trace.mp4'),ctx={signal:t.signal};
  await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=s=64x48:r=24:d=1','-c:v','libx264','-qp','0','-preset','ultrafast','-color_range','tv','-color_trc','bt709',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  const trace=await traceStructure(file,stream,{...ctx,traceLimits:{maxPackets:3}});
  assert.equal(trace.status,'resource-limited');assert.equal(trace.supported,false);assert.equal(trace.packets,undefined);
  const coding=mapStructure(trace,stream,frames);assert.equal(coding.gops.at(-1).end,frames.length-1);
  const metrics=await measureSiti(file,stream,{...ctx,sitiSettings:{range:'tv',transfer:'sdr'},sitiWorkers:1},frames);assert.equal(metrics.points.length,24);
  const parser=createTraceParser('av1',{maxEvents:1});
  const event=()=>{parser.line('[trace_headers] OBU header');parser.line('[trace_headers] 0 obu_type 0 = 6');parser.line('[trace_headers] Frame Header');};
  parser.line('[trace_headers] Packet: 10 pts 0');event();parser.line('[trace_headers] Packet: 10 pts 1');event();
  assert.throws(()=>parser.finish(),e=>e.code==='TRACE_RECORD_LIMIT');
});

test('[analysis-limits] SI/TI really decodes the 8192x4320 boundary and matches analytic PQ edge statistics',{timeout:180000},async t=>{
  const folder=await directory(),file=path.join(folder,'8k.mkv'),commands=[],ctx={signal:t.signal,decodeThreads:1,commands};
  await run(FF,['-v','error','-y','-f','lavfi','-i',"nullsrc=s=8192x4320:r=1,format=gray,geq=lum='if(lt(X,W/2+N),16,235)',setfield=prog",'-frames:v','2','-c:v','ffv1','-threads:v','1','-color_range','tv','-color_trc','smpte2084',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  assert.equal(stream.width*stream.height,MAX_SITI_PIXELS);assert.equal(stream.pix_fmt,'gray');
  const result=await measureSiti(file,stream,{...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1},frames);
  const p=2/(8192-2),si=4*Math.sqrt(p*(1-p))*255,q=1/8192,ti=Math.sqrt(q*(1-q))*255;
  for(const point of result.points)assert.ok(sitiValuesClose(point.si,si));
  assert.equal(result.points[0].ti,null);assert.ok(sitiValuesClose(result.points[1].ti,ti));
  await writeFile(path.join(folder,'8k-boundary.json'),JSON.stringify({outcome:'passed',commands,stream,result,analytic:{si,ti}}));
});

test('[analysis-limits] invalid samples stop and drain an active decoder instead of hanging',{timeout:20000},async t=>{
  const folder=await directory(),file=path.join(folder,'invalid.mkv'),ctx={signal:t.signal,decodeThreads:1};
  await run(FF,['-v','error','-y','-f','lavfi','-i',"nullsrc=s=512x256:r=120,format=gray,geq=lum='if(eq(X,0)*eq(Y,0),15,16)',setfield=prog",'-frames:v','96','-c:v','ffv1','-threads:v','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  await assert.rejects(measureSiti(file,stream,{...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1},frames),e=>e.sitiPhase==='input'&&/超出声明范围/.test(e.message));
  assert.equal(t.signal.aborted,false);
});

test('[analysis-limits] SI/TI processes two million real frames and verifies every measured point',{timeout:600000},async t=>{
  const folder=await directory(),file=path.join(folder,'two-million.mkv'),commands=[],ctx={signal:t.signal,decodeThreads:1,commands};
  await run(FF,['-v','error','-y','-f','lavfi','-i',"nullsrc=s=8x8:r=120,format=gray,geq=lum='16+219*mod(X+N,2)',setfield=prog",'-frames:v',String(MAX_ANALYSIS_FRAMES),'-c:v','ffv1','-threads:v','1','-color_range','tv','-color_trc','smpte2084',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  assert.equal(frames.length,MAX_ANALYSIS_FRAMES);
  const result=await measureSiti(file,stream,{...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1},frames);
  assert.equal(result.points.length,MAX_ANALYSIS_FRAMES);validateSitiPoints(result.points,frames);
  for(const point of result.points){assert.equal(point.si,0);assert.equal(point.ti,point.frame===0?null:255);}
  await writeFile(path.join(folder,'two-million-boundary.json'),JSON.stringify({outcome:'passed',commands,stream,framesScanned:frames.length,framesMeasured:result.points.length,first:result.points[0],last:result.points.at(-1),configuration:result.execution.configuration,allPointsMatchAnalytic:true}));
});
