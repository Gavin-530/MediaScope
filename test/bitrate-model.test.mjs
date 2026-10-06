import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBitrateAccumulator,bitrateView,validateBitrateCurve} from '../public/bitrate-model.js';
function calculate(packets,windowMs,timeBase='1/1000') {
  const a=createBitrateAccumulator(timeBase,windowMs); packets.forEach(p=>a.add(p)); const c=a.finish();validateBitrateCurve(c);return c;
}
test('100 ms aggregation equals direct 1 s: VFR, negative PTS, boundaries, empty intervals and clipped ends',()=>{
  const packets=[{pts:'-35',duration:'35',size:'101'},{pts:'0',duration:'100',size:'203'},{pts:'100',duration:'1150',size:'307'},{pts:'1000',duration:'250',size:'409'}];
  const fine=calculate(packets,100),coarse=calculate(packets,1000);
  assert.deepEqual(bitrateView(fine,1000),bitrateView(coarse));
  assert.equal(fine.bins.reduce((n,b)=>n+BigInt(b.bytes),0n),1020n);
  assert.equal(bitrateView(fine)[0].end-bitrateView(fine)[0].start,.035);
  assert.equal(fine.bins.at(-1).endNumerator,'1250000');
  assert.equal(bitrateView(fine).at(-1).end,1.25);
});
test('exact integer timestamps at 90 kHz, large offsets and a single clipped packet',()=>{
  for(const offset of [0n,900000000000000000n]) {
    const packets=[{pts:String(offset),duration:'9000',size:'9007199254740993'},{pts:String(offset+9000n),duration:'4500',size:'19'}];
    assert.deepEqual(bitrateView(calculate(packets,100,'1/90000'),1000),bitrateView(calculate(packets,1000,'1/90000')));
  }
  const c=calculate([{pts:'0',duration:'35',size:'21875'}],100);
  assert.equal(bitrateView(c)[0].mbps,5);
});
test('missing PTS never falls back to DTS; unknown duration and invalid bytes are unavailable',()=>{
  for(const p of [{pts:'N/A',dts:'0',duration:'100',size:'10'},{pts:'0',duration:'0',size:'10'},{pts:'0',duration:'100',size:'NaN'}]) {
    const c=calculate([p],100);assert.equal(c.status,'unavailable');assert.deepEqual(bitrateView(c),[]);assert.ok(c.reasons.length);
  }
  assert.throws(()=>calculate([],500));
  const c=calculate([{pts:'0',duration:'100',size:'10'}],1000);assert.throws(()=>bitrateView(c,100));
});
test('portable curve validation rejects broken accounting intervals',()=>{
  const c=calculate([{pts:'0',duration:'250',size:'10'}],100);
  c.bins[1].startNumerator='1';assert.throws(()=>validateBitrateCurve(c));
});
