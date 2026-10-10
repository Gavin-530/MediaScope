import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {sourceTestReadiness} from '../test/helpers/test-results.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [generalPath,gpuPath,commit]=process.argv.slice(2);
if(!generalPath||!gpuPath||!commit||process.argv.length!==5)throw Error('Usage: node scripts/verify-source-tests.mjs <general-record-directory> <gpu-record-directory> <exact-release-commit>');
const records=[];
for(const directory of [generalPath,gpuPath]){
  const root=path.resolve(directory);
  // Reuse full record/checksum validation, including results, feature mapping and logs.
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/verify-test-evidence.ps1'),'-Record',root],{windowsHide:true,stdio:'pipe'});
  records.push(JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')));
}
const measurements=JSON.parse(gunzipSync(await fs.readFile(path.join(path.resolve(gpuPath),'measurements.json.gz'))));
const hardware=measurements.entries.filter(e=>/^siti-gpu-[A-Za-z0-9]{6}\/hardware-equivalence\.json$/.test(e.path));
if(hardware.length!==1)throw Error('Exactly one real GPU equivalence measurement is required');
const version=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')).version;
const result=sourceTestReadiness(...records,hardware[0].data,{commit,version});
if(!result.ready)throw Error(result.reasons.join('\n'));
console.log(`Source verification passed for ${commit}: strict general regression + real GPU equivalence. Final ZIP deployment and manual acceptance remain separate requirements.`);
