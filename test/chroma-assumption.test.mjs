import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignment,resolveChromaAssumptions,validateComparableStreams} from '../engine.mjs';
import {parseReport} from '../public/report.js';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {FF,run} from '../engine.mjs';
import {startServer,waitForJob} from './helpers/server.mjs';

const stream=chroma_location=>({width:1920,height:1080,pix_fmt:'yuv420p',color_range:'tv',color_space:'bt709',color_transfer:'bt709',color_primaries:'bt709',chroma_location});

test('user assumption can supplement an unknown location without changing source metadata',()=>{
 const reference=stream(undefined),candidate=stream('left');
 assert.throws(()=>validateComparableStreams(reference,candidate),/chroma_location/);
 const resolved=resolveChromaAssumptions(reference,candidate,{reference:'left'});
 assert.equal(reference.chroma_location,undefined);
 assert.equal(resolved.reference.chroma_location,'left');
 assert.equal(resolved.candidate,candidate);
 assert.deepEqual(resolved.assumptions,[{side:'reference',declared:null,assumed:'left',source:'用户确认；未由文件或软件验证'}]);
 validateComparableStreams(resolved.reference,resolved.candidate);
 assert.equal(alignment(resolved.reference,resolved.candidate,[{t:0},{t:1}],[{t:0},{t:1}]).frames,2);
});

test('assumptions cannot override declared values or conceal a mismatch',()=>{
 assert.throws(()=>resolveChromaAssumptions(stream('center'),stream('left'),{reference:'left'}),/不能用用户确认覆盖/);
 const resolved=resolveChromaAssumptions(stream(undefined),stream('left'),{reference:'center'});
 assert.throws(()=>validateComparableStreams(resolved.reference,resolved.candidate),/chroma_location/);
 assert.throws(()=>resolveChromaAssumptions(stream(undefined),stream('left'),{reference:'bogus'}),/无效/);
 assert.throws(()=>resolveChromaAssumptions(stream(undefined),stream('left'),{}),/至少一路/);
});

test('saved real comparison preserves and validates assumption provenance',async()=>{
 const assumption={side:'reference',declared:null,assumed:'left',source:'用户确认；未由文件或软件验证'};
 const root=path.resolve('test-work/chroma-assumption');await mkdir(root,{recursive:true});
 const file=path.join(root,'undeclared.mkv'),commands=[];
 await run(FF,['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=4:duration=1','-c:v','ffv1','-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709',file],{commands});
 await writeFile(path.join(root,'fixture-recipe.json'),JSON.stringify({file,commands},null,2));
 const app=await startServer(path.join(root,'reports'));
 try {
  const job=await app.request('jobs','POST',{type:'compare',reference:file,candidate:file,refStream:0,candidateStream:0,metrics:['psnr'],confirm:true,chromaConfirmed:true,chromaAssumptions:{reference:'left',candidate:'left'}});
  const done=await waitForJob(app.request,job.id);assert.equal(done.status,'done',JSON.stringify(done));
  const report=await app.request(`jobs/${job.id}/report`);
  assert.deepEqual(parseReport(JSON.stringify(report)).chromaAssumptions,[assumption,{...assumption,side:'candidate'}]);
  assert.equal(report.metrics.psnr.pooled,'Infinity');
  assert.throws(()=>parseReport(JSON.stringify({...report,chromaAssumptions:[{...assumption,assumed:'arbitrary'}]})),/chromaAssumptions/);
 }finally{await app.stop()}
});
