import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=workPath('process-observer');
test('[basic-properties] memory observer retains fast child exit codes and both output streams',async()=>{
  const folder=path.join(root,'observer-exit-status');await mkdir(folder,{recursive:true});
  const statuses=[0,7,0,7,0,7,0,7];
  const commands=statuses.map((status,i)=>({exe:process.execPath,cwd:folder,args:['-e',`process.stdout.write('out-${i}');process.stderr.write('err-${i}');process.exit(${status})`]}));
  const input=path.join(folder,'input.json'),output=path.join(folder,'output.json');
  await writeFile(input,JSON.stringify(commands));
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/helpers/probe-memory.ps1'),'-InputPath',input,'-OutputPath',output],{windowsHide:true,timeout:60000});
  const rows=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));
  assert.deepEqual(rows.map(row=>row.exitCode),statuses,'nonzero exits must never be replaced with success');
  for(let i=0;i<statuses.length;i++){
    assert.equal(await readFile(path.join(folder,`memory-${i}.stdout`),'utf8'),`out-${i}`);
    assert.equal(await readFile(path.join(folder,`memory-${i}.stderr`),'utf8'),`err-${i}`);
  }
});
