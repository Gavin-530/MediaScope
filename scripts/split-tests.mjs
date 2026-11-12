import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparisonBase,checkDocuments,forcedMainRecovery,mainRecovery} from './ci-scope.mjs';
import {clean,commitCases,git,head,splitPlan} from './split-test-plan.mjs';
import {deploymentBinding,executeCommitCases,executeDeployment,executeFormal,identities,
  read,repository,verifyOfflineInputs} from './split-test-receipts.mjs';
import {SplitGitHub,isRecoveryPreflightTag,splitGitHubIdentity,verifyAcceptance} from './split-test-github.mjs';

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
const acceptedRecoveryTag = /^verify-main-accepted-recovery-/;
const recoveryConfig = () => process.env.MEDIASCOPE_MAIN_RECOVERY;
const recoveryOptions = recovery => ({base:recovery.base,forceFull:true,recovery});
const assertClean = () => {if(!clean(repo))throw Error('Split verification requires the clean candidate commit');};

function prepareRecovery(sha) {
  const recovery = mainRecovery(recoveryConfig(),mainSha(),sha);
  git(repo,'merge-base','--is-ancestor',recovery.base,recovery.before);
  return recovery;
}

function options(argv){
  const settings = {};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(['--release','--full','--recovery'].includes(flag)){
      const key=flag==='--full'?'forceFull':flag.slice(2);
      if(key in settings)throw Error('Duplicate '+flag);
      settings[key]=true;
    }else if(['--base','--anchor','--archive'].includes(flag)){
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
  if(opts.recovery&&['base','anchor','release','forceFull'].some(key=>key in opts)){
    throw Error('--recovery supplies its own baseline and full non-release scope');
  }
  const settings=opts.recovery?recoveryOptions(prepareRecovery(sha)):
    {...opts,base:opts.base??mainSha(),anchor:opts.anchor??process.env.MEDIASCOPE_SPLIT_BASELINE};
  const plan=splitPlan(repo,{...settings,sha});
  if(command==='plan'){console.log(JSON.stringify(plan,null,2));return;}
  assertClean();
  if(plan.scope==='docs-only'){console.log('Documentation-only plan; Actions checks the documents and no local test receipt is required.');return;}
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
  const token=Buffer.from(JSON.stringify(payload)).toString('base64url');
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
  const dir=await scratch(),identity=await identities(repo);
  const api=new SplitGitHub(repo,dir);
  let report,recovery;
  const mainPush=eventName==='push'&&github.ref==='refs/heads/main';
  if(eventName==='push'&&(mainPush||github.ref.startsWith('refs/tags/verify-main-accepted-'))){
    if(mainPush&&event.forced===true) recovery=forcedMainRecovery(recoveryConfig(),event,sha);
    if(acceptedRecoveryTag.test(github.ref.slice('refs/tags/'.length))){
      if(event.ref!==github.ref)throw Error('Recovery acceptance ref differs from the push event');
      recovery=prepareRecovery(sha);
      comparisonBase(eventName,event,sha,recovery.base);
    }
    const base=recovery?.base??(mainPush?comparisonBase(eventName,event,sha):mainSha());
    const {origin,row,approval}=await api.previousAcceptance(sha,{recovery:Boolean(recovery)});
    const prior=row.proof;
    const settings=recovery?recoveryOptions(recovery):{base,anchor:prior.scope==='full'?prior.anchor:anchor,...profile(origin.head_branch)};
    const plan=splitPlan(repo,{sha,...settings});
    verifyAcceptance(prior,plan,identity);
    await api.verifyAnchor(plan);
    report={...prior,kind:'split-reused',github,approval,previousAcceptance:{runId:row.runId,attempt:row.attempt,artifactSha256:row.artifactSha256}};
  }else{
    const tag=parseTag(github.ref);
    if(isRecoveryPreflightTag(tag)) recovery=prepareRecovery(sha);
    const settings=recovery?recoveryOptions(recovery):{base:mainSha(),anchor,...profile(tag)};
    const plan=splitPlan(repo,{sha,...settings});
    if(eventName==='push'){
      comparisonBase(eventName,event,sha,plan.base);
      await api.verifyAnchor(plan);
      report=await cloudReceipt(plan,identity,dir,github);
    }else if(eventName==='workflow_dispatch'){
      if(github.runAttempt!=='1'||tag.startsWith('verify-main-accepted-'))throw Error('Dispatch a fresh acceptance on the preflight tag');
      const token=process.env.MEDIASCOPE_SPLIT_RECEIPT?.trim()||null;
      const mode=process.env.MEDIASCOPE_ACCEPTANCE_MODE;
      if((mode==='docs'&&plan.scope!=='docs-only')||(mode==='review'&&plan.scope==='docs-only')||
         (mode&&mode!=='docs'&&mode!=='review'))throw Error('Candidate scope does not match the acceptance workflow');
      report={...await api.prepareAcceptance({plan,identity,tag,token}),github};
    }else throw Error('Unsupported split workflow event');
  }
  if(recovery)report.recovery=recovery;
  assertClean();
  await write(path.join(build,'ci-scope.json'),report);
  let summary='## '+report.kind+'\n\nCandidate `'+sha+'`\n\nScope `'+report.scope+'`\n';
  if(recovery)summary+='\nRecovery from `'+recovery.before+'` to `'+recovery.after+'`\n\nRecovery baseline `'+recovery.base+'`\n';
  if(report.kind==='split-acceptance'&&report.localReceipt!==null){
    summary+='\nPlan `'+report.plan+'`\n\nLocal receipt SHA-256 `'+report.localReceiptSha256+'`\n\n'+
      'Local general cases: '+report.expected.local+'\n\nLocal stages: '+(report.expected.stages.join(', ')||'none')+'\n\n'+
      'Before approving, verify the sealed local records and confirm the local receipt digest matches this run.\n';
    await fs.appendFile(process.env.GITHUB_OUTPUT,'review_required=true\n');
  }
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
  assertClean();
  const sha=head(repo),dir=await scratch(),identity=await identities(repo);
  const {row}=await new SplitGitHub(repo,dir).previousAcceptance(sha);
  const prior=row.proof;
  if(prior.release!==true||prior.scope!=='full')throw Error('Exact release requires full split acceptance and all local stages');
  const plan=splitPlan(repo,{sha,base:prior.base,anchor:prior.anchor,release:true});
  const localReceipt=verifyAcceptance(prior,plan,identity);
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
  else throw Error('Usage: npm run test:split -- plan|local [--base <sha>] [--anchor <verified-sha>] [--full|--release|--recovery] [--archive <ZIP>]');
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}
