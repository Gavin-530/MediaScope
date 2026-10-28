// Real analyzer process; parent measures cancellation with an independent clock.
import {setImmediate as yieldNow} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {probe} from '../../engine.mjs';
import {analyzeRepeats} from '../../repeat.mjs';
const controller=new AbortController();
process.on('message',message=>{if(message.type==='cancel')controller.abort();});
const heartbeat=setInterval(()=>process.send?.({type:'heartbeat',at:Date.now(),memory:process.memoryUsage()}),100);heartbeat.unref();
process.once('message',async request=>{
  if(request.type!=='analyze')return;
  const commands=[],ctx={signal:controller.signal,decodeThreads:4,commands,update:value=>process.send?.({type:'progress',at:Date.now(),...value})};
  try{
    const stream=(await probe(request.file,ctx)).raw.streams[0];process.send?.({type:'ready',stream});
    const start=performance.now(),r=await analyzeRepeats(request.file,stream,ctx),elapsedSeconds=(performance.now()-start)/1000;
    process.send?.({type:'analysis-complete',elapsedSeconds});
    const expected=request.expected,digest=createHash('sha256');
    assert.equal(r.configurationVersion,2);assert.equal(r.status,'complete');
    assert.equal(r.frames.length,expected.frames);assert.equal(r.exact.duplicates,expected.duplicates);
    if(request.expected.frames===2&&r.sampleFormat.bytes===128*1024*1024)assert.deepEqual(r.frames[1].difference,[[1,1,1,1,256,16368,8176]]);
    for(const [i,frame]of r.frames.entries()){
      if(expected.hash)assert.equal(frame.sha256,expected.hash);
      if(expected.duplicates===expected.frames-1){assert.equal(frame.equalPrevious,i?true:null);assert.equal(frame.difference,null);}
      digest.update(JSON.stringify(frame)+'\n');if(i%8192===0)await yieldNow();
    }
    assert.equal(r.timeline.status,'complete');assert.ok(r.timeline.grids.some(g=>g.rate===expected.rate&&g.status==='compatible'));
    process.send?.({type:'result',outcome:'passed',elapsedSeconds,frames:r.frames.length,duplicates:r.exact.duplicates,runCount:r.exact.runs.length,
      frameEvidenceSha256:digest.digest('hex'),first:r.frames[0],last:r.frames.at(-1),tools:r.tools,source:r.source,sampleFormat:r.sampleFormat,
      constant:r.constant,timeline:r.timeline,commands});
  }catch(error){process.send?.({type:'result',outcome:controller.signal.aborted?'cancelled':'failed',error:error.stack,commands});}
  finally{clearInterval(heartbeat);process.disconnect();}
});
