import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {TARGET,now,seal,stable,writeJson,readJson,exists,fileHash,safeRelative,insideCleanup,verifySnapshot,hash} from './github-archive-store.mjs';
import {GitHubReader} from './github-archive-api.mjs';
import {importTransport,evidenceRecords} from './github-archive-migration.mjs';
import {latestInventory} from './github-archive-inventory.mjs';
import {repositoryGraphql} from './github-archive-graphql.mjs';

const numeric=value=>{if(!/^[1-9]\d*$/.test(String(value)))throw Error('Invalid platform numeric ID');return String(value)};
const sha=value=>{if(!/^[a-f0-9]{40}$/.test(value))throw Error('Invalid platform SHA');return value};
export function attachments(value){
  const found=new Set();function visit(v){if(typeof v==='string'){
    for(const u of v.match(/https:\/\/(?:user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|github\.com\/user-attachments)[^\s<>"\])]+/g)??[])found.add(u);
    for(const match of v.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^\s)>]+)>?(?:\s+[^)]*)?\)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi))found.add(match[1]??match[2]);
  }else if(v&&typeof v==='object')for(const x of Object.values(v))visit(x)}visit(value);
  return [...found].map(url=>({url,status:'not-downloaded',reason:'Attachment adapter not supported; offline dependency'}));
}
function redactHook(hook){const {config,...rest}=hook;const clean={...config};delete clean.secret;for(const k of Object.keys(clean)){if(/token|password|authorization/i.test(k))delete clean[k];if(k==='url'){try{const url=new URL(clean[k]);url.username='';url.password='';url.search='';clean[k]=url.href}catch{clean[k]='unavailable'}}}return {...rest,config:clean}}
export async function sync(project,root,{budgetMs,maxBytes,reader=new GitHubReader({root,budgetMs,maxBytes})}={}){
  const inventory=await latestInventory(project),repository=(await reader.get('')).data;
  if(String(repository.id)!==TARGET.repositoryId||repository.full_name!==TARGET.repository)throw Error('Remote repository ID/name mismatch');
  const report={format:1,...TARGET,captureStartedAt:now(),captureCompletedAt:null,atomicSnapshot:false,counts:{saved:0,unchanged:0,waiting:0,expired:0,missing:0,'no-permission':0,error:0},categories:{},gaps:[],queue:[],pages:reader.pages,addedBytes:0,downloadBytes:0,sourceHistory:'Only previously preserved history and currently retrievable observations; never all past GitHub changes'};
  const shas=new Set();
  report.countScope='source-content objects; sync receipt excluded';
  report.addedBytesScope='new sealed source objects; receipt bytes reported separately';
  const save=async(relative,files,meta={})=>{reader.remaining();const result=await seal(root,relative,files,{captureStartedAt:report.captureStartedAt,...meta});reader.remaining();report.counts[result.state]++;report.addedBytes+=result.bytes;return result};
  const gap=(category,identity,error)=>{const state=error.state??'error';report.counts[state]=(report.counts[state]??0)+1;report.gaps.push({category,identity,state,reason:error.message});return {state,reason:error.message}};
  const category=async(name,body)=>{
    report.categories[name]={scan:'in-progress',content:'incomplete'};report.queue.push(name);await writeJson(path.join(root,'pending','sync-checkpoint.json'),report);
    try{await body();report.categories[name].scan='complete';report.categories[name].content=report.gaps.some(x=>x.category===name)?'gaps':'retrieved';report.queue=report.queue.filter(x=>x!==name)}catch(e){report.categories[name].scan='incomplete';gap(name,null,e)}
    console.log('Sync: '+name+' '+report.categories[name].scan+'/'+report.categories[name].content);await writeJson(path.join(root,'pending','sync-checkpoint.json'),report);
  };
  const fetchList=async(resource,key)=>reader.list(resource,key);
  await category('repository',async()=>{
    const config={repository,labels:await fetchList('labels'),milestones:await fetchList('milestones?state=all'),branches:await fetchList('branches'),tags:await fetchList('tags'),workflows:await fetchList('actions/workflows','workflows'),settings:{},branchProtection:{},environments:[],rulesets:[]};
    for(const b of config.branches){shas.add(sha(b.commit.sha));if(b.protected){try{config.branchProtection[b.name]=(await reader.get('branches/'+encodeURIComponent(b.name)+'/protection')).data}catch(e){config.branchProtection[b.name]=gap('repository','branch/'+b.name,e)}}}
    for(const t of config.tags)shas.add(sha(t.commit.sha));
    for(const [name,url,key,isList] of [['collaborators','collaborators',null,true],['rulesets','rulesets',null,true],['webhooks','hooks',null,true],['runners','actions/runners','runners',true],['actionsPermissions','actions/permissions'],['workflowPermissions','actions/permissions/workflow'],['allowedActions','actions/permissions/selected-actions'],['environments','environments','environments',true],['pages','pages'],['trafficViews','traffic/views'],['trafficClones','traffic/clones'],['trafficPaths','traffic/popular/paths'],['trafficReferrers','traffic/popular/referrers'],['contributorStatistics','stats/contributors'],['participationStatistics','stats/participation']]){
      if(name==='allowedActions'&&config.settings.actionsPermissions?.allowed_actions!=='selected'){config.settings[name]={state:'not-applicable',reason:'Repository Actions permissions do not use a selected-actions allowlist'};continue}
      if(name==='pages'&&repository.has_pages===false){config.settings[name]={state:'not-enabled',reason:'Repository has_pages=false'};continue}
      try{let value=isList?await fetchList(url,key):(await reader.get(url)).data;if(name==='webhooks')value=value.map(redactHook);config.settings[name]=value;
        if(name==='rulesets')for(const r of value)config.rulesets.push((await reader.get('rulesets/'+numeric(r.id))).data);
        if(name==='environments')for(const env of value)config.environments.push((await reader.get('environments/'+encodeURIComponent(env.name))).data);
      }catch(e){config.settings[name]=gap('repository',name,e)}
    }
    for(const [name,key] of [['contributorStatistics','statistics-contributors'],['pages','pages']]){
      const value=config.settings[name];inventory.remote.categories[key]=value?.state?{state:value.state,reason:value.reason}:{state:'included',observed:true};
    }
    const refs=[...shas].map(commit=>({sha:commit,localGitObjectAvailable:(()=>{try{execFileSync('git',['cat-file','-e',commit+'^{commit}'],{cwd:project,windowsHide:true,stdio:'ignore'});return true}catch{return false}})()}));
    await save('repository/configuration',{'configuration.json':stable(config),'code-references.json':refs},{sourceCreatedAt:repository.created_at??null,sourceUpdatedAt:repository.updated_at??null});
  });
  for(const kind of ['projects','packages'])await category(kind,async()=>{
    const rows=await repositoryGraphql(reader,kind);report.categories[kind].discovered=rows.length;
    await save('supplements/'+kind,{'metadata.json':rows,'coverage.json':{repositoryScoped:true,content:rows.length?'metadata-only; detailed content adapter pending':'no-associated-records-observed'}});
    inventory.remote.categories[kind]={state:rows.length?'unsupported':'included',count:rows.length,reason:rows.length?'Repository associations saved; detailed content adapter pending':'Repository-scoped GraphQL enumeration returned zero records'};
  });
  for(const kind of ['projects','packages'])if(report.categories[kind].scan==='incomplete'){const status=report.gaps.find(g=>g.category===kind);inventory.remote.categories[kind]={state:status.state,reason:status.reason}}
  await category('releases',async()=>{
    const releases=await fetchList('releases');report.categories.releases.discovered=releases.length;
    for(const release of releases){
      const id=numeric(release.id),assets=await fetchList('releases/'+id+'/assets'),out=[];let resolvedCommit=null;
      try{const commit=(await reader.get('commits/'+encodeURIComponent(release.tag_name))).data;resolvedCommit=sha(commit.sha);shas.add(resolvedCommit)}catch(e){gap('releases',id+'/tag',e)}
      for(const asset of assets){
        numeric(asset.id);const item={...stable(asset)};
        if(/^MediaScope-[A-Za-z0-9.-]+(?:-win-x64)?\.zip$/.test(asset.name)){
          safeRelative(asset.name);const local=path.join(project,'releases',asset.name);
          if(await exists(local)){
            const localSha=await fileHash(local),length=(await fs.stat(local)).size;
            if(asset.digest==='sha256:'+localSha&&length===asset.size)item.localPackage={path:'../releases/'+asset.name,sha256:localSha,bytes:length,validation:'platform-digest-and-local-sha256'};
            else{
              const task=await downloadTask(root,'asset-'+asset.id),zip=path.join(task,'asset.bin');
              const check=await reader.download('releases/assets/'+asset.id,zip,{digest:asset.digest,size:asset.size});
              if(check.sha256!==localSha){item.packageConflict={localSha256:localSha,remoteSha256:check.sha256,state:'conflict-retained-in-pending'};gap('releases',asset.id,Error('Same package name has different bytes; retained remote diagnostic, no overwrite'))}
              else{item.localPackage={path:'../releases/'+asset.name,sha256:localSha,bytes:length,validation:check.validation};await insideCleanup(root,task)}
            }
          }else{
            const task=await downloadTask(root,'asset-'+asset.id),zip=path.join(task,'asset.bin'),check=await reader.download('releases/assets/'+asset.id,zip,{digest:asset.digest,size:asset.size});
            // Exclusive copy keeps a concurrently created release package intact.
            await fs.copyFile(zip,local,1);if(await fileHash(local)!==check.sha256)throw Error('Published package checksum mismatch');item.localPackage={path:'../releases/'+asset.name,sha256:check.sha256,bytes:check.bytes,validation:check.validation};await insideCleanup(root,task);
          }
        }else{
          const task=await downloadTask(root,'asset-'+asset.id),file=path.join(task,'asset.bin');
          const check=await reader.download('releases/assets/'+asset.id,file,{digest:asset.digest,size:asset.size});
          const saved=await save('releases/'+id+'/assets/'+asset.id,{'asset.bin':{archiveSourceFile:file},'asset.json':stable(asset),'validation.json':check});item.archiveContent=saved.path;await insideCleanup(root,task);
        }
        out.push(item);
      }
      const current=(await reader.get('releases/'+id)).data;
      if(current.updated_at!==release.updated_at)gap('releases',id,Error('Release changed during capture; repeat sync'));
      await save('releases/'+id,{'release.json':{...stable(release),assets:out,resolvedCommit,offlineDependencies:attachments(release.body)}},{sourceCreatedAt:release.created_at??null,sourcePublishedAt:release.published_at??null,sourceUpdatedAt:release.updated_at??null});
    }
  });
  await category('actions',async()=>{
    // Unfiltered endpoint has no filtered-search 1000-result limit. Count and Link are both checked.
    const runs=await fetchList('actions/runs','workflow_runs');report.categories.actions.discovered=runs.length;report.categories.actions.attempts=0;report.categories.actions.jobs=0;
    const allArtifacts=await fetchList('actions/artifacts','artifacts');report.categories.actions.artifacts=allArtifacts.length;const associated=new Set();
    for(const run of runs){
      numeric(run.id);if(String(run.repository?.id)!==TARGET.repositoryId)throw Error('Run belongs to another repository');shas.add(sha(run.head_sha));
      const runContent={run:stable(run),attempts:[]};
      for(let attempt=1;attempt<=(run.run_attempt??1);attempt++){
        report.categories.actions.attempts++;const prefix='actions/runs/'+run.id+'/attempts/'+attempt;let data;
        try{data=(await reader.get(prefix)).data;if(String(data.id)!==String(run.id)||data.run_attempt!==attempt||String(data.repository.id)!==TARGET.repositoryId)throw Error('Attempt identity mismatch')}catch(e){runContent.attempts.push({attempt,...gap('actions',run.id+'/'+attempt,e)});continue}
        const jobs=await fetchList(prefix+'/jobs','jobs'),metadata={attempt,data:stable(data),jobs:jobs.map(j=>({id:j.id,status:j.status,conclusion:j.conclusion})),artifacts:[]};
        for(const job of jobs){
          if(String(job.run_id)!==String(run.id)||job.run_attempt!==attempt)throw Error('Job/run/attempt mismatch');numeric(job.id);report.categories.actions.jobs++;
          const content={'job.json':stable(job)};let task;
          if(job.status==='completed'){
            try{task=await downloadTask(root,'job-'+job.id);const file=path.join(task,'log.txt');const validation=await reader.download('actions/jobs/'+job.id+'/logs',file);content['log.txt']={archiveSourceFile:file};content['log-validation.json']=validation}catch(e){content['log-status.json']=gap('actions',run.id+'/'+attempt+'/job/'+job.id,e)}
          }else{report.counts.waiting++;content['log-status.json']={state:'waiting',reason:'Job has not completed'};report.gaps.push({category:'actions',identity:run.id+'/'+attempt+'/job/'+job.id,...content['log-status.json']})}
          await save('actions/'+run.id+'/attempts/'+attempt+'/jobs/'+job.id,content,{sourceCreatedAt:job.created_at??null,sourceUpdatedAt:job.completed_at??null});
          if(task&&content['log.txt'])await insideCleanup(root,task);
        }
        const artifacts=allArtifacts.filter(a=>String(a.workflow_run?.id)===String(run.id));
        const expected=artifacts.filter(a=>a.name==='mediascope-test-evidence-'+run.id+'-'+attempt);
        for(const artifact of artifacts){
          const namedAttempt=artifact.name.match(/^mediascope-test-evidence-\d+-(\d+)$/)?.[1];
          if(namedAttempt&&artifact.name.match(/^mediascope-test-evidence-(\d+)-/)[1]!==String(run.id))throw Error('Artifact name and platform run identity mismatch');
          if(artifact.workflow_run?.head_sha&&artifact.workflow_run.head_sha!==run.head_sha)throw Error('Artifact platform head SHA mismatch');
          if(namedAttempt&&Number(namedAttempt)!==attempt)continue;
          if(!namedAttempt&&attempt!==run.run_attempt)continue;
          associated.add(String(artifact.id));const entry={artifact:stable(artifact),attemptAssociation:namedAttempt?'validated-by-platform-run-and-transport':'unknown-generic-artifact-attempt'};
          if(artifact.expired){report.counts.expired++;entry.content={state:'expired',reason:'Platform artifact expired'};report.gaps.push({category:'actions',identity:String(artifact.id),...entry.content})}
          else if(namedAttempt){
            if(run.path!=='.github/workflows/tests.yml'||jobs.length!==1||jobs[0].name!=='Windows full regression'){
              // The exporter supports one product job. Do not silently accept a future matrix.
              entry.content=gap('actions',artifact.id,Error('Unrecognized product job layout; exporter identity adapter requires review'));
            }else{
              const existing=(await evidenceRecords(root,{verify:false})).find(r=>r.provenance.identity.github.runId===String(run.id)&&r.provenance.identity.github.runAttempt===String(attempt));
              if(existing&&artifact.digest&&existing.provenance.identity.transportSha256?.toLowerCase()===artifact.digest.slice(7)){
                await verifySnapshot(existing.dir);entry.content={state:'available',path:path.relative(root,existing.dir).replaceAll('\\','/'),validation:artifact.digest?'platform-digest-and-local-sha256':'local-sha256-only'};report.counts.unchanged++;
              }else{
                let task;try{task=await downloadTask(root,'artifact-'+artifact.id);const zip=path.join(task,'artifact.zip');const check=await reader.download('actions/artifacts/'+artifact.id+'/zip',zip,{digest:artifact.digest});
                  const saved=await importTransport(project,root,zip,{repository:TARGET.repository,runId:String(run.id),attempt:String(attempt),...['push','workflow_dispatch','schedule'].includes(run.event)?{commit:run.head_sha}:{}},{reader,artifact:{id:artifact.id,digest:artifact.digest??null,validation:check.validation}});
                  report.counts[saved.state]++;report.addedBytes+=saved.bytes;entry.content={state:'available',path:saved.path,validation:check.validation};await insideCleanup(root,task);
                }catch(e){entry.content=gap('actions',artifact.id,e)}
              }
            }
          }else{
            let task;try{task=await downloadTask(root,'artifact-'+artifact.id);const zip=path.join(task,'artifact.zip'),check=await reader.download('actions/artifacts/'+artifact.id+'/zip',zip,{digest:artifact.digest});
              if(run.run_attempt!==1){const error=Error('Generic artifact attempt cannot be confirmed; original download retained in owned pending');error.state='unresolved-attempt';entry.content=gap('actions',artifact.id,error)}
              else{const saved=await save('actions/'+run.id+'/attempts/1/artifacts/'+artifact.id,{'artifact.zip':{archiveSourceFile:zip},'artifact.json':stable(artifact),'validation.json':check});entry.attemptAssociation='unique-platform-attempt';entry.content={state:'available',path:saved.path,validation:check.validation};await insideCleanup(root,task)}
            }catch(e){entry.content=gap('actions',artifact.id,e)}
          }
          metadata.artifacts.push(entry);
        }
        if(run.path==='.github/workflows/tests.yml'&&!expected.length){const state=data.status==='completed'?'missing':'waiting';report.counts[state]++;metadata.productEvidence={state,reason:state==='waiting'?'Artifact not yet uploaded':'No located evidence artifact; workflow state does not substitute for test data'};report.gaps.push({category:'actions',identity:run.id+'/'+attempt,...metadata.productEvidence})}
        runContent.attempts.push(metadata);
      }
      await save('actions/'+run.id,{'run.json':runContent},{sourceCreatedAt:run.created_at??null,sourceUpdatedAt:run.updated_at??null});
    }
    const unassociated=allArtifacts.filter(a=>!associated.has(String(a.id)));if(unassociated.length){report.gaps.push({category:'actions',state:'missing',reason:'Artifacts without a discovered matching run/attempt',ids:unassociated.map(a=>a.id)});report.counts.missing+=unassociated.length}
  });
  await category('issues-and-prs',async()=>{
    const issues=await fetchList('issues?state=all'),pulls=await fetchList('pulls?state=all');report.categories['issues-and-prs'].issues=issues.filter(x=>!x.pull_request).length;report.categories['issues-and-prs'].pullRequests=pulls.length;
    for(const item of issues){
      if(item.pull_request)continue;const id=numeric(item.id),number=numeric(item.number);const content={issue:stable(item),comments:stable(await fetchList('issues/'+number+'/comments')),events:stable(await fetchList('issues/'+number+'/events')),reactions:stable(await fetchList('issues/'+number+'/reactions'))};content.offlineDependencies=attachments(content);
      for(const c of content.comments)c.reactionsDetail=stable(await fetchList('issues/comments/'+numeric(c.id)+'/reactions'));
      await save('issues/'+id,{'issue.json':content},{sourceCreatedAt:item.created_at??null,sourceUpdatedAt:item.updated_at??null});
    }
    for(const item of pulls){
      const number=numeric(item.number),pr=(await reader.get('pulls/'+number)).data;numeric(pr.id);if(String(pr.base.repo.id)!==TARGET.repositoryId)throw Error('PR base belongs to another repository');shas.add(sha(pr.base.sha));shas.add(sha(pr.head.sha));if(pr.merge_commit_sha)shas.add(sha(pr.merge_commit_sha));
      const content={pullRequest:stable(pr),comments:stable(await fetchList('issues/'+number+'/comments')),reviews:stable(await fetchList('pulls/'+number+'/reviews')),reviewComments:stable(await fetchList('pulls/'+number+'/comments')),events:stable(await fetchList('issues/'+number+'/events')),reactions:stable(await fetchList('issues/'+number+'/reactions')),reviewThreads:{state:'unsupported',reason:'REST preserves inline comments and reply relationships but not resolved GraphQL thread state'},offlineDependencies:[]};
      for(const c of content.comments)c.reactionsDetail=stable(await fetchList('issues/comments/'+numeric(c.id)+'/reactions'));
      for(const c of content.reviewComments)c.reactionsDetail=stable(await fetchList('pulls/comments/'+numeric(c.id)+'/reactions'));
      try{content.reviewThreads={state:'included',threads:await repositoryGraphql(reader,'threads',{number:Number(number)})}}catch(e){content.reviewThreads=gap('issues-and-prs',pr.id+'/review-threads',e)}
      content.offlineDependencies=attachments(content);await save('pull-requests/'+pr.id,{'pull-request.json':content},{sourceCreatedAt:pr.created_at??null,sourceUpdatedAt:pr.updated_at??null});
    }
  });
  await category('deployments',async()=>{const deployments=await fetchList('deployments');for(const d of deployments)await save('supplements/deployments/'+numeric(d.id),{'deployment.json':stable(d),'statuses.json':stable(await fetchList('deployments/'+d.id+'/statuses'))});report.categories.deployments.discovered=deployments.length});
  await category('checks-statuses',async()=>{
    report.categories['checks-statuses'].commits=shas.size;
    for(const commit of shas){try{const checks=await fetchList('commits/'+commit+'/check-runs','check_runs');const data={sha:commit,checks:stable(checks),statuses:stable(await fetchList('commits/'+commit+'/statuses')),annotations:{}};for(const check of checks)data.annotations[check.id]=stable(await fetchList('check-runs/'+numeric(check.id)+'/annotations'));await save('supplements/checks/'+commit,{'checks.json':data})}catch(e){gap('checks-statuses',commit,e)}}
  });
  report.captureCompletedAt=now();report.elapsedMs=Date.parse(report.captureCompletedAt)-Date.parse(report.captureStartedAt);report.downloadBytes=reader.downloadBytes;report.peakTemporaryDownloadBytes=reader.peakTemporaryBytes;report.remainingSpace=await fs.statfs(root);
  report.coverage={configured:inventory.remote.categories,current:report.categories,unsupported:Object.entries(inventory.remote.categories).filter(([,v])=>v.state==='unsupported').map(([k])=>k),scanComplete:Object.values(report.categories).every(v=>v.scan==='complete'),contentComplete:report.gaps.length===0&&report.counts.missing===0&&report.counts.expired===0,formalIntegrity:'requires-verify-command'};
  if(report.coverage.unsupported.length)report.coverage.contentComplete=false;
  const receipt=await seal(root,'sync-reports/'+report.captureStartedAt.replace(/[-:]/g,''),{'report.json':report},{captureStartedAt:report.captureStartedAt});
  report.receipt={path:receipt.path,bytes:receipt.bytes};await writeJson(path.join(root,'coverage.json'),report.coverage);await writeJson(path.join(root,'pending','sync-checkpoint.json'),report);return report;
}
async function downloadTask(root,name){const dir=path.join(root,'pending',name+'-'+hash(now()+Math.random()).slice(0,16));await fs.mkdir(dir);await writeJson(path.join(dir,'owner.json'),{owner:'mediascope-github-archive',state:'download'});return dir}
