import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,probe,run,scan,packets,summarize,alignment,compare} from '../engine.mjs';
import {allPackets,structure,metadataSummary,complexity,trial,av1ShortRefs} from '../analysis.mjs';
import {readdir} from 'node:fs/promises';
const dir=path.resolve('test-work'),source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{
 await mkdir(dir,{recursive:true});
 await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-f','lavfi','-i','sine=frequency=880:duration=1','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1','-c:a','aac',source]);
 await run(FF,['-hide_banner','-v','error','-y','-i',source,'-map','0:v','-c:v','libx264','-crf','42','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',candidate]);
});
test('Unicode path, complete audio inventory, frame and packet accounting',async()=>{
 const p=await probe(source);assert.equal(p.raw.streams.filter(s=>s.codec_type==='audio').length,2);
 const frames=await scan(source,0),stats=await packets(source,0);assert.equal(frames.length,12);assert.equal(summarize(frames).nonIncreasing,0);assert.equal(stats.count,12);assert.ok(stats.bytes>0);assert.ok(stats.bytes<p.size);assert.equal(stats.missing,0);
 assert.ok(Math.abs(stats.bins.reduce((s,b)=>s+b.mbps,0)*1e6/8-stats.bytes)<.001);
});
test('same-file PSNR is infinite; SSIM is one; VMAF produces all frames',async()=>{
 const result=await compare(source,source,0,0,['psnr','ssim','vmaf'],context());assert.equal(result.metrics.psnr.pooled,'Infinity');assert.equal(result.metrics.ssim.pooled,1);assert.equal(result.metrics.vmaf.values.length,12);assert.ok(result.metrics.vmaf.pooled>95);
});
test('lossy candidate yields finite PSNR and reduced SSIM',async()=>{
 const result=await compare(source,candidate,0,0,['psnr','ssim'],context());assert.ok(Number.isFinite(result.metrics.psnr.pooled));assert.ok(result.metrics.ssim.pooled<1);assert.equal(result.metrics.psnr.values.length,12);
});
test('reject mismatched formats, frame counts, timestamps, and non-increasing PTS',()=>{
 const s={width:192,height:108,pix_fmt:'yuv420p'},f=[{t:0},{t:1}];
 assert.throws(()=>alignment(s,{...s,width:100},f,f),/width/);
 assert.throws(()=>alignment(s,s,f,[{t:0}]),/帧数/);
 assert.throws(()=>alignment(s,s,f,[{t:0},{t:1.1}]),/时间戳/);
 assert.throws(()=>alignment(s,s,[{t:0},{t:0}],[{t:0},{t:0}]),/非递增/);
 assert.equal(alignment(s,s,f,[{t:3},{t:4}]).startOffset,3);
});
test('cancelled operations do not execute',async()=>{const c=new AbortController();c.abort();await assert.rejects(()=>run(FF,['-version'],{signal:c.signal}),/取消/)});
test('HEVC 10-bit HDR MOV with PCM: preserve metadata and refuse SDR VMAF',async()=>{
 const hdr=path.join(dir,'hdr-pcm.mov');
 await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=0.5','-f','lavfi','-i','sine=duration=0.5','-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le','-x265-params','log-level=error:pools=1:colorprim=9:transfer=16:colormatrix=9:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400','-tag:v','hvc1','-c:a','pcm_s16le',hdr]);
 const p=await probe(hdr);assert.equal(p.raw.streams[0].codec_name,'hevc');assert.equal(p.raw.streams[0].pix_fmt,'yuv420p10le');assert.equal(p.raw.streams[0].color_transfer,'smpte2084');assert.equal(p.raw.streams[1].codec_name,'pcm_s16le');assert.equal((await scan(hdr,0)).length,6);
 await assert.rejects(()=>compare(hdr,hdr,0,0,['vmaf'],context()),/HDR/);
 const r=await compare(hdr,hdr,0,0,['psnr','ssim'],context());assert.equal(r.metrics.psnr.pooled,'Infinity');assert.equal(r.metrics.ssim.pooled,1);
});
test('AV1 MP4: probe, decode and identical-frame metrics',async()=>{
 const av1=path.join(dir,'av1.mp4');await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=0.5','-c:v','libaom-av1','-cpu-used','8','-crf','35',av1]);
 assert.equal((await probe(av1)).raw.streams[0].codec_name,'av1');assert.equal((await scan(av1,0)).length,6);
 const r=await compare(av1,av1,0,0,['psnr','ssim'],context());assert.equal(r.metrics.psnr.pooled,'Infinity');assert.equal(r.metrics.ssim.pooled,1);
});
test('packet accounting separates both audio tracks and matches every packet byte',async()=>{
 const p=await probe(source),tracks=await allPackets(source,p.raw.streams,context());assert.equal(tracks.length,3);assert.equal(tracks.filter(t=>t.type==='audio').length,2);
 for(const t of tracks){assert.ok(t.bytes>0);assert.ok(Math.abs(t.bins.reduce((s,b)=>s+b.mbps,0)*1e6/8-t.bytes)<.001)}
});
test('H.264 IDR is determined from NAL headers, not inferred from I frames',async()=>{
 const p=await probe(source),frames=await scan(source,0),r=await structure(source,p.raw.streams[0],frames,context());assert.equal(frames[0].special,'IDR');assert.equal(r.matchedDisplayFrames,12);assert.equal(r.gops[0].count,12);assert.ok(frames.slice(1).every(f=>f.special==='NON_IDR'));
});
test('HEVC open GOP exposes CRA and IDR separately',async()=>{
 const file=path.join(dir,'open-gop.mp4');await run(FF,['-hide_banner','-v','error','-y','-f','lavfi','-i','testsrc2=size=192x108:rate=12:duration=3','-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error:pools=1:keyint=12:min-keyint=12:scenecut=0:open-gop=1',file]);
 const p=await probe(file),f=await scan(file,0),r=await structure(file,p.raw.streams[0],f,context());assert.match(f[0].special,/IDR/);assert.ok(f.some(x=>x.special==='CRA_NUT'));assert.ok(r.gops.length>=3);assert.equal(r.matchedDisplayFrames,f.length);
});
test('AV1 trace preserves hidden frames, show-existing events and reference slots',async()=>{
 const file=path.join(dir,'av1.mp4'),p=await probe(file),f=await scan(file,0),r=await structure(file,p.raw.streams[0],f,context());assert.ok(r.counts.hidden>0);assert.ok(r.counts.showExisting>0);assert.equal(r.counts.shown,f.length);assert.equal(r.matchedDisplayFrames,f.length);assert.equal(r.events[0].kind,'KEY');assert.ok(r.events.filter(e=>e.showExisting).every(e=>Number.isInteger(e.sourceEvent)));assert.ok(r.events.filter(e=>e.kind==='INTER').every(e=>e.referenceSlots.length===7));
});
test('short reference signaling yields seven valid slots',()=>{const refs=av1ShortRefs(0,1,10,7,[9,5,11,12,8,7,6,4]);assert.equal(refs.length,7);assert.equal(refs[0],0);assert.equal(refs[3],1);assert.equal(refs[6],3);assert.ok(refs.every(x=>x>=0&&x<8))});
test('SI/TI preserves one measurement per decoded frame',async()=>{const p=await probe(source),r=await complexity(source,p.raw.streams[0],context());assert.equal(r.points.length,12);assert.ok(r.si.mean>0);assert.ok(r.ti.mean>0)});
test('metadata summary merges repeated side data with explicit provenance',()=>{const r=metadataSummary({raw:{streams:[{index:0,side_data_list:[{side_data_type:'Mastering display',x:1}]}]},frameSample:{frames:[{stream_index:0,side_data_list:[{side_data_type:'Mastering display',x:1}]}]},frameSampleScope:'sample'});assert.equal(r.items.length,1);assert.equal(r.items[0].occurrences,2);assert.equal(r.items[0].sources.length,2)});
test('trial produces a measured curve and removes temporary media',async()=>{
 const cwd=path.join(dir,'trial');await mkdir(cwd,{recursive:true});const r=await trial({file:source,stream:0,start:0,duration:1,encoder:'libx264',crfs:[20,38],metrics:['psnr','ssim']},{...context(),cwd});assert.equal(r.rows.length,2);assert.ok(r.rows[0].videoBytes>r.rows[1].videoBytes);assert.ok(r.rows[0].metrics.psnr.pooled>r.rows[1].metrics.psnr.pooled);assert.ok(!(await readdir(cwd)).some(f=>/\.(nut|mkv)$/.test(f)));
});
test('H.265 HDR and AV1 trials preserve comparable sample formats',async()=>{
 for(const [encoder,file]of [['libx265',path.join(dir,'hdr-pcm.mov')],['libaom-av1',source]]){
  const cwd=path.join(dir,'trial-'+encoder);await mkdir(cwd,{recursive:true});const r=await trial({file,stream:0,start:0,duration:1,encoder,crfs:[24,36],metrics:['psnr','ssim']},{...context(),cwd});assert.equal(r.rows.length,2);assert.ok(r.rows.every(x=>Number.isFinite(x.metrics.psnr.pooled)));assert.ok(!(await readdir(cwd)).some(f=>f.endsWith('.mkv')));
 }
});
