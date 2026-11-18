import {readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {decodeMeasurements,encodeMeasurements} from '../testing-tools/helpers/measurement-codec.mjs';

const [record,output]=process.argv.slice(2);
if(!record||process.argv.length>4)throw Error('Usage: node scripts/preview-measurement-compaction.mjs <record-directory> [new-attachment-path]');
const input=resolve(record,'measurements.json.gz');
const manifest=JSON.parse((await readFile(resolve(record,'manifest.json'),'utf8')).replace(/^\uFEFF/,''));
const started=Date.parse(manifest.startedAt);
const month=Number.isFinite(started)?new Date(started+8*3600000).toISOString().slice(0,7):null;
if(manifest.kind!=='App'||month!=='2026-11')throw Error('Expected an App run started in November 2026 (Asia/Shanghai)');
const original=await readFile(input);
const measurements=decodeMeasurements(original);
const candidate=encodeMeasurements(measurements);
const smaller=candidate.length<original.length;
if(output&&smaller){
  const build=await realpath(fileURLToPath(new URL('../.build/',import.meta.url)));
  const destination=await realpath(dirname(resolve(output)));
  const location=relative(build,destination);
  if(!location||location.startsWith('..')||isAbsolute(location))throw Error('Stage within a dedicated .build directory');
  await writeFile(output,candidate,{flag:'wx'});
}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({originalMeasurementSha256:sha256(original),candidateMeasurementSha256:sha256(candidate),runId:manifest.runId,originalBytes:original.length,candidateBytes:candidate.length,
  savedBytes:Math.max(0,original.length-candidate.length),staged:!!output&&smaller},null,2));
