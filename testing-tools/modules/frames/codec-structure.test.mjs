import {engineControl,av1Control} from '../../helpers/encoded-controls.mjs';
import {workRoot} from '../../helpers/workspace.mjs';
import {before} from 'node:test';
import {projectTest,selectedCases} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,probe,run,scan} from '../../helpers/subject.mjs';
import {structure,av1ShortRefs} from '../../helpers/subject.mjs';




const dir=workRoot,source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{await mkdir(dir,{recursive:true});if(selectedCases(import.meta.url).some(c=>c.name.startsWith('H.264 IDR')))await engineControl(dir);});
test('H.264 IDR is determined from NAL headers, not inferred from I frames',async()=>{
 const p=await probe(source),frames=await scan(source,0),r=await structure(source,p.raw.streams[0],frames,context());assert.equal(frames[0].special,'IDR');assert.equal(r.matchedDisplayFrames,12);assert.equal(r.gops[0].count,12);assert.ok(frames.slice(1).every(f=>f.special==='NON_IDR'));
});
test('HEVC open GOP exposes CRA and IDR separately',async()=>{
 const file=path.join(dir,'open-gop.mp4');await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=3','-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:pools=1:keyint=12:min-keyint=12:scenecut=0:open-gop=1',file]);
 const p=await probe(file),f=await scan(file,0),r=await structure(file,p.raw.streams[0],f,context());assert.match(f[0].special,/IDR/);assert.ok(f.some(x=>x.special==='CRA_NUT'));assert.ok(r.gops.length>=3);assert.equal(r.matchedDisplayFrames,f.length);
});
test('AV1 trace preserves hidden frames, show-existing events and reference slots',async()=>{
 const file=await av1Control(dir),p=await probe(file),f=await scan(file,0),r=await structure(file,p.raw.streams[0],f,context());assert.ok(r.counts.hidden>0);assert.ok(r.counts.showExisting>0);assert.equal(r.counts.shown,f.length);assert.equal(r.matchedDisplayFrames,f.length);assert.equal(r.events[0].kind,'KEY');assert.ok(r.events.filter(e=>e.showExisting).every(e=>Number.isInteger(e.sourceEvent)));assert.ok(r.events.filter(e=>e.kind==='INTER').every(e=>e.referenceSlots.length===7));
});
test('short reference signaling yields seven valid slots',()=>{const refs=av1ShortRefs(0,1,10,7,[9,5,11,12,8,7,6,4]);assert.equal(refs.length,7);assert.equal(refs[0],0);assert.equal(refs[3],1);assert.equal(refs[6],3);assert.ok(refs.every(x=>x>=0&&x<8))});
