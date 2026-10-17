import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatBytes, formatBitrate, byteEvidence, byteLimit, quantityScale, quantityNumber, scalePlotData} from '../public/units.js';
import {maxPortableBytes} from '../public/portable.js';
import {recentBytes} from '../scripts/runtime-data.mjs';
import {trialValue} from '../public/trial-model.js';

test('[units] decimal capacity and bitrate prefixes obey case and adapt across boundaries', () => {
  // Mathematical unit-conversion inputs, not measured media.
  for (const [value, expected] of [[0,'0 B'],[999,'999 B'],[1000,'1 kB'],[1024,'1.024 kB'],
    [999999,'999.999 kB'],[1e6,'1 MB'],[1048576,'1.049 MB'],[1e9,'1 GB'],[1e12,'1 TB'],[1e15,'1 PB'],[-1e6,'-1 MB']])
    assert.equal(formatBytes(value), expected);
  for (const [value, expected] of [[8,'8 bit/s'],[128000,'128 kbit/s'],[8e6,'8 Mbit/s'],[1e9,'1 Gbit/s']])
    assert.equal(formatBitrate(value), expected);
  assert.equal(formatBytes(999999.9),'1 MB','rounded values must not display 1000 kB');
  assert.notEqual(quantityNumber(0.0000001),'0','small nonzero axis values remain visible');
  for (const value of [null,undefined,NaN,Infinity,'','N/A','<img>',false]) assert.equal(formatBytes(value),'未报告');
});

test('[units] common plot units preserve source values, missing points and metadata', () => {
  const source = [[0,1024,{bytes:1024}],[1,null,{bytes:null}],[2,2e6,{bytes:2e6}]], original=structuredClone(source);
  const scale=quantityScale(source.map(p=>p[1]));
  assert.deepEqual(scale,{divisor:1e6,unit:'MB'});
  const plotted=scalePlotData(source,{y:scale});
  assert.deepEqual(plotted.map(p=>p[1]),[0.001024,null,2]);
  assert.equal(plotted[0][2],source[0][2]);assert.deepEqual(source,original);
  assert.equal(trialValue({videoBytes:1024},'videoKiB'),1,'legacy model key retains its binary meaning');
  assert.equal(trialValue({videoBytes:1024},'videoBytes'),1024,'new plots start from bytes');
});

test('[units] integer evidence remains exact and capacity policies use round decimal limits', () => {
  assert.equal(byteEvidence('9007199254740993'),'9,007,199,254,740,993 B');
  assert.equal(byteEvidence(0),'0 B');
  assert.equal(maxPortableBytes,256000000);assert.equal(recentBytes,100000000);
  assert.equal(byteLimit(maxPortableBytes),'256 MB');
  assert.equal(byteLimit(recentBytes),'100 MB');
});
