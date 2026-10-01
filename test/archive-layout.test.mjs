import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {artifactIdentity} from '../scripts/sync-github-test-evidence.mjs';
test('[test-system] archive migration and unified envelopes preserve failed evidence and reject drift',async()=>{
  await mkdir('test-work',{recursive:true});
  for(const actions of ['','true']){
    const work=await mkdtemp(path.resolve('test-work/archive-layout-'));
    const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/archive-layout-protocol.ps1'),'-Work',work],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,GITHUB_ACTIONS:actions}});
    assert.equal(output.split(/\r?\n/).filter(x=>x.startsWith('PASS:')).length,14,output);
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
  assert.equal(output.split(/\r?\n/).filter(x=>x.startsWith('PASS:')).length,13,output);
});
