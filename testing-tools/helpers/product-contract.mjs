import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const productContract=JSON.parse(await fs.readFile(new URL('../product.json',import.meta.url)));
const declarations=text=>({exports:[...text.matchAll(/^export (?:async )?(?:function|const|class) ([\w$]+)/gm)].map(m=>m[1]),functions:[...text.matchAll(/^function ([\w-]+)/gm)].map(m=>m[1])});
const controls=text=>[...text.matchAll(/<(button|input|select)\b([^>]+)>/g)].map((m,index)=>({tag:m[1],id:/\bid="([^"]+)"/.exec(m[2])?.[1]??null,key:/\bdata-(mode|target)="([^"]+)"/.exec(m[2])?.slice(1).join('=')??null,index}));
const routes=text=>[...new Set([...text.matchAll(/url\.pathname===['"]([^'"]+)/g)].map(m=>m[1]))].sort();
const routePatterns=text=>[...text.matchAll(/url\.pathname\.match\((.+)\);/g)].map(m=>m[1]);
export async function validateProduct(catalog,{directory=root,contract=productContract}={}){
 if(contract.schema!==1||contract.scope!=='software-formal'||contract.extensionsIncluded!==false)throw Error('Invalid software contract');
 const domains=contract.modules.map(m=>m.id),ids=new Set();
 for(const r of contract.requirements){
  if(ids.has(r.id)||!domains.includes(r.module)||!r.title||!r.criterion||!r.oracle||!r.cases?.length)throw Error('Incomplete/duplicate software requirement: '+r.id);ids.add(r.id);
  for(const id of [...r.cases,...r.integrationCases??[]])if(!catalog.cases.some(c=>c.id===id&&c.module!=='test-system'))throw Error('Unknown product requirement case: '+id);
 }
 for(const c of catalog.cases){
  if(!c.covers?.includes(c.module)||c.covers.some(m=>m!=='test-system'&&!domains.includes(m)))throw Error('Incomplete case domain binding: '+c.id);
  if(c.module!=='test-system'&&!contract.requirements.some(r=>r.cases.includes(c.id)))throw Error('Unbound product case: '+c.id);
 }
 const seen=new Set();
 for(const source of contract.sources){
  if(seen.has(source.file)||!source.requirements.length||source.requirements.some(id=>!ids.has(id))||!['source','build-input','build-tool'].includes(source.shipment))throw Error('Unbound product source: '+source.file);seen.add(source.file);
  const file=path.resolve(directory,source.file);if(!file.startsWith(path.resolve(directory)+path.sep)||(await fs.lstat(file)).isSymbolicLink())throw Error('Unsafe product source');
  const actual=declarations(await fs.readFile(file,'utf8'));
  for(const key of ['exports','functions'])if(JSON.stringify(actual[key])!==JSON.stringify(source[key]))throw Error('Unreviewed product interface: '+source.file+' '+key);
 }
 for(const folder of ['public','gpu'])for(const name of await fs.readdir(path.join(directory,folder)))if(!seen.has(folder+'/'+name))throw Error('Unreviewed product file: '+folder+'/'+name);
 for(const name of await fs.readdir(directory))if(name.endsWith('.mjs')&&!seen.has(name))throw Error('Unreviewed product entry: '+name);
 if(JSON.stringify(controls(await fs.readFile(path.join(directory,'public/index.html'),'utf8')))!==JSON.stringify(contract.controls))throw Error('Unreviewed product controls');
 if(JSON.stringify(routes(await fs.readFile(path.join(directory,'server.mjs'),'utf8')))!==JSON.stringify(contract.api.map(r=>r.route)))throw Error('Unreviewed API routes');
 if(JSON.stringify(routePatterns(await fs.readFile(path.join(directory,'server.mjs'),'utf8')))!==JSON.stringify(contract.apiPatterns))throw Error('Unreviewed dynamic API routes');
 return {requirements:ids.size,sources:seen.size,api:contract.api.length,controls:contract.controls.length,extensionsIncluded:false};
}
export function assessRequirements(caseCoverage,contract=productContract){
 const rows=contract.requirements.map(r=>{const selected=r.cases.filter(id=>caseCoverage.cases.some(c=>c.id===id));const missing=r.cases.filter(id=>!selected.includes(id));const failures=selected.filter(id=>caseCoverage.cases.find(c=>c.id===id)?.status!=='passed');return {id:r.id,module:r.module,caseIds:r.cases,selected: selected.length,status:!selected.length?'not-selected':failures.length?'failed':missing.length?'partial':'passed',missing,failures};});
 return {schema:1,scope:'requirement-assessment',extensionsIncluded:false,complete:rows.every(r=>r.status==='passed'),requirements:rows};
}
export function requirementCases(ids,contract=productContract){
 const result=new Set();for(const id of ids){const r=contract.requirements.find(r=>r.id===id);if(!r)throw Error('Unknown behavior requirement: '+id);for(const c of r.cases)result.add(c);}return [...result];
}
export async function softwareIdentity(directory=root){
 const entries=[];
 for(const source of productContract.sources){const b=await fs.readFile(path.join(directory,source.file));entries.push({path:source.file,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 return {sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries};
}
export async function testSystemIdentity(directory=root){
 const rows=[];
 async function visit(folder){for(const e of (await fs.readdir(path.join(directory,folder),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const relative=folder+'/'+e.name;if(e.isSymbolicLink())throw Error('Linked test system input');if(e.isDirectory())await visit(relative);else rows.push({path:relative,sha256:createHash('sha256').update(await fs.readFile(path.join(directory,relative))).digest('hex')});}}
 for(const folder of ['testing-tools','scripts'])await visit(folder);
 const lock=await fs.access(path.join(directory,'harness-package-lock.json')).then(()=> 'harness-package-lock.json').catch(()=> 'package-lock.json');
 rows.push({path:'package-lock.json',sha256:createHash('sha256').update(await fs.readFile(path.join(directory,lock))).digest('hex')});
 return {sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),files:rows};
}
export function affectedModules(files,contract=productContract){
 const result=new Set();
 for(const file of files){
  if(/^(docs\/|licenses\/|README\.md$|\.github\/|\.gitattributes$|\.gitignore$)/.test(file))continue;
  if(file.startsWith('testing-tools/extensions/')||file.startsWith('testing-tools/maintenance/'))continue;
  const source=contract.sources.find(s=>s.file===file);
  if(source){for(const module of source.modules)result.add(module);continue;}
  const test=/^testing-tools\/modules\/([^/]+)\//.exec(file);if(test){result.add(test[1]);continue;}
  return [...contract.modules.map(m=>m.id),'test-system']; // shared or unknown code: conservative full selection
 }
 return [...result];
}
