import {createHash} from 'node:crypto';
import {fixtures,readFixture} from '../../../helpers/fixtures.mjs';
import {mkdir} from 'node:fs/promises';
import {workPath} from '../../../helpers/workspace.mjs';
import {sitiInputFixture} from './siti-inputs.mjs';

export async function referenceSitiCases(){
  const manifest=JSON.parse(await readFixture('published/manifest.json'));
  const corpus=await fixtures.readMany(manifest.files.map(item=>'siti/'+item.path));
  for(const item of manifest.files){const bytes=corpus.get('siti/'+item.path);if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Upstream fixture changed: '+item.path);}
  const cases=[];
  for(const name of ['fall-hlg','lights-hlg','sunset-hlg']){
    const reference=JSON.parse(corpus.get('siti/published/'+name+'.json')),s=reference.settings;
    cases.push({name,kind:'unmodified-upstream-LIVE-HLG',file:fixtures.file('siti/videos/'+name+'.mov'),reference,settings:{range:s.color_range==='full'?'pc':'tv',transfer:s.hdr_mode==='hdr10'?'pq':s.hdr_mode==='hlg'?'hlg':s.eotf_function==='inv_srgb'?'srgb':'sdr',...(s.hdr_mode==='hlg'?{hlg:{whiteCdM2:s.l_max,blackCdM2:s.l_min}}:{})}});
  }
  const controlled=JSON.parse(await readFixture('controlled-siti.json')),directory=workPath('siti-reference-corpus');await mkdir(directory,{recursive:true});
  for(const c of controlled.cases){
    const fixture=await sitiInputFixture(directory,c,{metadata:true,lossless:true});
    cases.push({name:c.name,kind:'self-authored-independent-reference',file:fixture.file,settings:c.settings,reference:{si:c.expected.map(p=>p.si),ti:c.expected.slice(1).map(p=>p.ti),source:controlled.reference,rawFrameSha256:c.frameSha256}});
  }
  return cases;
}
