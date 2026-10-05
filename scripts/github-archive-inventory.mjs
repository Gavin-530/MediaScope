import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {GitHubReader} from './github-archive-api.mjs';
import {TARGET,now,tree,readJson,writeJson,noLinks} from './github-archive-store.mjs';

export async function inventory(project,{online=true}={}){
  const work=path.join(project,'.build','github-archive-implementation');await noLinks(work);await fs.mkdir(work,{recursive:true});
  const run=now({milliseconds:true}).replace(/[-:]/g,'');
  const rows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/github-archive-evidence.ps1'),'-Action','Inventory','-Project',project],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:32*1024**2}));
  const evidence=await tree(path.join(project,'evidence-archive')),releases=await tree(path.join(project,'releases'));
  const report={format:1,phase:'A',startedAt:now(),target:TARGET,records:rows.map(r=>({...r,files:evidence.filter(f=>f.path.startsWith(r.path+'/')).map(f=>({...f,path:f.path.slice(r.path.length+1)}))})),evidenceInventory:evidence,releaseInventory:releases,space:await fs.statfs(project),git:{head:execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8',windowsHide:true}).trim(),status:execFileSync('git',['status','--short'],{cwd:project,encoding:'utf8',windowsHide:true}).trim()},remote:{state:'not-checked',categories:{}}};
  if(online){
    const reader=new GitHubReader({budgetMs:5*60*1000});
    const repository=(await reader.get('')).data;
    if(String(repository.id)!==TARGET.repositoryId||repository.full_name!==TARGET.repository)throw Error('Remote identity changed; inventory stopped');
    report.remote={state:'checked',identity:{...TARGET},features:{issues:repository.has_issues,wiki:repository.has_wiki,projects:repository.has_projects,discussions:repository.has_discussions,pages:repository.has_pages},permissions:repository.permissions??null,categories:{}};
    const specs=[['releases','releases'],['actions','actions/runs','workflow_runs'],['artifacts','actions/artifacts','artifacts'],['issues-and-prs','issues?state=all'],['branches','branches'],['tags','tags'],['labels','labels'],['milestones','milestones?state=all'],['deployments','deployments'],['environments','environments','environments'],['rulesets','rulesets'],['collaborators','collaborators'],['webhooks','hooks'],['runners','actions/runners','runners'],['statistics-contributors','stats/contributors']];
    for(const [name,resource,key] of specs){
      try{const data=await reader.list(resource,key);report.remote.categories[name]={state:'included',count:data.length,ids:data.map(x=>String(x.id??x.name??x.sha)),...(name==='actions'?{attempts:data.reduce((n,r)=>n+(r.run_attempt??1),0),states:Object.fromEntries([...new Set(data.map(r=>r.status))].map(s=>[s,data.filter(r=>r.status===s).length]))}:{}),...(name==='artifacts'?{bytes:data.reduce((n,a)=>n+a.size_in_bytes,0),expired:data.filter(a=>a.expired).length}:{}),...(name==='releases'?{assets:data.flatMap(r=>r.assets).length,assetBytes:data.flatMap(r=>r.assets).reduce((n,a)=>n+a.size,0)}:{})}}catch(e){report.remote.categories[name]={state:e.state??'error',reason:e.message}}
      console.log('Inventory: '+name+' '+report.remote.categories[name].state+' '+(report.remote.categories[name].count??''));
    }
    report.remote.categories.discussions={state:repository.has_discussions?'unsupported':'not-enabled',reason:repository.has_discussions?'GraphQL adapter pending':'Repository has_discussions=false'};
    report.remote.categories.wiki={state:repository.has_wiki?'unsupported':'not-enabled',reason:'Wiki content requires a separate repository-bound adapter; enabled flag does not prove pages exist'};
    report.remote.categories.projects={state:repository.has_projects?'unsupported':'not-enabled',reason:'Repository-related Projects v2 require GraphQL; account-wide Projects are excluded'};
    for(const [name,resource] of [['pages','pages'],['actions-permissions','actions/permissions'],['traffic-views','traffic/views'],['traffic-clones','traffic/clones']]){
      try{const data=(await reader.get(resource)).data;report.remote.categories[name]={state:'included',observed:true,...(name==='pages'?{status:data.status}:{})}}catch(e){report.remote.categories[name]={state:e.state??'error',reason:e.message}}
    }
    report.remote.categories.packages={state:'unsupported',reason:'Packages API is owner-scoped; no account-wide enumeration performed. Repository associations need a repository-scoped adapter'};
    report.remote.categories.audit={state:'excluded',reason:'User-owned repository; account and organization audit/billing are outside scope'};
    report.remote.categories['checks-statuses']={state:'included',reason:'Collect repository branches, tags and run/PR SHAs only; no source archive'};
    report.remote.categories.attachments={state:'unsupported',reason:'Body image/attachment URLs will be inventoried as offline dependencies; recursive or cross-repository downloads excluded'};
    report.remote.pages=reader.pages;
  }
  report.completedAt=now();const file=path.join(work,'inventory-'+run+'.json');await writeJson(file,report);await writeJson(path.join(work,'latest-inventory.json'),{path:path.basename(file)});
  console.log('Inventory report: '+file);return {file,report};
}
export async function latestInventory(project){const root=path.join(project,'.build','github-archive-implementation');const pointer=await readJson(path.join(root,'latest-inventory.json'));if(path.basename(pointer.path)!==pointer.path)throw Error('Invalid inventory pointer');const report=await readJson(path.join(root,pointer.path));if(report.target.repositoryId!==TARGET.repositoryId)throw Error('Inventory target mismatch');return report}
