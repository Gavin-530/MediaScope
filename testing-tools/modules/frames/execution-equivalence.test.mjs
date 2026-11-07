import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdtemp,readdir,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,scan} from '../../helpers/subject.mjs';
import {allPackets,structure,traceStructure,mapStructure} from '../../helpers/subject.mjs';

const testRoot=workRoot;
async function discardSuccessfulFixture(dir){
  const target=path.resolve(dir);
  assert.ok(target.startsWith(testRoot+path.sep),'fixture must stay inside .build/testing-work');
  // Preserve successful measurements and raw logs until the runner archives them.
  async function mediaOnly(directory){for(const entry of await readdir(directory,{withFileTypes:true})){assert.ok(!entry.isSymbolicLink());const file=path.join(directory,entry.name);if(entry.isDirectory())await mediaOnly(file);else if(/\.(mkv|mp4|mov|nut|yuv)$/.test(entry.name))await unlink(file)}}
  await mediaOnly(target);
}

test('concurrent frame, packet and header passes exactly match sequential structure analysis',async()=>{
  const root=await mkdtemp(workPath('structure-equivalence-'));
  const fixtures=[];
  for(const [name,codec,extra] of [
    ['h264-vfr','libx264',['-x264-params','open-gop=1:keyint=12:min-keyint=12:scenecut=0']],
    ['hevc-open-gop','libx265',['-preset','ultrafast','-x265-params','log-level=error:pools=1:open-gop=1:keyint=12:min-keyint=12:scenecut=0']],
    ['av1-hidden','libaom-av1',['-cpu-used','8']],
    ['unsupported','ffv1',[]]
  ]){
    const file=path.join(root,name+'.mkv'),filter=name==='h264-vfr'?"setpts='if(lt(N,12),N,2*N-12)/(12*TB)'":'null';
    await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=12:duration=2','-vf',filter,'-fps_mode','passthrough','-c:v',codec,...extra,file]);fixtures.push(file);
  }
  for(const file of fixtures){
    const info=await probe(file),stream=info.raw.streams[0],sequentialFrames=await scan(file,0,{decodeThreads:1}),sequentialTracks=await allPackets(file,info.raw.streams,{}),sequentialCoding=await structure(file,stream,sequentialFrames,{});
    const frames=await scan(file,0),[tracks,trace]=await Promise.all([allPackets(file,info.raw.streams,{}),traceStructure(file,stream,{})]);
    const coding=mapStructure(trace,stream,frames);
    await writeFile(path.join(root,path.basename(file)+'.json'),JSON.stringify({sequential:{frames:sequentialFrames,tracks:sequentialTracks,coding:sequentialCoding},parallel:{frames,tracks,coding}},null,2));
    assert.deepEqual(frames,sequentialFrames,path.basename(file)+' frames');
    assert.deepEqual(tracks,sequentialTracks,path.basename(file)+' packets');
    assert.deepEqual(coding,sequentialCoding,path.basename(file)+' structure');
  }
  await discardSuccessfulFixture(root);
});
