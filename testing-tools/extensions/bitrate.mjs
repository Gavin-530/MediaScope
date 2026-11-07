import path from 'node:path';
import assert from '../helpers/assert.mjs';
import {FF,FP,run,probe} from '../helpers/subject.mjs';
import {allPackets} from '../helpers/subject.mjs';
import {saveBitrateEvidence} from '../modules/bitrate/tools/bitrate-evidence.mjs';
export async function measure({parameters:p,directory,signal}){
  const file=path.resolve(p.file),commands=[],ctx={signal,commands,cwd:directory};
  const info=await probe(file,ctx),packets=JSON.parse(await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,dts,duration,size','-of','json',file],ctx));
  const fine=await allPackets(file,info.raw.streams,{...ctx,bitrateWindowMs:100}),coarse=await allPackets(file,info.raw.streams,{...ctx,bitrateWindowMs:1000});
  const result=await saveBitrateEvidence(directory,{file,probe:info,fine,coarse,commands,packets,inputProvenance:'Caller-supplied diagnostic media; capture provenance not verified'});
  assert.equal(result.outcome,'passed');return result;
}
