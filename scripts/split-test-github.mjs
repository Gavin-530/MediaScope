import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {GitHubReader} from './github-archive-api.mjs';
import {digest} from './split-test-plan.mjs';
import {read, repository, verifyCaseSummary, verifyLocalReceipt} from './split-test-receipts.mjs';

const workflow = '.github/workflows/tests.yml';
const commitWorkflow = '.github/workflows/commit-messages.yml';
const acceptanceJob = 'MediaScope split acceptance';
const unique = (rows, label) => {
  if(rows.length!==1)throw Error('Expected one '+label);
  return rows[0];
};
const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value)>0;
const trustedRun = (run, {file, event, sha, ref}) => run.path===file && run.event===event && run.head_sha===sha &&
  run.repository?.full_name===repository && run.head_repository?.full_name===repository &&
  (!ref || run.head_branch===ref);

export function verifyCloudReceipt(proof, plan, identity, origin) {
  if(proof.schema!==1||proof.kind!=='split-cloud'||proof.sha!==plan.sha||proof.plan!==plan.hash||
     proof.scope!==plan.scope||proof.base!==plan.base||proof.anchor!==plan.anchor||
     JSON.stringify(proof.identity)!==JSON.stringify(identity)||
     proof.github?.repository!==repository||proof.github.runId!==String(origin.id)||
     proof.github.runAttempt!==String(origin.run_attempt)||proof.github.ref!=='refs/tags/'+origin.head_branch) {
    throw Error('Cloud preflight evidence has a different origin, candidate or plan');
  }
  verifyCaseSummary(proof.general,plan.cloud,{runtime:true});
  if(proof.general?.tools.some(tool=>tool.name!=='node'))throw Error('Cloud preflight used media tools');
  if(plan.scope==='docs-only'&&(proof.documentationChecks?.documents!==plan.files.length||
     ['whitespace','utf8','fences'].some(key=>proof.documentationChecks[key]!=='passed')))throw Error('Missing documentation check receipt');
}

export function verifyCommitReceipt(proof, plan, origin) {
  if(proof.schema!==1||proof.kind!=='split-commits'||proof.sha!==plan.sha||
     proof.github?.repository!==repository||proof.github.runId!==String(origin.id)||
     proof.github.runAttempt!==String(origin.run_attempt)||proof.github.ref!=='refs/tags/'+origin.head_branch) {
    throw Error('Commit check evidence has a different origin or candidate');
  }
  verifyCaseSummary(proof.cases,plan.commits);
}

const expectedCoverage = plan => ({local:plan.local.length,cloud:plan.cloud.length,commits:plan.commits.length,stages:plan.stages});
const validOrigin = value => positive(value?.runId) && positive(value?.attempt) && /^[0-9a-f]{64}$/.test(value?.artifactSha256);

export function verifyAcceptance(proof, plan, identity, publicKey) {
  if(proof.schema!==1||proof.kind!=='split-acceptance'||proof.sha!==plan.sha||proof.base!==plan.base||
     proof.anchor!==plan.anchor||proof.scope!==plan.scope||proof.release!==plan.release||proof.forceFull!==plan.forceFull||
     proof.plan!==plan.hash||JSON.stringify(proof.identity)!==JSON.stringify(identity)||
     JSON.stringify(proof.expected)!==JSON.stringify(expectedCoverage(plan))||!validOrigin(proof.cloud)||!validOrigin(proof.commits)){
    throw Error('Prior acceptance does not cover this source, plan and evidence');
  }
  if(plan.scope==='docs-only'){
    if(proof.localReceipt!==null||proof.localReceiptSha256!==null)throw Error('Unexpected local receipt for documentation scope');
    return null;
  }
  const local=verifyLocalReceipt(proof.localReceipt,publicKey,plan,identity);
  if(proof.localReceiptSha256!==digest(proof.localReceipt))throw Error('Signed local receipt digest differs from prior acceptance');
  return local;
}

export function splitGitHubIdentity() {
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
     process.env.GITHUB_REPOSITORY!==repository||!positive(process.env.GITHUB_RUN_ID)||!positive(process.env.GITHUB_RUN_ATTEMPT))throw Error('Trusted GitHub-hosted job identity required');
  return {repository,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,ref:process.env.GITHUB_REF};
}

export class SplitGitHub {
  constructor(repo,dir,api=new GitHubReader({budgetMs:120000,maxBytes:4*1024*1024,token:process.env.GITHUB_TOKEN})){
    this.repo=repo;
    this.dir=dir;
    this.api=api;
  }

  async latest({file,event,sha,ref}) {
    const name=file.slice(file.lastIndexOf('/')+1);
    const {data}=await this.api.get('actions/workflows/'+name+'/runs?head_sha='+sha+'&event='+event+'&per_page=100');
    if(!Array.isArray(data.workflow_runs)||data.total_count!==data.workflow_runs.length)throw Error('Incomplete GitHub run list');
    const rows=data.workflow_runs.filter(run=>trustedRun(run,{file,event,sha,ref}))
      .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id);
    if(!rows.length)throw Error('Required GitHub execution has not been recorded: '+name);
    return rows[0];
  }

  async receipt(run,{file,event,sha,ref,job,artifact,entry='ci-scope.json'}) {
    if(!trustedRun(run,{file,event,sha,ref})||run.status!=='completed'||run.conclusion!=='success'||!positive(run.id)||!positive(run.run_attempt)){
      throw Error('GitHub run missing a completed passing result for '+job);
    }
    const route='actions/runs/'+run.id;
    const {data}=await this.api.get(route+'/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(data.total_count!==data.jobs?.length)throw Error('Incomplete GitHub job list');
    const proofJob=unique(data.jobs.filter(j=>j.name===job),'GitHub job '+job);
    if(proofJob.status!=='completed'||proofJob.conclusion!=='success'||proofJob.head_sha!==sha||
       proofJob.run_id!==run.id||proofJob.run_attempt!==run.run_attempt)throw Error('Expected GitHub job did not pass for candidate');
    const name=artifact+'-'+run.id+'-'+run.run_attempt;
    const {data:artifacts}=await this.api.get(route+'/artifacts?name='+name+'&per_page=100');
    if(artifacts.total_count!==artifacts.artifacts?.length)throw Error('Incomplete GitHub artifact list');
    const artifactRow=unique(artifacts.artifacts.filter(a=>a.name===name),'GitHub artifact '+name);
    if(artifactRow.expired||!positive(artifactRow.id)||!/^sha256:[0-9a-f]{64}$/.test(artifactRow.digest)||
       artifactRow.workflow_run?.id!==run.id||artifactRow.workflow_run?.head_sha!==sha)throw Error('Missing current artifact identity and digest');
    const root=await fs.mkdtemp(path.join(this.dir,'transport-'));
    const zip=path.join(root,'receipt.zip'), extracted=path.join(root,'receipt');
    await this.api.download('actions/artifacts/'+artifactRow.id+'/zip',zip,{digest:artifactRow.digest,size:artifactRow.size_in_bytes});
    const env={...process.env, MEDIASCOPE_RECEIPT_LIB:path.join(this.repo,'scripts/github-evidence-lib.ps1'),
      MEDIASCOPE_RECEIPT_ZIP:zip,MEDIASCOPE_RECEIPT_OUT:extracted};
    execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',
      '. $env:MEDIASCOPE_RECEIPT_LIB; Expand-GitHubEvidenceZip $env:MEDIASCOPE_RECEIPT_ZIP $env:MEDIASCOPE_RECEIPT_OUT'],
      {env,cwd:this.repo,windowsHide:true,stdio:'pipe'});
    const files=await fs.readdir(extracted);
    if(files.length!==1||files[0]!==entry||!(await fs.lstat(path.join(extracted,entry))).isFile())throw Error('Unexpected receipt artifact entries');
    return {proof:await read(path.join(extracted,entry)),artifactSha256:artifactRow.digest.slice(7),runId:run.id,attempt:run.run_attempt};
  }

  async previousAcceptance(sha) {
    const origin=await this.latest({file:workflow,event:'workflow_dispatch',sha});
    if(!/^verify-main-/.test(origin.head_branch??''))throw Error('Prior acceptance was not run on a verification tag');
    const row=await this.receipt(origin,{file:workflow,event:'workflow_dispatch',sha,ref:origin.head_branch,
      job:acceptanceJob,artifact:'mediascope-ci-scope'});
    if(row.proof.schema!==1||row.proof.kind!=='split-acceptance'||row.proof.sha!==sha||
       row.proof.github?.repository!==repository||row.proof.github.runId!==String(origin.id)||
       row.proof.github.runAttempt!==String(origin.run_attempt)||row.proof.github.ref!=='refs/tags/'+origin.head_branch)throw Error('Prior acceptance artifact identity mismatch');
    return {origin,row};
  }

  async verifyAnchor(plan) {
    if(plan.scope==='full')return;
    const {row}=await this.previousAcceptance(plan.anchor);
    if(row.proof.scope!=='full')throw Error('Scope reduction requires a completed full acceptance for the anchor SHA');
  }

  async accept({plan,identity,tag,token,publicKey}) {
    if(plan.scope==='docs-only'){
      if(token!==null)throw Error('Unexpected local receipt for documentation scope');
    }else verifyLocalReceipt(token,publicKey,plan,identity);
    await this.verifyAnchor(plan);
    const cloudQuery={file:workflow,event:'push',sha:plan.sha,ref:tag};
    const commitsQuery={file:commitWorkflow,event:'push',sha:plan.sha,ref:tag};
    const [cloudRun,commitRun]=await Promise.all([this.latest(cloudQuery),this.latest(commitsQuery)]);
    const [cloud,commits]=await Promise.all([
      this.receipt(cloudRun,{...cloudQuery,job:'MediaScope cloud preflight',artifact:'mediascope-ci-scope'}),
      this.receipt(commitRun,{...commitsQuery,job:'Commit messages',artifact:'mediascope-split-commits',entry:'commit-proof.json'}),
    ]);
    verifyCloudReceipt(cloud.proof,plan,identity,cloudRun);
    verifyCommitReceipt(commits.proof,plan,commitRun);
    const origin=({runId,attempt,artifactSha256})=>({runId,attempt,artifactSha256});
    return {schema:1,kind:'split-acceptance',sha:plan.sha,base:plan.base,anchor:plan.anchor,scope:plan.scope,
      release:plan.release,forceFull:plan.forceFull,plan:plan.hash,identity,
      localReceipt:token,localReceiptSha256:token?digest(token):null,cloud:origin(cloud),commits:origin(commits),
      expected:expectedCoverage(plan)};
  }
}
