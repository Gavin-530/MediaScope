import {createHash} from 'node:crypto';
import {fixtures,readFixture} from './fixtures.mjs';

export async function publishedSitiCases(){
  const manifest=JSON.parse(await readFixture('published/manifest.json'));
  for(const item of manifest.files){const bytes=await readFixture(item.path);if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Upstream fixture changed: '+item.path);}
  const cases=[];
  for(const name of ['foreman_cif','noise','fall-hlg','lights-hlg','sunset-hlg']){
    const reference=JSON.parse(await readFixture('published/'+name+'.json')),s=reference.settings;
    cases.push({name,file:fixtures.file('siti/videos/'+name+(name.endsWith('hlg')?'.mov':'.y4m')),reference,settings:{range:s.color_range==='full'?'pc':'tv',transfer:s.hdr_mode==='hdr10'?'pq':s.hdr_mode==='hlg'?'hlg':s.eotf_function==='inv_srgb'?'srgb':'sdr',...(s.hdr_mode==='hlg'?{hlg:{whiteCdM2:s.l_max,blackCdM2:s.l_min}}:{})}});
  }
  return cases;
}
