import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkLocalNotes, inventoryLocalNotes, safeRelative} from '../scripts/local-notes.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plan = 'plans/example-plan-20261016T010203Z.md';
const temporaryRoot = fileURLToPath(new URL('../.build/', import.meta.url));
async function fixture(t, {entryPath = plan, kind = 'plan', legacy = false} = {}) {
  await fs.mkdir(temporaryRoot, {recursive: true});
  const project = await fs.mkdtemp(path.join(temporaryRoot, 'local-notes-policy-'));
  t.after(async () => {
    assert.ok(project.startsWith(path.join(temporaryRoot, 'local-notes-policy-')));
    await fs.rm(project, {recursive: true, force: true});
  });
  const root = path.join(project, 'local-notes');
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.writeFile(path.join(root, file), bytes);
  };
  await write(entryPath, 'retained original\n');
  await write('README.md', `[Entry](${entryPath})\n`);
  const entry = {path: entryPath, kind, status: ({plan: 'active', reference: 'reference', rollback: 'recovery'})[kind] || 'historical',
    reason: 'Keep the approved plan and its acceptance requirements.', source: 'Local reviewed plan',
    timeBasis: 'Actual UTC save time', entrypoint: entryPath,
    retention: {document: 'Frozen plan text'},
    files: [{path: entryPath, role: 'document', bytes: 18, sha256: sha('retained original\n')}]};
  if (legacy) entry.legacyNameReason = 'Existing frozen record; source time is unknown.';
  const catalog = {schema: 1, reviewedAtUtc: '2026-10-16T01:02:03Z', entries: [entry]};
  const save = () => write('retention.json', JSON.stringify(catalog));
  await save();
  const baseline = legacy ? [entryPath] : [];
  await fs.writeFile(path.join(project, 'local-data-policy.json'), JSON.stringify({localNotes: {
    schema: 1, legacyNamingPathSha256: baseline.map(value => sha(value))
  }}));
  return {project, root, catalog, entry, write, save};
}
async function bundleFixture(t, scope, kind = 'reference') {
  const f = await fixture(t, {entryPath: `${scope}/README.md`, kind});
  f.entry.path = scope;
  await f.save();
  return f;
}
const errors = async fixture => (await checkLocalNotes(fixture.project)).errors.join('\n');

test('a fresh clone without private notes passes without creating them', async t => {
  const f = await fixture(t);
  await fs.rm(f.root, {recursive: true});
  assert.deepEqual(await checkLocalNotes(f.project), {present: false, entries: 0, files: 0, bytes: 0, errors: []});
  await assert.rejects(fs.stat(f.root), {code: 'ENOENT'});
});

test('checks ignored files directly and never registers an unexpected addition', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, '.gitignore'), '/local-notes/\n');
  assert.equal(await errors(f), '');
  const before = await fs.readFile(path.join(f.root, 'retention.json'));
  await f.write('references/random.txt', 'unreviewed');
  assert.match(await errors(f), /Unregistered file: references\/random.txt/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'retention.json')), before);
});

test('rejects missing catalog, malformed JSON and missing purpose', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, 'retention.json'));
  assert.match(await errors(f), /Missing local-notes\/retention.json/);
  await f.write('retention.json', '{');
  assert.notEqual(await errors(f), '');
  delete f.entry.reason;
  await f.save();
  assert.match(await errors(f), /Missing retention purpose/);
});

test('detects edits, missing files and size-preserving corruption', async t => {
  const f = await fixture(t);
  await f.write(plan, 'retained tampered\n');
  assert.match(await errors(f), /Retained content changed/);
  await fs.rm(path.join(f.root, plan));
  assert.match(await errors(f), /Missing retained file/);
});

test('requires UTC naming and rejects impossible calendar dates', async t => {
  for (const name of ['plans/example-20261016.md', 'plans/example-plan-20260230T010203Z.md',
    'plans/example-plan-20261016T250203Z.md', 'plans/example-plan-20261016T010203+0800.md']) {
    const f = await fixture(t, {entryPath: name});
    assert.match(await errors(f), /Nonstandard name/);
  }
  const f = await fixture(t, {entryPath: 'plans/example-plan-20261016T010203.123Z.md'});
  assert.equal(await errors(f), '');
});

test('accepts fixed reference categories, single results and pinned upstream versions', async t => {
  for (const category of ['benchmarks', 'validation', 'tooling']) {
    const f = await bundleFixture(t, `references/${category}/example-20261016T010203Z`);
    assert.equal(await errors(f), '');
    const single = await fixture(t, {entryPath: `references/${category}/example-20261016T010203.123Z.json`, kind: 'reference'});
    assert.equal(await errors(single), '');
  }
  for (const version of ['0.6.0', 'n8.1.3', 'commit_abc123']) {
    const f = await bundleFixture(t, `references/upstream/example/${version}`);
    assert.equal(await errors(f), '');
  }
});

test('timestamped references still need a fixed category and exact entry depth', async t => {
  for (const scope of ['references/example-20261016T010203Z',
    'references/misc/example-20261016T010203Z', 'references/other/example-20261016T010203Z',
    'references/validation/nested/example-20261016T010203Z', 'references/upstream/example']) {
    const f = await bundleFixture(t, scope);
    assert.match(await errors(f), /Reference needs a fixed category and entry scope/);
  }
  // Even a reviewed naming exception cannot authorize an unclassified reference.
  const legacy = await fixture(t, {entryPath: 'references/old-20261004.md', kind: 'reference', legacy: true});
  assert.match(await errors(legacy), /Reference needs a fixed category and entry scope/);
  const single = await fixture(t, {entryPath: 'references/example-20261016T010203Z.json', kind: 'reference'});
  assert.match(await errors(single), /Reference needs a fixed category and entry scope/);
  const invalidTime = await bundleFixture(t, 'references/validation/example-20260230T010203Z');
  assert.match(await errors(invalidTime), /Nonstandard name/);
});

test('recovery originals require rollback even with exact hashes and an explicit purpose', async t => {
  const f = await bundleFixture(t, 'references/validation/example-20261016T010203Z');
  assert.equal(await errors(f), '');
  const archive = `${f.entry.path}/original-source.zip`;
  await f.write(archive, 'original');
  f.entry.retention.recovery = 'Unique uncommitted source needed for recovery';
  f.entry.files.push({path: archive, role: 'recovery', bytes: 8, sha256: sha('original'),
    reason: 'Keep unique source bytes that are absent from Git.'});
  await f.save();
  assert.match(await errors(f), /Recovery material must be registered in rollback/);
  delete f.entry.retention.recovery;
  await f.save();
  assert.match(await errors(f), /Recovery material must be registered in rollback/);
  f.entry.files.pop();
  await fs.unlink(path.join(f.root, archive));
  f.entry.retention.recovery = 'A misplaced recovery declaration';
  await f.save();
  assert.match(await errors(f), /Recovery material must be registered in rollback/);

  const rollback = await bundleFixture(t, 'rollback/example-20261016T010203Z', 'rollback');
  const recovered = `${rollback.entry.path}/original-source.zip`;
  await rollback.write(recovered, 'original');
  rollback.entry.retention.recovery = 'Unique uncommitted source needed for recovery';
  rollback.entry.files.push({...f.entry.files[0], path: recovered, role: 'recovery', bytes: 8,
    sha256: sha('original'), reason: 'Keep unique source bytes that are absent from Git.'});
  await rollback.save();
  assert.equal(await errors(rollback), '');
});

test('accepts only the exact reviewed historical naming exceptions', async t => {
  const f = await fixture(t, {entryPath: 'operations/old-audit-20261004.md', kind: 'receipt', legacy: true});
  assert.equal(await errors(f), '');
  const renamed = 'operations/new-unstructured-note.md';
  await f.write(renamed, 'retained original\n');
  f.entry.path = renamed;
  f.entry.entrypoint = renamed;
  f.entry.files[0].path = renamed;
  await f.save();
  assert.match(await errors(f), /Unreviewed historical naming exception/);
});

test('new local notes and partial restores do not require unrelated historical files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project, 'local-data-policy.json'), JSON.stringify({localNotes: {
    schema: 1, legacyNamingPathSha256: [sha('operations/some-other-old-record.md')]
  }}));
  assert.equal(await errors(f), '');
  const old = await fixture(t, {entryPath: 'operations/old-audit-20261004.md', kind: 'receipt', legacy: true});
  const policyFile = path.join(old.project, 'local-data-policy.json');
  const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
  policy.localNotes.legacyNamingPathSha256.push(sha('operations/another-unrestored-record.md'));
  await fs.writeFile(policyFile, JSON.stringify(policy));
  assert.equal(await errors(old), '');
});

test('requires a live index link and flags stale links', async t => {
  const f = await fixture(t);
  await f.write('README.md', '[Stale](plans/deleted.md)\n');
  const output = await errors(f);
  assert.match(output, /Broken local index link/);
  assert.match(output, /indexed entrypoint/);
});

test('rejects escaping paths, duplicate inventory and overlapping scopes', async t => {
  const f = await fixture(t);
  for (const name of ['../outside', '/absolute', 'D:/absolute', 'plans\\note.md', 'plans/note.md:stream', 'plans/CON.txt', 'plans/a.']) assert.equal(safeRelative(name), false, name);
  f.entry.files.push({...f.entry.files[0]});
  await f.save();
  assert.match(await errors(f), /Duplicate inventory file/);
  f.entry.files.pop();
  f.catalog.entries.push({...f.entry});
  await f.save();
  assert.match(await errors(f), /Overlapping retention entries/);
  f.catalog.entries.pop();
  f.entry.files[0].path = '../outside.txt';
  await f.save();
  assert.match(await errors(f), /Unsafe or out-of-scope/);
});

test('registration cannot bless dependency caches or disguise scripts as documents', async t => {
  const f = await bundleFixture(t, 'references/tooling/example-20261016T010203Z');
  assert.equal(await errors(f), '');
  for (const [relative, role, pattern] of [['runtime/installed.py', 'reproduction', /runtime\/cache is forbidden/],
    ['throwaway.mjs', 'document', /Source script needs/], ['output.log', 'result', /Log needs/],
    ['download.whl', 'upstream', /archive needs its own/]]) {
    const file = `${f.entry.path}/${relative}`;
    await f.write(file, 'x');
    f.entry.retention[role] = 'Explicit role description';
    f.entry.files.push({path: file, role, bytes: 1, sha256: sha('x')});
    await f.save();
    assert.match(await errors(f), pattern);
    await fs.rm(path.join(f.root, file));
    f.entry.files.pop();
  }
});

test('detects unregistered empty directories', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'misc'));
  assert.match(await errors(f), /Unregistered directory: misc/);
});

test('rejects junctions inside notes and at the notes root without following them', async t => {
  const f = await fixture(t);
  const outside = path.join(f.project, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'unique.txt'), 'preserve');
  const link = path.join(f.root, 'linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(await errors(f), /Linked local-notes entry/);
  await fs.unlink(link);
  await fs.rm(f.root, {recursive: true});
  await fs.symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(await errors(f), /Linked local-notes entry/);
  await fs.unlink(f.root);
  assert.equal(await fs.readFile(path.join(outside, 'unique.txt'), 'utf8'), 'preserve');
});

test('inventory is read-only, scoped and refuses traversal', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, 'retention.json'));
  assert.deepEqual(await inventoryLocalNotes(f.project, plan), [{path: plan, bytes: 18, sha256: sha('retained original\n')}]);
  await assert.rejects(inventoryLocalNotes(f.project, '../outside'), /relative --path/);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'retention.json')), before);
});

test('the actual CLI exits nonzero for unregistered material', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, 'scripts'));
  const script = path.join(f.project, 'scripts/local-notes.mjs');
  await fs.copyFile(new URL('../scripts/local-notes.mjs', import.meta.url), script);
  let result = spawnSync(process.execPath, [script, 'check'], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  await f.write('random.txt', 'unreviewed');
  result = spawnSync(process.execPath, [script, 'check'], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unregistered file/);
});

test('the real test runner rejects unregistered notes before allocating evidence', async t => {
  const f = await fixture(t);
  await f.write('unreviewed.txt', 'unreviewed');
  await fs.mkdir(path.join(f.project, 'scripts'));
  await fs.mkdir(path.join(f.project, 'testing-tools/helpers'), {recursive: true});
  for (const name of ['test.mjs', 'local-notes.mjs', 'test-evidence.mjs']) await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(f.project, 'scripts', name));
  for (const name of ['helpers/test-results.mjs', 'helpers/fixtures.mjs', 'helpers/source-layout.mjs', 'fixtures.lock.json']) await fs.copyFile(new URL('./'+name, import.meta.url), path.join(f.project, 'testing-tools', name));
  const output = spawnSync(process.execPath, [path.join(f.project, 'scripts/test.mjs'), '--suite', 'core'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.notEqual(output.status, 0);
  assert.match(output.stdout + output.stderr, /Unregistered file: unreviewed.txt/);
  await assert.rejects(fs.stat(path.join(f.project, 'evidence-archive')), {code: 'ENOENT'});
});

test('local-data Verify stops on invalid notes before touching evidence', async t => {
  const f = await fixture(t);
  await f.write('unreviewed.txt', 'unreviewed');
  await fs.mkdir(path.join(f.project, 'scripts'));
  for (const name of ['local-data.ps1', 'local-notes.mjs', 'evidence-lib.ps1']) await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(f.project, 'scripts', name));
  const policy = JSON.parse(await fs.readFile(new URL('../local-data-policy.json', import.meta.url), 'utf8'));
  policy.localNotes = {schema: 1, legacyNamingPathSha256: []};
  await fs.writeFile(path.join(f.project, 'local-data-policy.json'), JSON.stringify(policy));
  const output = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.project, 'scripts/local-data.ps1'), '-Action', 'Verify'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.notEqual(output.status, 0);
  assert.match(output.stdout + output.stderr, /Unregistered file: unreviewed.txt/);
  assert.match(output.stdout + output.stderr, /Local notes validation failed/);
  await assert.rejects(fs.stat(path.join(f.project, 'evidence-archive')), {code: 'ENOENT'});
});
