import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FF,FP,run,probe} from '../../engine.mjs';
import {analyzeRepeats} from '../../repeat.mjs';
import {NativeSampleComparison} from '../../repeat-samples.mjs';
import {repeatFrameFormat} from '../../public/repeat-model.js';
import {oracleComponents,oracleDifference,writeOracleValue} from './repeat-oracle.mjs';
import {repeatLayouts,componentLabels as labels,canonicalLayout as target} from './repeat-layouts.mjs';
import {repeatTestToolIdentity} from './repeat-tooling.mjs';

export async function auditRepeatLayouts(work,ctx={commands:[]}){
  await fs.mkdir(path.join(work,'generated'),{recursive:true});
  const names=repeatLayouts(),digest=b=>createHash('sha256').update(b).digest('hex');
  // set_meta accepts float and prints %f: half a decimal step + max half float32 ULP on [0,1].
  const tolerance=0.5e-6+2**-25+Number.EPSILON;
  const result={startedAtUtc:new Date().toISOString(),scope:'Product qualification list of 103 layouts, not all FFmpeg media formats or every codec/container combination',cpuFlags:0,filterComplexThreads:1,metadataTolerance:tolerance,toleranceBasis:'0.5e-6 + 2^-25 + Number.EPSILON from upstream float argument and six printed fractional digits; exact integer answers require zero disagreement',source:[],tools:[],cases:[],outcome:'running'};
  function fixture(name){
   const layout=oracleComponents(name,35,33),peak=2**layout.bits-1,a=Buffer.alloc(layout.bytes),c=Buffer.alloc(layout.bytes);
   for(const [i,component]of layout.components.entries())for(let y=0;y<component.height;y++)for(let x=0;x<component.width;x++){
    writeOracleValue(a,component.addresses[y][x],(i*137+x*17+y*31)%(peak+1),layout);
    writeOracleValue(c,component.addresses[y][x],(x+y+i)%3?peak:0,layout);
   }
   const b=Buffer.from(a),last=layout.components.at(-1).addresses.at(-1).at(-1),value=layout.components.at(-1).read(b,last);writeOracleValue(b,last,value^1,layout);
   const d=Buffer.from(a);for(const comp of layout.components)for(const address of [comp.addresses[0][0],comp.addresses[0].at(-1),comp.addresses.at(-1)[0],comp.addresses.at(-1).at(-1)])writeOracleValue(d,address,comp.read(a,address)^peak,layout);
   return {layout,frames:[a,a,b,b,c,c,d,d]};
  }
  function replay(format,frames){const reader=new NativeSampleComparison(repeatFrameFormat(format,35,33));return frames.map(b=>{let value;for(let p=0;p<b.length;p+=67)value=reader.push(b.subarray(p,p+67));return value;});}
  function parse(output,metric){const events=[];let item;for(const line of output.split(/\r?\n/)){if(line.startsWith('frame:')){item={};events.push(item);}const m=new RegExp(`^lavfi\\.${metric}\\.${metric}\\.([^.]+)=(.+)$`).exec(line);if(m)item[m[1]]=Number(m[2]);}return events;}
  async function official(name,raw,answers,layout,channelNames,allowUnsupported){
   const metrics=[];
   for(const metric of ['identity','msad']){
    const graph=`[0:v]split[a][b];[a]trim=end_frame=7,setpts=N/TB[x];[b]trim=start_frame=1,setpts=N/TB[y];[x][y]${metric}=shortest=1:repeatlast=0,metadata=mode=print:file=-`;
    const args=['-v','error','-cpuflags','0','-filter_complex_threads','1','-noauto_conversion_filters','-f','rawvideo','-pixel_format',name,'-video_size','35x33','-framerate','1','-i',raw,'-filter_complex',graph,'-fps_mode','passthrough','-f','null','-'];
    let output;try{output=await run(FF,args,ctx);}catch(e){if(allowUnsupported&&/do not have a common format|Impossible to convert between the formats/i.test(e.message)){metrics.push({metric,status:'native-unsupported',reason:e.message});continue;}throw e;}
    const events=parse(output,metric);assert.equal(events.length,7,name+' '+metric);let maximumAbsoluteError=0;
    for(let i=0;i<7;i++)for(let c=0;c<answers[i].length;c++){
     const samples=layout.components[c].width*layout.components[c].height,row=answers[i][c],expected=metric==='identity'?1-row[1]/samples:row[0]/(samples*(2**layout.bits-1)),actual=events[i][channelNames[c]],error=Math.abs(actual-expected);
     assert.ok(error<=tolerance,`${name} ${metric} pair ${i}, component ${channelNames[c]}: ${actual} vs ${expected}`);maximumAbsoluteError=Math.max(maximumAbsoluteError,error);
    }
    metrics.push({metric,status:'passed',maximumAbsoluteError,output});
   }
   return metrics;
  }
  try{
   for(const name of ['repeat.mjs','repeat-samples.mjs','engine.mjs','public/repeat-model.js','public/repeat-difference.js','testing-tools/helpers/repeat-oracle.mjs','testing-tools/helpers/repeat-upstream.mjs']){const b=await fs.readFile(name);result.source.push({path:name,bytes:b.length,sha256:digest(b)});}
   for(const [name,file]of [['node',process.execPath],['ffmpeg',FF],['ffprobe',FP]])result.tools.push(await repeatTestToolIdentity(name,file));
   const runtimePixelFormats=JSON.parse(await run(FP,['-v','error','-show_pixel_formats','-of','json'],ctx)).pixel_formats.map(p=>p.name);
   const accepted=runtimePixelFormats.filter(p=>repeatFrameFormat(p,35,33));assert.deepEqual(accepted.toSorted(),names.toSorted());
   result.runtimeScope={runtimeAccepted:accepted.length,audited:names.length,acceptedNotAudited:[],auditedNotListedByRuntime:[]};
   for(const [index,name]of names.entries()){
    const {layout,frames}=fixture(name),observed=replay(name,frames),answers=frames.slice(1).map((b,i)=>oracleDifference(frames[i],b,layout));
    // Equality truth follows independent integer changed counts, never Buffer.equals.
    for(let i=0;i<7;i++){const equal=answers[i].every(row=>row[1]===0);assert.equal(observed[i+1].equalPrevious,equal);assert.deepEqual(observed[i+1].difference,equal?null:answers[i]);}
    const raw=path.join(work,'generated',name+'.raw');await fs.writeFile(raw,Buffer.concat(frames));
    const native=await official(name,raw,answers,layout,labels(name),true),entry={format:name,sourceDepth:layout.bits,sourceLabels:labels(name),pairs:7,integerReference:'passed',native};
    if(native.some(m=>m.status==='native-unsupported')){
     assert.ok(native.every(m=>m.status==='native-unsupported'),name+' capability differs between metrics');
     const canonicalName=target(name,layout.bits),canonicalLayout=oracleComponents(canonicalName,35,33),canonicalLabels=labels(canonicalName),shift=canonicalLayout.bits-layout.bits;assert.ok(shift>=0);
     const canonical=frames.map(source=>{
      const destination=Buffer.alloc(canonicalLayout.bytes);
      for(const [component,src]of layout.components.entries()){
       const dst=canonicalLayout.components[canonicalLabels.indexOf(labels(name)[component])];assert.ok(dst);assert.equal(src.width,dst.width);assert.equal(src.height,dst.height);
       for(let y=0;y<src.height;y++)for(let x=0;x<src.width;x++){
        const value=src.read(source,src.addresses[y][x]);writeOracleValue(destination,dst.addresses[y][x],value*2**shift,canonicalLayout);
        const encoded=dst.read(destination,dst.addresses[y][x]);assert.equal(encoded%2**shift,0);assert.equal(encoded/2**shift,value);
       }
      }
      return destination;
     });
     const canonicalAnswers=canonical.slice(1).map((b,i)=>oracleDifference(canonical[i],b,canonicalLayout));
     // Prove relation of all integer measurements, including block geometry, before using proxy output.
     for(let pair=0;pair<7;pair++)for(let c=0;c<layout.components.length;c++){
      const mapped=canonicalLabels.indexOf(labels(name)[c]),expected=[...answers[pair][c]];
      for(const field of [0,2,3])expected[field]*=2**shift;
      assert.deepEqual(canonicalAnswers[pair][mapped],expected,name+' representation relation');
     }
     const canonicalFile=path.join(work,'generated',name+'-as-'+canonicalName+'.raw');await fs.writeFile(canonicalFile,Buffer.concat(canonical));
     entry.adapter={status:'passed',targetFormat:canonicalName,targetDepth:canonicalLayout.bits,exactScale:2**shift,proof:'Every component sample round-trips exactly; integer SAD/max/block sums scale exactly; changed counts/block sample counts/coordinates preserved; no resizing, chroma resampling, tone mapping or bit-depth reduction. Project test adapter, not native upstream support.',samplesRoundTripChecked:layout.components.reduce((n,c)=>n+c.width*c.height,0)*frames.length,metrics:await official(canonicalName,canonicalFile,canonicalAnswers,canonicalLayout,canonicalLabels,false)};
    }
    result.cases.push(entry);if(index%10===0)await fs.writeFile(path.join(work,'progress.json'),JSON.stringify({completed:index+1,total:names.length,format:name}));
   }
   result.summary={layouts:result.cases.length,pairsPerLayout:7,integerReferencePassed:result.cases.filter(c=>c.integerReference==='passed').length,nativeMetricsPassed:result.cases.filter(c=>c.native.every(m=>m.status==='passed')).length,nativeUnsupported:result.cases.filter(c=>c.native.every(m=>m.status==='native-unsupported')).length,losslessAdapterPassed:result.cases.filter(c=>c.adapter?.status==='passed').length};
   // Every product-enabled native freezedetect layout gets a closed interval,
   // sustained high changes, and an EOF-open interval on deterministic code values.
   const productText=await fs.readFile('repeat.mjs','utf8'),literal=/const freezeFormats=new Set\((\[[\s\S]*?\])\);/.exec(productText)?.[1];assert.ok(literal);
   const freezeNames=JSON.parse(literal.replaceAll("'",'"'));assert.equal(freezeNames.length,51);result.freezeCases=[];
   for(const [index,name]of freezeNames.entries()){
    const layout=oracleComponents(name,35,33),a=Buffer.alloc(layout.bytes),b=Buffer.alloc(layout.bytes),peak=2**layout.bits-1;
    for(const component of layout.components)for(const row of component.addresses)for(const address of row)writeOracleValue(b,address,peak,layout);
    const frames=[...Array(80).fill(a),...Array.from({length:25},(_,i)=>i%2?a:b),...Array(80).fill(a)],raw=path.join(work,'generated','freeze-'+name+'.raw'),file=raw+'.nut';await fs.writeFile(raw,Buffer.concat(frames));
    await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',name,'-video_size','35x33','-framerate','25','-i',raw,'-c:v','rawvideo','-threads:v','1','-fps_mode','passthrough',file],ctx);
    const stream=(await probe(file,ctx)).raw.streams[0];assert.equal(stream.pix_fmt,name);const r=await analyzeRepeats(file,stream,ctx,{freeze:true});assert.equal(r.freeze.status,'complete',r.freeze.reason);
    assert.deepEqual(r.freeze.segments.map(({start,end,duration})=>({start,end,duration})),[{start:'0',end:'3.2',duration:'3.2'},{start:'4.2',end:null,duration:null}]);
    let frame=null,pts=null;const upstreamEvents=[];
    await run(FF,['-v','error','-noauto_conversion_filters','-copyts','-i',file,'-vf','freezedetect=noise=0.001:duration=2,metadata=mode=print:file=-','-fps_mode','passthrough','-f','null','-'],ctx,line=>{
     const header=/^frame:(\d+)\s+pts:(-?\d+)/.exec(line);if(header){frame=Number(header[1]);pts=header[2];}
     const tag=/^lavfi\.freezedetect\.freeze_(start|duration|end)=(.+)$/.exec(line);if(tag)upstreamEvents.push({kind:tag[1],value:tag[2],frame,filterPts:pts});
    });
    assert.deepEqual(r.freeze.events,upstreamEvents);result.freezeCases.push({format:name,frames:frames.length,events:r.freeze.events,segments:r.freeze.segments,upstreamEvents,status:'passed'});
    if(index%10===0)await fs.writeFile(path.join(work,'progress.json'),JSON.stringify({phase:'freeze',completed:index+1,total:freezeNames.length,format:name}));
   }
   result.summary.freezeNativeLayoutsPassed=result.freezeCases.length;
   result.outcome='passed';
  }catch(e){result.outcome='failed';result.error=e.stack;throw e;}
  finally{result.commands=ctx.commands;result.finishedAtUtc=new Date().toISOString();await fs.writeFile(path.join(work,'layout-coverage.json'),JSON.stringify(result)+'\n');}
  return result;
}
