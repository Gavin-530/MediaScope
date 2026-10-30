import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makePortable,parsePortable} from '../public/portable.js';
import {repeatReportFixture} from './helpers/repeat-report-fixture.mjs';

const save=(report,extra={})=>makePortable({results:[{entryId:'fixture',report}],applicationVersion:'protocol-test',...extra});
const read=value=>parsePortable(JSON.stringify(value));

test('[portable-repeat] legacy 0.4 and draft 0.5 method-1/2 data retain their original evidence',()=>{
  for(const version of [1,2])for(const formatVersion of ['0.4','0.5']){
    const report=repeatReportFixture({version}),wire={...save(report),formatVersion};delete wire.requires;
    assert.deepEqual(read(wire).results[0].report,report);
    const exported=makePortable({...read(wire),applicationVersion:'new-exporter'});assert.equal(exported.formatVersion,'0.5');
    assert.deepEqual(read(exported).results[0].report,report);assert.deepEqual(exported.requires,['repeat/'+version]);
    assert.equal(Object.hasOwn(report.repeatAnalysis,'fingerprint'),false);
  }
});

test('[portable-repeat] shared generic descriptors preserve SHA-256 SHA-512 and SHA3-256 in hex and base64',()=>{
  for(const algorithm of ['sha256','sha512','sha3-256'])for(const encoding of ['hex','base64']){
    const report=repeatReportFixture({algorithm,encoding}),wire=save(report);
    assert.deepEqual(read(wire).results[0].report,report);assert.deepEqual(wire.requires,['frame-digest/1','repeat/2']);
    const r=wire.results[0].report.repeatAnalysis;assert.equal(r.constant.segments.count,1);
    assert.equal(r.frames.columns.includes('fingerprint'),false);assert.equal(r.frames.columns.includes('sha256'),false);
    assert.equal(report.repeatAnalysis.exact.duplicates,3);assert.equal(report.repeatAnalysis.frames[3].equalPrevious,false);
  }
});

test('[portable-repeat] unknown declared digests are preserved as data while unsupported required capabilities fail closed',()=>{
  const report=repeatReportFixture({algorithm:'sha256'}),r=report.repeatAnalysis;
  r.fingerprint.algorithm='example/future-256';r.fingerprint.parameters={seed:'18446744073709551615',variant:'reference-a'};
  r.extensions={example:{display:'preserve only'}};
  report.extensions={example:{note:'original source',values:[1,null,'text']}};report.requires=['frame-digest/1'];
  const wire=save(report);
  assert.deepEqual(read(wire).results[0].report,report);
  const exported=makePortable({...read(wire),applicationVersion:'next'});assert.deepEqual(exported.results,wire.results);
  assert.throws(()=>read({...wire,requires:['example/future-validation/9']}),/必需能力/);
  assert.throws(()=>save(report,{requires:['example/future-validation/9']}),/必需能力/);
});

test('[portable-repeat] a generic profile rejects mismatched lengths mixed fields wrong inputs and malformed encodings',()=>{
  const report=repeatReportFixture({algorithm:'sha256'});
  for(const damage of [r=>r.fingerprint.version=2,r=>r.fingerprint.bits=128,r=>r.fingerprint.parameters={seed:1},r=>r.fingerprint.input='scaled-rgb',r=>r.algorithm='FFmpeg/rawvideo/framehash/SHA256',r=>r.frames[0].sha256=r.frames[0].digest,r=>r.frames[0].digest=r.frames[0].digest.toUpperCase(),r=>r.frames[0].digest=r.frames[0].digest.slice(1),r=>r.frames[0].equalPrevious=true,r=>r.configurationVersion=3]){
    const broken=structuredClone(report);damage(broken.repeatAnalysis);assert.throws(()=>save(broken));
  }
  const base64=repeatReportFixture({algorithm:'sha256',encoding:'base64'});
  const canonical=base64.repeatAnalysis.frames[0].digest,alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',nonzeroPadBits=canonical.slice(0,-2)+alphabet[alphabet.indexOf(canonical.at(-2))+1]+'=';
  for(const digest of ['A'.repeat(44),canonical.replace(/=+$/,''),'!'.repeat(44),nonzeroPadBits]){
    const broken=structuredClone(base64);broken.repeatAnalysis.frames[0].digest=digest;assert.throws(()=>save(broken));
  }
});

test('[portable-repeat] equal frames require matching digests but a digest collision does not override direct comparison',()=>{
  const report=repeatReportFixture({algorithm:'sha256'}),broken=structuredClone(report);
  broken.repeatAnalysis.frames[1].digest='f'.repeat(64);assert.throws(()=>save(broken),/摘要不一致/);
  // Protocol collision boundary only, not a claimed SHA collision or media measurement.
  report.repeatAnalysis.fingerprint.algorithm='example/collision-control';for(const f of report.repeatAnalysis.frames)f.digest='0'.repeat(64);
  const restored=read(save(report)).results[0].report;assert.equal(restored.repeatAnalysis.exact.duplicates,3);assert.equal(restored.repeatAnalysis.frames[3].equalPrevious,false);
});

test('[portable-repeat] constant interval tables and integer evidence cannot be dropped or silently changed',()=>{
  const wire=save(repeatReportFixture({algorithm:'sha512'}));
  for(const damage of [r=>r.constant.segments.count++,r=>delete r.differenceSummary,r=>r.exact.duplicates++,r=>r.differenceConfiguration.fields.reverse(),r=>delete r.source.contentSha256]){
    const broken=structuredClone(wire);damage(broken.results[0].report.repeatAnalysis);assert.throws(()=>read(broken));
  }
});

test('[portable-repeat] generic execution identities allow extra roles without removing source and base tool evidence',()=>{
  const report=repeatReportFixture({algorithm:'sha256'});report.repeatAnalysis.tools.push({role:'gpu-kernel',path:'protocol-fixture/kernel',sha256:'2'.repeat(64)});
  assert.deepEqual(read(save(report)).results[0].report,report);
  for(const damage of [r=>r.tools.push(r.tools[0]),r=>r.tools.shift()]){const broken=structuredClone(report);damage(broken.repeatAnalysis);assert.throws(()=>save(broken),/工具身份/);}
});

test('[portable-repeat] optional metadata rejects values that JSON would lose and enforces a bounded structure',()=>{
  const report=repeatReportFixture();
  const cycle={};cycle.self=cycle;
  const accessor={};Object.defineProperty(accessor,'value',{enumerable:true,get(){throw Error('must not execute');}});
  const hidden=[];Object.defineProperty(hidden,'lost',{value:1});
  class CustomArray extends Array{toJSON(){throw Error('must not execute');}}
  const cases=[{value:undefined},{value:NaN},{value:1n},{value:new Date()},cycle,{value:Array(2)},{value:hidden},{value:new CustomArray(1)},accessor,JSON.parse('{"__proto__":1}')];
  for(const extensions of cases)assert.throws(()=>save({...report,extensions}));
  let deep={};for(let i=0;i<18;i++)deep={child:deep};assert.throws(()=>save({...report,extensions:deep}),/预算/);
  const unknown=save(report);unknown.requires=['repeat/2','repeat/2'];assert.throws(()=>read(unknown),/必需能力/);
});
