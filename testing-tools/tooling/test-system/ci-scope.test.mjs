import {projectTest} from '../../helpers/case-test.mjs';
import {workPath} from '../../helpers/workspace.mjs';
import assert from '../../helpers/assert.mjs';
const test = projectTest(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {assessScope, baselinePassed, checkDocuments, comparisonBase, documentationChanges, forcedMainRecovery} from '../../../scripts/ci-scope.mjs';
import {SplitGitHub} from '../../../scripts/split-test-github.mjs';
import {splitPlan} from '../../../scripts/split-test-plan.mjs';
import {repository} from '../../../scripts/split-test-receipts.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const successfulCheck = sha => ({name: 'Windows full regression', head_sha: sha,
  app: {slug: 'github-actions'}, status: 'completed', conclusion: 'success'});
const pushEvent = (before, after, ref = 'refs/heads/main') => ({before, after, ref, forced: false, deleted: false});
const raw = (file, status = 'M', oldMode = '100644', newMode = '100644') =>
  `:${oldMode} ${newMode} ${a} ${b} ${status}\0${file}\0`;

test('scope bases cover main, cumulative branch/tag changes, PR test merge and merge queue', () => {
  assert.equal(comparisonBase('push', pushEvent(a, b), b, c), a);
  assert.equal(comparisonBase('push', pushEvent(a, b, 'refs/heads/topic'), b, c), c);
  assert.equal(comparisonBase('push', pushEvent('0'.repeat(40), b, 'refs/tags/verify-main-docs'), b, c), c);
  assert.equal(comparisonBase('pull_request', {pull_request: {base: {ref: 'main', sha: a}, head: {sha: c}}}, b), a);
  assert.equal(comparisonBase('merge_group', {merge_group: {base_ref: 'refs/heads/main', base_sha: a, head_sha: b}}, b), a);
});

test('manual/release events, invalid identities, new main and force pushes require full regression', () => {
  for (const [name, event, sha, main] of [
    ['workflow_dispatch', {}, b], ['release', {}, b],
    ['push', pushEvent(a, b), c], ['push', {...pushEvent(a, b), forced: true}, b],
    ['push', {...pushEvent(a, b), deleted: true}, b], ['push', pushEvent('0'.repeat(40), b), b],
    ['push', {...pushEvent(a, b), forced: undefined}, b],
    ['push', pushEvent(a, b, 'refs/tags/v0.3.0'), b, c],
    ['push', pushEvent(a, b, 'refs/heads/topic'), b],
    ['pull_request', {pull_request: {base: {ref: 'other', sha: a}, head: {sha: c}}}, b],
    ['merge_group', {merge_group: {base_ref: 'refs/heads/main', base_sha: a, head_sha: c}}, b],
  ]) assert.throws(() => comparisonBase(name, event, sha, main));
  const recovery = {before:a, after:b, base:c};
  const forced = {...pushEvent(a, b), forced:true};
  const config = JSON.stringify(recovery);
  assert.deepEqual(forcedMainRecovery(config, forced, b), recovery);
  assert.throws(() => forcedMainRecovery('', forced, b), /not authorized/);
  assert.throws(() => forcedMainRecovery(config, {...forced, before:c}, b), /authorized SHA pair/);
  assert.throws(() => forcedMainRecovery(config, {...forced, after:c}, c), /authorized SHA pair/);
  for (const invalid of [{...forced, forced:false}, {...forced, deleted:true}, {...forced, ref:'refs/heads/topic'}]) {
    assert.throws(() => forcedMainRecovery(config, invalid, b), /Invalid main history recovery event/);
  }
  assert.throws(() => forcedMainRecovery(JSON.stringify({...recovery, base:'main'}), forced, b), /authorized SHA pair/);
});

test('only existing regular Markdown modifications are documentation candidates', () => {
  assert.deepEqual(documentationChanges(raw('README.md') + raw('docs/json-format.md')), ['README.md', 'docs/json-format.md']);
  for (const value of ['', raw('README.md').slice(0, -1), raw('engine.mjs'),


     raw('.github/workflows/tests.yml'), raw('package.json'),
    raw('README.md', 'A'), raw('README.md', 'D'), raw('README.md', 'R100'),
    raw('README.md', 'M', '100644', '100755'), raw('README.md', 'M', '100644', '120000'),
    raw('README.md') + raw('scripts/ci-scope.mjs'),
  ]) assert.equal(documentationChanges(value), null, value);
});

test('baseline requires completed successful checks from the expected SHA and GitHub app', async t => {
  assert.equal(baselinePassed([successfulCheck(a)], a), true);
  for (const checks of [[], [successfulCheck(b)], [{...successfulCheck(a), app: {slug: 'other'}}],
    [{...successfulCheck(a), name: 'Other check'}], [{...successfulCheck(a), status: 'in_progress'}],
    ...['failure', 'cancelled', 'skipped', 'neutral', null].map(conclusion => [{...successfulCheck(a), conclusion}]),
    [successfulCheck(a), {...successfulCheck(a), conclusion: 'failure'}],
  ]) assert.equal(baselinePassed(checks, a), false);

  const owner = {id:1,type:'User'};
  const repo = {full_name:repository,owner};
  const run = (id, type, conclusion = 'success') => ({
    id,path:'.github/workflows/tests.yml',event:'workflow_dispatch',head_sha:a,
    head_branch:'verify-main-'+type+'-test',repository:repo,head_repository:repo,
    created_at:new Date(id * 1000).toISOString(),status:'completed',conclusion,run_attempt:1
  });
  const normal = run(1,'full'), recovery = run(2,'recovery');
  let runs = [normal,recovery];
  const reader = new SplitGitHub('',null,{get:async route=>{
    if(route.includes('/runs?'))return {data:{total_count:runs.length,workflow_runs:runs}};
    if(route==='')return {data:repo};
    assert.match(route,/\/approvals$/);
    return {data:[{state:'approved',user:owner,environments:[{name:'mediascope-local-evidence'}]}]};
  }});
  const readReceipt = reader.receipt.bind(reader);
  reader.receipt = async (origin, requirements) => {
    if(origin.conclusion!=='success'||origin.status!=='completed')return readReceipt(origin,requirements);
    return {
      proof:{schema:2,kind:'split-acceptance',scope:'full',sha:a,
        github:{repository,runId:String(origin.id),runAttempt:'1',ref:'refs/tags/'+origin.head_branch}},
      jobs:[{name:'Review MediaScope local evidence',head_sha:a,run_id:origin.id,run_attempt:1,status:'completed',conclusion:'success'}]
    };
  };
  const failedRecovery = run(3,'recovery','failure');
  runs = [normal,recovery,failedRecovery];
  assert.equal((await reader.previousAcceptance(a)).origin.id,normal.id);
  await reader.verifyAnchor({scope:'selected',anchor:a});
  await assert.rejects(reader.previousAcceptance(a,{recovery:true}), /missing a completed passing result/);

  const failedNormal = run(4,'full','failure');
  runs = [normal,recovery,failedNormal];
  assert.equal((await reader.previousAcceptance(a,{recovery:true})).origin.id,recovery.id);
  await assert.rejects(reader.previousAcceptance(a), /missing a completed passing result/);
  await assert.rejects(reader.verifyAnchor({scope:'selected',anchor:a}), /missing a completed passing result/);

  runs = [recovery];
  await assert.rejects(reader.verifyAnchor({scope:'selected',anchor:a}), /Required GitHub execution has not been recorded/);

  const f = fixture(t);
  const base = f.commit({'runtime-lock.json':'{}\n'});
  const docSha = f.commit({'README.md':'# Recover this revision\n'});
  const planRecovery = {before:f.base,after:docSha,base};
  const recovered = splitPlan(f.repo,{sha:docSha,base,forceFull:true,recovery:planRecovery});
  assert.equal(recovered.scope,'full');
  assert.equal(recovered.release,false);
  assert.deepEqual(recovered.stages,['gpu','native','package','online']);
  assert.notEqual(recovered.hash,splitPlan(f.repo,{sha:docSha,base,forceFull:true,recovery:{...planRecovery,before:a}}).hash);
  assert.throws(() => splitPlan(f.repo,{sha:docSha,base,forceFull:true,anchor:base,recovery:planRecovery}), /authorized baseline/);
  assert.throws(() => splitPlan(f.repo,{sha:docSha,base,recovery:planRecovery}), /full non-release acceptance/);
});

const temporaryRoot = workPath('ci-scope');
function fixture(t) {
  fs.mkdirSync(temporaryRoot, {recursive: true});
  const repo = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  t.after(() => {
    assert.ok(path.resolve(repo).startsWith(path.resolve(temporaryRoot) + path.sep + 'case-'));
    fs.rmSync(repo, {recursive: true, force: true});
  });
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=CI scope test',
    '-c', 'user.email=ci-scope@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(repo, 'unused-hooks')}`, ...args],
    {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '--initial-branch=main', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const commit = files => {
    for (const [file, value] of Object.entries(files)) {
      const target = path.join(repo, file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, value);
    }
    git('add', '--all');
    git('commit', '--quiet', '-m', 'test: prepare scope fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = commit({'README.md': '# Guide\n', 'docs/json-format.md': '# Format\n', 'engine.mjs': '// baseline\n', 'docs/testing.md':'# Policy\n', '.gitattributes':fs.readFileSync(new URL('../../../.gitattributes',import.meta.url))});
  return {repo, git, commit, base, options: sha => ({repo, sha, eventName: 'push', event: pushEvent(base, sha),
    readChecks: async () => [successfulCheck(base)]})};
}

test('real Git comparison admits explanatory changes and validates links, UTF-8 and fences', async t => {
  const f = fixture(t);
  const sha = f.commit({'README.md': '# Guide updated\n\n[Format](docs/json-format.md#fields)\n\n[ref]: docs/json-format.md\n\n```text\n[example](missing.md)\n```\n'});
  const result = await assessScope(f.options(sha));
  assert.equal(result.scope, 'docs-only');
  assert.deepEqual(checkDocuments(f.repo, result), {documents: 1, localLinks: 2, whitespace: 'passed', utf8: 'passed', fences: 'passed'});
});

test('mixed changes and new documents require full regression without consulting baseline checks', async t => {
  const f = fixture(t);
  const sha = f.commit({'README.md': '# Guide updated\n', 'engine.mjs': '// modified\n', 'docs/new.md': '# New\n'});
  const result = await assessScope({...f.options(sha), readChecks: () => {throw Error('Must not be called')}});
  assert.equal(result.scope, 'full');
  assert.match(result.reason, /non-Markdown/);
});

test('branch comparison includes earlier code changes even when the latest push only changes docs', async t => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/main', f.base);
  const before = f.commit({'engine.mjs': '// unverified code\n'});
  const sha = f.commit({'README.md': '# Latest documentation\n'});
  const result = await assessScope({...f.options(sha), event: pushEvent(before, sha, 'refs/heads/topic')});
  assert.equal(result.scope, 'full');
  assert.equal(result.base, f.base);
});

test('verification tags can validate documentation before main accepts the same SHA', async t => {
  const f = fixture(t);
  f.git('update-ref', 'refs/remotes/origin/main', f.base);
  const sha = f.commit({'README.md': '# Updated\n'});
  const result = await assessScope({...f.options(sha), event: pushEvent('0'.repeat(40), sha, 'refs/tags/verify-main-docs')});
  assert.equal(result.scope, 'docs-only');
  assert.equal(result.base, f.base);
});

test('missing/failed baseline checks, API failures, missing objects and inconsistent checkout default to full', async t => {
  const f = fixture(t);
  const sha = f.commit({'README.md': '# Updated\n'});
  for (const readChecks of [async () => [], async () => [{...successfulCheck(f.base), conclusion: 'failure'}],
    async () => {throw Error('API unavailable')}]) {
    assert.equal((await assessScope({...f.options(sha), readChecks})).scope, 'full');
  }
  assert.equal((await assessScope({...f.options(sha), event: pushEvent(a, sha)})).scope, 'full');
  const unrelated = f.git('commit-tree', `${f.base}^{tree}`, '-m', 'test: unrelated history');
  assert.equal((await assessScope({...f.options(sha), event: pushEvent(unrelated, sha)})).scope, 'full');
  assert.equal((await assessScope(f.options(f.base))).scope, 'full');
  assert.equal((await assessScope({...f.options(sha), eventName: 'workflow_dispatch', event: {}})).scope, 'full');
});

test('PR and merge queue classify the tested result; missing PR head ancestry is rejected', async t => {
  const f = fixture(t);
  const sha = f.commit({'README.md': '# Updated\n'});
  const pull_request = {base: {ref: 'main', sha: f.base}, head: {sha}};
  assert.equal((await assessScope({...f.options(sha), eventName: 'pull_request', event: {pull_request}})).scope, 'full');
  assert.equal((await assessScope({...f.options(sha), eventName: 'pull_request',
    event: {pull_request: {...pull_request, head: {sha: a}}}})).scope, 'full');
  assert.equal((await assessScope({...f.options(sha), eventName: 'merge_group',
    event: {merge_group: {base_ref: 'refs/heads/main', base_sha: f.base, head_sha: sha}}})).scope, 'full');
});

test('broken local links, whitespace errors, malformed UTF-8 and unclosed examples fail lightweight checks', async t => {
  const f = fixture(t);
  for (const value of ['# Guide\n\n[missing](docs/missing.md)\n', '# Guide  \n',
    Buffer.from([0xff]), '# Guide\n\n```text\nexample\n', '# Guide\n\0', '# Guide\n\n[escape](../outside.md)\n']) {
    const sha = f.commit({'README.md': value});
    const result = await assessScope(f.options(sha));
    assert.equal(result.scope, 'docs-only');
    assert.throws(() => checkDocuments(f.repo, result));
  }
});

test('reviewed guides have valid current local links', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true}).trim();
  const result = checkDocuments(repo, {base: sha, testedSha: sha, files: ['README.md','docs/chart-controls.md']});
  assert.equal(result.documents, 2);
});

test('CLI emits scope output, an exact-commit report and an explicit documentation-only summary', async t => {
  const f = fixture(t);
  const sourceScript = fileURLToPath(new URL('../../../scripts/ci-scope.mjs', import.meta.url));
  const base = f.commit({'scripts/ci-scope.mjs': fs.readFileSync(sourceScript)});
  const sha = f.commit({'README.md': '# Updated\n\n[Format](docs/json-format.md)\n'});
  const eventPath = path.join(f.repo, '.build/event.json');
  fs.mkdirSync(path.dirname(eventPath), {recursive: true});
  fs.writeFileSync(eventPath, JSON.stringify(pushEvent(base, sha)));
  const output = path.join(f.repo, '.build/output'), summary = path.join(f.repo, '.build/summary');
  let status = 200, payload = {total_count: 1, check_runs: [successfulCheck(base)]};
  const server = createServer((request, response) => {
    assert.match(request.url, new RegExp(`/commits/${base}/check-runs\\?`));
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = eventName => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.repo, 'scripts/ci-scope.mjs')], {windowsHide: true,
      env: {...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, GITHUB_SHA: sha,
        GITHUB_REPOSITORY: 'fixture/repo', GITHUB_TOKEN: 'test-only', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary}});
    let log = '';
    child.stdout.on('data', value => log += value);
    child.stderr.on('data', value => log += value);
    child.once('error', reject);
    child.once('exit', code => resolve({code, log}));
  });
  const docs = await run('push');
  assert.equal(docs.code, 0, docs.log);
  assert.match(fs.readFileSync(output, 'utf8'), /^scope=docs-only\n$/, docs.log);
  assert.match(fs.readFileSync(summary, 'utf8'), /not release acceptance/);
  const report = JSON.parse(fs.readFileSync(path.join(f.repo, '.build/ci-scope.json')));
  assert.equal(report.testedSha, sha);
  assert.equal(report.productRegressionPerformed, false);
  assert.equal(report.releaseAcceptance, false);
  assert.equal(report.documentationChecks.localLinks, 1);
  const manual = await run('workflow_dispatch');
  assert.equal(manual.code, 0, manual.log);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, '.build/ci-scope.json'))).scope, 'full');
  for (const [httpStatus, body] of [[403, {message: 'not permitted'}],
    [200, {check_runs: [successfulCheck(base)]}],
    [200, {total_count: 2, check_runs: [successfulCheck(base)]}],
    [200, {total_count: 1, check_runs: [{...successfulCheck(base), status: 'in_progress'}]}]]) {
    status = httpStatus;
    payload = body;
    const fallback = await run('push');
    assert.equal(fallback.code, 0, fallback.log);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, '.build/ci-scope.json'))).scope, 'full');
  }
});

test('policy documents and changes to file roles retain full regression',async t=>{const f=fixture(t);const sha=f.commit({'docs/testing.md':'# Updated policy\n'});const r=await assessScope(f.options(sha));assert.equal(r.scope,'full');assert.match(r.reason,/roles/);});
