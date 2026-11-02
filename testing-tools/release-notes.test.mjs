import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateReleaseNotes} from '../scripts/check-release-notes.mjs';

const name = 'MediaScope-0.3.0-win-x64.zip';
const sha256 = 'a'.repeat(64);
const archives = [{name, sha256}];
const body = `## 本次更新\n\n- 新增功能，支持导出。\n\n兼容性：旧文件只读，升级前请保存。\n\n## 校验\n\n\`\`\`text\n${sha256}  ${name}\n\`\`\`\n`;

test('[release-notes] accepts two sections, unrestricted factual paragraphs, CRLF and BOM', () => {
  assert.deepEqual(validateReleaseNotes(body, archives), []);
  assert.deepEqual(validateReleaseNotes('\uFEFF' + body.replaceAll('\n', '\r\n'), archives), []);
  assert.deepEqual(validateReleaseNotes(body.replace('兼容性：', '已知问题：' + '必要限制。'.repeat(500)), archives), []);
});

test('[release-notes] rejects extra, missing, reordered and duplicate headings', () => {
  for (const invalid of [
    body.replace('兼容性：', '## 升级与兼容性\n兼容性：'),
    body.replace('兼容性：', '### 新增\n兼容性：'),
    body.replace('## 校验', '## 本次更新'),
    body.replace('## 本次更新', '## 校验'),
    '# MediaScope 0.3.0\n' + body,
    body.replace('兼容性：', '额外标题\n===\n兼容性：'),
  ]) assert.ok(validateReleaseNotes(invalid, archives).length);
});

test('[release-notes] rejects empty updates, nested categories, comments and template placeholders', () => {
  for (const invalid of [
    body.replace('- 新增功能，支持导出。', ''),
    body.replace('- 新增功能，支持导出。', '- 分类\n  - 新增功能'),
    body + '<!-- 提示 -->',
    body.replace('新增功能，支持导出。', '<本版本变化及其对用户的作用>'),
  ]) assert.ok(validateReleaseNotes(invalid, archives).length);
});

test('[release-notes] rejects missing, duplicate, malformed or unclosed checksum blocks', () => {
  for (const invalid of [
    body.replace('```text', '```'),
    body + '```text\n```\n',
    body.slice(0, -4),
    body.replace(`${sha256}  `, `${sha256} `),
    body.replace(sha256, sha256.toUpperCase()),
    body.replace(name, '../' + name),
    body.replace(`${sha256}  ${name}`, `${sha256}  ${name}\n${sha256}  ${name}`),
  ]) assert.ok(validateReleaseNotes(invalid, archives).length);
});

test('[release-notes] requires exact correspondence, matching bytes and unique attachment names', () => {
  assert.ok(validateReleaseNotes(body, []).length);
  assert.ok(validateReleaseNotes(body, [{name, sha256: 'b'.repeat(64)}]).length);
  assert.ok(validateReleaseNotes(body, [...archives, ...archives]).length);
  assert.ok(validateReleaseNotes(body, [{name: 'other.zip', sha256}]).length);
  const extra = {name: 'MediaScope-0.3.0-rc.1-win-x64.zip', sha256: 'b'.repeat(64)};
  const two = body.replace(`${sha256}  ${name}`, `${sha256}  ${name}\n${extra.sha256}  ${extra.name}`);
  assert.deepEqual(validateReleaseNotes(two, [...archives, extra]), []);
  assert.ok(validateReleaseNotes(two, archives).length);
});

test('[release-notes] maintained template produces a valid body after filling and removing prompts', () => {
  const template = fs.readFileSync(new URL('../.github/RELEASE_TEMPLATE.md', import.meta.url), 'utf8');
  const filled = template.replace(/<!--[\s\S]*?-->/g, '')
    .replace('<本版本变化及其对用户的作用>', '修复导出失败时提示不明确的问题。')
    .replace('<SHA-256>', sha256).replace('<实际上传的 ZIP 文件名>', name);
  assert.deepEqual(validateReleaseNotes(filled, archives), []);
  assert.ok(validateReleaseNotes(template, archives).length);
});

test('[release-notes] CLI hashes actual bytes and distinguishes validation, usage and read errors', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  fs.mkdirSync(path.join(root, '.build'), {recursive: true});
  const dir = fs.mkdtempSync(path.join(root, '.build/release-notes-test-'));
  try {
    const zip = path.join(dir, name);
    const notes = path.join(dir, 'body.md');
    fs.writeFileSync(zip, 'fixture bytes; archive structure is checked separately');
    const hash = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    fs.writeFileSync(notes, body.replace(sha256, hash));
    const run = args => spawnSync(process.execPath, [path.join(root, 'scripts/check-release-notes.mjs'), ...args], {encoding: 'utf8'});
    const args = ['--body', notes, '--archive', zip];
    assert.equal(run(args).status, 0);
    fs.appendFileSync(zip, 'changed');
    assert.equal(run(args).status, 1);
    assert.equal(run([]).status, 2);
    assert.equal(run([...args, '--body', notes]).status, 2);
    assert.equal(run(['--body', notes, '--archive', zip + '.missing']).status, 2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
