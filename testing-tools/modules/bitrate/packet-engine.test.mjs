import {engineControl} from '../../helpers/encoded-controls.mjs';
import {workRoot} from '../../helpers/workspace.mjs';
import {before} from 'node:test';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {FP,probe,run,packets} from '../../helpers/subject.mjs';
import {allPackets} from '../../helpers/subject.mjs';

import {bitrateView} from '../../../public/bitrate-model.js';
import {saveBitrateEvidence} from './tools/bitrate-evidence.mjs';

const dir=workRoot,source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{await engineControl(dir);});
test('packet accounting separates both audio tracks and matches every packet byte',async()=>{
 const p=await probe(source),tracks=await allPackets(source,p.raw.streams,context());assert.equal(tracks.length,3);assert.equal(tracks.filter(t=>t.type==='audio').length,2);
 for(const t of tracks){assert.ok(t.bytes>0);assert.ok(Math.abs(t.bins.reduce((s,b)=>s+b.mbps,0)*1e6/8-t.bytes)<.001)}
});

test('[packet-distribution] audio packet evidence matches independent FFprobe output without changing existing accounting',async()=>{
 const ctx=context(),p=await probe(source,ctx),plain=await allPackets(source,p.raw.streams,ctx),recorded=await allPackets(source,p.raw.streams,{...ctx,audioPacketDistribution:true});
 const oracle=JSON.parse(await run(FP,['-v','error','-show_packets','-show_entries','packet=stream_index,pts,dts,duration,size','-of','json',source],ctx));
 for(const track of recorded){
  const {packetDistribution,...unchanged}=track;assert.deepEqual(unchanged,plain.find(t=>t.index===track.index));
  if(track.type!=='audio'){assert.equal(packetDistribution,undefined);continue;}
  const packets=oracle.packets.filter(x=>x.stream_index===track.index),normalize=v=>v==null||v==='N/A'?null:String(v);
  assert.equal(packetDistribution.count,packets.length);assert.equal(packetDistribution.timeBase,p.raw.streams.find(s=>s.index===track.index).time_base);
  assert.deepEqual(packetDistribution.packets,packets.map(x=>[x.pts,x.dts,x.duration,x.size].map(normalize)));
  assert.equal(packetDistribution.packets.reduce((n,row)=>n+BigInt(row[3]),0n),BigInt(track.bytes));
 }
});
test('real video and two audio tracks: 100 ms aggregation matches direct 1 s without changing legacy accounting',async()=>{
 const ctx=context(),p=await probe(source,ctx),fine=await allPackets(source,p.raw.streams,{...ctx,bitrateWindowMs:100}),coarse=await allPackets(source,p.raw.streams,{...ctx,bitrateWindowMs:1000}),legacy=await allPackets(source,p.raw.streams,ctx);
 const evidence=await saveBitrateEvidence(await mkdtemp(path.join(dir,'bitrate-equivalence-')),{file:source,probe:p,fine,coarse,commands:ctx.commands});
 assert.equal(evidence.outcome,'passed');
 for(let i=0;i<fine.length;i++){
   assert.equal(fine[i].bitrateCurve.status,'ok');
   assert.deepEqual(bitrateView(fine[i].bitrateCurve,1000),bitrateView(coarse[i].bitrateCurve));
   assert.equal(fine[i].bitrateCurve.bins.reduce((sum,b)=>sum+BigInt(b.bytes),0n),BigInt(fine[i].bytes));
   assert.equal(fine[i].bytes,legacy[i].bytes);assert.equal(fine[i].averageMbps,legacy[i].averageMbps);
 }
});
