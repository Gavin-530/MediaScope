import {utcNow} from '../../public/portable.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {bitrateView} from '../../public/bitrate-model.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const floor = (n,d) => n>=0n?n/d:-((-n+d-1n)/d);
export async function saveBitrateEvidence(directory,{file,probe,fine,coarse,commands,packets,inputProvenance='FFmpeg-generated real encoded media fixture; not camera footage'}) {
  await mkdir(directory,{recursive:true});
  const tracks=fine.map((track,i)=>{
    const c=track.bitrateCurve,direct=coarse[i].bitrateCurve,groups=new Map();
    if(c.status==='ok')for(const b of c.bins){
      const index=floor(BigInt(b.index),10n).toString(),prev=groups.get(index);
      if(prev){prev.endNumerator=b.endNumerator;prev.bytes=(BigInt(prev.bytes)+BigInt(b.bytes)).toString()}
      else groups.set(index,{...b,index});
    }
    const aggregated=[...groups.values()];
    const comparisons=direct.bins.map((bin,j)=>({index:bin.index,aggregated:aggregated[j]??null,direct:bin,equal:isDeepStrictEqual(aggregated[j],bin)}));
    const exactEqual=c.status==='ok'&&direct.status==='ok'&&c.denominator===direct.denominator&&isDeepStrictEqual(aggregated,direct.bins);
    return {index:track.index,type:track.type,codec:track.codec,fine:c,direct,aggregated,comparisons,exactEqual,displayEqual:exactEqual&&isDeepStrictEqual(bitrateView(c,1000),bitrateView(direct)),byteConservation:c.status==='ok'&&c.bins.reduce((n,b)=>n+BigInt(b.bytes),0n)===BigInt(track.bytes)};
  });
  const sourceFiles=['analysis.mjs','public/bitrate-model.js','test/helpers/bitrate-evidence.mjs'];
  const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async p=>[p,sha(await readFile(p))])));
  const inputBytes=await readFile(file);
  const result={schema:1,purpose:'100 ms versus direct 1 s bitrate equivalence',createdAt:utcNow(),input:{name:path.basename(file),size:inputBytes.length,sha256:sha(inputBytes),provenance:inputProvenance},sourceHashes,probe,commands,packets,tracks,outcome:tracks.length&&tracks.every(t=>t.exactEqual&&t.displayEqual&&t.byteConservation)?'passed':'failed'};
  await writeFile(path.join(directory,'measured-equivalence.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
