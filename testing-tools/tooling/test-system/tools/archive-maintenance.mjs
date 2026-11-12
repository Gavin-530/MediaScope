import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {caseCatalog, project} from '../../../helpers/case-catalog.mjs';

const selected=caseCatalog.cases.filter(entry=>entry.archiveMaintenance);
if(!selected.length)throw Error('No archive maintenance cases registered');
const build=path.join(project,'.build');
await fs.mkdir(build,{recursive:true});
const dir=await fs.mkdtemp(path.join(build,'archive-maintenance-'));
const selection=path.join(dir,'selection.json');
const caseIds=selected.map(entry=>entry.id);
await fs.writeFile(selection,JSON.stringify({caseIds}));
const files=[...new Set(selected.map(entry=>entry.file))];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...files],{
  cwd:project,windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024,
  env:{...process.env,MEDIASCOPE_TEST_SELECTION:selection}
});
await fs.writeFile(path.join(dir,'tests.log'),(result.stdout??'')+(result.stderr??''));
if(result.error)throw result.error;
const rows=[...result.stdout.matchAll(/^# MEDIASCOPE_CHECKS (.+)$/gm)].map(match=>JSON.parse(match[1]));
const recorded=new Set(rows.map(row=>row.caseId));
if(result.status!==0||rows.length!==caseIds.length||recorded.size!==caseIds.length||
   caseIds.some(id=>!recorded.has(id))||rows.some(row=>row.assertions<1)||
   !/^# skipped 0\r?$/m.test(result.stdout)||!/^# todo 0\r?$/m.test(result.stdout)){
  throw Error('Archive maintenance validation failed; see '+path.join(dir,'tests.log'));
}
console.log('Archive maintenance: '+caseIds.length+' cases passed; log: '+path.join(dir,'tests.log'));
