import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {FP,run,probe,readPixelFormats} from '../engine.mjs';
import {propertyValue,pixelDescription,summarizeSample} from '../public/properties.js';
import {makePropertyMedia,legacyFrameSample} from './helpers/basic-properties.mjs';
import {basicInfoHTML,componentDepth} from '../public/basic-info.js';
const root=path.resolve('test-work/basic-properties');
let media;
const evidence={reports:{},performance:{}};
before(async()=>{media=await makePropertyMedia(path.join(root,'media'));evidence.recipe=media.commands});
async function measured(name){const commands=[],info=await probe(media.files[name],{commands});evidence.reports[name]={...info,commands};await writeFile(path.join(root,'measured-properties.json'),JSON.stringify(evidence));return info}
test('[basic-properties] real YUV 8/10/12-bit 420/422/444 descriptors and base evidence without automatic sampling',async()=>{
  for(const sampling of ['420','422','444'])for(const depth of [8,10,12]){
    const pix=`yuv${sampling}p${depth===8?'':depth+'le'}`,info=await measured(pix+'.mkv');
    assert.equal(info.raw.streams[0].pix_fmt,pix);
    const d=info.pixelFormats.raw.pixel_formats.find(d=>d.name===pix);
    assert.deepEqual(d.components.map(c=>c.bit_depth),[depth,depth,depth]);
    assert.equal(componentDepth(d),`${depth} bit`);
    assert.equal(d.log2_chroma_w,sampling==='444'?0:1);assert.equal(d.log2_chroma_h,sampling==='420'?1:0);
    assert.equal(info.frameSampleRead.status,'not-requested');assert.equal(info.frameSample,null);
    assert.equal(propertyValue(info.raw.streams[0].color_primaries,'enum','color_primaries').state,'missing');
    assert.ok(evidence.reports[pix+'.mkv'].commands.every(c=>!c.args.includes('-show_frames')&&!c.args.includes('-read_intervals')));
    assert.equal(typeof info.pixelFormats.raw.program_version.version,'string');
    assert.ok(info.pixelFormats.raw.library_versions.length>0);
    assert.equal(info.pixelFormats.commands[0].exitCode,0);
  }
});
test('[basic-properties] real RGB grayscale alpha semi-planar and unequal component depths',async()=>{
  for(const pix of ['rgb24','rgba','gray','nv12','rgb565le']){
    const info=await measured(pix+'.nut'),d=info.pixelFormats.raw.pixel_formats.find(d=>d.name===pix);
    assert.equal(info.raw.streams[0].pix_fmt,pix);assert.equal(info.frameSample,null);
    if(pix==='rgba')assert.equal(d.flags.alpha,1);
    if(pix==='gray')assert.equal(d.nb_components,1);
    if(pix==='nv12')assert.match(pixelDescription(d).text,/不能据此区分/);
    if(pix==='rgb565le')assert.deepEqual(d.components.map(c=>c.bit_depth),[5,6,5]);
    if(pix==='rgb565le')assert.equal(componentDepth(d),'R 5 bit / G 6 bit / B 5 bit');
    assert.match(pixelDescription(d).text,/存储宽度.*未报告/);
  }
});
test('[basic-properties] real color tags SAR display matrix interlacing HDR and attached image',async()=>{
  const rotated=await measured('rotated.mp4'),s=rotated.raw.streams[0];
  assert.equal(s.sample_aspect_ratio,'4:3');assert.equal(s.color_primaries,'bt709');assert.equal(s.color_transfer,'bt709');
  assert.equal(s.side_data_list.find(d=>d.side_data_type==='Display Matrix').rotation,90);
  const interlaced=await measured('interlaced.mkv');assert.ok(['tt','bb','tb','bt'].includes(interlaced.raw.streams[0].field_order));
  const hdr=await measured('hdr.mkv');assert.equal(hdr.raw.streams[0].color_transfer,'smpte2084');
  const legacyCommands=[],legacy=await legacyFrameSample(media.files['hdr.mkv'],hdr.raw.streams,{commands:legacyCommands});
  const legacyReport={...hdr,...legacy,commands:legacyCommands};
  evidence.reports.legacyHdr=legacyReport;await writeFile(path.join(root,'measured-properties.json'),JSON.stringify(evidence));
  const data=legacy.frameSample.frames.flatMap(f=>f.side_data_list??[]);
  assert.ok(data.some(d=>d.side_data_type==='Mastering display metadata'));assert.ok(data.some(d=>d.side_data_type==='Content light level metadata'));
  assert.match(basicInfoHTML(legacyReport),/Mastering display metadata/);
  assert.match(basicInfoHTML(hdr),/本次未执行帧级附加数据读取/);
  const attached=await measured('attached.mp4');assert.equal(attached.raw.streams.filter(s=>s.codec_type==='video').length,2);
  const cover=attached.raw.streams.find(s=>s.disposition.attached_pic===1);assert.ok(cover);
  assert.equal(attached.frameSampleRead.status,'not-requested');assert.equal(attached.frameSample,null);
});
test('[basic-properties] real multi-track base read avoids sample commands and audio-only applicability',async()=>{
  const multi=await measured('multi.mkv');assert.equal(multi.raw.streams.length,3);
  assert.equal(multi.frameSampleRead.status,'not-requested');assert.deepEqual(multi.frameSampleRead.tracks,[]);
  assert.equal(evidence.reports['multi.mkv'].commands.length,2);
  assert.ok(evidence.reports['multi.mkv'].commands.every(c=>!c.args.includes('-show_frames')&&!c.args.includes('-read_intervals')));
  const audio=await measured('audio.wav');assert.equal(audio.frameSampleRead.status,'not-applicable');assert.equal(audio.frameSample,null);
});
test('[basic-properties] specified parser boundaries preserve zero unknown absent invalid and sample differences',()=>{
  // Contract inputs only; these assertions do not claim measurements from media.
  for(const [value,kind,key,state] of [[0,'integer','nb_frames','reported'],[0,'number','start_time','reported'],[0,'nonnegative','duration','reported'],['0','positive','bits_per_raw_sample','unknown'],['0/0','rate','','invalid'],['0/1','rate','','unknown'],['2/0','ratio','','invalid'],['-1','positive','','invalid'],[undefined,'enum','color_space','missing'],['new-matrix','enum','color_space','unknown'],['unknown','enum','color_space','unknown'],['-99','level','','unknown']])assert.equal(propertyValue(value,kind,key).state,state);
  const streams=[{index:0,codec_type:'video',color_range:'tv'},{index:1,codec_type:'video'}],raw={frames:[{stream_index:0,pts_time:'0',color_range:'tv'},{stream_index:0,pts_time:'0.5',color_range:'pc'}]},copy=structuredClone(raw);
  const summary=summarizeSample(streams,raw);assert.equal(summary.tracks[0].fields.color_range.varies,true);assert.equal(summary.tracks[0].fields.color_range.differsFromTrack,true);
  assert.equal(summary.tracks[1].status,'empty');assert.deepEqual(raw,copy);
  assert.equal(summarizeSample(streams,null,'failed','actual failure').tracks[0].status,'failed');
});
test('[basic-properties] presentation keeps specified unknown fields and differences without mutating evidence',()=>{
  // Contract input for forward compatibility, not a measured-media report.
  const report={file:'<script>example</script>.mkv',size:0,raw:{format:{size:'0',duration:'0',start_time:'0',future_container:'container-value'},streams:[{index:0,codec_type:'video',codec_name:'test',color_range:'tv',future_stream:'stream-value',tags:{language:'zho',rotate:'0',custom_tag:'<img src=x>'},side_data_list:[{side_data_type:'Future side data',custom:'side-value'}]}],chapters:[],future_root:{custom:'root-value'}},frameSample:{frames:[{stream_index:0,pts_time:'0',color_range:'pc'}]}};
  const copy=structuredClone(report),html=basicInfoHTML(report);
  assert.deepEqual(report,copy);
  for(const text of ['container-value','stream-value','root-value','side-value','Future side data','开头样本属性存在差异','0 byte','0 s'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('<script>example</script>'));assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;script&gt;example&lt;/script&gt;'));
  assert.equal(componentDepth({components:[{index:1,bit_depth:0}]}),'分量 1 未指定（0）');
  assert.equal(componentDepth({nb_components:3,components:[{index:1,bit_depth:8}]}),'分量 1 8 bit','incomplete descriptions cannot be abbreviated as a uniform format');
  assert.equal(componentDepth({nb_components:3,flags:{rgb:1},components:[{index:1,bit_depth:5},{index:2,bit_depth:6},{index:3,bit_depth:5}]}),'R 5 bit / G 6 bit / B 5 bit');
  assert.equal(componentDepth({nb_components:3,flags:{rgb:0},components:[{index:1,bit_depth:10},{index:2,bit_depth:8},{index:3,bit_depth:8}]}),'Y 10 bit / U 8 bit / V 8 bit');
  const old={file:'old.wav',raw:{format:{},streams:[]}};
  assert.ok(!basicInfoHTML(old).includes('NaN'));
  assert.ok(basicInfoHTML(old).includes('不适用（无视频轨道）'));
  old.raw.format.size='100';
  assert.ok(!basicInfoHTML(old).includes('文件大小来源不同'),'a missing source cannot be classified as a conflicting size');
});
test('[basic-properties] real damaged input and failed supplemental read keep successful base evidence separate',async()=>{
  const info=await measured('tagged.mp4'),damaged=path.join(root,'damaged.mp4');await writeFile(damaged,'damaged media, deliberately invalid');
  await assert.rejects(()=>probe(damaged));
  const controller=new AbortController();controller.abort();await assert.rejects(()=>readPixelFormats({signal:controller.signal}),/取消/);
  const timed=await probe(media.files['tagged.mp4'],{probeSupplementTimeoutMs:1});
  assert.deepEqual(timed.raw,info.raw);assert.equal(timed.frameSampleRead.status,'not-requested');assert.equal(timed.frameSample,null);
  assert.equal(timed.pixelFormats.status,'failed');assert.match(timed.pixelFormats.error,/超时/);
  evidence.reports.timeoutSupplement=timed;
  await writeFile(path.join(root,'measured-properties.json'),JSON.stringify(evidence));
});
test('[basic-properties] same-runtime baseline versus supplemented probe timing and memory observations',async()=>{
  const file=media.files['multi.mkv'],observations=[];
  for(let i=0;i<3;i++){
    const commands=[],before=process.memoryUsage().rss,start=performance.now();
    await run(FP,['-v','error','-show_format','-show_streams','-show_chapters','-of','json',file],{commands});
    await run(FP,['-v','error','-select_streams','v','-read_intervals','%+#32','-show_frames','-show_entries','frame=stream_index,color_range,color_space,color_transfer,color_primaries:frame_side_data','-of','json',file],{commands});
    const baselineSeconds=(performance.now()-start)/1000,fullStart=performance.now(),fullCommands=[];
    const info=await probe(file,{commands:fullCommands});const supplementedSeconds=(performance.now()-fullStart)/1000;
    assert.equal(info.frameSampleRead.status,'not-requested');assert.ok(fullCommands.every(c=>c.exitCode===0&&c.elapsedSeconds<10));
    assert.ok(fullCommands.every(c=>!c.args.includes('-read_intervals')));
    const rssAfter=process.memoryUsage().rss;assert.ok(rssAfter-before<128*1024**2);
    observations.push({baselineSeconds,supplementedSeconds,nodeRssBeforeBytes:before,nodeRssAfterBytes:rssAfter,serializedProbeBytes:Buffer.byteLength(JSON.stringify(info)),commands,fullCommands});
  }
  evidence.performance={scope:'Same fixture and runtime; Node RSS snapshots, not subprocess peak memory or general throughput',observations};await writeFile(path.join(root,'measured-properties.json'),JSON.stringify(evidence));
  const memoryInput=path.join(root,'memory-input.json'),memoryOutput=path.join(root,'memory-output.json');
  await writeFile(memoryInput,JSON.stringify([...observations[0].commands,...observations[0].fullCommands]));
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/probe-memory.ps1'),'-InputPath',memoryInput,'-OutputPath',memoryOutput],{windowsHide:true,timeout:60000});
  const {readFile}=await import('node:fs/promises');
  evidence.performance.toolMemory=JSON.parse((await readFile(memoryOutput,'utf8')).replace(/^\uFEFF/,''));
  for(const row of evidence.performance.toolMemory){assert.equal(row.exitCode,0);assert.ok(row.observedPeakWorkingSetBytes>0&&row.observedPeakWorkingSetBytes<256*1024**2)}
  evidence.performance.scope='Same fixture and runtime: Node RSS snapshots plus OS peak-working-set observations for individual FFprobe processes; sampling may miss final allocation, not a throughput claim';
  await writeFile(path.join(root,'measured-properties.json'),JSON.stringify(evidence));
});
