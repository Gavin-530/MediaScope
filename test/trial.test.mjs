import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,run,probe,video} from '../engine.mjs';
import {trial,trialOptions} from '../analysis.mjs';
import {parseCrfs,trialPlotData} from '../public/trial-model.js';
import {visiblePoints} from '../public/charts.js';
const root=path.resolve('test-work/trials-expanded'),sources={};
const input={stream:0,start:0,duration:1,encoder:'libx265',crfs:[25],presets:['ultrafast'],metrics:['psnr','ssim'],depthMode:'both'};
before(async()=>{
 await mkdir(root,{recursive:true});
 for(const depth of [8,10]){
  const count=256*64*3/2*2,buffer=Buffer.alloc(count*(depth===8?1:2));
  for(let i=0;i<count;i++){if(depth===8)buffer[i]=i%256;else buffer.writeUInt16LE(i%1024,i*2)}
  const raw=path.join(root,`source-${depth}.yuv`),file=path.join(root,`source-${depth}.mkv`);await writeFile(raw,buffer);
  await run(FF,['-v','error','-y','-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size','256x64','-framerate','2','-i',raw,'-vf','setfield=prog,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','ffv1','-level','3','-chroma_sample_location','left',file]);
  sources[depth]=file;
 }
});
async function context(name){const cwd=await mkdtemp(path.join(root,name+'-'));return {cwd,commands:[],update:()=>{}}}
test('expanded settings and CRF ranges reject invalid or excessive matrices',()=>{
 assert.deepEqual(parseCrfs('18:20:0.5, 24'),[18,18.5,19,19.5,20,24]);
 for(const value of ['1:20','2:1','1:5:0','18,18','20,NaN',''])assert.throws(()=>parseCrfs(value));
 assert.equal(trialOptions({...input,crfs:[10,15,20,25,30,35],presets:['fast','slow']}).points,24);
 for(const change of [{presets:['bad']},{presets:[]},{presets:['fast','fast']},{crfs:[52]},{crfs:[]},{depthMode:'automatic'},{crfs:Array.from({length:12},(_,i)=>i),presets:['fast','slow','medium']},{metrics:['vmaf']},{encoder:'libaom-av1',crfs:[20.5]},{cpuUsed:9}])assert.throws(()=>trialOptions({...input,...change}));
});
test('10-bit source: exact full-code truncation, common-domain scores, metadata and presets',async()=>{
 const ctx=await context('ten'),result=await trial({...input,file:sources[10],presets:['ultrafast','fast'],keepFiles:true},ctx);
 assert.equal(result.rows.length,4);assert.equal(result.experiment.frameTimes.length,result.experiment.actualFrames);assert.equal(result.experiment.frameTimes[0],0);assert.ok(result.experiment.frameTimes.every((t,i,a)=>Number.isFinite(t)&&(i===0||t>a[i-1])));assert.equal(result.experiment.preparation.reductionCheck.passed,true);
 assert.equal(result.experiment.preparation.normalization.verification.passed,true);
 assert.deepEqual(new Set(result.rows.map(r=>r.preset)),new Set(['ultrafast','fast']));
 assert.deepEqual(new Set(result.rows.map(r=>r.bitDepth)),new Set([8,10]));
 const raw=path.join(ctx.cwd,'prepared.yuv');await run(FF,['-v','error','-y','-i',path.join(ctx.cwd,'input-8bit.mkv'),'-map','0:v','-c:v','rawvideo','-f','rawvideo',raw]);
 const actual=await readFile(raw),source=await readFile(path.join(root,'source-10.yuv'));
 assert.equal(actual.length,source.length/2);for(let i=0;i<actual.length;i++)assert.equal(actual[i],Math.floor(source.readUInt16LE(i*2)/4));
 for(const row of result.rows){
  assert.ok(row.encodeSeconds>0);assert.equal(row.metrics.psnr.values.length,2);assert.ok(row.metrics.psnr.components);
  const stream=video(await probe(path.join(ctx.cwd,row.id+'.mkv')),0);
  for(const key of ['color_space','color_transfer','color_primaries'])assert.equal(stream[key],'bt709');assert.equal(stream.color_range,'tv');assert.equal(stream.chroma_location,'left');
  assert.equal(stream.pix_fmt,row.bitDepth===8?'yuv420p':'yuv420p10le');
  if(row.bitDepth===8)assert.equal(row.normalization.psnrPeak,1023);
 }
 const encoded=ctx.commands.filter(c=>c.args.includes('libx265'));assert.equal(encoded.length,4);
 assert.ok(encoded.every(c=>c.args.includes('-noauto_conversion_filters')));
});
test('8-bit source: exact promotion, VMAF omitted consistently, cleanup',async()=>{
 const ctx=await context('eight'),result=await trial({...input,file:sources[8],metrics:['psnr','ssim','vmaf']},ctx);
 assert.equal(result.rows.length,2);assert.equal(result.experiment.preparation.baseline.psnr.pooled,'Infinity');
 assert.ok(result.skippedMetrics.vmaf);assert.ok(result.rows.every(r=>!r.metrics.vmaf));
 assert.deepEqual(result.experiment.retainedFiles,[]);assert.ok(!(await readdir(ctx.cwd)).some(f=>f.endsWith('.mkv')));
});
test('native experiment accepts more than four CRFs and decimal x265 CRF',async()=>{
 const ctx=await context('many'),result=await trial({...input,file:sources[8],depthMode:'native',crfs:[20,22.5,25,27,30],metrics:['psnr']},ctx);
 assert.equal(result.rows.length,5);assert.equal(result.rows[1].crf,22.5);assert.ok(result.rows.every(r=>r.preset==='ultrafast'));
});
test('dual-depth rejects HDR before creating references and cleans up cancellation',async()=>{
 const hdr=path.join(root,'hdr.mkv');await run(FF,['-v','error','-y','-i',sources[10],'-vf','setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc','-c:v','ffv1','-level','3',hdr]);
 const ctx=await context('reject');await assert.rejects(()=>trial({...input,file:hdr},ctx),/BT.709/);assert.deepEqual(await readdir(ctx.cwd),[]);
 const cancelled=await context('cancel'),controller=new AbortController();cancelled.signal=controller.signal;cancelled.update=progress=>{if(progress?.stage?.startsWith('编码点 '))controller.abort()};
 await assert.rejects(()=>trial({...input,file:sources[8]},cancelled),/取消/);assert.ok(!(await readdir(cancelled.cwd)).some(f=>f.endsWith('.mkv')));
});
test('chart data separates bit depths and presets, and preserves unavailable metrics as gaps',()=>{
 const rows=[{crf:25,preset:'fast',bitDepth:8,videoBytes:200,metrics:{psnr:{pooled:'Infinity'}}},{crf:20,preset:'slow',bitDepth:10,videoBytes:400,metrics:{psnr:{pooled:40}}},{crf:20,preset:'fast',bitDepth:8,videoBytes:300,metrics:{psnr:{pooled:38}}}];
 const chart=trialPlotData(rows,'crf','psnr');assert.equal(chart.series.length,2);assert.deepEqual(chart.data.map(p=>p[0]),[20,20,25]);assert.equal(chart.data.at(-1)[1],null);assert.equal(chart.data[1][3],chart.data[2][3]);assert.notEqual(chart.data[0][3],chart.data[1][3]);
 assert.equal(trialPlotData(rows,'videoKiB','vmaf').data[0][1],null);
 const repeated=[...chart.data,...chart.data].sort((a,b)=>a[0]-b[0]);
 assert.equal(visiblePoints(repeated,20,25).length,6);
 assert.equal(visiblePoints(repeated,20,20).length,4);
 assert.equal(visiblePoints(repeated,20,25,true).length,4);
});

test('dual-depth x264 uses both requested output depths',async()=>{
 const ctx=await context('x264'),result=await trial({...input,file:sources[8],encoder:'libx264'},ctx);
 assert.deepEqual(result.rows.map(r=>r.bitDepth),[8,10]);assert.ok(result.rows.every(r=>r.metrics.psnr.values.length===2));
});

test('dual-depth AV1 records the selected cpu-used and both output depths',async()=>{
 const ctx=await context('av1'),result=await trial({...input,file:sources[8],encoder:'libaom-av1',cpuUsed:8},ctx);
 assert.deepEqual(result.rows.map(r=>r.bitDepth),[8,10]);assert.ok(result.rows.every(r=>r.preset==='cpu-used=8'&&r.metrics.ssim.values.length===2));
});

test('failure never deletes a previously retained reference',async()=>{
 const ctx=await context('existing'),file=path.join(ctx.cwd,'reference.mkv');await writeFile(file,'retained data');
 await assert.rejects(()=>trial({...input,file:sources[8]},ctx),/已存在/);assert.equal(await readFile(file,'utf8'),'retained data');
});
