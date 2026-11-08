import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparisonBase,checkDocuments} from './ci-scope.mjs';
import {clean,commitCases,git,head,splitPlan} from './split-test-plan.mjs';
import {deploymentBinding,executeCommitCases,executeDeployment,executeFormal,identities,makeSignature,
  read,repository,verifyOfflineInputs} from './split-test-receipts.mjs';
import {SplitGitHub,splitGitHubIdentity,verifyAcceptance} from './split-test-github.mjs';

const repo = fileURLToPath(new URL('../',import.meta.url));
const build = path.join(repo,'.build');
const mainSha = () => git(repo,'rev-parse','--verify','refs/remotes/origin/main^{commit}').trim();
const write = (file,data) => fs.writeFile(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
async function scratch(){
  await fs.mkdir(build,{recursive:true});
  return fs.mkdtemp(path.join(build,'split-'));
}
const parseTag = ref => {
  const match=/^refs\/tags\/(verify-main-[a-zA-Z0-9._-]+)$/.exec(ref??'');
  if(!match)throw Error('Split preflight and acceptance require a verification tag');
  return match[1];
};
const profile = tag => ({release:/^verify-main-(?:pilot-)?release-/.test(tag),forceFull:/^verify-main-(?:pilot-)?full-/.test(tag)});
const assertClean = () => {if(!clean(repo))throw Error('Split verification requires the clean candidate commit');};

function options(argv){
  const settings = {};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(flag==='--release'||flag==='--full'){
      const key=flag==='--release'?'release':'forceFull';
      if(key in settings)throw Error('Duplicate '+flag);
      settings[key]=true;
    }else if(['--base','--anchor','--key','--archive'].includes(flag)){
      const key=flag.slice(2),value=argv[++i];
      if(!value||value.startsWith('--')||key in settings)throw Error('Missing or duplicate '+flag);
      settings[key]=value;
    }else throw Error('Unknown option '+flag);
  }
  return settings;
}

async function local(command,args){
  const opts=options(args);
  const sha=head(repo);
  const plan=splitPlan(repo,{...opts,sha,base:opts.base??mainSha(),anchor:opts.anchor??process.env.MEDIASCOPE_SPLIT_BASELINE});
  if(command==='plan'){console.log(JSON.stringify(plan,null,2));return;}
  assertClean();
  if(plan.scope==='docs-only'){console.log('Documentation-only plan; Actions checks the documents and no local test receipt is required.');return;}
  if(!opts.key)throw Error('--key requires a maintainer-controlled Ed25519 private key outside this project');
  const key=await fs.realpath(opts.key);
  const relative=path.relative(await fs.realpath(repo),key);
  if(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('Keep the signing key outside the project');
  const dir=await scratch(), identity=await identities(repo);
  if(plan.stages.includes('package')&&!opts.archive)throw Error('--archive is required for the deployment stages');
  if(plan.stages.includes('package'))await verifyOfflineInputs(repo);
  const archive=opts.archive&&path.resolve(opts.archive);
  const packageHash=archive?await deploymentBinding(repo,archive):null;
  const general=await executeFormal(repo,dir,plan,identity,{side:'local'});
  const stages={},records={general:general?.record??null};
  for(const id of plan.stages){
    const stage=plan.stageCases[id]?await executeFormal(repo,dir,plan,identity,{side:'local',suite:id}):
      await executeDeployment(repo,dir,plan,id,archive,packageHash);
    stages[id]=stage.summary;
    records[id]=stage.record;
  }
  assertClean();
  if(head(repo)!==sha||JSON.stringify(await identities(repo))!==JSON.stringify(identity))throw Error('Candidate changed during local verification');
  const payload={schema:1,side:'local',repository,sha,plan:plan.hash,identity,general:general?.summary??null,stages};
  const privatePem=await fs.readFile(key);
  const token=makeSignature(payload,privatePem);
  const tokenPath=path.join(dir,'local-receipt.txt');
  await fs.writeFile(tokenPath,token+'\n',{flag:'wx'});
  await write(path.join(dir,'local-records.json'),records);
  console.log(JSON.stringify({sha,scope:plan.scope,plan:plan.hash,receipt:tokenPath,records},null,2));
}

async function cloudReceipt(plan,identity,dir,github) {
  const execution=await executeFormal(repo,dir,plan,identity,{side:'cloud'});
  const report={schema:1,kind:'split-cloud',sha:plan.sha,plan:plan.hash,scope:plan.scope,identity,github,
    base:plan.base,anchor:plan.anchor,general:execution?.summary??null};
  if(plan.scope==='docs-only')report.documentationChecks=checkDocuments(repo,{...plan,testedSha:plan.sha});
  if(execution&&process.env.GITHUB_OUTPUT)await fs.appendFile(process.env.GITHUB_OUTPUT,'cloud_record='+execution.record+'\n');
  return report;
}

async function ci(){
  const github=splitGitHubIdentity();
  assertClean();
  const sha=head(repo);
  if(sha!==process.env.GITHUB_SHA)throw Error('GitHub and checkout SHA differ');
  const eventName=process.env.GITHUB_EVENT_NAME,event=await read(process.env.GITHUB_EVENT_PATH);
  const anchor=process.env.MEDIASCOPE_SPLIT_BASELINE;
  const publicKey=process.env.MEDIASCOPE_SPLIT_PUBLIC_KEY;
  if(!publicKey)throw Error('Trusted local receipt public key is not configured');
  const dir=await scratch(),identity=await identities(repo);
  const api=new SplitGitHub(repo,dir);
  let report;
  if(eventName==='push'&&github.ref==='refs/heads/main'){
    const base=comparisonBase(eventName,event,sha);
    const {origin,row}=await api.previousAcceptance(sha);
    const plan=splitPlan(repo,{sha,base,anchor,...profile(origin.head_branch)});
    const prior=row.proof;
    verifyAcceptance(prior,plan,identity,publicKey);
    await api.verifyAnchor(plan);
    report={...prior,kind:'split-reused',github,previousAcceptance:{runId:row.runId,attempt:row.attempt,artifactSha256:row.artifactSha256}};
  }else{
    const tag=parseTag(github.ref);
    const base=mainSha();
    const plan=splitPlan(repo,{sha,base,anchor,...profile(tag)});
    if(eventName==='push'){
      comparisonBase(eventName,event,sha,base);
      await api.verifyAnchor(plan);
      report=await cloudReceipt(plan,identity,dir,github);
    }else if(eventName==='workflow_dispatch'){
      const token=process.env.MEDIASCOPE_SPLIT_RECEIPT?.trim()||null;
      report={...await api.accept({plan,identity,tag,token,publicKey}),github};
    }else throw Error('Unsupported split workflow event');
  }
  assertClean();
  await write(path.join(build,'ci-scope.json'),report);
  const summary='## '+report.kind+'\n\nCandidate `'+sha+'`\n\nScope `'+report.scope+'`\n';
  if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
  console.log(summary);
}

async function commits(){
  const github=splitGitHubIdentity();
  assertClean();
  const sha=head(repo);
  if(sha!==process.env.GITHUB_SHA)throw Error('GitHub and checkout SHA differ');
  const dir=await scratch();
  const cases=await executeCommitCases(repo,dir,commitCases());
  assertClean();
  await write(path.join(build,'commit-proof.json'),{schema:1,kind:'split-commits',sha,cases,github});
}

async function release(args){
  const opts=options(args);
  if(!opts.archive||Object.keys(opts).length!==1)throw Error('Release verification requires --archive <ZIP>');
  const publicKey=process.env.MEDIASCOPE_SPLIT_PUBLIC_KEY;
  if(!publicKey)throw Error('Set MEDIASCOPE_SPLIT_PUBLIC_KEY to the reviewed public key');
  assertClean();
  const sha=head(repo),dir=await scratch(),identity=await identities(repo);
  const {row}=await new SplitGitHub(repo,dir).previousAcceptance(sha);
  const prior=row.proof;
  if(prior.release!==true||prior.scope!=='full')throw Error('Exact release requires full split acceptance and all local stages');
  const plan=splitPlan(repo,{sha,base:prior.base,anchor:prior.anchor,release:true});
  const localReceipt=verifyAcceptance(prior,plan,identity,publicKey);
  const packageSha256=await deploymentBinding(repo,path.resolve(opts.archive));
  if(localReceipt.stages.package.packageSha256!==packageSha256||localReceipt.stages.online.packageSha256!==packageSha256)throw Error('Release ZIP differs from the tested artifact');
  await write(path.join(dir,'release-acceptance.json'),{sha,packageSha256,run:row.runId,attempt:row.attempt,accepted:true});
  console.log('Verified split release acceptance for '+sha+' and ZIP '+packageSha256+'; manual acceptance remains separate.');
}

const [command,...args]=process.argv.slice(2);
try {
  if(command==='ci'&&!args.length)await ci();
  else if(command==='commits'&&!args.length)await commits();
  else if(command==='plan'||command==='local')await local(command,args);
  else if(command==='release')await release(args);
  else throw Error('Usage: npm run test:split -- plan|local [--base <sha>] [--anchor <verified-sha>] [--full|--release] [--key <file>] [--archive <ZIP>]');
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}
