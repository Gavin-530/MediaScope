import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {featureResults,releaseReadiness} from './helpers/test-results.mjs';

// Evidence protocol inputs only; these do not stand in for product/media results.
const coverage={features:[{id:'example',files:['test/a.test.mjs','test/browser.test.mjs'],names:'check'}]};
const passed=file=>({event:'test:pass',file,name:'check'});
test('[test-system] partial suites cannot label core plus browser coverage complete',()=>{
  const features=featureResults(coverage,[passed('test/a.test.mjs')],'core');
  assert.equal(features[0].status,'partial');assert.deepEqual(features[0].missingFiles,['test/browser.test.mjs']);
  assert.equal(releaseReadiness({tests:1,passed:1},features).ready,false);
});
test('[test-system] release checks reject skips, TODOs, cancellation and an empty feature map',()=>{
  const features=featureResults(coverage,coverage.features[0].files.map(passed),'full');
  assert.equal(releaseReadiness({tests:2,passed:2},features).ready,true);
  for(const field of ['failed','skipped','cancelled','todo'])assert.equal(releaseReadiness({tests:2,passed:1,[field]:1},features).ready,false);
  assert.equal(releaseReadiness({tests:1,passed:1},[]).ready,false);
});
test('[test-system] failure and skip statuses survive feature aggregation',()=>{
  assert.equal(featureResults(coverage,[],'browser')[0].status,'not-run');
  assert.equal(featureResults(coverage,[{...passed('test/browser.test.mjs'),skip:'historical feature absent'}],'browser')[0].status,'skipped');
  assert.equal(featureResults(coverage,[{...passed('test/a.test.mjs'),event:'test:fail'},passed('test/browser.test.mjs')],'full')[0].status,'failed');
});
test('[test-system] real filesystem validators reject changed fixtures, malformed identities and missing verifier evidence',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/test-system-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/evidence-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,5,output);
});
test('[test-system] cloud evidence import preserves failures, rejects tampering and cannot overwrite history',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/github-evidence-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/github-evidence-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,9,output);
});
