import {test} from 'node:test';
import assert from 'node:assert/strict';
import {alignment,resolveChromaAssumptions,validateComparableStreams} from '../engine.mjs';
import {parseReport} from '../public/report.js';

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

test('saved comparison preserves and validates assumption provenance',()=>{
 const assumption={side:'reference',declared:null,assumed:'left',source:'用户确认；未由文件或软件验证'};
 const report={schema:'MediaScope/0.2',type:'compare',reference:{file:'reference.mp4'},candidate:{file:'candidate.mp4'},alignment:{frames:1},metrics:{psnr:{values:[42]}},chromaAssumptions:[assumption]};
 assert.deepEqual(parseReport(JSON.stringify(report)).chromaAssumptions,[assumption]);
 assert.throws(()=>parseReport(JSON.stringify({...report,chromaAssumptions:[{...assumption,assumed:'arbitrary'}]})),/chromaAssumptions/);
});
