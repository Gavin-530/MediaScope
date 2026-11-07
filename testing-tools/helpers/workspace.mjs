import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';

const project=fileURLToPath(new URL('../../',import.meta.url));
const file=process.env.MEDIASCOPE_TEST_FILE||path.relative(project,process.argv[1]||'explicit-tool').replaceAll('\\','/');
export const workspaceId=createHash('sha256').update(file).digest('hex').slice(0,8);
export const workRoot=path.join(project,'.build','testing-work',workspaceId);
await mkdir(workRoot,{recursive:true});
export function workPath(...parts){
 const result=path.resolve(workRoot,...parts);
 if(result!==workRoot&&!result.startsWith(workRoot+path.sep))throw Error('TEST_INFRA: test work path escapes its file workspace');
 return result;
}
