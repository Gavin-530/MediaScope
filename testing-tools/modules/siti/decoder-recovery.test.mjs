import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {measureSiti} from '../../helpers/subject.mjs';
import {FF,run,probe,scan} from '../../helpers/subject.mjs';


async function directory(){await mkdir(workRoot,{recursive:true});return mkdtemp(workPath('siti-p910-'));}

test('[analysis-limits] invalid samples stop and drain an active decoder instead of hanging',{timeout:20000},async t=>{
  const folder=await directory(),file=path.join(folder,'invalid.mkv'),ctx={signal:t.signal,decodeThreads:1};
  await run(FF,['-v','error','-y','-f','lavfi','-i',"nullsrc=s=512x256:r=120,format=gray,geq=lum='if(eq(X,0)*eq(Y,0),15,16)',setfield=prog",'-frames:v','96','-c:v','ffv1','-threads:v','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],frames=await scan(file,0,ctx);
  await assert.rejects(measureSiti(file,stream,{...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1},frames),e=>e.sitiPhase==='input'&&/超出声明范围/.test(e.message));
  assert.equal(t.signal.aborted,false);
});
