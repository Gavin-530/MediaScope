import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pending=path.join(project,'evidence-archive','pending');
const options=process.argv.slice(2);
const automatic=options.includes('--automatic');
if(options.some(x=>!['--automatic'].includes(x)))throw Error('Unknown evidence sync argument');
export function artifactIdentity(artifact){
  const match=artifact.name?.match(/^mediascope-test-evidence-([1-9][0-9]*)-([1-9][0-9]*)$/);
  if(!match)return null;
  if(String(artifact.workflow_run?.id)!==match[1])throw Error('Artifact/run identity mismatch');
  if(!/^[a-f0-9]{40}$/.test(artifact.workflow_run.head_sha))throw Error('Artifact commit identity missing');
  return {runId:match[1],attempt:match[2],sha:artifact.workflow_run.head_sha};
}
function credential(){
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  if(token)return token;
  try{
    const output=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'},stdio:['pipe','pipe','pipe'],timeout:10000});
    return output.split(/\r?\n/).find(x=>x.startsWith('password='))?.slice(9);
  }catch{return undefined}
}
async function main(){
  if(process.env.GITHUB_ACTIONS==='true')return;
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/test-storage.ps1'),'-Action','Validate','-Source',pending],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await fs.mkdir(pending,{recursive:true});
  let lock;
  try{lock=await fs.open(path.join(pending,'sync.lock'),'wx')}catch(e){if(e.code==='EEXIST'){console.log('Evidence sync already running or interrupted; inspect pending/sync.lock.');return}throw e}
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  const started=Date.now();
  const repository='Gavin-530/MediaScope';
  const token=credential();
  const headers={'User-Agent':'MediaScope-evidence-sync','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{})};
  const api=async resource=>{
    if(Date.now()-started>(automatic?10000:120000))throw Error('Evidence sync time budget reached; resume later');
    const response=await fetch('https://api.github.com/repos/'+repository+'/'+resource,{headers,signal:AbortSignal.timeout(automatic?4000:20000)});
    if(!response.ok)throw Error('GitHub request failed: HTTP '+response.status);
    return response.json();
  };
  const statePath=path.join(pending,'sync-state.json');
  let previous={artifacts:{}};
  try{previous=JSON.parse(await fs.readFile(statePath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  const artifacts=[];
  const maxPages=automatic?1:20;
  let truncated=false;
  const sync={schema:1,repository,startedAt:new Date().toISOString(),artifacts:{...previous.artifacts},missing:[],imported:0,skipped:0,errors:[],scanTruncated:false};
  try{
    for(let page=1;page<=maxPages;page++){
      const data=await api('actions/artifacts?per_page=100&page='+page);
      artifacts.push(...data.artifacts);
      if(data.artifacts.length<100)break;
      if(page===maxPages)truncated=true;
    }
    const runs=[];
    for(let page=1;page<=maxPages;page++){
      const data=await api('actions/runs?status=completed&per_page=100&page='+page);
      runs.push(...data.workflow_runs);
      if(data.workflow_runs.length<100)break;
      if(page===maxPages)truncated=true;
    }
    for(const run of runs){
      if(run.path!=='.github/workflows/tests.yml')continue;
      const name='mediascope-test-evidence-'+run.id+'-'+run.run_attempt;
      if(!artifacts.some(x=>x.name===name))sync.missing.push({runId:String(run.id),attempt:String(run.run_attempt),sha:run.head_sha,conclusion:run.conclusion,reason:truncated?'not-found-in-scanned-pages':'no-evidence-artifact'});
    }
    for(const artifact of artifacts){
      const identity=artifactIdentity(artifact);if(!identity)continue;
      if(artifact.expired){sync.errors.push({artifactId:artifact.id,reason:'expired'});continue}
      if(!token){sync.errors.push({artifactId:artifact.id,reason:'authentication-required-for-download'});continue}
      const key=repository+'/'+identity.runId+'/'+identity.attempt;
      const known=sync.artifacts[key];
      if(known&&known.artifactId===artifact.id&&known.digest===artifact.digest){
        try{await fs.access(path.join(known.path,'SHA256SUMS.txt'));sync.skipped++;continue}catch{/* Missing local data must not be treated as saved. */}
      }
      if(automatic&&sync.imported>=1){truncated=true;break}
      const remoteRun=runs.find(x=>String(x.id)===identity.runId)||await api('actions/runs/'+identity.runId);
      // PR run head_sha may be the source branch while GITHUB_SHA is a merge commit.
      const expectedCommit=['push','workflow_dispatch','schedule'].includes(remoteRun.event)?remoteRun.head_sha:undefined;
      const data=await fetch('https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifact.id+'/zip',{headers,signal:AbortSignal.timeout(automatic?5000:60000)});
      if(!data.ok)throw Error('Artifact download failed: HTTP '+data.status);
      const dir=path.join(pending,'downloads',String(artifact.id)+'-'+randomUUID().slice(0,8));
      await fs.mkdir(dir,{recursive:true});
      const zip=path.join(dir,'artifact.zip');
      await fs.writeFile(path.join(dir,'github-metadata.json'),JSON.stringify({artifact,run:remoteRun},null,2)+'\n');
      const hash=createHash('sha256');let stored=0;
      await pipeline(Readable.fromWeb(data.body),new Transform({transform(chunk,encoding,callback){
        stored+=chunk.length;
        if(stored>3*1024**3){callback(Error('Artifact exceeds 3 GiB transport limit'));return}
        hash.update(chunk);callback(null,chunk);
      }}),createWriteStream(zip,{flags:'wx'}));
      const digest='sha256:'+hash.digest('hex');
      if(artifact.digest&&artifact.digest!==digest)throw Error('Downloaded artifact digest mismatch');
      const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/import-github-test-evidence.ps1'),'-Archive',zip,'-Repository',repository,'-RunId',identity.runId,'-Attempt',identity.attempt,...(expectedCommit?['-Commit',expectedCommit]:[])],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
      const saved=output.trim();
      const record=JSON.parse(await fs.readFile(path.join(saved,'record.json'),'utf8'));
      sync.artifacts[key]={artifactId:artifact.id,digest,path:saved,runHeadSha:remoteRun.head_sha,testedSha:record.github.sha,importedAt:new Date().toISOString()};
      sync.imported++;
    }
    sync.scanTruncated=truncated;
  }catch(e){sync.errors.push({reason:e.message});if(!automatic)process.exitCode=1}
  finally{
    sync.finishedAt=new Date().toISOString();
    const candidate=statePath+'.'+randomUUID()+'.tmp';
    await fs.writeFile(candidate,JSON.stringify(sync,null,2)+'\n');
    await fs.rename(candidate,statePath);
    await lock.close();await fs.unlink(path.join(pending,'sync.lock'));
  }
  console.log('Evidence sync: '+sync.imported+' imported, '+sync.skipped+' already saved, '+sync.missing.length+' runs without a located artifact, '+sync.errors.length+' errors'+(sync.scanTruncated?' (partial scan)':'')+'.');
  if(sync.errors.length){console.error(sync.errors.map(x=>x.reason).join('\n'));if(!automatic)process.exitCode=1}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main().catch(e=>{console.error('Evidence sync: '+e.message);if(!automatic)process.exitCode=1});
