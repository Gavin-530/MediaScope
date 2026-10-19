import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roles = new Set(['document', 'provenance', 'result', 'reproduction', 'input', 'upstream', 'diagnostic', 'recovery']);
const kinds = new Set(['plan', 'receipt', 'reference', 'history', 'rollback']);
const topic = '[a-z0-9]+(?:-[a-z0-9]+)*';
const stamp = '\\d{8}T\\d{6}(?:\\.\\d{3})?Z';
const names = {
  plan: new RegExp(`^plans/${topic}-plan-(${stamp})\\.md$`),
  receipt: new RegExp(`^operations/${topic}-receipt-(${stamp})\\.(?:md|json)$`),
  reference: new RegExp(`^references/(?:benchmarks|validation|tooling)/${topic}-(${stamp})(?:\\.(?:md|json))?$`),
  history: new RegExp(`^history/${topic}-(${stamp})$`),
  rollback: new RegExp(`^rollback/${topic}-(${stamp})$`)
};
const upstreamName = /^references\/upstream\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9._-]*$/;
const referenceLocation = /^references\/(?:(?:benchmarks|validation|tooling)\/[^/]+|upstream\/[^/]+\/[^/]+)$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = value => value.toLowerCase();
const under = (file, scope) => file === scope || file.startsWith(scope + '/');

export function safeRelative(value) {
  return text(value) && !/[\\:*?"<>|\x00-\x1f]/.test(value) && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function validStamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction || '.000'}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.valueOf()) && date.toISOString() === iso;
}

async function hash(file) {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}

// lstat every node, including the root: never follow junctions or symbolic links.
async function walk(root) {
  const files = new Map(), directories = new Set(), folded = new Set();
  async function visit(relative) {
    if (relative && !safeRelative(relative)) throw Error(`Unsafe local-notes path: ${relative}`);
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw Error(`Linked local-notes entry: ${relative || '.'}`);
    if (relative) {
      if (folded.has(key(relative))) throw Error(`Case-colliding local-notes path: ${relative}`);
      folded.add(key(relative));
    }
    if (stat.isDirectory()) {
      if (relative) directories.add(relative);
      for (const name of (await fs.readdir(absolute)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) files.set(relative, {path: relative, bytes: stat.size, absolute});
    else throw Error(`Nonregular local-notes entry: ${relative}`);
  }
  await visit('');
  return {files, directories};
}

export async function inventoryLocalNotes(projectRoot = project, scope) {
  if (!safeRelative(scope)) throw Error('inventory requires a relative --path inside local-notes');
  const root = path.join(projectRoot, 'local-notes');
  const tree = await walk(root);
  const files = [...tree.files.values()].filter(file => under(file.path, scope));
  if (!files.length) throw Error(`No files at local-notes/${scope}`);
  return Promise.all(files.map(async file => ({path: file.path, bytes: file.bytes, sha256: await hash(file.absolute)})));
}

export async function checkLocalNotes(projectRoot = project) {
  const root = path.join(projectRoot, 'local-notes');
  const result = {present: false, entries: 0, files: 0, bytes: 0, errors: []};
  const fail = message => result.errors.push(message);
  try {
    try {await fs.lstat(root);} catch (error) {if (error.code === 'ENOENT') return result; throw error;}
    result.present = true;
    const tree = await walk(root);
    result.files = tree.files.size;
    result.bytes = [...tree.files.values()].reduce((sum, file) => sum + file.bytes, 0);
    for (const name of ['README.md', 'retention.json']) if (!tree.files.has(name)) fail(`Missing local-notes/${name}`);
    if (result.errors.length) return result;
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'retention.json'), 'utf8'));
    if (catalog.schema !== 1 || !Array.isArray(catalog.entries) ||
        !text(catalog.reviewedAtUtc) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(catalog.reviewedAtUtc) ||
        !Number.isFinite(Date.parse(catalog.reviewedAtUtc)) ||
        new Date(catalog.reviewedAtUtc).toISOString() !== (catalog.reviewedAtUtc.includes('.') ? catalog.reviewedAtUtc : catalog.reviewedAtUtc.replace('Z', '.000Z'))) throw Error('Invalid retention catalog schema or review time');
    const policy = JSON.parse(await fs.readFile(path.join(projectRoot, 'local-data-policy.json'), 'utf8'));
    const allowedLegacy = policy.localNotes?.legacyNamingPathSha256;
    if (policy.localNotes?.schema !== 1 || !Array.isArray(allowedLegacy) || allowedLegacy.some(value => !digest(value)) || new Set(allowedLegacy).size !== allowedLegacy.length) throw Error('Missing reviewed local-notes naming baseline in local-data-policy.json');
    for (const entry of catalog.entries.filter(entry => entry?.legacyNameReason !== undefined)) {
      if (!text(entry.path) || !allowedLegacy.includes(createHash('sha256').update(entry.path).digest('hex'))) fail(`Unreviewed historical naming exception; new exceptions require a policy change: ${entry.path}`);
    }
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const links = new Set();
    for (const match of readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = decodeURIComponent(match[1].split('#')[0]);
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/|\.\.\/)/i.test(target)) continue;
      const normalized = target.replace(/^\.\//, '');
      links.add(normalized);
      if (!tree.files.has(normalized)) fail(`Broken local index link: ${target}`);
    }
    const scopes = [], declared = new Set(['readme.md', 'retention.json']);
    for (const entry of catalog.entries) {
      if (!entry || !safeRelative(entry.path) || !kinds.has(entry.kind)) {fail('Invalid retention entry path or kind'); continue;}
      const label = entry.path;
      result.entries++;
      if (scopes.some(scope => under(key(label), scope) || under(scope, key(label)))) fail(`Overlapping retention entries: ${label}`);
      scopes.push(key(label));
      if (!label.startsWith(({plan: 'plans', receipt: 'operations', reference: 'references', history: 'history', rollback: 'rollback'})[entry.kind] + '/')) fail(`Wrong directory for ${entry.kind}: ${label}`);
      if (entry.kind === 'reference' && !referenceLocation.test(label)) fail(`Reference needs a fixed category and entry scope (benchmarks, validation, tooling or upstream): ${label}`);
      const match = names[entry.kind].exec(label);
      const standard = match ? validStamp(match[1]) : entry.kind === 'reference' && upstreamName.test(label);
      if (!standard && !(text(entry.legacyNameReason) && text(entry.timeBasis))) fail(`Nonstandard name without a documented historical exception: ${label}`);
      if (standard && entry.legacyNameReason !== undefined) fail(`Unnecessary naming exception: ${label}`);
      if (!text(entry.reason) || !text(entry.source) || !text(entry.timeBasis) || !['active', 'historical', 'reference', 'recovery'].includes(entry.status)) fail(`Missing retention purpose, source, time basis or status: ${label}`);
      if ((entry.kind === 'plan' && !['active', 'historical'].includes(entry.status)) ||
          (['receipt', 'history'].includes(entry.kind) && entry.status !== 'historical') ||
          (entry.kind === 'reference' && entry.status !== 'reference') ||
          (entry.kind === 'rollback' && entry.status !== 'recovery')) fail(`Status disagrees with kind: ${label}`);
      const singleFile = ['plan', 'receipt'].includes(entry.kind) || /\.(?:md|json)$/.test(label);
      if (singleFile ? !tree.files.has(label) || entry.entrypoint !== label || entry.files?.length !== 1 : !tree.directories.has(label)) fail(`Entry has the wrong file/directory shape: ${label}`);
      if (!safeRelative(entry.entrypoint) || !under(entry.entrypoint, label) || !tree.files.has(entry.entrypoint) || !links.has(entry.entrypoint)) fail(`Entry must have an existing, indexed entrypoint within its scope: ${label}`);
      if (!entry.retention || typeof entry.retention !== 'object' || Array.isArray(entry.retention) ||
          Object.entries(entry.retention).some(([role, reason]) => !roles.has(role) || !text(reason))) fail(`Invalid retention role descriptions: ${label}`);
      if (entry.kind !== 'rollback' && entry.retention && Object.hasOwn(entry.retention, 'recovery')) fail(`Recovery material must be registered in rollback: ${label}`);
      if (!Array.isArray(entry.files) || !entry.files.length) {fail(`Missing exact file inventory: ${label}`); continue;}
      for (const file of entry.files) {
        if (!file || !safeRelative(file.path) || !under(file.path, label)) {fail(`Unsafe or out-of-scope inventory file: ${label}`); continue;}
        if (declared.has(key(file.path))) fail(`Duplicate inventory file: ${file.path}`);
        declared.add(key(file.path));
        if (!roles.has(file.role) || !text(entry.retention?.[file.role]) ||
            !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !digest(file.sha256)) fail(`Incomplete file retention record: ${file.path}`);
        if (file.role === 'recovery' && entry.kind !== 'rollback') fail(`Recovery material must be registered in rollback: ${file.path}`);
        if (/(^|\/)(?:node_modules|__pycache__|\.venv|venv|runtime|\.git)(\/|$)/i.test(file.path) ||
            /\.(?:pyc|pyo|tmp|temp|part|crdownload|exe|dll|pyd)$/i.test(file.path)) fail(`Disposable runtime/cache is forbidden in local-notes: ${file.path}`);
        if (/\.(?:mjs|cjs|js|py|ps1|sh|ipynb|ptx|c|cpp|h|hpp|cs)$/i.test(file.path) && !['reproduction', 'upstream', 'recovery'].includes(file.role)) fail(`Source script needs a reproduction/upstream/recovery role: ${file.path}`);
        if (/\.(?:y4m|mov|mp4|mkv|yuv)$/i.test(file.path) && !['input', 'upstream', 'recovery'].includes(file.role)) fail(`Media needs an input/upstream/recovery role: ${file.path}`);
        if (/\.(?:log|stdout|stderr)$/i.test(file.path) && !['diagnostic', 'upstream', 'recovery'].includes(file.role)) fail(`Log needs an explicit diagnostic/upstream/recovery role: ${file.path}`);
        if (/\.(?:whl|zip|tar|7z)$/i.test(file.path) && (!['upstream', 'recovery'].includes(file.role) || !text(file.reason))) fail(`Distribution archive needs its own original-retention justification: ${file.path}`);
        const actual = tree.files.get(file.path);
        if (!actual) fail(`Missing retained file: ${file.path}`);
        else if (file.bytes !== actual.bytes || file.sha256 !== await hash(actual.absolute)) fail(`Retained content changed; review instead of blindly refreshing hashes: ${file.path}`);
      }
    }
    for (const file of tree.files.keys()) if (!declared.has(key(file))) fail(`Unregistered file: ${file}`);
    const allowedDirectories = new Set();
    for (const file of declared) {
      let parent = path.posix.dirname(file);
      while (parent !== '.') {allowedDirectories.add(parent); parent = path.posix.dirname(parent);}
    }
    for (const directory of tree.directories) if (!allowedDirectories.has(key(directory))) fail(`Unregistered directory: ${directory}`);
  } catch (error) {fail(error.message);}
  return result;
}

async function main(args) {
  if (args.length === 3 && args[0] === 'inventory' && args[1] === '--path') {
    console.log(JSON.stringify(await inventoryLocalNotes(project, args[2]), null, 2));
    return 0;
  }
  if (args.length !== 1 || args[0] !== 'check') throw Error('Usage: node scripts/local-notes.mjs check | inventory --path <relative-path-in-local-notes>');
  const result = await checkLocalNotes();
  for (const error of result.errors.slice(0, 40)) console.error(`  - ${error}`);
  if (result.errors.length > 40) console.error(`  ... ${result.errors.length - 40} more error(s)`);
  console.log(result.present ? `Local notes: ${result.entries} entries, ${result.files} files, ${result.errors.length} error(s).` : 'No local-notes directory in this checkout.');
  return result.errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {process.exitCode = await main(process.argv.slice(2));}
  catch (error) {console.error(`Local notes check blocked: ${error.message}`); process.exitCode = 2;}
}
