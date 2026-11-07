import {inflateRawSync} from 'node:zlib';
import assert from './assert.mjs';
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
