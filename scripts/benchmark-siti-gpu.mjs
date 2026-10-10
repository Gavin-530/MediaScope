// Development measurement only; never invoked by startup or packaging.
import {mkdir,mkdtemp,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {FF,run,probe,scan} from '../engine.mjs';
import {complexity} from '../analysis.mjs';
await mkdir('test-work',{recursive:true});const dir=await mkdtemp(path.resolve('test-work/siti-gpu-'));
const file=path.join(dir,'benchmark.mkv');
const duration=Number(process.argv[2]??10);
if(!Number.isInteger(duration)||duration<1||duration>60)throw Error('Duration must be 1–60 seconds');
await run(FF,['-v','error','-f','lavfi','-i',`testsrc2=size=1280x720:rate=24:duration=${duration}`,'-c:v','libx264','-preset','fast',file]);
const info=await probe(file),stream=info.raw.streams[0],frames=await scan(file,0),runs=[];
for(const [device,workers] of [['cpu',1],['cpu',4],['gpu',1]]){
  const commands=[],start=performance.now();
  const content=await complexity(file,stream,{sitiDevice:device,sitiWorkers:workers,commands},frames);
  runs.push({requestedDevice:device,requestedWorkers:workers,elapsedSeconds:(performance.now()-start)/1000,content,commands});
  assert.equal(content.execution.device,device,JSON.stringify(content.execution));
  for(let i=0;i<frames.length;i++)for(const key of ['si','ti'])assert.ok(Math.abs(content.points[i][key]-runs[0].content.points[i][key])<=0.0100001);
}
await writeFile(path.join(dir,'benchmark.json'),JSON.stringify({frames:frames.length,resolution:[stream.width,stream.height],runs},null,2));
await unlink(file);
console.log(JSON.stringify({evidence:path.join(dir,'benchmark.json'),runs:runs.map(r=>({device:r.requestedDevice,workers:r.requestedWorkers,seconds:r.elapsedSeconds,execution:r.content.execution}))},null,2));
