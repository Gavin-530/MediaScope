import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {caseCatalog, selectCases} from '../testing-tools/helpers/case-catalog.mjs';
import {productContract} from '../testing-tools/helpers/product-contract.mjs';
import {dependencyImpact} from './split-test-dependencies.mjs';

const tooling = 'testing-tools/tooling/test-system/';
const commitFile = tooling + 'check-commits.test.mjs';
const cloudCases = JSON.parse(fs.readFileSync(new URL('./split-test-cloud-cases.json', import.meta.url)));
const reviewedImpact = JSON.parse(fs.readFileSync(new URL('../testing-tools/selection-impact.json', import.meta.url)));
if (reviewedImpact.schema !== 2) throw Error('Unknown selection impact schema');
const reviewedSources = new Set(reviewedImpact.sources);
const reviewedHelpers = new Set(reviewedImpact.testHelpers);
const trackedTestFiles = new Set(caseCatalog.cases.filter(c => !c.archiveMaintenance && c.file !== commitFile).map(c => c.file));
const formalTestFiles = new Set([...trackedTestFiles].filter(file => file.startsWith('testing-tools/modules/')));
const productSources = new Map(productContract.sources.map(source => [source.file, source]));
const validationEntrypoints = new Set([
  '.gitattributes',
  'scripts/check-commits.mjs',
  'scripts/ci-scope.mjs',
  'scripts/split-tests.mjs',
  'testing-tools/selection-impact.json',
  'scripts/evidence-lib.ps1',
  'scripts/github-archive-api.mjs',
  'scripts/github-archive-store.mjs',
  'scripts/github-evidence-lib.ps1',
  'scripts/read-measurements.mjs',
  'scripts/verify-source-tests.mjs',
  '.github/workflows/candidate-evidence-review.yml',
]);
const stageOrder = ['gpu', 'native', 'package', 'online'];
const fixtureLockPath = 'testing-tools/fixtures.lock.json';
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
    return [{file:fields[index + 1], status:match[3], regularEdit:match[1] === '100644' && match[2] === '100644' && match[3] === 'M'}];
  });
}

function documentedFiles(repo, sha, paths) {
  const markdown = paths.filter(file=>file.endsWith('.md'));
  if (!markdown.length) return [];
  const fields = git(repo,'check-attr','--source='+sha,'-z','mediascope-validation','--',...markdown).split('\0');
  return markdown.filter((file,i)=>fields[i*3]===file && fields[i*3+1]==='mediascope-validation' && fields[i*3+2]==='docs');
}

function reviewedChanges(repo, revisions, files) {
  const unknown = files.find(file => !formalTestFiles.has(file) && !reviewedHelpers.has(file) &&
    !(reviewedSources.has(file) && productSources.get(file)?.shipment === 'source'));
  if (unknown) return {reason:'Changed path has no reviewed impact mapping: ' + unknown};
  try {
    const helpers = files.filter(file=>reviewedHelpers.has(file));
    const {affected, uncertain, usedHelpers} = dependencyImpact(
      repo,revisions,files,reviewedImpact.runtimeLoaders,helpers,trackedTestFiles);
    const unbounded = [...uncertain].find(file => !trackedTestFiles.has(file));
    if (unbounded) return {reason:'Unresolved runtime load: ' + unbounded, allStages:true};
    const unused = helpers.find(file=>!usedHelpers.has(file));
    if (unused) return {reason:'No formal consumers found for changed test helper: ' + unused};
    return {impact:{
      sources:[...affected].map(file=>productSources.get(file)).filter(Boolean),
      tests:new Set([...affected].filter(file=>trackedTestFiles.has(file))),
      uncertain:[...uncertain].sort(),
      testInputs:new Set(files.filter(file=>trackedTestFiles.has(file) || reviewedHelpers.has(file))),
    }};
  } catch (error) {
    return {reason:'Dependency analysis failed: ' + error.message.split(/\r?\n/, 1)[0], allStages:true};
  }
}

function fixtureStages(repo, base, sha, paths, add) {
  try {
    const locks = [base, sha].map(ref => {
      if (git(repo, 'ls-tree', '--name-only', ref, '--', fixtureLockPath).trim() !== fixtureLockPath) {
        throw Error('Missing formal fixture lock');
      }
      const {files, ...metadata} = JSON.parse(git(repo, 'show', ref + ':' + fixtureLockPath));
      const entries = new Map(files.map(entry => [entry.path, entry]));
      if (entries.size !== files.length) throw Error('Duplicate formal fixture');
      return {entries, metadata};
    });
    const [before, after] = locks;
    if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) throw Error('Fixture lock policy changed');
    const fixtureNames = new Set([...before.entries.keys(), ...after.entries.keys()]);
    const changed = new Set([...fixtureNames].filter(name => {
      const old = before.entries.get(name), current = after.entries.get(name);
      return paths.includes(old?.sourceFile) || paths.includes(current?.sourceFile) ||
        JSON.stringify(old) !== JSON.stringify(current);
    }));
    if (!changed.size || paths.some(file => file !== fixtureLockPath &&
      ![...fixtureNames].some(name => locks.some(lock => lock.entries.get(name)?.sourceFile === file)))) {
      throw Error('Unknown formal fixture change');
    }
    const parents = new Map();
    for (const {entries} of locks) for (const entry of entries.values()) {
      for (const child of entry.attachments ?? []) {
        if (!entries.has(child)) throw Error('Unknown fixture attachment');
        const owners = parents.get(child) ?? new Set();
        owners.add(entry.path);
        parents.set(child, owners);
      }
    }
    for (const input of changed) {
      const related = new Set([input]);
      for (const name of related) for (const parent of parents.get(name) ?? []) related.add(parent);
      const consumers = caseCatalog.cases.filter(c => !c.archiveMaintenance && c.inputs.some(name => related.has(name)));
      if (!consumers.length) throw Error('No formal consumers for ' + input);
      for (const c of consumers) {
        const reason = input + ' → ' + c.id;
        if (c.scope === 'gpu' || c.module === 'siti') add('gpu', reason);
        if (c.scope === 'native' || c.module === 'desktop') add('native', reason);
        if (c.module === 'desktop') {
          add('package', reason);
          add('online', reason);
        }
      }
    }
  } catch (error) {
    for (const id of stageOrder) add(id, paths.join(', ') + ': ' + error.message.split(/\r?\n/, 1)[0]);
  }
}

function localStages(repo, base, sha, files, specialCases, allStagesReason) {
  const stages = new Map();
  const add = (id, reason) => {
    if (!stages.has(id)) stages.set(id, new Set());
    stages.get(id).add(reason);
  };
  if (allStagesReason) for (const id of stageOrder) add(id, allStagesReason);
  for (const c of specialCases) add(c.scope, c.id);
  const fixturePaths = [];
  for (const file of files) {
    if (file === fixtureLockPath || file.startsWith('testing-tools/data/')) fixturePaths.push(file);
    const source = productSources.get(file);
    const desktop = source?.modules.includes('desktop') || file.startsWith('testing-tools/modules/desktop/');
    if (source?.modules.includes('siti') || /^(gpu\/|testing-tools\/modules\/siti\/|analysis\.mjs$|engine\.mjs$|server\.mjs$)/.test(file)) add('gpu', file);
    if (desktop) add('native', file);
    if (desktop || source?.shipment === 'build-input' || source?.shipment === 'build-tool' || /^(runtime-lock\.json|package(?:-lock)?\.json)$/.test(file)) {
      add('package', file);
      add('online', file);
    }
    const shared = validationEntrypoints.has(file) || /^(runtime-lock\.json$|package(?:-lock)?\.json$|\.github\/workflows\/(?:tests|commit-messages)\.yml$|testing-tools\/(helpers\/|prepare-fixtures\.mjs$|product\.json$|modules\/catalog\.json$)|scripts\/(?:split-test|test|record-test|check-environment|deployment|verify-release|verify-test-evidence)[.-])/.test(file);
    const known = source || /^(docs\/|\.github\/|\.gitattributes$|\.gitignore$|AGENTS\.md$|README\.md$|licenses\/|testing-tools\/|scripts\/|evidence-archive\/tools\/)/.test(file);
    if (shared || !known) for (const id of stageOrder) add(id, file);
  }
  if (fixturePaths.length) fixtureStages(repo, base, sha, fixturePaths, add);
  return Object.fromEntries(stageOrder.filter(id => stages.has(id)).map(id => [id, [...stages.get(id)].sort()]));
}

export function reviewedCloudCase(testCase) {
  if (!Object.hasOwn(cloudCases, testCase.file) || !cloudCases[testCase.file].includes(testCase.id)) return false;
  if (testCase.scope !== 'general' || testCase.requiresMedia !== false ||
      testCase.requiresBrowser === true || testCase.inputs.length || testCase.archiveMaintenance) {
    throw Error('Cloud case has unreviewed prerequisites: ' + testCase.id);
  }
  return true;
}

export function splitPlan(repo, {sha, base, anchor, release = false, forceFull = false, recovery, explain = false}) {
  if (sha !== head(repo)) throw Error('Checkout differs from candidate SHA');
  if (recovery && (recovery.after !== sha || recovery.base !== base || anchor || release || !forceFull)) {
    throw Error('Main history recovery requires its authorized baseline and full non-release acceptance');
  }
  const diff = changes(repo, base, sha);
  const anchorDiff = anchor && !forceFull && !release ? (anchor === base ? diff : changes(repo, anchor, sha)) : [];
  const canNarrow = !forceFull && !release && Boolean(anchor) && diff.length > 0 && anchorDiff.length > 0;
  const considered = [...diff,...anchorDiff];
  const paths = [...new Set(considered.map(c=>c.file))];
  const regular = canNarrow && considered.every(change => change.regularEdit);
  const documents = regular ? documentedFiles(repo,sha,paths) : [];
  const docsOnly = regular && documents.length===paths.length;
  const assessment = regular && !docsOnly
    ? reviewedChanges(repo,[...new Set([base,anchor,sha])],paths.filter(file=>!documents.includes(file))) : null;
  const impact = assessment?.impact;
  const sources = impact?.sources ?? [];
  const modules = [...new Set(sources.flatMap(source => source.modules))].sort();
  const requirements = new Set(sources.flatMap(source => source.requirements));
  const reviewedRequirements = productContract.requirements.filter(r => requirements.has(r.id));
  if (reviewedRequirements.length !== requirements.size) throw Error('Reviewed source has an unknown product requirement');
  const requirementCases = new Set(reviewedRequirements.flatMap(r => [...r.cases, ...(r.integrationCases ?? [])]));
  const selected = Boolean(impact);
  const moduleCases = new Set(modules.length ? selectCases({modules}).caseIds : []);
  const general = docsOnly ? [] : selectCases().cases;
  const selection = general.filter(c => !selected || requirementCases.has(c.id) || moduleCases.has(c.id) || impact?.tests.has(c.file));
  const extraStages = caseCatalog.cases.filter(c => (requirementCases.has(c.id) || impact?.tests.has(c.file)) &&
    (c.scope === 'gpu' || c.scope === 'native'));
  for (const id of requirementCases) {
    if (!selection.some(c => c.id === id) && !extraStages.some(c => c.id === id)) {
      throw Error('Reviewed requirement has an unavailable case: ' + id);
    }
  }
  const cloud = [], local = [];
  for (const c of selection) {
    if (c.file === commitFile) continue;
    (reviewedCloudCase(c) ? cloud : local).push(c.id);
  }
  const stagePaths = new Set([...paths.filter(file=>!impact?.testInputs.has(file)), ...sources.map(source=>source.file)]);
  const stageReasons = docsOnly ? {} : localStages(repo, base, sha, stagePaths, extraStages,
    assessment?.allStages ? assessment.reason : release || recovery ? 'Release or history recovery' : null);
  const stages = Object.keys(stageReasons);
  const stageCases = Object.fromEntries(stages.filter(id => ['gpu','native'].includes(id))
    .map(id => [id, selectCases({suite:id}).caseIds.sort()]));
  const plan = {schema:1, sha, base, anchor:anchor || null, scope:docsOnly ? 'docs-only' : selected ? 'selected' : 'full', release, forceFull,
    files:diff.map(c => c.file), local:local.sort(), cloud:cloud.sort(), commits:commitCases(), stages, stageCases,
    runtimeLock:digest(fs.readFileSync(path.join(repo,'runtime-lock.json')))};
  if (recovery) plan.recovery = recovery;
  if (selected && documents.length) plan.documents = documents.sort();
  const combined = [...plan.local,...plan.cloud,...plan.commits];
  const required = new Set([...selection.map(c => c.id),...plan.commits]);
  if (new Set(combined).size !== combined.length || combined.length !== required.size || combined.some(id => !required.has(id))) {
    throw Error('Split plan does not cover each required case exactly once');
  }
  const result = {...plan, hash:digest(JSON.stringify(plan))};
  if (!explain) return result;
  let reason = assessment?.reason ?? 'At least one changed path or test dependency has no reviewed impact mapping';
  if (docsOnly) reason = 'Both comparisons contain only reviewed documentation edits';
  else if (selected) reason = impact.uncertain.length
    ? 'Included tests with an unresolved runtime load' : 'Both comparisons have reviewed source, test or documentation impact';
  else if (recovery || release || forceFull) reason = 'Explicit full profile';
  else if (!anchor) reason = 'No full acceptance anchor configured';
  else if (!canNarrow) reason = 'At least one comparison is empty';
  else if (considered.some(change => !change.regularEdit)) reason = 'At least one comparison contains a non-regular edit';
  return {...result, explanation:{reason, baseChanges:diff, anchorChanges:anchorDiff, modules,
    requirements:[...requirements].sort(), stages:stageReasons, uncertainTests:impact?.uncertain ?? [],
    anchorEvidence:'GitHub verification is separate from this local plan'}};
}
