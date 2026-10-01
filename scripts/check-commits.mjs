import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Existing published history is exempt by identity, not by branch or date.
export const baseline = 'fc648355fcc12e1a07003fd75746cedf8a73bdba';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const header = /^(feat|fix|perf|refactor|test|docs|style|ci|build|chore|revert)(?:\(([a-z0-9]+(?:[-/.][a-z0-9]+)*)\))?(!)?: (\S(?:.*\S)?)$/u;
const versionPattern = /\b\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?\b/g;

export function validateMessage(message, {parents = 0, titleOnly = false, version} = {}) {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const title = lines[0];
  // These exceptions depend on commit metadata or a complete Git revert record.
  if (!titleOnly && parents > 1 && title.startsWith('Merge ')) return [];
  if (!titleOnly && /^Revert ".+"$/.test(title) && lines[1] === '' &&
      /^This reverts commit [a-f0-9]{40}\.$/m.test(lines.slice(2).join('\n'))) return [];
  const errors = [];
  if (titleOnly && lines.length !== 1) errors.push('PR title must be a single line.');
  const match = header.exec(title);
  if (!match) errors.push('Use type(scope): description with a supported lowercase type and optional scope.');
  if (Array.from(title).length > 72) errors.push('Title exceeds 72 Unicode characters. Move details into the body.');
  if (/[\u0000-\u001f\u007f]/u.test(title)) errors.push('Title contains a control character.');
  if (/[.。]$/u.test(title)) errors.push('Omit the final period in the title.');
  if (!titleOnly && lines.length > 1 && lines[1].trim()) errors.push('Separate the title and body with a blank line.');
  const body = lines.slice(2).join('\n');
  const breaking = /^BREAKING[ -]CHANGE: \S.*$/m.test(body);
  if (!titleOnly && match?.[3] && !breaking) errors.push('A ! title requires BREAKING CHANGE: impact and migration guidance.');
  if (!titleOnly && /^BREAKING[ -]CHANGE:/m.test(body) && !breaking) errors.push('BREAKING CHANGE needs a nonempty explanation.');
  if (match?.[1] === 'chore' && match[2] === 'release' && version !== undefined) {
    const mentioned = title.match(versionPattern) || [];
    if (mentioned.some(value => value !== version)) errors.push(`Release title version must match package.json (${version}).`);
  }
  return errors;
}

function git(repo, ...args) {
  return execFileSync('git', ['--no-pager', '--no-replace-objects', '-C', repo, ...args],
    {encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
}

function resolve(repo, ref) {
  if (typeof ref !== 'string' || !ref) throw Error('Missing commit reference.');
  return git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
}

export function eventRange(event, eventName, policyBase = baseline) {
  if (event.pull_request) {
    if (typeof event.pull_request.title !== 'string') throw Error('PR event is missing its title.');
    return {base: event.pull_request.base.sha, head: event.pull_request.head.sha, title: event.pull_request.title};
  }
  if (event.merge_group) return {base: event.merge_group.base_sha, head: event.merge_group.head_sha};
  if (eventName === 'workflow_dispatch') return {base: policyBase, head: 'HEAD'};
  if (event.deleted === true) return {deleted: true};
  if (typeof event.before === 'string' && typeof event.after === 'string') {
    return {base: /^0+$/.test(event.before) ? policyBase : event.before, head: event.after};
  }
  throw Error('Unsupported or incomplete GitHub event; cannot determine the commit range.');
}

export function checkHistory({repo = project, base = baseline, head = 'HEAD', policyBase = baseline, title} = {}) {
  const exempt = resolve(repo, policyBase);
  const from = resolve(repo, base);
  const to = resolve(repo, head);
  // ^exempt excludes precisely the baseline's ancestors, including merged branches.
  const commits = git(repo, 'rev-list', '--reverse', `${from}..${to}`, `^${exempt}`).trim().split('\n').filter(Boolean);
  const failures = [];
  const packageVersion = commit => JSON.parse(git(repo, 'show', `${commit}:package.json`)).version;
  if (title !== undefined) {
    if (typeof title !== 'string') throw Error('PR title must be a string.');
    const needsVersion = /^chore\(release\)/.test(title);
    const errors = validateMessage(title, {titleOnly: true, ...(needsVersion ? {version: packageVersion(to)} : {})});
    if (errors.length) failures.push({commit: 'PR title', errors});
  }
  for (const commit of commits) {
    const message = git(repo, 'show', '-s', '--format=%B', commit);
    const parents = git(repo, 'show', '-s', '--format=%P', commit).trim().split(' ').filter(Boolean).length;
    const needsVersion = /^chore\(release\)/.test(message);
    const errors = validateMessage(message, {parents, ...(needsVersion ? {version: packageVersion(commit)} : {})});
    if (needsVersion) {
      const entries = git(repo, 'ls-tree', '--name-only', commit, '--', 'package-lock.json').trim();
      if (entries) {
        const lock = JSON.parse(git(repo, 'show', `${commit}:package-lock.json`));
        const version = packageVersion(commit);
        if (lock.version !== version || (lock.lockfileVersion >= 2 && lock.packages?.['']?.version !== version)) {
          errors.push('Release package-lock.json versions must match package.json.');
        }
      }
    }
    if (errors.length) failures.push({commit: commit.slice(0, 7), errors});
  }
  return {checked: commits.length, titleChecked: title !== undefined, failures};
}

export function main(args = process.argv.slice(2)) {
  let file, range, eventFile;
  while (args.length) {
    const option = args.shift();
    if (!['--file', '--range', '--event'].includes(option)) throw Error(`Unknown argument: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${option}`);
    if ((option === '--file' && file) || (option === '--range' && range) || (option === '--event' && eventFile)) {
      throw Error(`Duplicate argument: ${option}`);
    }
    if (option === '--file') file = value;
    if (option === '--range') range = value;
    if (option === '--event') eventFile = value;
  }
  if ([file, range, eventFile].filter(Boolean).length > 1) throw Error('Use one of --file, --range, or --event.');
  let result;
  if (file) {
    const errors = validateMessage(fs.readFileSync(file, 'utf8'));
    result = {checked: 1, titleChecked: false, failures: errors.length ? [{commit: 'Message file', errors}] : []};
  } else if (eventFile) {
    const selection = eventRange(JSON.parse(fs.readFileSync(eventFile, 'utf8')), process.env.GITHUB_EVENT_NAME);
    if (selection.deleted) {
      console.log('Deleted ref: no new commits to check.');
      return 0;
    }
    result = checkHistory(selection);
  } else {
    let base = baseline, head = 'HEAD';
    if (range) {
      const refs = range.split('..');
      if (refs.length !== 2 || refs.some(ref => !ref || ref.startsWith('.'))) throw Error('Range must be base..head (two dots).');
      [base, head] = refs;
    }
    result = checkHistory({base, head});
  }
  for (const failure of result.failures) {
    console.error(failure.commit);
    for (const error of failure.errors) console.error(`  - ${error}`);
  }
  console.log(`Checked ${result.checked} new commit(s)${result.titleChecked ? ' and PR title' : ''}; ${result.failures.length} failure(s). Existing history remains exempt.`);
  return result.failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {process.exitCode = main();}
  catch (error) {console.error(`Commit check blocked: ${error.message}`); process.exitCode = 2;}
}
