import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {FF,FP,run,probe} from '../engine.mjs';
import {allPackets} from '../analysis.mjs';
import {createBitrateAccumulator} from '../public/bitrate-model.js';
import {saveBitrateEvidence} from '../test/helpers/bitrate-evidence.mjs';
export async function measureSuite(directory,ctx) {
  const definitions=[
    {name:'long-high-fps',args:['-f','lavfi','-i','testsrc2=size=96x64:rate=120:duration=60'],description:'60 s, 120 fps, small resolution; encoded fixture, not camera footage'},
    {name:'variable-frame-rate',args:['-f','lavfi','-i','testsrc2=size=96x64:rate=100:duration=3.25','-vf',"select='not(mod(n,3))+not(mod(n,7))'"],description:'Selected frames retain nonuniform PTS; real encoded VFR fixture'}
  ];
  const cases=[];
  for(const def of definitions) {
    const file=path.join(directory,def.name+'.mkv');
    await run(FF,['-hide_banner','-nostdin','-v','error',...def.args,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-fps_mode','passthrough',file],ctx);
    const p=await probe(file,ctx),packets=JSON.parse(await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,dts,duration,size','-of','json',file],ctx));
    const fine=await allPackets(file,p.raw.streams,{...ctx,bitrateWindowMs:100}),coarse=await allPackets(file,p.raw.streams,{...ctx,bitrateWindowMs:1000});
    const result=await saveBitrateEvidence(directory,{file,probe:p,fine,coarse,commands:ctx.commands.slice(),packets,inputProvenance:def.description});
    const pts=packets.packets.map(p=>BigInt(p.pts)),gaps=new Set(pts.slice(1).map((n,i)=>(n-pts[i]).toString()));
    const vfrVerified=def.name!=='variable-frame-rate'||gaps.size>1;
    result.observed={packetCount:pts.length,distinctPtsGaps:[...gaps],vfrVerified};
    result.outcome=result.outcome==='passed'&&vfrVerified?'passed':'failed';
    const dataFile=def.name+'.json.gz';await fs.writeFile(path.join(directory,dataFile),gzipSync(Buffer.from(JSON.stringify(result)+'\n')));
    await fs.unlink(path.join(directory,'measured-equivalence.json'));
    cases.push({name:def.name,file:dataFile,outcome:result.outcome,packetCount:pts.length,intervals:result.tracks[0].comparisons.length,vfrVerified});
    if(def.name==='variable-frame-rate') {
      const base=packets.packets[0],timeBase=p.raw.streams[0].time_base;
      const faults=[{name:'missing-pts',packet:{...base,pts:'N/A'}},{name:'unknown-duration',packet:{...base,duration:'0'}}].map(f=>{
        const a=createBitrateAccumulator(timeBase,100);a.add(f.packet);return {...f,timeBase,result:a.finish(),provenance:'Fault injected into measured packet metadata; not a corrupted media capture'};
      });
      await fs.writeFile(path.join(directory,'faults.json.gz'),gzipSync(Buffer.from(JSON.stringify(faults)+'\n')));
      cases.push({name:'timestamp-faults',file:'faults.json.gz',outcome:faults.every(f=>f.result.status==='unavailable')?'passed':'failed'});
    }
    // Packet evidence and generation commands suffice for calculation replay.
    await fs.unlink(file);
  }
  return {outcome:cases.every(c=>c.outcome==='passed')?'passed':'failed',cases};
}
