import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {artifactIdentity} from '../scripts/sync-github-test-evidence.mjs';
import {readableEvidenceName} from '../scripts/github-archive-evidence-names.mjs';
test('[test-system] archive migration and unified envelopes preserve failed evidence and reject drift',async()=>{
  await mkdir('test-work',{recursive:true});
  for(const actions of ['','true']){
    const work=await mkdtemp(path.resolve('test-work/archive-layout-'));
    const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/archive-layout-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,GITHUB_ACTIONS:actions}});
    assert.equal(output.split(/\r?\n/).filter(x=>x.startsWith('PASS:')).length,16,output);
  }
});
test('[test-system] sync separates reruns and rejects artifact/run identity mismatches',()=>{
  const a={name:'mediascope-test-evidence-123-1',workflow_run:{id:123,head_sha:'a'.repeat(40)}};
  assert.deepEqual(artifactIdentity(a),{runId:'123',attempt:'1',sha:'a'.repeat(40)});
  assert.equal(artifactIdentity({...a,name:'unrelated'}),null);
  assert.equal(artifactIdentity({...a,name:'mediascope-test-evidence-123-2'}).attempt,'2');
  assert.throws(()=>artifactIdentity({...a,workflow_run:{id:124}}),/identity mismatch/);
});
test('[test-system] collaborator import preserves provenance, deduplicates and rolls back catalog failures',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/local-import-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/local-import-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(output.split(/\r?\n/).filter(x=>x.startsWith('PASS:')).length,20,output);
});
test('[test-system] readable record names preserve sealed identities, recover interruptions and reject short-token collisions',async()=>{
  await mkdir('test-work',{recursive:true});
  const work=await mkdtemp(path.resolve('test-work/evidence-names-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/evidence-names-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(output.split(/\r?\n/).filter(x=>x.startsWith('PASS:')).length,5,output);
  for(const line of output.split(/\r?\n/).filter(x=>x.startsWith('NAME:'))){
    const [runId,name]=line.slice(5).split('=');
    assert.equal(readableEvidenceName({kind:'App',scope:'full',runId}),name);
  }
  for(const line of output.split(/\r?\n/).filter(x=>x.startsWith('LABEL:'))){
    const [fields,name]=line.slice(6).split('='),[kind,scope,label]=fields.split('|');
    assert.equal(readableEvidenceName({kind,scope,label,runId:'20261001T102030Z-abcd'}),name);
  }
  assert.throws(()=>readableEvidenceName({kind:'../escape',runId:'20261001T102030Z-abcd'}),/Invalid evidence kind/);
});
