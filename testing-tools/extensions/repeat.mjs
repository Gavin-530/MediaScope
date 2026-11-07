import assert from '../helpers/assert.mjs';
import path from 'node:path';
import {writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FF,run,probe} from '../helpers/subject.mjs';
import {observeAnalysis} from './repeat/tools/repeat-resource-run.mjs';
import {MAX_REPEAT_FRAME_BYTES} from '../helpers/subject.mjs';
import {MAX_ANALYSIS_FRAMES} from '../../public/analysis-limits.js';

export async function measure({parameters:p,directory,signal},kind){
  const commands=[],ctx={signal,cwd:directory,commands,decodeThreads:1},file=path.join(directory,'input.nut');
  let expected;
  if(kind==='changing'){
    assert.ok(Number.isSafeInteger(p.width*p.height)&&p.width*p.height<=MAX_REPEAT_FRAME_BYTES,'Requested native bytes exceed product admission');
    assert.ok(p.frames<=MAX_ANALYSIS_FRAMES,'Requested frames exceed product admission');
    await run(FF,['-v','error','-y','-f','lavfi','-i',`nullsrc=size=${p.width}x${p.height}:rate=${p.rate},format=gray,geq=lum=mod(X+2*Y+floor(N/2)\\,256)`,'-frames:v',String(p.frames),'-c:v','ffv1','-threads:v','1',file],ctx);
    expected={frames:p.frames,duplicates:Math.floor(p.frames/2),rate:p.rate+'/1',pattern:'paired-changing-ramp',width:p.width,height:p.height};
  }else if(kind==='native'){
    const bytes=p.width*p.height*2;
    assert.ok(Number.isSafeInteger(bytes)&&bytes<=MAX_REPEAT_FRAME_BYTES,'Requested native input exceeds the current product admission limit');
    const frame=Buffer.alloc(bytes),raw=path.join(directory,'input.raw');await writeFile(raw,frame);frame.writeUInt16LE(1,bytes-2);await appendFile(raw,frame);
    await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray16le','-video_size',`${p.width}x${p.height}`,'-framerate','1','-i',raw,'-c:v','rawvideo','-threads:v','1',file],ctx);
    expected={frames:2,duplicates:0,rate:'1/1',difference:[1,1,1,1,(p.width%16||16)*(p.height%16||16),Math.floor((p.width-1)/16)*16,Math.floor((p.height-1)/16)*16]};
  }else{
    const width=kind==='frames'?8:p.width,height=kind==='frames'?8:p.height,frames=kind==='long'?Math.round(p.seconds*p.rate):p.frames,rate=kind==='long'?p.rate:120;
    assert.ok(Number.isSafeInteger(frames)&&frames<=MAX_ANALYSIS_FRAMES,'Requested frame count exceeds the current product admission limit');
    assert.ok(Number.isSafeInteger(width*height*1.5)&&width*height*1.5<=MAX_REPEAT_FRAME_BYTES,'Requested native input exceeds the current product admission limit');
    assert.ok(width%2===0&&height%2===0,'Static YUV fixture requires even width and height');
    await run(FF,['-v','error','-y','-f','lavfi','-i',`color=black:size=${width}x${height}:rate=${rate}`,'-frames:v',String(frames),'-c:v','ffv1','-threads:v','1','-pix_fmt','yuv420p',file],ctx);
    const digest=createHash('sha256');for(const [value,size]of [[16,width*height],[128,width*height/2]]){const chunk=Buffer.alloc(Math.min(size,65536),value);for(let left=size;left>0;left-=chunk.length)digest.update(chunk.subarray(0,Math.min(left,chunk.length)))}
    expected={frames,duplicates:frames-1,rate:rate+'/1',hash:digest.digest('hex')};
  }
  const stream=(await probe(file,ctx)).raw.streams[0];
  const measurement=await observeAnalysis(file,expected,{directory,signal,cancelStage:p['cancel-stage']});
  return {outcome:'passed',scope:'Explicit generated input; independent parent observation, no general throughput or memory guarantee',input:{stream,frames:expected.frames},expectedCancellation:!!p['cancel-stage'],allFramesVerified:!p['cancel-stage'],measurement,commands};
}
