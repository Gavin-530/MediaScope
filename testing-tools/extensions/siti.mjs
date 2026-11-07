import assert from '../helpers/assert.mjs';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {FF,run,probe,scan} from '../helpers/subject.mjs';
import {measureSiti,closeSitiGpu} from '../helpers/subject.mjs';
import {sitiValuesClose,validateSitiPoints} from '../../public/siti.js';
import {validateSitiDimensions,MAX_ANALYSIS_FRAMES} from '../../public/analysis-limits.js';

export async function measure({parameters:p,directory,signal},kind){
  const file=path.join(directory,'input.mkv'),commands=[],ctx={signal,cwd:directory,decodeThreads:1,commands};
  const dimensions=kind==='dimensions',width=dimensions?p.width:8,height=dimensions?p.height:8,frames=dimensions?2:p.frames;
  validateSitiDimensions(width,height);assert.ok(frames<=MAX_ANALYSIS_FRAMES,'Requested frame count exceeds the current product admission limit');
  if(dimensions){assert.ok(width>=6,'The analytic edge pattern requires width >= 6');assert.equal(width%2,0,'The analytic edge pattern requires an even width')}
  const pattern=dimensions?"if(lt(X,W/2+N),16,235)":"16+219*mod(X+N,2)";
  await run(FF,['-v','error','-y','-f','lavfi','-i',`nullsrc=s=${width}x${height}:r=120,format=gray,geq=lum='${pattern}',setfield=prog`,'-frames:v',String(frames),'-c:v','ffv1','-threads:v','1','-color_range','tv','-color_trc','smpte2084',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],sourceFrames=await scan(file,0,ctx);
  assert.equal(stream.width,width);assert.equal(stream.height,height);assert.equal(sourceFrames.length,frames);assert.equal(stream.pix_fmt,'gray');
  const options={...ctx,sitiSettings:{range:'tv',transfer:'pq'},sitiWorkers:1};
  try{
    const cpu=await measureSiti(file,stream,options,sourceFrames);
    const result=p.device==='gpu'?await measureSiti(file,stream,{...options,sitiDevice:'gpu'},sourceFrames):cpu;
    assert.equal(result.execution.device,p.device,result.execution.gpuFallbackReason);
    assert.equal(result.points.length,frames);validateSitiPoints(result.points,sourceFrames);
    const edge=2/(width-2),si=dimensions?4*Math.sqrt(edge*(1-edge))*255:0;
    const q=1/width,ti=dimensions?Math.sqrt(q*(1-q))*255:255;
    for(const [i,point]of result.points.entries()){
      assert.ok(sitiValuesClose(point.si,si));
      if(i)assert.ok(sitiValuesClose(point.ti,ti));else assert.equal(point.ti,null);
      assert.ok(sitiValuesClose(point.si,cpu.points[i].si));
      if(i)assert.ok(sitiValuesClose(point.ti,cpu.points[i].ti));
    }
    const measurement={outcome:'passed',input:{width,height,frames,pixelFormat:stream.pix_fmt,kind:'Generated lossless analytic PQ pattern'},analytic:{si,ti},execution:result.execution,first:result.points[0],last:result.points.at(-1),allPointsVerified:true,commands};
    await writeFile(path.join(directory,'measurement.json'),JSON.stringify(measurement,null,2));return measurement;
  }finally{await closeSitiGpu()}
}
