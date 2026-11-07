import {zipMembers} from '../../../helpers/zip.mjs';
// Read numeric inputs and the ORIGINAL cached answers, without executing macros.
// Only fixed, SHA-256-locked upstream archives enter this small OOXML reader.
import {createHash} from 'node:crypto';
import assert from '../../../helpers/assert.mjs';


const attr=(s,key)=>new RegExp(`\\b${key}="([^"]*)"`).exec(s)?.[1];
const xml=s=>s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"');
const workbooks={
  'hm-16.20_vs_vtm-5.0.xlsm':'61c05a0e47a26c5abf7a47f776f59048640bb473cfe037acdf7c9342616413e6',
  'vtm-4.2_vs_vtm-5.0.xlsm':'bd61d45eec5d52e6d7fff6366be470edb9bc8ca2f55ec02f76ce29073daec274',
  'vtm-5.0_vs_vtm-5.1rc1.xlsm':'9c22bfb3509db55a3eee5178f5dee268ca95a591b2ef1687378ba68a6b31c91d',
};
export function jvetCases(archive) {
  const cases=[];
  for(const [name,bytes] of zipMembers(archive)) {
    const base=name.split('/').at(-1);if(!workbooks[base])continue;
    assert.equal(createHash('sha256').update(bytes).digest('hex'),workbooks[base]);
    const book=zipMembers(bytes),relationships=new Map([...book.get('xl/_rels/workbook.xml.rels').toString().matchAll(/<Relationship\b([^>]+)\/?\s*>/g)]
      .map(m=>[attr(m[1],'Id'),attr(m[1],'Target')]));
    for(const sheet of book.get('xl/workbook.xml').toString().matchAll(/<sheet\b([^>]+)\/?\s*>/g)) {
      const title=attr(sheet[1],'name'),target=relationships.get(attr(sheet[1],'r:id'));
      const file=target.startsWith('/')?target.slice(1):'xl/'+target;
      const cells=new Map();
      for(const cell of book.get(file).toString().matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body=cell[2]??'',text=/<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        cells.set(attr(cell[1],'r'),{value:attr(cell[1],'t')==='e'?xml(text):Number(text),formula:xml(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1]??'')});
      }
      const range=ref=>{
        const m=/^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(ref);
        assert.ok(m,ref);assert.equal(m[1],m[3]);
        return Array.from({length:Number(m[4])-Number(m[2])+1},(_,i)=>cells.get(m[1]+(Number(m[2])+i))?.value);
      };
      for(const [coordinate,cell] of cells) {
        const formula=/^bdrate\(([^)]+)\)$/i.exec(cell.formula);if(!formula)continue;
        const refs=formula[1].split(',');if(refs.length!==4)continue;
        const [ar,aq,tr,tq]=refs.map(range);
        cases.push({workbook:base,sheet:title,coordinate,answer:cell.value,
          anchor:aq.map((quality,i)=>({quality,rate:ar[i]})),test:tq.map((quality,i)=>({quality,rate:tr[i]}))});
      }
    }
  }
  return cases;
}
