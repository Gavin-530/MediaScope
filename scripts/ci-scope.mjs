import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// File roles are project policy in .gitattributes, read from the exact tested commit.
const validSha = value => /^[a-f0-9]{40}$/.test(value || '') && !/^0+$/.test(value);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args],
  {windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});

export function comparisonBase(eventName, event, sha, mainSha) {
  if (!validSha(sha)) throw Error('Missing exact tested SHA');
  if (eventName === 'push') {
    if (event.deleted !== false || event.forced !== false || event.after !== sha) throw Error('Deleted, forced or inconsistent push');
    if (event.ref === 'refs/heads/main') {
      if (!validSha(event.before)) throw Error('New main has no comparison baseline');
      return event.before;
    }
    if (!event.ref?.startsWith('refs/heads/') && !event.ref?.startsWith('refs/tags/verify-main-')) {
      throw Error('Unsupported push ref');
    }
    if (!validSha(mainSha)) throw Error('Missing main baseline');
    return mainSha;
  }
  if (eventName === 'pull_request' && event.pull_request?.base?.ref === 'main' &&
      validSha(event.pull_request.base.sha) && validSha(event.pull_request.head?.sha)) {
    return event.pull_request.base.sha;
  }
  if (eventName === 'merge_group' && event.merge_group?.base_ref === 'refs/heads/main' &&
      event.merge_group.head_sha === sha && validSha(event.merge_group.base_sha)) {
    return event.merge_group.base_sha;
  }
  throw Error('Manual, release or unsupported event requires full regression');
}

export function documentationChanges(raw) {
  const fields = raw.split('\0');
  if (fields.pop() !== '' || !fields.length || fields.length % 2) return null;
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    // Only modifications of existing regular files qualify; renames, deletions and links do not.
    if (!/^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M$/.test(fields[i]) ||
        !fields[i + 1].endsWith('.md')) return null;
    files.push(fields[i + 1]);
  }
  return files;
}

export function baselinePassed(checks, sha) {
  const matching = checks.filter(check => check.name === 'Windows full regression' &&
    check.head_sha === sha && check.app?.slug === 'github-actions');
  return matching.length > 0 && matching.every(check => check.status === 'completed' && check.conclusion === 'success');
}

async function githubChecks(sha) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !process.env.GITHUB_TOKEN) {
    throw Error('Baseline checks unavailable');
  }
  const url = `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repository}/commits/${sha}/check-runs?check_name=Windows%20full%20regression&filter=latest&per_page=100`;
  const response = await fetch(url, {headers: {Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`}, redirect: 'error', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw Error(`Baseline checks unavailable (HTTP ${response.status})`);
  const body = await response.json();
  if (!Array.isArray(body.check_runs) || !Number.isInteger(body.total_count) ||
      body.total_count !== body.check_runs.length || body.total_count > 100) throw Error('Incomplete baseline checks');
  return body.check_runs;
}

export async function assessScope({repo, eventName, event, sha, readChecks = githubChecks}) {
  const result = {schema: 1, scope: 'full', testedSha: sha, event: eventName, productRegressionPerformed: false,
    releaseAcceptance: false};
  try {
    if(eventName !== 'push') throw Error('PR, merge queue and manual runs retain full regression');
    if (git(repo, 'rev-parse', 'HEAD').toString().trim() !== sha) throw Error('Checkout differs from tested SHA');
    let mainSha;
    if (eventName === 'push' && event.ref !== 'refs/heads/main') {
      mainSha = git(repo, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}').toString().trim();
    }
    const base = comparisonBase(eventName, event, sha, mainSha);
    result.base = base;
    git(repo, 'merge-base', '--is-ancestor', base, sha);
    if (eventName === 'pull_request') git(repo, 'merge-base', '--is-ancestor', event.pull_request.head.sha, sha);
    const files = documentationChanges(git(repo, 'diff', '--raw', '--no-abbrev', '-z', '--no-renames',
      '--no-ext-diff', base, sha, '--').toString('utf8'));
    if (!files) throw Error('Changes are empty or include non-Markdown or non-regular file changes');
    result.files = files;
    const attributes=git(repo,'check-attr','--source='+sha,'-z','mediascope-validation','--',...files).toString().split('\0');
    if(attributes.pop()!==''||attributes.length!==files.length*3||files.some((file,index)=>
      attributes[index*3]!==file||attributes[index*3+1]!=='mediascope-validation'||attributes[index*3+2]!=='docs'))
      throw Error('File roles do not permit documentation-only validation');
    const checks = await readChecks(base);
    result.baselineChecks = checks.filter(check => check.name === 'Windows full regression').map(check =>
      ({id: check.id, sha: check.head_sha, app: check.app?.slug, status: check.status, conclusion: check.conclusion, url: check.details_url}));
    if (!baselinePassed(checks, base)) throw Error('Baseline has missing, pending or unsuccessful required regression checks');
    result.scope = 'docs-only';
    result.reason = 'Only reviewed explanatory documents changed from a baseline with successful regression-gate checks';
  } catch (error) {
    result.reason = error.message;
  }
  return result;
}

export function checkDocuments(repo, result) {
  git(repo, 'diff', '--check', '--no-ext-diff', result.base, result.testedSha, '--');
  let localLinks = 0;
  for (const file of result.files) {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(git(repo, 'show', `${result.testedSha}:${file}`));
    if (!text.trim() || text.includes('\0')) throw Error(`Empty or invalid document: ${file}`);
    // Check ordinary inline and reference-style local links outside fenced examples.
    let fence;
    const prose = text.split(/\r?\n/).filter(line => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!fence && marker) { fence = marker[1]; return false; }
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
        return false;
      }
      return true;
    }).join('\n');
    if (fence) throw Error(`Unclosed fenced code block: ${file}`);
    const links = [...prose.matchAll(/\[[^\]\r\n]*\]\(<?([^\s<>)]*)>?(?:\s+"[^"\r\n]*")?\)/g),
      ...prose.matchAll(/^ {0,3}\[[^\]\r\n]+\]:\s*<?([^\s<>]+)>?/gm)];
    for (const [, href] of links) {
      if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      const link = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      const target = path.posix.normalize(link.startsWith('/') ? link.slice(1) : path.posix.join(path.posix.dirname(file), link));
      if (!target || target === '..' || target.startsWith('../') || target.includes('\\')) throw Error(`Link escapes repository: ${file}`);
      try { git(repo, 'cat-file', '-e', `${result.testedSha}:${target}`); }
      catch { throw Error(`Missing local link target in ${file}: ${target}`); }
      localLinks++;
    }
  }
  return {documents: result.files.length, localLinks, whitespace: 'passed', utf8: 'passed', fences: 'passed'};
}

async function main() {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await assessScope({repo, eventName: process.env.GITHUB_EVENT_NAME, event, sha: process.env.GITHUB_SHA});
  result.github = {repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB};
  if (result.scope === 'docs-only') result.documentationChecks = checkDocuments(repo, result);
  fs.mkdirSync(path.join(repo, '.build'), {recursive: true});
  fs.writeFileSync(path.join(repo, '.build/ci-scope.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
  const summary = `## CI scope: ${result.scope}\n\nTested commit: \`${result.testedSha}\`\n\n${result.reason}\n\n` +
    (result.scope === 'docs-only' ? 'Documentation checks passed. Full product regression was not run; this is not release acceptance.\n' : 'Full product regression is required; its results are recorded separately.\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
