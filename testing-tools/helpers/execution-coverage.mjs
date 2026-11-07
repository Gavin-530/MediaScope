import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {productContract} from './product-contract.mjs';
import {createHash} from 'node:crypto';
export async function saveExecutionCoverage(source,evidence){
 const files=new Map(productContract.sources.filter(s=>/\.(?:mjs|js)$/.test(s.file)).map(s=>[s.file,{file:s.file,modules:s.modules,runtimes:new Set(),functions:new Map()}]));
 function include(file,functions,runtime){const item=files.get(file);if(!item)return;item.runtimes.add(runtime);for(const fn of functions){if(!fn.ranges?.length)continue;const key=[fn.functionName,fn.ranges[0].startOffset,fn.ranges[0].endOffset].join(':');const prior=item.functions.get(key);if(!prior)item.functions.set(key,structuredClone(fn));else for(const range of fn.ranges){const old=prior.ranges.find(r=>r.startOffset===range.startOffset&&r.endOffset===range.endOffset);if(old)old.count+=range.count;else prior.ranges.push({...range});}}}
 const hashes=new Map();for(const file of files.keys())hashes.set(file,createHash('sha256').update(await fs.readFile(path.join(source,file))).digest('hex'));
 const directory=path.join(source,'.build/v8');for(const name of await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
  const file=path.join(directory,name);if((await fs.lstat(file)).isSymbolicLink())throw Error('Linked V8 coverage');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  for(const script of data.result??[]){if(!script.url.startsWith('file:'))continue;const absolute=fileURLToPath(script.url);if(!absolute.startsWith(source+path.sep))continue;const relative=path.relative(source,absolute).replaceAll('\\','/');let owner=files.has(relative)?relative:[...files.keys()].find(file=>relative.endsWith('/'+file));if(!owner)continue;if(owner!==relative){const bytes=await fs.readFile(absolute).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!bytes||createHash('sha256').update(bytes).digest('hex')!==hashes.get(owner))continue;}include(owner,script.functions,owner===relative?'node':'node-identical-owned-copy');}
 }
 async function visit(dir){for(const item of await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){const file=path.join(dir,item.name);if(item.isSymbolicLink())throw Error('Linked browser coverage');if(item.isDirectory())await visit(file);else if(item.name.endsWith('.json.gz')){const data=JSON.parse(gunzipSync(await fs.readFile(file)));if(data.kind==='browser.coverage')for(const script of data.result)include(script.file,script.functions,'browser');}}}
 await visit(path.join(source,'.build/testing-observations'));
 const rows=[...files.values()].map(({functions,runtimes,...item})=>{const all=[...functions.values()];return {...item,runtimes:[...runtimes],functions:all,discoveredFunctions:all.length,calledFunctions:all.filter(f=>f.ranges[0].count>0).length,uncalledFunctions:all.filter(f=>f.ranges[0].count===0).map(f=>({name:f.functionName,start:f.ranges[0].startOffset,end:f.ranges[0].endOffset})),status:all.length?'observed':'not-observed'};});
 const result={schema:1,scope:'execution-observation',claim:'Actual V8 function/range counts; not branch completeness, standards certification, native-code coverage or proof of absence of bugs. Owned source copies count only if their bytes match; modified fixture sources are excluded.',files:rows};
 await fs.writeFile(path.join(evidence,'execution-coverage.json.gz'),gzipSync(Buffer.from(JSON.stringify(result)+'\n')));return {javascriptFiles:rows.length,observedFiles:rows.filter(r=>r.status==='observed').length,discoveredFunctions:rows.reduce((n,r)=>n+r.discoveredFunctions,0),calledFunctions:rows.reduce((n,r)=>n+r.calledFunctions,0)};
}
