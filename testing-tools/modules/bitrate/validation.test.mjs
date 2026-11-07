import {workRoot,workPath} from '../../helpers/workspace.mjs';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {measureSuite} from './tools/validation.mjs';

test('real high-rate and VFR packet windows preserve byte conservation and unavailable timestamp states',async t=>{
  await mkdir(workRoot,{recursive:true});const directory=await mkdtemp(workPath('bitrate-validation-'));
  const result=await measureSuite(directory,{signal:t.signal,commands:[]});
  assert.equal(result.outcome,'passed');assert.equal(result.cases.length,3);
  await writeFile(path.join(directory,'suite-summary.json'),JSON.stringify(result,null,2));
});
