import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export async function publishedSitiCases(){
  const root=new URL('../reference/siti/',import.meta.url),manifest=JSON.parse(await readFile(new URL('published/manifest.json',root),'utf8'));
  for(const item of manifest.files){const bytes=await readFile(new URL(item.path,root));if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Upstream fixture changed: '+item.path);}
  const cases=[];
  for(const name of ['foreman_cif','noise','fall-hlg','lights-hlg','sunset-hlg']){
    const reference=JSON.parse(await readFile(new URL('published/'+name+'.json',root),'utf8')),s=reference.settings;
    cases.push({name,file:fileURLToPath(new URL('videos/'+name+(name.endsWith('hlg')?'.mov':'.y4m'),root)),reference,settings:{range:s.color_range==='full'?'pc':'tv',transfer:s.hdr_mode==='hdr10'?'pq':s.hdr_mode==='hlg'?'hlg':s.eotf_function==='inv_srgb'?'srgb':'sdr',...(s.hdr_mode==='hlg'?{hlg:{whiteCdM2:s.l_max,blackCdM2:s.l_min}}:{})}});
  }
  return cases;
}
