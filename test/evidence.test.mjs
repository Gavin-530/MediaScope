import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {saveMeasurements,compactResults,criticalMeasurements} from '../scripts/test-evidence.mjs';

test('[test-system] archive contains measurements but excludes source, profiles and simulated archives',async()=>{
  await fs.mkdir('test-work',{recursive:true});
  const work=await fs.mkdtemp(path.resolve('test-work/independent-evidence-'));
  const generated=path.join(work,'generated'),evidence=path.join(work,'evidence');
  await fs.mkdir(evidence,{recursive:true});
  const inputs={
    'metrics-equivalence-Ab1234/measured-equivalence.json':{baseline:1.25,combined:1.25},
    'siti-parallel-Ab1234/serial.json':{si:[1,2],ti:[0,3]},
    'bitrate-equivalence-Ab1234/measured-equivalence.json':{outcome:'passed',tracks:[{exactEqual:true}]},
    'psnr.log':'n:1 mse_avg:0 psnr_avg:inf',
    'archive-layout-Ab1234/records/result.json':{protocol:'simulated'},
    'local-import-Ab1234/receipt.json':{protocol:'simulated'},
    'startup-desktop/desktop-profile/config.json':{cache:'discard'},
    'browser/01/browser-errors.json':['failure diagnostic'],
    'startup-desktop/owned-case/job/failure.json':{status:'error',message:'real task failure diagnostic'},
    'browser/01/README.md':'not test data',
    'browser/01/source.mjs':'not test data'
  };
  for(const [name,data] of Object.entries(inputs)){
    const file=path.join(generated,name);await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,typeof data==='string'?data:JSON.stringify(data));
  }
  assert.deepEqual(await saveMeasurements(generated,evidence),{measurements:4,diagnostics:0});
  const saved=JSON.parse(gunzipSync(await fs.readFile(path.join(evidence,'measurements.json.gz'))).toString());
  assert.equal(saved.entries.find(x=>x.path.startsWith('metrics-equivalence-')).data.combined,1.25);
  assert.equal(saved.entries.find(x=>x.path.startsWith('bitrate-equivalence-')).data.tracks[0].exactEqual,true);
  assert.deepEqual(await fs.readdir(evidence),['measurements.json.gz']);
  assert.deepEqual(await saveMeasurements(generated,evidence,{failed:true}),{measurements:4,diagnostics:2});
  assert.ok((await fs.stat(path.join(evidence,'diagnostics/browser/01/browser-errors.json.gz'))).size>0);
  assert.equal(JSON.parse(gunzipSync(await fs.readFile(path.join(evidence,'diagnostics/startup-desktop/owned-case/job/failure.json.gz'))).toString()).message,'real task failure diagnostic');
  assert.ok(work.startsWith(path.resolve('test-work')+path.sep));
  await fs.rm(work,{recursive:true,force:true});
});

test('[test-system] compact results distinguish skipped, TODO and cancelled cases from passes',()=>{
  const item={name:'protocol-only',file:'test/example.test.mjs',event:'test:pass'};
  const result=compactResults({},[item,{...item,skip:'unavailable'},{...item,todo:true},{...item,event:'test:fail',details:{error:{failureType:'cancelledByParent'}}}]);
  assert.deepEqual(result.cases.map(x=>x.status),['passed','skipped','todo','cancelled']);
});
test('[test-system] successful critical checks require retained measurement data',async()=>{
 const work=await fs.mkdtemp(path.resolve('test-work/independent-evidence-'));
 try {
  await assert.rejects(saveMeasurements(work,work,{requiredMeasurements:criticalMeasurements}),/Missing critical measurement evidence/);
  const data=path.join(work,'bitrate-equivalence-Ab1234');await fs.mkdir(data);
  await fs.writeFile(path.join(data,'measured-equivalence.json'),JSON.stringify({outcome:'passed'}));
  assert.equal((await saveMeasurements(work,work,{requiredMeasurements:criticalMeasurements})).measurements,1);
 } finally {assert.ok(work.startsWith(path.resolve('test-work')+path.sep));await fs.rm(work,{recursive:true,force:true})}
});

test('[test-system] compacted history preserves original claims and rejects missing data, changed counts and fabricated precision',async()=>{
  await fs.mkdir('test-work',{recursive:true});
  const work=await fs.mkdtemp(path.resolve('test-work/independent-evidence-'));
  try{
    const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/compacted-evidence.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.match(output,/PASS: compacted historical identity/);
  }finally{await fs.rm(work,{recursive:true,force:true})}
});

test('[test-system] records survive deletion, missing caches, isolated copies and actual import/export',async()=>{
  await fs.mkdir('test-work',{recursive:true});
  const work=await fs.mkdtemp(path.resolve('test-work/independent-evidence-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/independent-evidence.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,7,output);
});
