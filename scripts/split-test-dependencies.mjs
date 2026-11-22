import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {parse} from './split-test-vendor/acorn.mjs';

const scriptPath = /\.(?:[cm]?[jt]s|[jt]sx|html?)$/i;
const decoder = new TextDecoder('utf-8', {fatal:true});
const posix = path.posix;
const maxBuffer = 32 * 1024 * 1024;

function gitObjects(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], {input, maxBuffer, windowsHide:true});
}

function readTree(repo, ref) {
  const entries = new Map();
  for (const row of decoder.decode(gitObjects(repo, ['ls-tree','-rz','--full-tree',ref])).split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!match) throw Error('Unrecognized Git tree entry');
    const [, mode, , object, file] = match;
    if (mode === '120000' || mode === '160000') throw Error('Unresolved linked source: ' + file);
    if (scriptPath.test(file)) entries.set(file, object);
  }
  return entries;
}

function readBlobs(repo, ids) {
  if (!ids.size) return new Map();
  const result = new Map();
  const bytes = gitObjects(repo, ['cat-file','--batch'], [...ids].join('\n') + '\n');
  let offset = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset);
    const header = /^(\w+) blob (\d+)$/.exec(bytes.toString('ascii', offset, end));
    if (end < 0 || header?.[1] !== id) throw Error('Missing dependency blob: ' + id);
    const next = end + 1 + Number(header[2]);
    if (bytes[next] !== 10) throw Error('Incomplete dependency blob: ' + id);
    result.set(id, decoder.decode(bytes.subarray(end + 1, next)));
    offset = next + 1;
  }
  return result;
}

function constantString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node?.type !== 'BinaryExpression' || node.operator !== '+') return undefined;
  const left = constantString(node.left), right = constantString(node.right);
  return left === undefined || right === undefined ? undefined : left + right;
}

function relativeModuleURL(node) {
  if (node?.type !== 'NewExpression' || node.callee.name !== 'URL') return undefined;
  const [target, base] = node.arguments;
  if (base?.type !== 'MemberExpression' || base.computed || base.object.type !== 'MetaProperty' ||
      base.object.meta.name !== 'import' || base.property.name !== 'url') return undefined;
  const value = constantString(target);
  if (value === undefined || /^(?:[a-z][a-z\d+.-]*:|\/|\.)/i.test(value)) return value;
  return './' + value;
}

function javascriptLoads(text, file, loads) {
  const ast = parse(text, {ecmaVersion:'latest', sourceType:/\.(?:cjs|cts)$/i.test(file) ? 'commonjs' : 'module'});
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') {
      if (node.source) loads.push({target:node.source.value});
    } else if (node.type === 'ImportExpression') {
      loads.push({target:constantString(node.source) ?? relativeModuleURL(node.source)});
    } else if (node.type === 'CallExpression' && (['require','importScripts'].includes(node.callee.name) ||
        (node.callee.type === 'MemberExpression' && ['require','importScripts'].includes(
          node.callee.computed ? constantString(node.callee.property) : node.callee.property.name)))) {
      for (const arg of node.arguments) loads.push({target:constantString(arg)});
    } else if (node.type === 'NewExpression' && ['Worker','SharedWorker'].includes(node.callee.name)) {
      loads.push({target:relativeModuleURL(node.arguments[0])});
    } else if (node.type === 'NewExpression' && node.callee.name === 'URL') {
      const target = relativeModuleURL(node);
      if (target && scriptPath.test(target.split(/[?#]/, 1)[0])) loads.push({target});
    } else if (node.type === 'Identifier' &&
        ['createRequire','eval','Function','SourceTextModule','compileFunction','registerHooks'].includes(node.name)) {
      loads.push({});
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) pending.push(child);
      } else if (value?.type) pending.push(value);
    }
  }
}

function parseLoads(text, file) {
  const loads = [];
  if (!/\.html?$/i.test(file)) javascriptLoads(text, file, loads);
  else {
    // Audit browser entry points. Unrecognized script markup is an opaque loader.
    if (/<base\b|\bon[a-z]+\s*=/i.test(text)) loads.push({});
    const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    if ((text.match(/<script\b/gi) ?? []).length !== scripts.length) loads.push({});
    for (const [, attributes, body] of scripts) {
      const src = /\bsrc\s*=\s*(["'])([^"'&]+)\1/i.exec(attributes);
      if (src) loads.push({target:src[2], browser:true});
      else if (/\bsrc\b|\bimportmap\b/i.test(attributes)) loads.push({});
      else if (body.trim()) javascriptLoads(body, file, loads);
    }
  }
  return loads;
}

function targets(file, {target, browser}, tree) {
  if (!target || target.startsWith('//') || /^file:|^data:|^blob:/i.test(target)) return null;
  if (target.startsWith('node:')) return [];
  const pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]).replaceAll('\\', '/');
  const relative = /^\.{1,2}(?:\/|$)/.test(pathname);
  if (!relative && !pathname.startsWith('/') && !browser) {
    return /^[\w@][\w@./-]*$/.test(target) && !target.startsWith('#') ? [] : null;
  }
  const names = pathname.startsWith('/') ? [pathname.slice(1), 'public' + pathname] :
    [posix.normalize(posix.join(posix.dirname(file), pathname))];
  if (pathname.startsWith('/')) names.push(posix.normalize(pathname).slice(1), 'public' + posix.normalize(pathname));
  const candidates = names.flatMap(name => [name, name + '.js', name + '.mjs', name + '.cjs', name + '/index.js']);
  const known = [...new Set(candidates.filter(name => tree.has(name)))];
  if (!known.length && (!posix.extname(pathname) || scriptPath.test(pathname))) return null;
  return known;
}

function reverseGraph(tree, blobs, parsed, reviewedLoaders) {
  const consumers = new Map(), opaque = new Set();
  for (const [file, object] of tree) {
    const key = file + '\0' + object;
    if (!parsed.has(key)) parsed.set(key, parseLoads(blobs.get(object), file));
    for (const load of parsed.get(key)) {
      const dependencies = targets(file, load, tree) ??
        (reviewedLoaders[file]?.blob === object ? reviewedLoaders[file].targets : null);
      if (dependencies === null) opaque.add(file);
      else for (const dependency of dependencies) {
        if (!consumers.has(dependency)) consumers.set(dependency, new Set());
        consumers.get(dependency).add(file);
      }
    }
  }
  return {consumers, opaque};
}

function expandConsumers(files, consumers) {
  const reachable = new Set(files);
  for (const file of reachable) {
    for (const consumer of consumers.get(file) ?? []) reachable.add(consumer);
  }
  return reachable;
}

export function dependencyImpact(repo, revisions, files, reviewedLoaders, helpers, tests) {
  const trees = revisions.map(ref => readTree(repo, ref));
  const blobs = readBlobs(repo, new Set(trees.flatMap(tree => [...tree.values()])));
  const parsed = new Map(), affected = new Set(), uncertain = new Set(), usedHelpers = new Set();
  for (const tree of trees) {
    const {consumers, opaque} = reverseGraph(tree, blobs, parsed, reviewedLoaders);
    for (const file of opaque) uncertain.add(file);
    for (const helper of helpers) {
      if ([...expandConsumers([helper], consumers)].some(file=>tests.has(file))) usedHelpers.add(helper);
    }
    // Follow each tree independently so edges from two revisions cannot form a false path.
    for (const file of expandConsumers([...files,...opaque], consumers)) affected.add(file);
  }
  return {affected, uncertain, usedHelpers};
}
