import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {featureResults,releaseReadiness,regressionAssessment,testSuiteFiles,sourceTestReadiness} from './helpers/test-results.mjs';
import {requireFeature,supportedThemeModes} from './helpers/feature-policy.mjs';

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
test('[test-system] current full regression uses the release gate even without --release',()=>{
  const features=featureResults(coverage,coverage.features[0].files.map(passed),'full');
  const counts={tests:2,passed:2};
  assert.equal(regressionAssessment(counts,features).status,'complete');
  assert.equal(regressionAssessment(counts,features).accepted,releaseReadiness(counts,features).ready);
  for(const field of ['failed','cancelled','skipped','todo']){
    const changed={...counts,[field]:1};
    assert.equal(regressionAssessment(changed,features).accepted,false,field);
    assert.equal(regressionAssessment(changed,features).accepted,releaseReadiness(changed,features).ready);
  }
  assert.equal(regressionAssessment(counts,[{...features[0],status:'partial'}]).accepted,false);
  assert.equal(regressionAssessment(counts,[]).accepted,false);
  const processFailure=regressionAssessment(counts,features,{processExitCode:1});
  assert.equal(processFailure.accepted,false);assert.equal(processFailure.status,'failed');assert.ok(processFailure.reasons.length);
});
test('[test-system] quick checks and historical comparisons cannot claim complete current regression',()=>{
  const counts={tests:2,passed:1,skipped:1},features=featureResults(coverage,[passed('test/a.test.mjs')],'core');
  for(const options of [{suite:'core'},{suite:'browser'},{suite:'full',historical:true}]){
    const result=regressionAssessment(counts,features,options);
    assert.equal(result.accepted,true);assert.equal(result.status,'incomplete');assert.ok(result.reasons.length);
    assert.equal(regressionAssessment({...counts,failed:1},features,options).accepted,false);
    assert.equal(regressionAssessment({...counts,cancelled:1},features,options).accepted,false);
    assert.equal(regressionAssessment({tests:1,passed:0,skipped:1},features,options).accepted,false);
    assert.equal(regressionAssessment({tests:1,passed:1},features,options).status,'partial');
  }
});

test('[test-system] general and GPU scopes require their own coverage and exact clean source acceptance',()=>{
  // Protocol inputs only; these are not GPU measurements or product acceptance.
  const names=['browser.test.mjs','siti-gpu.test.mjs','siti-gpu-hardware.test.mjs'];
  assert.deepEqual(testSuiteFiles(names,'full'),names.slice(0,2));
  assert.deepEqual(testSuiteFiles(names,'core'),['siti-gpu.test.mjs']);
  assert.deepEqual(testSuiteFiles(names,'gpu'),['siti-gpu-hardware.test.mjs']);
  const mapping={features:[...coverage.features,{id:'gpu',scope:'gpu',files:['test/siti-gpu-hardware.test.mjs'],names:'check'}]};
  const gpuFeatures=featureResults(mapping,[passed('test/siti-gpu-hardware.test.mjs')],'gpu');
  assert.deepEqual(gpuFeatures.map(f=>f.id),['gpu']);
  assert.equal(featureResults(mapping,coverage.features[0].files.map(passed),'full').length,1);
  const counts={tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0};
  const validation=regressionAssessment(counts,gpuFeatures,{suite:'gpu'});
  assert.equal(validation.mode,'gpu-regression');assert.equal(validation.status,'complete');assert.equal(validation.accepted,true);
  assert.equal(regressionAssessment(counts,[],{suite:'gpu'}).accepted,false);
  for(const field of ['failed','cancelled','skipped','todo'])assert.equal(regressionAssessment({...counts,[field]:1},gpuFeatures,{suite:'gpu'}).accepted,false);
  const commit='a'.repeat(40),version='0.2.10',identity={commit,sha256:'b'.repeat(64),workingTree:[]};
  const environment={executables:['node','ffmpeg','ffprobe'].map(name=>({name,sha256:'e'.repeat(64)}))};
  const general={scope:'full',version,outcome:'passed',exitCode:0,testSummary:counts,validation:{...validation,mode:'full-regression'},source:{...identity,kind:'working-tree'},harness:identity,environment,releaseCheck:{requested:true,ready:true}};
  const gpu={...general,scope:'gpu',validation,releaseCheck:{requested:false,ready:false}};
  const measurement={outcome:'passed',capability:{available:true,device:'protocol-only',selfTestMaxError:0},cases:[{maxError:0,cpu:{execution:{device:'cpu'}},gpu:{execution:{device:'gpu'}}}]};
  const check=(g=general,h=gpu,m=measurement)=>sourceTestReadiness(g,h,m,{commit,version}).ready;
  assert.equal(check(),true);
  assert.equal(check(general,null),false);
  assert.equal(check(general,{...gpu,source:{...gpu.source,commit:'c'.repeat(40)}}),false);
  assert.equal(check({...general,source:{...general.source,workingTree:[' M app.mjs']}}),false);
  assert.equal(check(general,{...gpu,harness:{...gpu.harness,sha256:'d'.repeat(64)}}),false);
  assert.equal(check(general,{...gpu,environment:{executables:[]}}),false);
  assert.equal(check(general,{...gpu,testSummary:{...counts,cancelled:1}}),false);
  assert.equal(check(general,gpu,{...measurement,capability:{available:false}}),false);
  assert.equal(check(general,gpu,{...measurement,cases:[{...measurement.cases[0],gpu:{execution:{device:'cpu'}}}]}),false);
  assert.equal(check(general,gpu,{...measurement,cases:[{...measurement.cases[0],maxError:0.02}]}),false);
});
test('[test-system] missing current UI features fail; only explicit historical sources may skip',()=>{
  const reasons=[],context={skip:reason=>reasons.push(reason)};
  assert.equal(requireFeature(context,true,'sidebar',{historical:false}),true);
  assert.throws(()=>requireFeature(context,false,'sidebar',{historical:false}),/Required current-version feature/);
  assert.deepEqual(reasons,[]);
  assert.equal(requireFeature(context,false,'sidebar',{historical:true}),false);
  assert.match(reasons[0],/^Not applicable to this historical source:/);
  assert.deepEqual(supportedThemeModes('dark',{historical:false}),['light','dark']);
  assert.deepEqual(supportedThemeModes('dark',{historical:true}),['dark']);
  assert.deepEqual(supportedThemeModes('normal',{historical:true}),[]);
});
test('[test-system] real filesystem validators protect cleanup boundaries and reject malformed legacy evidence',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/test-system-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/evidence-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,6,output);
});
test('[test-system] cloud evidence import preserves failures, rejects tampering and cannot overwrite history',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/github-evidence-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/github-evidence-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(output.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).length,12,output);
});
