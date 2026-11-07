import assert from '../helpers/assert.mjs';
import {createHash} from 'node:crypto';
import {repeatCsvParts} from '../../public/repeat-csv.js';
import {maxPortableBytes} from '../../public/portable.js';

export async function measure({parameters:p}){
  const report={configurationVersion:1,timeBase:'1/25',hashTimeBase:'1/25',source:{pixelFormat:'gray',signature:'a'.repeat(64)},exact:{runs:[]},timeline:{intervals:[]},freeze:{events:[{kind:''}]},frames:[]};
  const base=[...repeatCsvParts(report,'freeze')],overhead=base.reduce((n,s)=>n+Buffer.byteLength(s),0);
  assert.ok(p.bytes>=overhead,'Requested byte count is smaller than one CSV record');
  assert.ok(p.bytes<=maxPortableBytes+1,'This checker supports the accepted range and the first rejected byte');
  report.freeze.events[0].kind='x'.repeat(p.bytes-overhead);
  let bytes=0;const digest=createHash('sha256');
  const serialize=()=>{for(const part of repeatCsvParts(report,'freeze')){bytes+=Buffer.byteLength(part);digest.update(part)}};
  const rejected=p.bytes>maxPortableBytes;
  if(rejected)assert.throws(serialize,/CSV 超过/);else{serialize();assert.equal(bytes,p.bytes)}
  return {outcome:'passed',role:'Constructed serialization input; not measured video',requestedBytes:p.bytes,accepted:!rejected,emittedBytes:bytes,emittedSha256:digest.digest('hex')};
}
