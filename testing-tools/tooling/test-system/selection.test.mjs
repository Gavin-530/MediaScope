import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {caseCatalog,selectCases,validateCatalog,assessCases} from '../../helpers/case-catalog.mjs';
import {extensionTools,parseExtension,validateParameters} from '../../extensions/index.mjs';
import {browserPort,fetchBlocksPort} from '../../helpers/server.mjs';

test('[test-selection] browser port preparation distinguishes a real Fetch restriction from other failures',async()=>{
  let rejected;try{await fetch('http://127.0.0.1:10080')}catch(error){rejected=error}
  assert.equal(fetchBlocksPort(rejected),true);
  assert.equal(fetchBlocksPort(new Error('network failure')),false);
  const port=await browserPort();assert.ok(Number.isInteger(port)&&port>0);
});

test('[test-selection] module and case selection reject unknown or contradictory ranges',()=>{
  const selection=selectCases({modules:['bitrate']});
  assert.ok(selection.cases.length>1);assert.ok(selection.cases.every(c=>c.covers.includes('bitrate')));
  const first=selection.cases.find(c=>c.module==='bitrate'&&!c.covers.includes('siti'));
  assert.deepEqual(selectCases({cases:[first.id]}).caseIds,[first.id]);
  assert.throws(()=>selectCases({modules:['unknown']}),/Unknown module/);
  assert.throws(()=>selectCases({cases:['unknown']}),/Unknown case/);
  assert.throws(()=>selectCases({modules:['siti'],cases:[first.id]}),/No formal|outside/);
  assert.ok(selectCases({suite:'gpu'}).cases.every(c=>c.scope==='gpu'));
  assert.ok(selectCases().cases.every(c=>c.scope!=='gpu'));
  assert.ok(extensionTools.every(tool=>!caseCatalog.cases.some(c=>c.id===tool.id)));
});

test('[test-selection] missing duplicate skipped and unexpected actual cases cannot pass',()=>{
  const selection=selectCases({cases:[caseCatalog.cases[0].id]}),entry=selection.cases[0],event={caseId:entry.id,file:entry.file,name:entry.name,event:'test:pass'};
  assert.equal(assessCases(selection,[event]).accepted,true);
  for(const actual of [[],[event,event],[{...event,caseId:undefined}],[{...event,skip:'environment'}],[{...event,event:'test:fail'}],[event,{...event,name:'undeclared'}]])assert.equal(assessCases(selection,actual).accepted,false);
  const duplicate=structuredClone(caseCatalog);duplicate.cases.push(duplicate.cases[0]);assert.throws(()=>validateCatalog(duplicate),/duplicate case ID/);
});

test('[test-selection] a selected native run executes one registered case without skipped placeholders',async t=>{
  const entry=caseCatalog.cases.find(c=>c.file==='testing-tools/modules/bitrate/bitrate-model.test.mjs');
  await fs.mkdir(workRoot,{recursive:true});const directory=await fs.mkdtemp(workPath('selection-'));
  t.after(async()=>{assert.equal(path.dirname(directory),workRoot);await fs.rm(directory,{recursive:true,force:true})});
  const file=path.join(directory,'selection.json');await fs.writeFile(file,JSON.stringify({caseIds:[entry.id]}));
  const env={...process.env,MEDIASCOPE_TEST_SELECTION:file,MEDIASCOPE_OBSERVATIONS:path.join(directory,'observations')};delete env.NODE_TEST_CONTEXT;
  const output=execFileSync(process.execPath,['--test','--test-reporter=tap',entry.file],{env,encoding:'utf8',windowsHide:true});
  assert.match(output,/# tests 1\r?\n/);assert.match(output,/# skipped 0/);assert.ok(output.includes(entry.name));
  for(const other of caseCatalog.cases.filter(c=>c.file===entry.file&&c.id!==entry.id))assert.equal(output.includes(other.name),false);
});

test('[test-selection] extensions require an explicit tool and scale and reject unknown configuration',()=>{
  assert.deepEqual(parseExtension([]),{list:true});
  assert.throws(()=>parseExtension(['unknown']),/Unknown extension/);
  const tool=extensionTools.find(t=>t.id==='siti-frames');
  assert.throws(()=>validateParameters(tool,{}),/Explicit parameter/);
  assert.deepEqual(validateParameters(tool,{frames:3}),{frames:3,device:'cpu'});
  for(const frames of [0,-1,NaN,Infinity,1.5])assert.throws(()=>validateParameters(tool,{frames}),/Positive safe integer/);
  assert.throws(()=>validateParameters(tool,{frames:3,width:4}),/Unknown extension/);
  assert.throws(()=>parseExtension([tool.id,'--constructor','x']),/Unknown\/duplicate/);
});

test('[test-selection] CLI preview selects formal cases without allocating an execution or adding extensions',()=>{
  const output=execFileSync(process.execPath,['scripts/test.mjs','--module','bitrate','--dry-run'],{encoding:'utf8',windowsHide:true});
  const plan=JSON.parse(output);assert.equal(plan.scope,'formal');assert.equal(plan.extensionsIncluded,false);assert.ok(plan.selection.cases.every(c=>c.covers.includes('bitrate')));
  assert.throws(()=>execFileSync(process.execPath,['scripts/test.mjs','--release','--module','bitrate','--dry-run'],{encoding:'utf8',windowsHide:true,stdio:'pipe'}),/complete formal suite/);
});
