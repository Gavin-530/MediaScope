import {projectTest} from '../../helpers/case-test.mjs';
import assert from '../../helpers/assert.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {startServer} from '../../helpers/server.mjs';
import {MAX_ANALYSIS_FRAMES} from '../../../public/analysis-limits.js';
const test=projectTest(import.meta.url);

test('job admission accepts a valid scene list above the small request limit without running its frames',async t=>{
 await mkdir(workRoot,{recursive:true});const file=workPath('queued-control.y4m');
 const frameCount=2048,frame=Buffer.concat([Buffer.from('FRAME\n'),Buffer.alloc(16,16)]);
 await writeFile(file,Buffer.concat([Buffer.from('YUV4MPEG2 W4 H4 F30:1 Ip A1:1 Cmono\n'),...Array.from({length:frameCount},()=>frame)]));
 const app=await startServer(workPath('data'));t.after(()=>app.stop());
 // This is a bounded request/queue contract, not a maximum-media computation.
 // Every scene start corresponds to an actual frame in this tiny control.
 const starts=Array.from({length:frameCount},(_,i)=>i);
 const input={type:'analyze',file,complexity:true,sitiSettings:{range:'pc',transfer:'pq'},sitiSceneStarts:starts,enqueue:true};
 // Ordinary formatted JSON crosses the generic request limit without inventing
 // out-of-media scene indices or decoding an upper-limit workload.
 assert.ok(Buffer.byteLength(JSON.stringify(input,null,2))>16384);
 const accepted=await app.request('jobs','POST',input,{jsonSpace:2});
 assert.equal((await app.request('jobs/'+accepted.id)).status,'queued');
 await assert.rejects(app.request('jobs','POST',{...input,sitiSceneStarts:[0,MAX_ANALYSIS_FRAMES]}),/400/);
});
