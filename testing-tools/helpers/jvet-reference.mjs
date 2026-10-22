// Read numeric inputs and the ORIGINAL cached answers, without executing macros.
// Only fixed, SHA-256-locked upstream archives enter this small OOXML reader.
import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export function zipMembers(bytes) {
  let end=bytes.length-22;
  while(end>=Math.max(0,bytes.length-65557) && bytes.readUInt32LE(end)!==0x06054b50)end--;
  assert.ok(end>=0,'ZIP directory');
  const count=bytes.readUInt16LE(end+10), result=new Map();
  let pos=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++) {
    assert.equal(bytes.readUInt32LE(pos),0x02014b50);
    const method=bytes.readUInt16LE(pos+10),size=bytes.readUInt32LE(pos+20),length=bytes.readUInt32LE(pos+24),
      nl=bytes.readUInt16LE(pos+28),el=bytes.readUInt16LE(pos+30),cl=bytes.readUInt16LE(pos+32),local=bytes.readUInt32LE(pos+42),
      name=bytes.subarray(pos+46,pos+46+nl).toString('utf8');
    assert.ok(!result.has(name));assert.ok(length<64*1024*1024);assert.equal(bytes.readUInt32LE(local),0x04034b50);
    const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),packed=bytes.subarray(start,start+size);
    assert.ok([0,8].includes(method));
    const unpacked=method===0?packed:inflateRawSync(packed,{maxOutputLength:64*1024*1024});
    assert.equal(unpacked.length,length);result.set(name,unpacked);
    pos+=46+nl+el+cl;
  }
  return result;
}
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
