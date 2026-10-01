import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateMessage, checkHistory, eventRange} from './check-commits.mjs';

const checker = fileURLToPath(new URL('./check-commits.mjs', import.meta.url));

test('accepts scoped and unscoped English/Chinese messages and optional bodies', () => {
  for (const message of ['fix(report): improve light-theme contrast', 'docs: clarify installation',
    'test(server): cover blocked ports\n\nExercise HTTP startup with an OS-selected blocked port.',
    'fix(ui): 修复紧凑视图任务状态不同步', 'style: normalize indentation']) {
    assert.deepEqual(validateMessage(message), []);
  }
});

test('rejects malformed headers, control characters, periods and missing blank lines', () => {
  for (const message of ['update things', 'release: prepare 0.2.3', 'Fix: repair report', 'fix(): repair report',
    'fix(UI): repair report', 'fix: repair report ', 'fix: repair report.', 'fix: 修复报告。',
    'fix: repair\treport', 'fix: repair report\nExplanation without blank line']) {
    assert.ok(validateMessage(message).length, message);
  }
});

test('enforces the 72-character boundary using Unicode code points', () => {
  assert.deepEqual(validateMessage('fix: ' + '字'.repeat(67)), []);
  assert.ok(validateMessage('fix: ' + '字'.repeat(68)).some(error => error.includes('72')));
  assert.deepEqual(validateMessage('fix: ' + '😀'.repeat(67)), []);
});

test('requires an explanation for breaking changes but accepts a PR ! title', () => {
  assert.ok(validateMessage('feat(report)!: change saved format').length);
  assert.deepEqual(validateMessage('feat(report)!: change saved format', {titleOnly: true}), []);
  assert.ok(validateMessage('fix: valid title\nextra title text', {titleOnly: true}).length);
  assert.deepEqual(validateMessage('feat(report)!: change saved format\n\nBREAKING CHANGE: Import old reports before upgrading.'), []);
  assert.ok(validateMessage('feat: change format\n\nBREAKING CHANGE: ').length);
});

test('permits actual generated merges and reverts without exempting fake merge titles', () => {
  assert.deepEqual(validateMessage('Merge pull request #7 from contributor/feature', {parents: 2}), []);
  assert.ok(validateMessage('Merge pull request #7 from contributor/feature', {parents: 1}).length);
  assert.ok(validateMessage('Merge pull request #7 from contributor/feature', {titleOnly: true}).length);
  assert.deepEqual(validateMessage('Revert "add feature"\n\nThis reverts commit ' + 'a'.repeat(40) + '.'), []);
  assert.ok(validateMessage('Revert "add feature"').length);
});

test('release versions are checked when snapshot identity is available', () => {
  assert.deepEqual(validateMessage('chore(release): prepare 0.2.3', {version: '0.2.3'}), []);
  assert.deepEqual(validateMessage('chore(release): prepare 0.3.0-rc.1', {version: '0.3.0-rc.1'}), []);
  assert.ok(validateMessage('chore(release): prepare 0.3.0', {version: '0.2.3'}).length);
  assert.ok(validateMessage('chore(release): change 0.3.0 to 0.2.3', {version: '0.2.3'}).length);
});

test('selects push, new branch, PR, merge queue, manual and deleted-ref ranges', () => {
  assert.deepEqual(eventRange({before: 'a', after: 'b'}, 'push', 'base'), {base: 'a', head: 'b'});
  assert.deepEqual(eventRange({before: '0'.repeat(40), after: 'b'}, 'push', 'base'), {base: 'base', head: 'b'});
  const title = 'fix(ui): display a literal $(echo example)';
  assert.deepEqual(eventRange({pull_request: {base: {sha: 'a'}, head: {sha: 'b'}, title}}, 'pull_request'), {base: 'a', head: 'b', title});
  assert.deepEqual(eventRange({merge_group: {base_sha: 'a', head_sha: 'b'}}, 'merge_group'), {base: 'a', head: 'b'});
  assert.deepEqual(eventRange({}, 'workflow_dispatch', 'base'), {base: 'base', head: 'HEAD'});
  assert.deepEqual(eventRange({deleted: true}, 'push'), {deleted: true});
  assert.throws(() => eventRange({}, 'push'), /incomplete/);
  assert.throws(() => eventRange({pull_request: {base: {sha: 'a'}, head: {sha: 'b'}}}, 'pull_request'), /missing its title/);
});

// Use real Git objects: these are governance fixtures, not simulated media tests.
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mediascope-commit-policy-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Commit policy test',
    '-c', 'user.email=commit-policy@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(repo, 'unused-hooks')}`, ...args],
    {encoding: 'utf8', windowsHide: true}).trim();
  git('init', '--initial-branch=main', '--quiet');
  git('config', 'core.autocrlf', 'false');
  let sequence = 0;
  const commit = (message, files = {}) => {
    fs.writeFileSync(path.join(repo, 'sequence.txt'), String(++sequence));
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), value);
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const policyBase = commit('Legacy title is deliberately retained', {'package.json': '{"version":"0.2.2"}'});
  return {repo, git, commit, policyBase};
}

test('exempts the exact old history and detects new malformed commits on an older branch', () => {
  const f = fixture();
  const oldTip = f.commit('Another legacy title');
  const good = f.commit('docs: add contribution rules');
  assert.equal(checkHistory({repo: f.repo, base: oldTip, head: good, policyBase: oldTip}).checked, 1);
  f.git('checkout', '--quiet', '--detach', f.policyBase);
  const bad = f.commit('A new invalid title on an old branch');
  const result = checkHistory({repo: f.repo, base: oldTip, head: bad, policyBase: oldTip});
  assert.equal(result.checked, 1);
  assert.equal(result.failures[0].commit, bad.slice(0, 7));
});

test('checks every commit snapshot version and lockfile, rather than only the current version', () => {
  const f = fixture();
  f.commit('chore(release): prepare 0.2.3', {
    'package.json': '{"version":"0.2.3"}',
    'package-lock.json': '{"lockfileVersion":3,"version":"0.2.3","packages":{"":{"version":"0.2.3"}}}'
  });
  const bad = f.commit('chore(release): prepare 0.3.0');
  const lockBad = f.commit('chore(release): prepare 0.2.4', {
    'package.json': '{"version":"0.2.4"}',
    'package-lock.json': '{"lockfileVersion":3,"version":"0.2.3","packages":{"":{"version":"0.2.4"}}}'
  });
  const result = checkHistory({repo: f.repo, base: f.policyBase, policyBase: f.policyBase});
  assert.equal(result.checked, 3);
  assert.deepEqual(result.failures.map(failure => failure.commit), [bad.slice(0, 7), lockBad.slice(0, 7)]);
  assert.deepEqual(checkHistory({repo: f.repo, base: f.policyBase, policyBase: f.policyBase, title: 'chore(release): prepare 0.3.0'}).failures.at(0).commit, 'PR title');
  const rootMissing = f.commit('chore(release): prepare 0.2.4', {
    'package-lock.json': '{"lockfileVersion":3,"version":"0.2.4","packages":{}}'
  });
  const missingResult = checkHistory({repo: f.repo, base: lockBad, head: rootMissing, policyBase: f.policyBase});
  assert.match(missingResult.failures[0].errors[0], /package-lock/);
});

test('checks a real merge and still reports invalid commits introduced by that merge', () => {
  const f = fixture();
  f.git('checkout', '--quiet', '-b', 'feature');
  const bad = f.commit('Invalid feature title', {'feature.txt': 'feature'});
  f.git('checkout', '--quiet', 'main');
  f.git('merge', '--no-ff', '--quiet', 'feature', '-m', 'Merge branch feature');
  const result = checkHistory({repo: f.repo, base: f.policyBase, policyBase: f.policyBase});
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].commit, bad.slice(0, 7));
});

test('CLI returns distinct failure and infrastructure codes and never executes message text', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mediascope-commit-message-'));
  const file = path.join(folder, 'message.txt');
  fs.writeFileSync(file, 'fix(ui): display a literal $(echo example)\n');
  const invoke = (...args) => spawnSync(process.execPath, [checker, ...args], {cwd: folder, encoding: 'utf8', windowsHide: true});
  assert.equal(invoke('--file', file).status, 0);
  fs.writeFileSync(file, 'fix: display $(echo injected > marker.txt)\n');
  assert.equal(invoke('--file', file).status, 0);
  assert.equal(fs.existsSync(path.join(folder, 'marker.txt')), false);
  fs.writeFileSync(file, 'Invalid title\n');
  assert.equal(invoke('--file', file).status, 1);
  assert.equal(invoke('--file').status, 2);
  assert.equal(invoke('--range', 'HEAD...HEAD').status, 2);
  assert.equal(invoke('--file', file, '--range', 'HEAD~1..HEAD').status, 2);
  assert.equal(invoke('--file', file, '--file', file).status, 2);
});
