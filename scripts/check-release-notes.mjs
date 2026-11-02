import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// This checks formatting and the supplied files, never release acceptance.
export function validateReleaseNotes(body, archives) {
  const errors = [];
  const lines = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim().split('\n');
  const headings = [];
  const checksumLines = [];
  let fence = null;
  let checksumBlocks = 0;
  let updateText = '';
  for (const line of lines) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        fence = null;
      } else if (fence.checksum) {
        checksumLines.push(line);
      }
      continue;
    }
    const start = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (start) {
      const checksum = headings.at(-1) === '## 校验';
      fence = {marker: start[1][0], length: start[1].length, checksum};
      if (checksum) {
        checksumBlocks++;
        if (start[1] !== '```' || start[2] !== 'text') errors.push('校验代码块必须以 ```text 开始');
      }
      continue;
    }
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line) || /^ {0,3}(?:=+|-+)\s*$/.test(line)) {
      headings.push(line);
    } else if (headings.at(-1) === '## 本次更新') {
      updateText += line + '\n';
    }
  }
  if (lines[0] !== '## 本次更新' || headings.join('\n') !== '## 本次更新\n## 校验') {
    errors.push('正文须从“## 本次更新”开始，且仅有“## 本次更新”“## 校验”两个标题，顺序固定');
  }
  if (fence) errors.push('存在未闭合的代码块');
  if (!/^\s*-\s+\S/m.test(updateText)) errors.push('本次更新须有实际变化列表');
  if (/^[ \t]+(?:[-+*]|\d+[.)])[ \t]+/m.test(updateText)) errors.push('更新列表不得增加嵌套分类');
  if (/<!--|-->|<(?:SHA-256|实际上传的 ZIP 文件名|本版本变化及其对用户的作用|version)>/i.test(body)) {
    errors.push('正文仍含模板注释或占位符');
  }
  if (checksumBlocks !== 1) errors.push('校验须有且只有一个 text 代码块');
  const declared = new Map();
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64}) {2}(MediaScope-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9]\d*))?)?-win-x64\.zip)$/);
    if (!match) {
      errors.push('校验行须为 64 位小写 SHA-256、两个空格和规范 ZIP 附件名');
      continue;
    }
    if (declared.has(match[2])) errors.push(`重复的校验附件：${match[2]}`);
    declared.set(match[2], match[1]);
  }
  if (!archives.length) errors.push('至少提供一个实际 ZIP 附件');
  const supplied = new Set();
  for (const {name, sha256} of archives) {
    if (supplied.has(name)) errors.push(`重复提供的附件名：${name}`);
    supplied.add(name);
    if (!declared.has(name)) errors.push(`正文缺少附件：${name}`);
    else if (declared.get(name) !== sha256) errors.push(`SHA-256 不匹配：${name}`);
  }
  for (const name of declared.keys()) {
    if (!supplied.has(name)) errors.push(`未提供正文所列附件：${name}`);
  }
  return errors;
}

async function main(args) {
  let bodyPath;
  const archivePaths = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`缺少参数值：${flag}`);
    if (flag === '--body' && !bodyPath) bodyPath = value;
    else if (flag === '--archive') archivePaths.push(value);
    else throw new Error(`未知或重复参数：${flag}`);
  }
  if (!bodyPath || !archivePaths.length) {
    throw new Error('用法：node scripts/check-release-notes.mjs --body <正文> --archive <ZIP> [--archive <ZIP> ...]');
  }
  const body = fs.readFileSync(bodyPath, 'utf8');
  const archives = [];
  for (const archivePath of archivePaths) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk);
    archives.push({name: path.basename(archivePath), sha256: hash.digest('hex')});
  }
  const errors = validateReleaseNotes(body, archives);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`正文结构与 ${archives.length} 个所给附件的名称、SHA-256 一致；不代表发布验收通过。`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
