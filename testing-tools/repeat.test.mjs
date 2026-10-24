import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {FF,FP,run,probe} from '../engine.mjs';
import {analyzeRepeats,repeatPreview,verifyRepeatPadding} from '../repeat.mjs';
import {repeatFrameFormat,repeatExactSummary,repeatTimeline,validateRepeatAnalysis} from '../public/repeat-model.js';

const root=path.resolve('.build/testing-work');let dir;
before(async()=>{await mkdir(root,{recursive:true});dir=await mkdtemp(path.join(root,'repeat-analysis-'));});
const digest=b=>createHash('sha256').update(b).digest('hex');
// This independent byte generator does not import the product's format descriptor.
function fixture(format){
  const width=257,height=257;let depth=8,word=1,endian='le',shift=0,counts,alpha=false;
  let m;
  if((m=/^yuv(a)?(420|422|444)p(?:(9|10|12|14|16)(le|be))?$/.exec(format))){
    depth=Number(m[3]??8);endian=m[4]??'le';alpha=!!m[1];
    const cw=m[2]==='444'?width:129,ch=m[2]==='420'?129:height;counts=[width*height,cw*ch,cw*ch];if(alpha)counts.push(width*height);
  }else if((m=/^gbr(a)?p(?:(9|10|12|14|16)(le|be))?$/.exec(format))){
    depth=Number(m[2]??8);endian=m[3]??'le';alpha=!!m[1];counts=Array(alpha?4:3).fill(width*height);
  }else if((m=/^gray(?:(9|10|12|14|16)(le|be))?$/.exec(format))){depth=Number(m[1]??8);endian=m[2]??'le';counts=[width*height];}
  else if(['rgb24','bgr24','rgba','bgra','argb','abgr'].includes(format)){alpha=format.length===4;counts=[width*height*(alpha?4:3)];}
  else if(['nv12','nv21'].includes(format)){counts=[width*height,129*129*2];}
  else throw Error('Unknown independent fixture');
  word=depth>8?2:1;
  const count=counts.reduce((a,b)=>a+b,0),a=Buffer.alloc(count*word),maximum=2**depth;
  for(let i=0;i<count;i++){const value=(i%maximum)*2**shift;if(word===1)a[i]=value;else if(endian==='le')a.writeUInt16LE(value,i*2);else a.writeUInt16BE(value,i*2);}
  const versions=[a];
  // Every plane's top-left sample, last edge, and alpha are changed separately by one LSB.
  const positions=[];let offset=0;for(const n of counts){positions.push(offset);offset+=n;}
  if(alpha&&format==='rgba')positions.push(3);
  positions.push(count-1);
  for(const position of positions){const b=Buffer.from(a),byte=position*word+(endian==='be'&&word===2?1:0);b[byte]^=1;versions.push(b);}
  const frames=versions.flatMap(b=>[b,b]);
  return {format,width,height,word,depth,counts,frames,expected:frames.map((b,i)=>i>0&&b.equals(frames[i-1]))};
}
async function media(c,name=c.format,extra=[]){
  const raw=path.join(dir,name+'.raw'),file=path.join(dir,name+'.nut'),ctx={commands:[]};await writeFile(raw,Buffer.concat(c.frames));
  await run(FF,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format',c.format,'-video_size',`${c.width}x${c.height}`,'-framerate','24','-i',raw,...extra,'-fps_mode','passthrough','-c:v','rawvideo','-threads:v','1',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0];assert.equal(stream.pix_fmt,c.format,'fixture must really decode in the requested format');
  return {file,stream,ctx};
}

test('[repeat-analysis] native integer layouts preserve every plane, alpha, edge and LSB against independent known bytes',async()=>{
  const formats=['yuv420p','yuv422p','yuv444p','yuva420p','yuva422p','yuva444p','gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','gbrap','nv12','nv21'];
  for(const sampling of ['420','422','444'])for(const depth of [9,10,12,14,16])for(const endian of ['le','be'])formats.push(`yuv${sampling}p${depth}${endian}`);
  for(const sampling of ['420','422','444'])for(const depth of [9,10,16,...(sampling==='420'?[]:[12])])for(const endian of ['le','be'])formats.push(`yuva${sampling}p${depth}${endian}`);
  for(const depth of [9,10,12,14,16])for(const endian of ['le','be'])formats.push(`gbrp${depth}${endian}`,`gray${depth}${endian}`);
  for(const depth of [10,12,14,16])for(const endian of ['le','be'])formats.push(`gbrap${depth}${endian}`);
  const cases=[];
  for(const format of formats){
    const c=fixture(format),{file,stream,ctx}=await media(c),result=await analyzeRepeats(file,stream,ctx);
    assert.equal(result.status,'complete');assert.equal(result.sampleFormat.bytes,c.frames[0].length);
    assert.deepEqual(result.frames.map(f=>f.sha256),c.frames.map(digest));
    assert.deepEqual(result.frames.map((f,i)=>i>0&&f.sha256===result.frames[i-1].sha256),c.expected);
    assert.equal(result.exact.duplicates,c.frames.length/2);assert.equal(result.exact.comparisons,c.frames.length-1);
    assert.equal(result.exact.runs.length,c.frames.length/2);assert.ok(result.exact.runs.every(r=>r.extraFrames===1&&r.frameCount===2));
    assert.equal(result.timeline.status,'complete');assert.equal(result.freeze.status,'not-requested');
    cases.push({format,expectedHashes:c.frames.map(digest),expectedMask:c.expected,result,commands:ctx.commands});
  }
  await writeFile(path.join(dir,'native-layouts.json'),JSON.stringify({outcome:'passed',cases}));
});

test('[repeat-analysis] original PTS, offset and VFR holds agree with separate FFprobe integer evidence',async()=>{
  const c=fixture('yuv420p');c.frames=c.frames.slice(0,8);
  const {file,stream,ctx}=await media(c,'vfr',['-vf',"setpts='(N+floor(N/3))/(24*TB)+3600/TB'"]);
  const official=JSON.parse(await run(FP,['-v','error','-select_streams','0','-show_frames','-show_entries','frame=pts,best_effort_timestamp,duration','-of','json',file],ctx));
  const r=await analyzeRepeats(file,stream,ctx);
  assert.deepEqual(r.frames.map(f=>f.pts),official.frames.map(f=>String(f.pts)));
  assert.ok(BigInt(r.frames[0].pts)>0n);assert.equal(r.timeline.intervals.length,2);assert.equal(r.timeline.grids[0].status,'incompatible');
  const intervalCounts=new Map();for(let i=1;i<official.frames.length;i++){const d=String(BigInt(official.frames[i].pts)-BigInt(official.frames[i-1].pts));intervalCounts.set(d,(intervalCounts.get(d)??0)+1);}
  assert.deepEqual(r.timeline.intervals,[...intervalCounts].sort((a,b)=>Number(a[0])-Number(b[0])).map(([ticks,count])=>({ticks,count})));
  assert.ok(r.timeline.longestIntervals.length>0);assert.equal(r.timeline.longestIntervals[0].frame,2);assert.equal(r.timeline.longestIntervals[1].frame,5);
  await writeFile(path.join(dir,'timestamps.json'),JSON.stringify({outcome:'passed',official,result:r,commands:ctx.commands}));
});

test('[repeat-analysis] integer rational grid, missing PTS, one frame and open boundaries have explicit meanings',()=>{
  const frame=(pts,sha256='a')=>({pts,sha256,duration:null});
  const ntsc=Array.from({length:120},(_,i)=>frame(String(Math.round(i*1001/30))));
  const t=repeatTimeline(ntsc,'1/1000',['30000/1001']);assert.equal(t.grids[0].status,'compatible');assert.deepEqual(t.intervals.map(x=>x.ticks),['33','34']);
  assert.equal(repeatTimeline([frame('90071992547409930'),frame('90071992547410030')],'1/12000',['120/1']).grids[0].maxError.numerator,'0');
  assert.equal(repeatTimeline([frame(null),frame('1')],'1/24',['24/1']).status,'partial');
  assert.equal(repeatTimeline([frame('0'),frame('0')],'1/24',['24/1']).nonIncreasing,1);
  assert.equal(repeatTimeline([frame(null),frame(null)],'1/24',['24/1']).status,'unavailable');
  assert.equal(repeatExactSummary([frame('0')]).ratio,null);
  assert.deepEqual(repeatExactSummary([frame('0'),frame('1')]).runs[0],{startFrame:0,endFrame:1,frameCount:2,extraFrames:1,startPts:'0',endPts:null,endSource:'unknown'});
  assert.equal(repeatExactSummary([frame('0'),frame('1'),frame('8','b')]).runs[0].endPts,'8');
  assert.equal(repeatExactSummary([frame('0'),frame(null)]).runs[0].endPts,null);
});

test('[repeat-analysis] P010 P012 P016 native raw paths match official hashes and reject non-sample bits without a container claim',async()=>{
  const cases=[];
  for(const depth of [10,12,16])for(const endian of ['le','be']){
    const format=`p0${depth}${endian}`,width=257,height=257,samples=width*height+129*129*2,shift=16-depth,a=Buffer.alloc(samples*2);
    for(let i=0;i<samples;i++){const value=(i%(2**depth))*2**shift;if(endian==='le')a.writeUInt16LE(value,i*2);else a.writeUInt16BE(value,i*2);}
    const changed=Buffer.from(a);changed[(samples-1)*2+(endian==='le'?0:1)]^=2**shift;
    const frames=[a,a,changed,changed],file=path.join(dir,format+'.raw');await writeFile(file,Buffer.concat(frames));
    const desc=repeatFrameFormat(format,width,height);assert.equal(desc.bytes,a.length);assert.equal(desc.samples,samples);assert.equal(desc.shift,shift);
    for(let offset=0;offset<a.length;offset+=65)verifyRepeatPadding(a.subarray(offset,offset+65),offset,desc);
    if(shift){const invalid=Buffer.from(a);invalid[endian==='le'?0:1]|=1;assert.throws(()=>verifyRepeatPadding(invalid,0,desc),/填充位/);if(endian==='be')assert.throws(()=>verifyRepeatPadding(invalid.subarray(1),1,desc),/填充位/);else assert.doesNotThrow(()=>verifyRepeatPadding(invalid.subarray(1),1,desc));}
    const ctx={commands:[]},official=await run(FF,['-v','error','-noauto_conversion_filters','-f','rawvideo','-pixel_format',format,'-video_size',`${width}x${height}`,'-framerate','24','-i',file,'-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+format,'-fps_mode','passthrough','-f','framehash','-hash','sha256','-'],ctx);
    const hashes=official.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());assert.deepEqual(hashes,frames.map(digest));
    assert.equal(repeatExactSummary(hashes.map(sha256=>({sha256,pts:null,duration:null}))).duplicates,2);
    cases.push({format,width,height,samples,expected:frames.map(digest),official,commands:ctx.commands,scope:'Explicit raw input. Auto-probed container carriage not certified by this case.'});
  }
  // An automatically probed rawvideo NUT can mislabel this format. Reject that
  // representation; do not present the raw-path test as successful file support.
  const file=path.join(dir,'mis-tagged-p010.nut');await run(FF,['-v','error','-y','-f','lavfi','-i','color=size=32x32:rate=1:duration=1,format=p010le','-c:v','rawvideo',file]);
  const stream=(await probe(file)).raw.streams[0];assert.equal(stream.pix_fmt,'rgb555le');const rejected=await analyzeRepeats(file,stream);assert.equal(rejected.status,'unsupported');
  await writeFile(path.join(dir,'semiplanar-raw.json'),JSON.stringify({outcome:'passed',cases,mislabelledContainer:{stream,result:rejected}}));
});

test('[repeat-analysis] missing source PTS never borrows generated framehash timestamps',async()=>{
  const file=path.join(dir,'missing.h264'),ctx={commands:[]};
  await run(FF,['-v','error','-y','-f','lavfi','-i','color=size=32x32:rate=24:duration=0.5','-c:v','libx264','-bf','0','-f','h264',file],ctx);
  const stream=(await probe(file,ctx)).raw.streams[0],r=await analyzeRepeats(file,stream,ctx,{freeze:true});
  assert.ok(r.frames.every(f=>f.pts===null));assert.ok(r.frames.every(f=>f.hashPts!==null));assert.equal(r.timeline.status,'unavailable');assert.equal(r.freeze.status,'unavailable');
  await writeFile(path.join(dir,'missing-pts.json'),JSON.stringify({outcome:'passed',result:r,commands:ctx.commands}));
});

test('[repeat-analysis] freezedetect metadata matches upstream events and preserves open EOF in native 8, 10, 12, 16-bit and alpha',async()=>{
  const cases=[];
  const formats=['yuv420p','yuv422p','yuv444p','gray','gbrp','gbrap','rgb24','bgr24','rgba','bgra','argb','abgr','nv12','nv21','yuva420p','yuva422p','yuva444p'];
  for(const depth of [9,10,12,14,16])for(const group of ['yuv420p','yuv422p','yuv444p','gray','gbrp'])formats.push(`${group}${depth}le`);
  for(const depth of [10,12,16])formats.push(`gbrap${depth}le`);
  for(const depth of [10,16])for(const group of ['yuva420p','yuva422p','yuva444p'])formats.push(`${group}${depth}le`);
  for(const format of formats){
    const c=fixture(format);c.frames=Array(73).fill(c.frames[0]);
    const {file,stream,ctx}=await media(c,'freeze-'+format),r=await analyzeRepeats(file,stream,ctx,{freeze:true});
    assert.equal(r.freeze.status,'complete',r.freeze.reason);assert.equal(r.freeze.events.length,1);assert.equal(r.freeze.events[0].kind,'start');assert.equal(r.freeze.events[0].frame,48);assert.equal(r.freeze.segments[0].end,null);
    let raw='';await run(FF,['-v','error','-copyts','-noauto_conversion_filters','-i',file,'-vf','freezedetect=n=0.001:d=2,metadata=mode=print:file=-','-fps_mode','passthrough','-f','null','-'],ctx,l=>{raw+=l+'\n';});
    assert.equal(r.freeze.events[0].value,/lavfi\.freezedetect\.freeze_start=(\S+)/.exec(raw)[1]);
    cases.push({format,upstream:raw,result:r,commands:ctx.commands});
  }
  await writeFile(path.join(dir,'freeze.json'),JSON.stringify({outcome:'passed',cases}));
});

test('[repeat-analysis] preview checks native hashes, changed files, report tampering and cancellation',async()=>{
  const c=fixture('rgba'),{file,stream,ctx}=await media(c,'preview'),r=await analyzeRepeats(file,stream,ctx);
  const input={file,signature:r.source.signature,stream:0,frame:1,hashes:r.frames.slice(0,2).map(f=>f.sha256)};
  const preview=await repeatPreview(input,ctx);assert.equal(preview.images.length,2);assert.ok(preview.images.every(i=>i.image.startsWith('data:image/png;base64,iVBOR')));
  assert.equal(preview.images[0].image,preview.images[1].image);
  await assert.rejects(()=>repeatPreview({...input,hashes:['0'.repeat(64),input.hashes[1]]},ctx),/指纹不一致/);
  const damaged=structuredClone(r);damaged.exact.duplicates++;assert.throws(()=>validateRepeatAnalysis(damaged,stream),/派生/);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>analyzeRepeats(file,stream,{signal:cancelled.signal}),/取消/);
  await appendFile(file,Buffer.from([0]));await assert.rejects(()=>repeatPreview(input,ctx),/发生变化/);
  await writeFile(path.join(dir,'preview.json'),JSON.stringify({outcome:'passed',images:preview.images.map(({image,...i})=>({...i,pngSha256:digest(Buffer.from(image.split(',')[1],'base64'))})),result:r,commands:ctx.commands}));
});

test('[repeat-analysis] closed and open freeze events reproduce upstream strings, event frames and durations',async()=>{
  const c=fixture('yuv420p'),black=Buffer.concat([Buffer.alloc(c.counts[0],16),Buffer.alloc(c.counts[1]+c.counts[2],128)]),white=Buffer.from(black);white.fill(235,0,c.counts[0]);
  c.frames=[...Array(60).fill(black),...Array(24).fill(white),...Array(60).fill(black)];
  const {file,stream,ctx}=await media(c,'closed-freeze'),r=await analyzeRepeats(file,stream,ctx,{freeze:true});
  assert.equal(r.freeze.status,'complete',r.freeze.reason);
  assert.deepEqual(r.freeze.events.map(e=>e.kind),['start','duration','end','start']);
  assert.deepEqual(r.freeze.segments.map(({start,end,duration})=>({start,end,duration})),[{start:'0',end:'2.5',duration:'2.5'},{start:'3.5',end:null,duration:null}]);
  let frame=null,pts=null;const official=[];
  await run(FF,['-v','error','-copyts','-noauto_conversion_filters','-i',file,'-vf','freezedetect=n=-60dB:d=2,metadata=mode=print:file=-','-fps_mode','passthrough','-f','null','-'],ctx,line=>{
    const header=/^frame:(\d+)\s+pts:(-?\d+)/.exec(line);if(header){frame=+header[1];pts=header[2];}
    const event=/^lavfi\.freezedetect\.freeze_(start|duration|end)=(\S+)/.exec(line);if(event)official.push({kind:event[1],value:event[2],frame,filterPts:pts});
  });
  assert.deepEqual(r.freeze.events,official);
  await writeFile(path.join(dir,'closed-freeze.json'),JSON.stringify({outcome:'passed',official,result:r,commands:ctx.commands}));
});

test('[repeat-analysis] bad padding, truncated decode, unsupported representation and mid-process cancel cannot succeed',async()=>{
  const c=fixture('yuv420p10le');for(const b of c.frames)b[1]|=128;
  const bad=await media(c,'bad-padding');await assert.rejects(()=>analyzeRepeats(bad.file,bad.stream,bad.ctx),/填充位/);
  const valid=await media(fixture('yuv420p'),'truncated'),bytes=await readFile(valid.file);await writeFile(valid.file,bytes.subarray(0,bytes.length-17000));
  await assert.rejects(()=>analyzeRepeats(valid.file,valid.stream,valid.ctx));
  const floating=path.join(dir,'float.mkv');await run(FF,['-v','error','-y','-f','lavfi','-i','nullsrc=size=32x32:rate=1:duration=1,format=grayf32le','-c:v','exr','-format','float','-gamma','1',floating]);
  const stream=(await probe(floating)).raw.streams[0];assert.equal(stream.pix_fmt,'grayf32le');const unsupported=await analyzeRepeats(floating,stream);
  assert.equal(unsupported.status,'unsupported');assert.equal(unsupported.frames,undefined);validateRepeatAnalysis(unsupported,stream);
  const file=path.join(dir,'cancel.mkv');await run(FF,['-v','error','-y','-f','lavfi','-i','color=size=1280x720:rate=120:duration=10','-c:v','libx264','-preset','ultrafast','-qp','0',file]);
  const s=(await probe(file)).raw.streams[0],controller=new AbortController();let scheduled=false;
  await assert.rejects(()=>analyzeRepeats(file,s,{signal:controller.signal,update:value=>{if(value.detail==='原始帧证据读取完成'){scheduled=true;setTimeout(()=>controller.abort(),50);}}}));
  assert.equal(scheduled,true);assert.equal(controller.signal.aborted,true);
  await writeFile(path.join(dir,'failure-boundaries.json'),JSON.stringify({outcome:'passed',unsupported,paddingCommands:bad.ctx.commands,truncatedCommands:valid.ctx.commands,cancelled:true}));
});
