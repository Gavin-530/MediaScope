import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

test('[desktop-startup] actual Windows JSON replacement waits for a reader and preserves state on persistent locks',()=>{
  const result=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('test/helpers/deployment-json.ps1'),'-DeploymentScript',path.resolve('scripts/deployment.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000});
  const evidence=JSON.parse(result.trim());
  assert.equal(evidence.temporaryReader,'passed');
  assert.equal(evidence.persistentReader,'passed');
  assert.equal(evidence.noTemporaryFiles,true);
});
