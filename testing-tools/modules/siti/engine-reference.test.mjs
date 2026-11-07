import {workRoot} from '../../helpers/workspace.mjs';
import {before} from 'node:test';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,probe,run} from '../../helpers/subject.mjs';
import {complexity} from '../../helpers/subject.mjs';




const dir=workRoot,source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{await mkdir(dir,{recursive:true});});
test('SI/TI preserves one measurement per decoded frame',async()=>{
 const native=path.join(dir,'sdr-lossless.mkv');await run(FF,['-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=1,setfield=prog,setparams=range=limited:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v','ffv1','-level','3',native]);
 const p=await probe(native),r=await complexity(native,p.raw.streams[0],context());assert.equal(r.points.length,12);assert.ok(r.si.mean>0);assert.ok(r.ti.mean>0);assert.equal(r.points[0].ti,null);
 // Explicit out-of-range boundary media, losslessly encoded. Preserve the
 // worker's useful rejection reason instead of a downstream pipe error.
 const invalid=path.join(dir,'sdr-invalid-range.mkv');await run(FF,['-v','error','-y','-f','lavfi','-i','color=black:size=192x108:rate=12:duration=1,format=yuv420p,geq=lum=15:cb=128:cr=128,setfield=prog,setparams=range=limited:color_trc=bt709:color_primaries=bt709:colorspace=bt709','-c:v','ffv1','-level','3',invalid]);
 const rejected=await probe(invalid);const unavailable=await complexity(invalid,rejected.raw.streams[0],context());assert.equal(unavailable.available,false);assert.match(unavailable.reason,/亮度码值 15 超出声明范围/);
});
