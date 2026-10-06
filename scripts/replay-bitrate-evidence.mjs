// Run the archived copy with: node replay.mjs <record-directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const root=path.resolve(process.argv[2]??'.');
const {createBitrateAccumulator,bitrateView}=await import(pathToFileURL(path.join(root,'replay','bitrate-model.mjs')));
const summary=JSON.parse(await fs.readFile(path.join(root,'suite-summary.json'),'utf8'));
for(const c of summary.cases) {
  const data=JSON.parse(gunzipSync(await fs.readFile(path.join(root,c.file))));
  if(c.name==='timestamp-faults')for(const fault of data){const a=createBitrateAccumulator(fault.timeBase,100);a.add(fault.packet);assert.deepEqual(a.finish(),fault.result);assert.equal(fault.result.status,'unavailable');}
  else for(const track of data.tracks){
    const stream=data.probe.raw.streams.find(s=>s.index===track.index),fine=createBitrateAccumulator(stream.time_base,100),coarse=createBitrateAccumulator(stream.time_base,1000);
    for(const p of data.packets.packets.filter(p=>p.stream_index===track.index)){fine.add(p);coarse.add(p)}
    const f=fine.finish(),d=coarse.finish();assert.deepEqual(f,track.fine);assert.deepEqual(d,track.direct);assert.deepEqual(bitrateView(f,1000),bitrateView(d));assert.equal(track.exactEqual,true);
  }
  assert.equal(c.outcome,'passed');console.log('PASS: '+c.name);
}
