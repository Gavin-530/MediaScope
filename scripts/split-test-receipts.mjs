import {execFileSync, spawn} from 'node:child_process';
import {createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {caseCatalog, assessCases, selectCases} from '../testing-tools/helpers/case-catalog.mjs';
import {softwareIdentity, testSystemIdentity} from '../testing-tools/helpers/product-contract.mjs';
import {zipMembers} from '../testing-tools/helpers/zip.mjs';
import {packagedSourceReadiness} from './test-complete.mjs';
import {fileHash,TARGET} from './github-archive-store.mjs';
import {digest} from './split-test-plan.mjs';

export const read = async file => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const hashFile = async file => digest(await fs.readFile(file));
const sorted = ids => [...ids].sort();
export const caseDigest = ids => digest(JSON.stringify(sorted(ids)));
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const repository = TARGET.repository;

export async function identities(repo) {
  return {
    software:(await softwareIdentity(repo)).sha256,
    testSystem:(await testSystemIdentity(repo)).sha256,
    contract:await hashFile(path.join(repo,'testing-tools/product.json')),
    runtimeLock:await hashFile(path.join(repo,'runtime-lock.json')),
  };
}

export async function runLogged(repo, exe, args, log) {
  const fd = await fs.open(log,'wx');
  let stderr = '';
  try {
    const env={...process.env};
    for(const key of ['GITHUB_TOKEN','GH_TOKEN','MEDIASCOPE_SPLIT_RECEIPT'])delete env[key];
    const result = await new Promise((resolve,reject) => {
      const child = spawn(exe,args,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
      child.once('error',reject);
      child.once('close',code=>resolve({code,stdout}));
    });
    await fd.writeFile(result.stdout + stderr);
    if(result.code !== 0) throw Error('Test command failed; see ' + log);
    return result.stdout;
  } finally {await fd.close();}
}

function verifySealed(repo, record) {
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    path.join(repo,'scripts/verify-test-evidence.ps1'),'-Record',record],{cwd:repo,windowsHide:true,stdio:'pipe'});
}

function recordFrom(repo, stdout, prefix, isJson = false) {
  const row=stdout.split(/\r?\n/).findLast(s=>s.startsWith(prefix));
  if (!row) throw Error('Test command did not save its evidence');
  const marker=isJson?JSON.parse(row.slice(prefix.length)):{directory:row.slice(prefix.length)};
  const record=path.resolve(repo,marker.directory);
  if(path.dirname(record)!==path.join(repo,'evidence-archive','records')) throw Error('Unexpected test record location');
  return {record,marker};
}

function allPassed(counts, expected) {
  return counts?.tests===expected && counts.passed===expected &&
    ['failed','skipped','todo','cancelled'].every(key=>counts[key]===0);
}

async function summarizeFormal(repo, record, plan, identity, ids, suite, jobs, cloud) {
  verifySealed(repo,record);
  const manifest=await read(path.join(record,'manifest.json'));
  const coverage=await read(path.join(record,'case-coverage.json'));
  const assertions=await read(path.join(record,'assertions.json'));
  const files=await read(path.join(record,'results.json'));
  const selectedScope=suite==='full'?'selected':suite;
  if (manifest.kind!=='App' || manifest.scope!==selectedScope || manifest.outcome!=='passed' || manifest.exitCode!==0 ||
      !manifest.validation?.accepted || !allPassed(manifest.testSummary,ids.length) ||
      manifest.source?.kind!=='working-tree' || manifest.source.commit!==plan.sha || manifest.harness?.commit!==plan.sha ||
      !Array.isArray(manifest.source.workingTree) || manifest.source.workingTree.length ||
      !Array.isArray(manifest.harness.workingTree) || manifest.harness.workingTree.length ||
      manifest.software?.sha256!==identity.software || manifest.testSystem?.sha256!==identity.testSystem ||
      manifest.contract?.sha256!==identity.contract || manifest.selection?.extensionsIncluded!==false ||
      caseDigest(manifest.selection.caseIds)!==caseDigest(ids) ||
      !manifest.command?.args?.includes('--test-concurrency='+jobs) || !coverage.accepted ||
      caseDigest(coverage.cases.map(c=>c.id))!==caseDigest(ids) || coverage.cases.some(c=>c.status!=='passed') ||
      caseDigest(assertions.cases.map(c=>c.id))!==caseDigest(ids) || assertions.cases.some(c=>!(c.assertions>0)) ||
      caseDigest(files.cases.map(c=>c.id))!==caseDigest(ids) || files.cases.some(c=>c.status!=='passed')) {
    throw Error('Formal receipt does not match the clean candidate, required cases and execution settings');
  }
  if(cloud ? (manifest.github?.sha!==plan.sha || manifest.github.repository!==repository ||
      manifest.github.runId!==process.env.GITHUB_RUN_ID || manifest.github.runAttempt!==process.env.GITHUB_RUN_ATTEMPT ||
      manifest.environment?.compatibility?.mediaToolsRequired!==false) : Boolean(manifest.github)) {
    throw Error('Unexpected receipt origin or cloud media dependencies');
  }
  const tools=manifest.environment?.executables?.map(({name,sha256})=>({name,sha256}));
  if(!Array.isArray(tools)||!tools.some(x=>x.name==='node')||tools.some(x=>!isDigest(x.sha256)))throw Error('Missing runtime fingerprints');
  return {cases:ids.length,caseHash:caseDigest(ids),manifest:await hashFile(path.join(record,'manifest.json')),tools};
}

export async function executeFormal(repo, dir, plan, identity, {side, suite='full'}) {
  const ids=suite==='full'?plan[side]:plan.stageCases[suite];
  if (!ids?.length) return null;
  const jobs=suite==='full'&&side==='local'?2:1;
  console.log('Running '+side+' '+suite+' with '+ids.length+' cases and '+jobs+' worker(s)');
  const args=['scripts/test.mjs'];
  if(suite==='full'){
    const input=path.join(dir,side+'-cases.json');
    await fs.writeFile(input,JSON.stringify(ids),{flag:'wx'});
    args.push('--case-file',input);
  }
  args.push('--suite',suite,'--require-clean','--jobs',String(jobs));
  const stdout=await runLogged(repo,process.execPath,args,path.join(dir,suite+'-'+side+'.log'));
  const {record,marker}=recordFrom(repo,stdout,'MEDIASCOPE_RUN ',true);
  const summary=await summarizeFormal(repo,record,plan,identity,ids,suite,jobs,side==='cloud');
  if(summary.manifest!==marker.manifestSha256)throw Error('Formal record changed after it was written');
  return {summary,record};
}

export async function verifyOfflineInputs(repo){
  const lock=await read(path.join(repo,'runtime-lock.json'));
  for(const name of ['node','ffmpeg']){
    const file=path.join(repo,'.build','downloads',name+'.zip');
    const expected=lock.components.find(c=>c.name===name)?.sha256;
    const actual=await fileHash(file).catch(()=>null);
    if(!isDigest(expected)||actual!==expected)throw Error('Supply the locked runtime ZIP before starting deployment acceptance: '+file);
  }
}

export async function executeCommitCases(repo,dir,ids) {
  const expected=selectCases({cases:ids});
  if(expected.files.length!==1)throw Error('Commit self-test cases must share a file');
  const reporter=pathToFileURL(path.join(repo,'testing-tools/helpers/reporter.mjs')).href;
  const log=path.join(dir,'commit-events.jsonl');
  const stdout=await runLogged(repo,process.execPath,['--test','--test-concurrency=1','--test-reporter='+reporter,expected.files[0]],log);
  const rows=stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  const summary=rows.findLast(row=>row.type==='test:summary');
  const results=rows.filter(row=>row.type==='test:pass'||row.type==='test:fail')
    .map(({type,data})=>({event:type,...data,file:data.file?path.relative(repo,data.file).replaceAll('\\','/'):null}));
  const checks=rows.filter(row=>row.type==='test:stdout').flatMap(row=>String(row.data.message).split(/\r?\n/))
    .filter(line=>line.startsWith('MEDIASCOPE_CHECKS ')).map(line=>JSON.parse(line.slice('MEDIASCOPE_CHECKS '.length)));
  if(!allPassed(summary?.data?.counts,ids.length)||!assessCases(expected,results).accepted||
     caseDigest(checks.map(c=>c.caseId))!==caseDigest(ids)||checks.some(c=>!(c.assertions>0))) {
    throw Error('Commit self-test evidence does not cover the expected executed cases');
  }
  return {cases:ids.length,caseHash:caseDigest(ids),manifest:await hashFile(log)};
}

export async function deploymentBinding(repo, archive) {
  const bytes=await fs.readFile(archive);
  const {version}=await read(path.join(repo,'package.json'));
  const prefix='MediaScope-'+version+'-win-x64/';
  const members=new Map();
  for(const [name,data] of zipMembers(bytes)){
    const normalized=name.replaceAll('\\','/');
    if(!normalized.startsWith(prefix)||members.has(normalized.slice(prefix.length)))throw Error('Unexpected package root or duplicate member');
    members.set(normalized.slice(prefix.length),data);
  }
  const inputs=await Promise.all(['scripts/launcher/Launcher.cs','scripts/build-launcher.ps1','scripts/fast-bootstrap.mjs'].map(file=>fs.readFile(path.join(repo,file))));
  const binding=packagedSourceReadiness(members,await softwareIdentity(repo),{launcherFingerprint:digest(Buffer.concat(inputs))});
  if(!binding.accepted)throw Error('Package/source identity mismatch: '+binding.reasons.join(', '));
  return digest(bytes);
}

export async function executeDeployment(repo,dir,plan,stage,archive,packageHash) {
  console.log('Running local '+stage+' checks for '+packageHash);
  const kind=stage==='online'?'OnlineDeployment':'Package';
  const stdout=await runLogged(repo,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    'scripts/record-test.ps1','-Kind',kind,'-Archive',archive,'-RequireClean'],path.join(dir,stage+'.log'));
  const {record}=recordFrom(repo,stdout,'Evidence: ');
  verifySealed(repo,record);
  const manifest=await read(path.join(record,'manifest.json'));
  const checks=await read(path.join(record,'deployment-results.json'));
  if(manifest.kind!==kind||manifest.outcome!=='passed'||manifest.exitCode!==0||manifest.git?.commit!==plan.sha||
     manifest.git.dirty!==false||manifest.package?.sha256?.toLowerCase()!==packageHash||
     await hashFile(archive)!==packageHash||checks.outcome!=='passed'||checks.online!==(stage==='online')||
     !checks.checks?.length||checks.checks.some(c=>c.status!=='passed'))throw Error('Deployment evidence does not match the tested package and source');
  return {summary:{manifest:await hashFile(path.join(record,'manifest.json')),packageSha256:packageHash,checks:checks.checks.length},record};
}

export function verifyCaseSummary(summary,ids,{runtime=false}={}) {
  if(!ids.length){if(summary!==null)throw Error('Unexpected case receipt for empty partition');return;}
  if(!summary||summary.cases!==ids.length||summary.caseHash!==caseDigest(ids)||!isDigest(summary.manifest))throw Error('Case receipt differs from expected partition');
  if(runtime&&(!Array.isArray(summary.tools)||!summary.tools.some(x=>x.name==='node')||summary.tools.some(x=>!isDigest(x.sha256))))throw Error('Missing runtime fingerprints');
}

export function makeSignature(payload,privatePem) {
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Expected an Ed25519 private key');
  const bytes=Buffer.from(JSON.stringify(payload));
  return bytes.toString('base64url')+'.'+sign(null,bytes,key).toString('base64url');
}

export function verifyLocalReceipt(token,publicPem,plan,identity) {
  if(typeof token!=='string'||token.length>20000||!/^[-_a-zA-Z0-9]+\.[-_a-zA-Z0-9]+$/.test(token))throw Error('Missing or invalid signed local receipt');
  const [value,signature]=token.split('.').map(x=>Buffer.from(x,'base64url'));
  const key=createPublicKey(publicPem);
  if(key.asymmetricKeyType!=='ed25519'||!verify(null,value,key,signature))throw Error('Local receipt signature verification failed');
  const result=JSON.parse(value);
  if(result.schema!==1||result.side!=='local'||result.repository!==repository||result.sha!==plan.sha||
      result.plan!==plan.hash||!same(result.identity,identity)||
      !same(Object.keys(result.stages??{}),plan.stages))throw Error('Local receipt targets a different source, plan or stage set');
  verifyCaseSummary(result.general,plan.local,{runtime:true});
  for(const id of plan.stages){
    const proof=result.stages[id];
    if(plan.stageCases[id])verifyCaseSummary(proof,plan.stageCases[id],{runtime:true});
    else if(!isDigest(proof?.manifest)||!isDigest(proof?.packageSha256)||!Number.isSafeInteger(proof.checks)||proof.checks<1)throw Error('Missing deployment receipt');
  }
  const tools = new Map();
  for(const proof of [result.general,...Object.values(result.stages)])for(const tool of proof?.tools??[]){
    if(tools.has(tool.name)&&tools.get(tool.name)!==tool.sha256)throw Error('Local runtime changed between stages');
    tools.set(tool.name,tool.sha256);
  }
  if(result.stages.package&&result.stages.online&&result.stages.package.packageSha256!==result.stages.online.packageSha256)throw Error('Deployment receipts refer to different packages');
  return result;
}
