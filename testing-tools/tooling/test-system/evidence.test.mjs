import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gunzipSync,gzipSync} from 'node:zlib';
import {saveMeasurements,compactResults,criticalMeasurements} from '../../../scripts/test-evidence.mjs';

test('[test-system] archive contains measurements but excludes source, profiles and simulated archives',async()=>{
  await fs.mkdir(workRoot,{recursive:true});
  const work=await fs.mkdtemp(workPath('independent-evidence-'));
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
  assert.ok(work.startsWith(workRoot+path.sep));
  await fs.rm(work,{recursive:true,force:true});
});

test('[test-system] compact results distinguish skipped, TODO and cancelled cases from passes',()=>{
  const item={name:'protocol-only',file:'testing-tools/example.test.mjs',event:'test:pass'};
  const result=compactResults({},[item,{...item,skip:'unavailable'},{...item,todo:true},{...item,event:'test:fail',details:{error:{failureType:'cancelledByParent'}}}]);
  assert.deepEqual(result.cases.map(x=>x.status),['passed','skipped','todo','cancelled']);
});
test('[test-system] successful critical checks require retained measurement data',async()=>{
 const work=await fs.mkdtemp(workPath('independent-evidence-'));
 try{
  const unique=new Map();
  for(const requirement of criticalMeasurements){
   const sample=requirement.pathPattern.source.replace(/^\^|\$$/g,'').replaceAll('[A-Za-z0-9]{6}','Ab1234').replace(/\\(.)/g,'$1');
   assert.ok(requirement.pathPattern.test(sample),'Artifact needs a reproducible protocol sample: '+sample);unique.set(sample,requirement);
  }
  for(const [sample]of unique){
   await assert.rejects(saveMeasurements(work,work,{requiredMeasurements:criticalMeasurements}),/Missing critical measurement evidence/);
   const file=path.resolve(work,sample);assert.ok(file.startsWith(work+path.sep));await fs.mkdir(path.dirname(file),{recursive:true});
   const bytes=Buffer.from(JSON.stringify({role:'Evidence protocol fixture only, not media measurements',outcome:'passed'}));
   await fs.writeFile(file,sample.endsWith('.gz')?gzipSync(bytes):bytes);
  }
  assert.equal((await saveMeasurements(work,work,{requiredMeasurements:criticalMeasurements})).measurements,unique.size);
 }finally{assert.equal(path.dirname(work),workRoot);await fs.rm(work,{recursive:true,force:true})}
});

test('[test-system] compacted history preserves original claims and rejects missing data, changed counts and fabricated precision',async()=>{
  await fs.mkdir(workRoot,{recursive:true});
  const work=await fs.mkdtemp(workPath('independent-evidence-'));
  try{
    const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/tooling/test-system/tools/compacted-evidence.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
    assert.match(output,/PASS: compacted historical identity/);
  }finally{await fs.rm(work,{recursive:true,force:true})}
});

test('[test-system] records survive deletion, missing caches, isolated copies and actual import/export',async()=>{
  await fs.mkdir(workRoot,{recursive:true});
  const work=await fs.mkdtemp(workPath('independent-evidence-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/tooling/test-system/tools/independent-evidence.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,7,output);
});
