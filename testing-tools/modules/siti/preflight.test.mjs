import {mkdir,mkdtemp,utimes} from 'node:fs/promises';
import path from 'node:path';
import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {FF,run,probe} from '../../helpers/subject.mjs';
import {startServer,waitForJob} from '../../helpers/server.mjs';
import {sitiInput,createSitiRangeReader,sitiFormat,sitiRawBytes} from '../../../public/siti.js';
import {preflightSitiLuma,sitiPreflightEligibility} from '../../../siti-preflight.mjs';

async function directory(){await mkdir(workRoot,{recursive:true});return mkdtemp(workPath('siti-preflight-'))}
async function makeVideo(folder,name,{pixFmt='gray',width=64,height=64,frames=6,expression='128',chroma=null}={}){
  const filter=`nullsrc=s=${width}x${height}:r=8,format=${pixFmt},geq=lum='${expression}'${chroma==null?'':`:cb='${chroma}':cr='${chroma}'`},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,setfield=prog`;
  const file=path.join(folder,name);
  await run(FF,['-v','error','-y','-f','lavfi','-i',filter,'-frames:v',String(frames),'-c:v','ffv1','-level','3','-pix_fmt',pixFmt,'-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',file],{});
  return file;
}
async function streamOf(file){return (await probe(file,{})).raw.streams.find(s=>s.codec_type==='video')}
const settings={range:'tv',transfer:'sdr'};

test('SI/TI luma range preflight decodes full tracks, stops at a valid hit, and rejects ineligible input',{timeout:60000},async t=>{
  const folder=await directory(),clean=await makeVideo(folder,'clean.mkv',{expression:'if(eq(N,0),16,235)'}),hit=await makeVideo(folder,'hit.mkv',{expression:'if(gte(N,2),240,16)'}),
    late=await makeVideo(folder,'late.mkv',{expression:'if(eq(N,5),240,16)'}),high10=await makeVideo(folder,'high10.mkv',{pixFmt:'yuv420p10le',chroma:512,expression:'if(gte(N,2),941,64)'}),
    low10=await makeVideo(folder,'low10.mkv',{pixFmt:'yuv420p10le',chroma:512,expression:'if(gte(N,2),63,64)'}),edge12=await makeVideo(folder,'edge12.mkv',{pixFmt:'yuv420p12le',chroma:2048,expression:'if(eq(N,0),256,3760)'}),
    high12=await makeVideo(folder,'high12.mkv',{pixFmt:'yuv420p12le',chroma:2048,expression:'if(gte(N,2),3761,256)'}),chromaOnly=await makeVideo(folder,'chroma.mkv',{pixFmt:'yuv420p10le',chroma:1023,expression:'64'}),
    long=await makeVideo(folder,'long.mkv',{pixFmt:'yuv420p',width:320,height:180,frames:600,expression:'64'});
  const runFor=async(file,extra={})=>preflightSitiLuma(file,await streamOf(file),{sitiSettings:settings,...extra});

  // Full decode is the only source of an in-range conclusion; endpoints are valid.
  const complete=await runFor(clean);
  assert.equal(complete.status,'in-range');assert.equal(complete.framesScanned,6);assert.equal(complete.firstOutOfRange,null);assert.deepEqual(complete.nominalRange,{min:16,max:235});
  assert.equal((await runFor(edge12)).status,'in-range');
  assert.equal((await runFor(chromaOnly)).status,'in-range','chroma must not become a luma hit');

  // A valid frame stops the scan early and records the actual frame and code.
  const early=await runFor(hit);
  assert.equal(early.status,'out-of-range');assert.equal(early.framesScanned,3);assert.deepEqual({frame:early.firstOutOfRange.frame,code:early.firstOutOfRange.code},{frame:2,code:240});
  assert.deepEqual(early.metadataVerification.frames,3);
  const nearEnd=await runFor(late);
  assert.equal(nearEnd.status,'out-of-range');assert.equal(nearEnd.framesScanned,6);assert.equal(nearEnd.firstOutOfRange.frame,5);
  assert.equal((await runFor(high10)).firstOutOfRange.code,941);
  assert.equal((await runFor(low10)).firstOutOfRange.code,63);
  assert.equal((await runFor(high12)).firstOutOfRange.code,3761);
  assert.deepEqual((await runFor(edge12)).nominalRange,{min:256,max:3760});

  // The shared reader retains native layout, padding and opaque-alpha checks.
  const input=(pixFmt,extra={})=>sitiInput({pix_fmt:pixFmt,color_range:'tv',color_transfer:'bt709',field_order:'progressive',...extra},settings);
  const gray=input('gray'),reader=createSitiRangeReader(gray,4,4);
  assert.equal(reader.scan(Buffer.alloc(16,16)).outside,false);assert.equal(reader.scan(Buffer.alloc(16,235)).outside,false);
  assert.equal(reader.scan(Buffer.alloc(16,236)).firstOutOfRange.code,236);
  const tenReader=createSitiRangeReader(input('p010le'),4,4),raw=Buffer.alloc(tenReader.bytes);
  for(let i=0;i<32;i+=2)raw.writeUInt16LE(64<<6,i);
  for(let i=32;i<raw.length;i+=2)raw.writeUInt16LE(512<<6,i);
  assert.equal(tenReader.scan(raw).outside,false);
  for(let i=0;i<16;i++)raw.writeUInt16LE(941<<6,i*2);
  assert.equal(tenReader.scan(raw).firstOutOfRange.code,941);
  assert.equal(tenReader.scan(raw).firstOutOfRange.sample,0);
  const padded=Buffer.from(raw);padded.writeUInt16LE((64<<6)|1,0);
  assert.throws(()=>tenReader.scan(padded),/填充位/);
  const planarReader=createSitiRangeReader(input('yuv420p10le'),4,4),overDepth=Buffer.alloc(planarReader.bytes);
  overDepth.writeUInt16LE(1024,0);
  assert.throws(()=>planarReader.scan(overDepth),/超出位深/);
  const alphaRaw=Buffer.alloc(sitiRawBytes(sitiFormat('yuva420p'),4,4),16);alphaRaw.fill(255,24);
  const alphaReader=createSitiRangeReader(input('yuva420p'),4,4);
  assert.equal(alphaReader.scan(alphaRaw).outside,false);alphaRaw[24]=254;assert.throws(()=>alphaReader.scan(alphaRaw),/Alpha/);

  // Only fixed, progressive, limited-range 8/10/12-bit SDR luma is eligible.
  const eligible=(over={},s=settings)=>sitiPreflightEligibility({pix_fmt:'gray',color_range:'tv',color_transfer:'bt709',field_order:'progressive',width:64,height:64,...over},s).applicable;
  assert.equal(eligible(),true);
  for(const [over,s] of [[{color_transfer:'smpte2084'},{}],[{color_range:'pc'},{}],[{pix_fmt:'gbrp'},{range:'tv',transfer:'sdr',matrix:'bt709'}],[{pix_fmt:'yuv420p9le'},settings],[{pix_fmt:'yuv420p14le'},settings],[{pix_fmt:'yuv420p16le'},settings],[{field_order:'tt'},settings],[{field_order:'tt'},{interlaced:'bwdif'}],[{color_range:'unknown',color_transfer:'unknown'},{}]])assert.equal(eligible(over,s),false,JSON.stringify([over,s]));

  // Cancellation reaps the decoder and a later full check still succeeds.
  const controller=new AbortController();let progressed=0;
  await assert.rejects(preflightSitiLuma(long,await streamOf(long),{sitiSettings:settings,signal:controller.signal,update:({framesScanned})=>{progressed=framesScanned;if(framesScanned===3)controller.abort();}}),e=>e.code==='SITI_PREFLIGHT_CANCELLED');
  assert.ok(progressed>=3);
  const recovered=await runFor(long);assert.equal(recovered.status,'in-range');assert.equal(recovered.framesScanned,600);
  assert.equal(t.signal.aborted,false);
});

function ndjson(text){
  const events=text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {events,result:events.find(event=>event.event==='result')};
}
async function preflight(app,body){
  const response=await fetch(app.base+'/api/siti-preflight',{method:'POST',headers:{'x-mediascope-token':app.token,'content-type':'application/json'},body:JSON.stringify(body)});
  const text=await response.text();
  return {status:response.status,text,...ndjson(text)};
}
function evidenceFor(result,track=0){return {status:'out-of-range',signature:result.signature,framesScanned:result.framesScanned,checkedAt:new Date().toISOString(),track,settingsKey:JSON.stringify(['tv','sdr','reject','auto',null,null])}}

test('SI/TI range preflight API streams progress and a signed clip conclusion into one report',{timeout:90000},async()=>{
  const folder=await directory(),file=await makeVideo(folder,'api-hit.mkv',{expression:'if(gte(N,2),240,16)'}),app=await startServer(path.join(folder,'reports'));
  try{
    const first=await preflight(app,{file,stream:0,sitiSettings:settings});
    assert.equal(first.status,200);
    assert.equal(first.events[0].event,'start');assert.deepEqual(first.events[0].nominalRange,{min:16,max:235});
    assert.ok(first.events.some(event=>event.event==='progress'&&event.framesScanned>=1));
    assert.equal(first.result.status,'out-of-range');assert.equal(first.result.firstOutOfRange.frame,2);assert.ok(first.result.signature);
    const notApplicable=await preflight(app,{file,stream:0,sitiSettings:{range:'pc',transfer:'sdr'}});
    assert.equal(notApplicable.result.status,'not-applicable');

    const evidence=evidenceFor(first.result),clipSettings={...settings,rangeTreatment:'clip-nominal'};
    const job=await app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,frameAnalysis:true,bitrate:true,complexity:true,sitiSettings:clipSettings,sitiPreflight:evidence});
    await app.request('queue','POST',{action:'start'});
    const done=await waitForJob(app.request,job.id);assert.equal(done.status,'done',done.message);
    const report=await app.request('jobs/'+job.id+'/report');
    assert.deepEqual(report.analysisTargets,{frames:true,bitrate:true,complexity:true});
    assert.equal(report.frames.length,6);assert.ok(report.packets);
    assert.equal(report.content.available,true);assert.equal(report.content.execution.configuration.configurationVersion,9);
    assert.equal(report.content.execution.configuration.rangeTreatment,'clip-nominal');assert.deepEqual(report.content.execution.configuration.nominalRange,{min:16,max:235});
    assert.ok(report.content.notes.some(text=>/按有限范围标称黑白端点裁剪后计算/.test(text)));

    const strictJob=await app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,frameAnalysis:true,bitrate:true,complexity:true,sitiSettings:settings});
    await app.request('queue','POST',{action:'start'});
    const strictDone=await waitForJob(app.request,strictJob.id);assert.equal(strictDone.status,'done',strictDone.message);
    const strictReport=await app.request('jobs/'+strictJob.id+'/report');
    assert.equal(strictReport.content.available,false);assert.equal(strictReport.content.errorCode,'luma-outside-nominal');
    assert.equal(strictReport.frames.length,6);assert.ok(strictReport.packets);
    assert.equal((await app.request('status')).jobs.filter(job=>job.status==='done').length,2,'clipping must not create a retry task');
  }finally{await app.stop()}
});

test('SI/TI range preflight evidence rejects stale files and plans retain the explicit clipping setting',{timeout:90000},async()=>{
  const folder=await directory(),file=await makeVideo(folder,'plan-hit.mkv',{expression:'if(gte(N,2),240,16)'}),app=await startServer(path.join(folder,'reports'));
  try{
    const result=(await preflight(app,{file,stream:0,sitiSettings:settings})).result,evidence=evidenceFor(result),clipSettings={...settings,rangeTreatment:'clip-nominal'};
    await assert.rejects(app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,complexity:true,sitiSettings:clipSettings,sitiPreflight:{...evidence,signature:evidence.signature+'x'}}),/源文件在预检后已变化/);
    await assert.rejects(app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,complexity:true,sitiSettings:clipSettings,sitiPreflight:{...evidence,settingsKey:'other'}}),/预检证据与当前输入设置不一致/);
    await assert.rejects(app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,complexity:true,sitiSettings:clipSettings,sitiPreflight:{...evidence,frame:0}}),/预检证据无效|未知参数/);
    await assert.rejects(app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,complexity:true,sitiSettings:settings,sitiPreflight:evidence}),/只能随标称范围裁剪提交/);

    await app.request('queue','POST',{action:'pause'});
    const queued=await app.request('jobs','POST',{type:'analyze',enqueue:true,file,stream:0,frameAnalysis:true,bitrate:true,complexity:true,sitiSettings:clipSettings,sitiPreflight:evidence});
    const plans=await app.request('plans');
    const plan=plans.plans.find(entry=>entry.entryId===queued.id);
    assert.equal(plan.input.sitiSettings.rangeTreatment,'clip-nominal');assert.equal(plan.input.sitiPreflight.signature,evidence.signature);
    await app.request('jobs/'+queued.id,'DELETE');
    const imported=await app.request('plans/import','POST',{mode:'append',start:false,plans:[{...plan,entryId:'imported-clip'}]});
    assert.equal(imported.imported,1);assert.equal(imported.queueRunning,false);
    // The file changes after enqueue: the stored conclusion must not clip it.
    const changed=new Date(Date.now()+2000);await utimes(file,changed,changed);
    await app.request('queue','POST',{action:'start'});
    const done=await waitForJob(app.request,imported.ids[0]);assert.equal(done.status,'done',done.message);
    const report=await app.request('jobs/'+imported.ids[0]+'/report');
    assert.ok(report.warnings.some(text=>/预检结论因源文件或轨道在入队后发生变化而失效/.test(text)));
    assert.equal(report.content.available,false);assert.equal(report.content.errorCode,'luma-outside-nominal');
    assert.equal(report.frames.length,6);assert.ok(report.packets);
  }finally{await app.stop()}
});
