import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAudioPacketDistribution, validateAudioPacketDistribution, audioPacketPoints, packetSeconds, frameTimePoints, frameTimeRange} from '../public/distribution-model.js';

test('[packet-distribution] discrete audio evidence preserves negative/duplicate PTS and unknown duration without DTS substitution', () => {
  // Declared boundary inputs; not a measured media fixture.
  const collector = createAudioPacketDistribution('1/48000');
  for (const p of [
    {pts:'48000', dts:'47000', duration:'0', size:'9007199254740993'},
    {pts:'-1024', dts:'-1024', duration:'1024', size:'0'},
    {pts:'N/A', dts:'0', duration:'N/A', size:'12'},
    {pts:'48000', dts:'48000', duration:'1024', size:'14'},
  ]) collector.add(p);
  const d = collector.finish();validateAudioPacketDistribution(d);
  assert.equal(d.packets[0][3], '9007199254740993');
  assert.deepEqual(d.packets[2], [null,'0',null,'12']);
  assert.deepEqual(audioPacketPoints(d).map(p => [p[0],p[2].index]), [[-1024/48000,1],[1,0],[1,3]]);
  assert.equal(d.count,4);assert.equal(d.packets[0][2],'0');
  for (const timeBase of [null,'0/48000','1/0','bad']) assert.equal(packetSeconds('1',timeBase),null);
});

test('[packet-distribution] recording limit explicitly disables the complete view instead of silently truncating packets', () => {
  const collector = createAudioPacketDistribution('1/1000',2);
  for (let i=0;i<4;i++) collector.add({pts:String(i),size:'8'});
  const d = collector.finish();validateAudioPacketDistribution(d);
  assert.equal(d.count,4);assert.equal(d.status,'unavailable');assert.deepEqual(d.packets,[]);assert.deepEqual(audioPacketPoints(d),[]);
  assert.match(d.reason,/超过 2/);
});

test('[packet-distribution] reject broken packet counts, integer evidence and unavailable-state contradictions', () => {
  const collector=createAudioPacketDistribution('1/1000');collector.add({pts:'0',size:'15'});const d=collector.finish();
  for (const change of [x=>x.count++,x=>x.packets[0][3]='-1',x=>x.packets[0][0]=0,x=>x.packets[0].pop(),x=>x.status='unavailable',x=>x.reason='incorrect']) {
    const broken=structuredClone(d);change(broken);assert.throws(()=>validateAudioPacketDistribution(broken));
  }
});

test('[packet-distribution] frame time view retains display-frame identities, variable gaps and original GOP boundaries', () => {
  const frames=[{t:1,bytes:10,duration:.2},{t:null,bytes:20},{t:-.1,bytes:30,duration:.1},{t:1,bytes:40,duration:.05}];
  const before=structuredClone(frames),points=frameTimePoints(frames);
  assert.deepEqual(points.map(p=>[p[0],p[1],p[3]]),[[-.1,30,2],[1,10,0],[1,40,3]]);
  assert.equal(points[1][2],frames[0]);assert.deepEqual(frames,before);
  assert.deepEqual(frameTimeRange(frames),[-.1,1.2]);assert.deepEqual(frameTimeRange(frames,2,3),[-.1,1.05]);
  assert.equal(frameTimeRange(frames,1,1),null);
});
