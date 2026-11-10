import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {caseCatalog, selectCases} from '../testing-tools/helpers/case-catalog.mjs';
import {productContract} from '../testing-tools/helpers/product-contract.mjs';

const tooling = 'testing-tools/tooling/test-system/';
const commitFile = tooling + 'check-commits.test.mjs';
const cloudFiles = new Set([
  'testing-tools/modules/ui/analysis-notes.test.mjs',
  'testing-tools/modules/reports/portable-repeat.test.mjs',
  ...['ci-scope', 'github-archive', 'product-contract'].map(name => tooling + name + '.test.mjs'),
]);
const bitrateFile = 'public/bitrate-model.js';
const shaPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const rawChange = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADMT])$/;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8', windowsHide:true});
export const head = repo => git(repo, 'rev-parse', 'HEAD').trim();
export const clean = repo => !git(repo, 'status', '--porcelain=v1', '--untracked-files=normal').trim();
export const commitCases = () => selectCases().cases.filter(c => c.file === commitFile).map(c => c.id).sort();

function changes(repo, base, sha) {
  if (!shaPattern.test(base) || !shaPattern.test(sha)) throw Error('Exact candidate and baseline SHAs required');
  git(repo, 'merge-base', '--is-ancestor', base, sha);
  const fields = git(repo, 'diff', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', base, sha, '--').split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw Error('Incomplete Git comparison');
  return fields.flatMap((field, index) => {
    if (index % 2) return [];
    const match = rawChange.exec(field);
    if (!match || !fields[index + 1]) throw Error('Unsupported Git change metadata');
    return [{file:fields[index + 1], regularEdit:match[1] === '100644' && match[2] === '100644' && match[3] === 'M'}];
  });
}

function localStages(files, release) {
  const stages = new Set();
  for (const {file} of files) {
    const source = productContract.sources.find(entry => entry.file === file);
    const desktop = source?.modules.includes('desktop') || file.startsWith('testing-tools/modules/desktop/');
    if (source?.modules.includes('siti') || /^(gpu\/|testing-tools\/modules\/siti\/|analysis\.mjs$|engine\.mjs$|server\.mjs$)/.test(file)) stages.add('gpu');
    if (desktop) stages.add('native');
    if (desktop || source?.shipment === 'build-input' || source?.shipment === 'build-tool' || /^(runtime-lock\.json|package(?:-lock)?\.json)$/.test(file)) {
      stages.add('package');
      stages.add('online');
    }
    const shared = /^(runtime-lock\.json$|package(?:-lock)?\.json$|\.github\/workflows\/(?:tests|commit-messages)\.yml$|testing-tools\/(helpers\/|product\.json$|modules\/catalog\.json$)|scripts\/(?:split-test|test|record-test|check-environment|deployment|verify-release|verify-test-evidence)[.-])/.test(file);
    const known = source || /^(docs\/|\.github\/|\.gitattributes$|\.gitignore$|AGENTS\.md$|README\.md$|licenses\/|testing-tools\/|scripts\/|evidence-archive\/tools\/)/.test(file);
    if (shared || !known) for (const id of ['gpu', 'native', 'package', 'online']) stages.add(id);
  }
  return ['gpu', 'native', 'package', 'online'].filter(id => release || stages.has(id));
}

export function splitPlan(repo, {sha, base, anchor, release = false, forceFull = false, recovery}) {
  if (sha !== head(repo)) throw Error('Checkout differs from candidate SHA');
  if (recovery && (recovery.after !== sha || recovery.base !== base || anchor || release || !forceFull)) {
    throw Error('Main history recovery requires its authorized baseline and full non-release acceptance');
  }
  const diff = changes(repo, base, sha);
  const anchorDiff = anchor ? changes(repo, anchor, sha) : [];
  const canNarrow = !forceFull && !release && Boolean(anchor) && diff.length > 0 && anchorDiff.length > 0;
  const considered = [...diff,...anchorDiff];
  const paths = [...new Set(considered.map(c=>c.file))];
  const docsOnly = canNarrow && considered.every(c=>c.regularEdit && c.file.endsWith('.md')) &&
    git(repo,'check-attr','--source='+sha,'-z','mediascope-validation','--',...paths)===
      paths.map(file=>file+'\0mediascope-validation\0docs\0').join('');
  // Only the reviewed bitrate module can narrow, and only from an explicit full baseline.
  const bounded = canNarrow && considered.every(change => change.regularEdit && change.file === bitrateFile);
  const selection = docsOnly ? {cases:[],caseIds:[]} : selectCases(bounded ? {modules:['bitrate']} : {});
  const cloud = [], local = [];
  for (const c of selection.cases) {
    if (c.file === commitFile) continue;
    if (cloudFiles.has(c.file)) {
      if (c.requiresMedia !== false || c.requiresBrowser === true || c.scope !== 'general') {
        throw Error('Cloud case has unreviewed prerequisites: ' + c.id);
      }
      cloud.push(c.id);
    } else local.push(c.id);
  }
  const stages = docsOnly ? [] : localStages(diff, release || Boolean(recovery));
  const stageCases = Object.fromEntries(stages.filter(id => ['gpu','native'].includes(id))
    .map(id => [id, selectCases({suite:id}).caseIds.sort()]));
  const plan = {schema:1, sha, base, anchor:anchor || null, scope:docsOnly ? 'docs-only' : bounded ? 'selected' : 'full', release, forceFull,
    files:diff.map(c => c.file), local:local.sort(), cloud:cloud.sort(), commits:commitCases(), stages, stageCases,
    runtimeLock:digest(fs.readFileSync(path.join(repo,'runtime-lock.json')))};
  if (recovery) plan.recovery = recovery;
  const combined = [...plan.local,...plan.cloud,...plan.commits];
  const required = new Set([...selection.caseIds,...plan.commits]);
  if (new Set(combined).size !== combined.length || combined.length !== required.size || combined.some(id => !required.has(id))) {
    throw Error('Split plan does not cover each required case exactly once');
  }
  return {...plan, hash:digest(JSON.stringify(plan))};
}
