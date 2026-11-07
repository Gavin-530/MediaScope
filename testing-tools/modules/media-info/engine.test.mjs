import {engineControl} from '../../helpers/encoded-controls.mjs';
import {workRoot} from '../../helpers/workspace.mjs';
import {before} from 'node:test';
import {projectTest,selectedNeedsMedia} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';

import path from 'node:path';
import {probe,scan,packets,summarize,normalizeMediaPath} from '../../helpers/subject.mjs';
import {metadataSummary} from '../../helpers/subject.mjs';




const dir=workRoot,source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{if(selectedNeedsMedia(import.meta.url))await engineControl(dir);});
test('Unicode path, complete audio inventory, frame and packet accounting',async()=>{
 assert.equal(normalizeMediaPath(`“${source}”`),source);assert.equal(normalizeMediaPath(source.replace(/^([A-Za-z]):/,'$1：')),source);
 const p=await probe(source);assert.equal(p.raw.streams.filter(s=>s.codec_type==='audio').length,2);
 const frames=await scan(source,0),stats=await packets(source,0);assert.equal(frames.length,12);assert.equal(summarize(frames).nonIncreasing,0);assert.equal(stats.count,12);assert.ok(stats.bytes>0);assert.ok(stats.bytes<p.size);assert.equal(stats.missing,0);
 assert.ok(Math.abs(stats.bins.reduce((s,b)=>s+b.mbps,0)*1e6/8-stats.bytes)<.001);
});
test('metadata summary merges repeated side data with explicit provenance',()=>{const r=metadataSummary({raw:{streams:[{index:0,side_data_list:[{side_data_type:'Mastering display',x:1}]}]},frameSample:{frames:[{stream_index:0,side_data_list:[{side_data_type:'Mastering display',x:1}]}]},frameSampleScope:'sample'});assert.equal(r.items.length,1);assert.equal(r.items[0].occurrences,2);assert.equal(r.items[0].sources.length,2)});
