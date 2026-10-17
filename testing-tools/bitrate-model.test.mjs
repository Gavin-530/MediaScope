import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBitrateAccumulator,bitrateView,validateBitrateCurve} from '../public/bitrate-model.js';
import {visibleIntervals} from '../public/charts.js';
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

test('constant PCM demonstrates packet attribution ripple and a zero-byte occupied tail',()=>{
  // Mathematical oracle: stereo f32, 48 kHz, 1024 samples per full packet.
  const samples=48000*29+48,packets=[];
  for(let pts=0;pts<samples;pts+=1024){
    const duration=Math.min(1024,samples-pts);
    packets.push({pts:String(pts),duration:String(duration),size:String(duration*8)});
  }
  const c=calculate(packets,1000,'1/48000'),view=bitrateView(c);
  assert.equal(view[0].mbps,3.080192);
  assert.equal(view[7].mbps,3.014656);
  assert.deepEqual(view.at(-1),{start:29,end:29.001,mbps:0,bytes:'0'});
  assert.equal(c.bins.reduce((n,b)=>n+BigInt(b.bytes),0n),BigInt(samples*8));
  assert.deepEqual(bitrateView(calculate(packets,100,'1/48000'),1000),view);
});

test('interval viewport includes the containing bin and respects half-open boundaries',()=>{
  const data=[[0,3,{end:1}],[1,2,{end:2}],[2,1,{end:2.312}]];
  assert.deepEqual(visibleIntervals(data,0.7,1.7),data.slice(0,2));
  assert.deepEqual(visibleIntervals(data,1,2),data.slice(1,2));
  assert.deepEqual(visibleIntervals(data,2.1,2.312),data.slice(2));
});
