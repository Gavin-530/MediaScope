import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {measureSiti} from '../../helpers/subject.mjs';
import {FF,run,probe,scan} from '../../helpers/subject.mjs';
import {traceStructure,mapStructure,createTraceParser} from '../../helpers/subject.mjs';

async function directory(){await mkdir(workRoot,{recursive:true});return mkdtemp(workPath('siti-p910-'));}

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
