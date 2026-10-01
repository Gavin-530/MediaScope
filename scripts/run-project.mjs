import {spawnSync,spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.GITHUB_ACTIONS!=='true'&&process.env.MEDIASCOPE_SKIP_EVIDENCE_SYNC!=='1'){
  const sync=spawnSync(process.execPath,[path.join(project,'scripts/sync-github-test-evidence.mjs'),'--automatic'],{cwd:project,stdio:'inherit',windowsHide:true});
  if(sync.error)console.error('Evidence sync deferred: '+sync.error.message);
}
const [entry,...args]=process.argv.slice(2);
if(!['start','test'].includes(entry))throw Error('Entry must be start or test');
const target=entry==='start'?'server.mjs':'scripts/test.mjs';
const child=spawn(process.execPath,[path.join(project,target),...args],{cwd:project,stdio:'inherit',windowsHide:true});
child.on('error',e=>{console.error(e.message);process.exitCode=2});
child.on('exit',code=>{process.exitCode=code??2});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill(signal)});
