import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';

export const project=fileURLToPath(new URL('../../',import.meta.url));
export const caseCatalog=JSON.parse(fs.readFileSync(new URL('../modules/catalog.json',import.meta.url),'utf8'));
export const caseContext=new AsyncLocalStorage();
export function validateCatalog(catalog){
  if(catalog.schema!==1||!Array.isArray(catalog.modules)||!Array.isArray(catalog.cases))throw Error('Invalid test catalog');
  const modules=new Set(),ids=new Set(),names=new Set(),workspaces=new Map();
  for(const m of catalog.modules){if(!/^[a-z][a-z0-9-]*$/.test(m.id)||modules.has(m.id))throw Error('Duplicate/invalid module: '+m.id);modules.add(m.id)}
  for(const c of catalog.cases){
    if(!modules.has(c.module)||typeof c.id!=='string'||!c.id.startsWith(c.module+'.')||ids.has(c.id))throw Error('Unknown module or duplicate case ID: '+c.id);
    if(!['general','browser','gpu','native'].includes(c.scope)||!/^testing-tools\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.mjs$/.test(c.file)||typeof c.name!=='string'||!c.name)throw Error('Invalid formal case: '+c.id);
    const identity=c.file+'\0'+c.name;if(names.has(identity))throw Error('Duplicate registration: '+identity);names.add(identity);ids.add(c.id);
    const owner=c.module==='test-system'?'tooling/test-system':'modules/'+c.module;
    if(!c.file.startsWith('testing-tools/'+owner+'/'))throw Error('Misowned formal case: '+c.id);
    const workspace=createHash('sha256').update(c.file).digest('hex').slice(0,8);if(workspaces.has(workspace)&&workspaces.get(workspace)!==c.file)throw Error('Test workspace identity collision');workspaces.set(workspace,c.file);
    if(!Array.isArray(c.inputs))throw Error('Missing allowed input declarations: '+c.id);
    if(c.archiveMaintenance!==undefined&&(c.archiveMaintenance!==true||c.module!=='test-system'||c.scope!=='general'||c.requiresMedia!==false||c.requiresBrowser===true||c.covers?.some(m=>m!=='test-system')))throw Error('Invalid archive maintenance case: '+c.id);
    for(const key of ['requiresMedia','requiresBrowser'])if(c[key]!==undefined&&typeof c[key]!=='boolean')throw Error('Invalid test prerequisite: '+key+' / '+c.id);
    for(const artifact of c.artifacts??[])new RegExp(artifact);
  }
  if(!ids.size)throw Error('Empty formal catalog');return catalog;
}
validateCatalog(caseCatalog);
const locked=JSON.parse(fs.readFileSync(new URL('../fixtures.lock.json',import.meta.url),'utf8'));
const roles={schema:1,files:locked.files};
const roleNames=new Set(['compatibility-reference','independent-reference','provenance','license','upstream-media','upstream-source','upstream-vector-archive']);
if(locked.schema!==2||locked.scope!=='formal'||roles.files.some(f=>!roleNames.has(f.role)||f.consumerGroup!==f.path.split('/')[0]||f.scope!=='formal'))throw Error('Invalid formal input role or scope');
if(roles.files.length!==locked.files.length||new Set(roles.files.map(f=>f.path)).size!==roles.files.length)throw Error('Input role manifest must match the immutable lock');
for(const input of locked.files)if(!roles.files.some(f=>f.path===input.path&&f.role))throw Error('Missing input role: '+input.path);
for(const c of caseCatalog.cases)for(const input of c.inputs)if(!locked.files.some(f=>f.path===input))throw Error('Unlocked case input: '+input);
for(const input of roles.files)for(const attachment of input.attachments??[])if(!locked.files.some(f=>f.path===attachment)||attachment===input.path)throw Error('Invalid input attachment: '+attachment);
export const inputAttachments=name=>roles.files.find(f=>f.path===name)?.attachments??[];

export function selectCases({suite='full',modules=[],cases=[],includeArchiveMaintenance=false}={},catalog=caseCatalog){
  validateCatalog(catalog);
  if(!['full','core','browser','gpu','native'].includes(suite))throw Error('Unknown suite: '+suite);
  for(const module of modules)if(!catalog.modules.some(m=>m.id===module))throw Error('Unknown module: '+module);
  for(const id of cases)if(!catalog.cases.some(c=>c.id===id))throw Error('Unknown case ID: '+id);
  const eligible=catalog.cases.filter(c=>['gpu','native','browser'].includes(suite)?c.scope===suite:['general',...(suite==='full'?['browser']:[])].includes(c.scope));
  const selected=eligible.filter(c=>(!c.archiveMaintenance||includeArchiveMaintenance||cases.includes(c.id))&&(!modules.length||modules.some(m=>(c.covers??[c.module]).includes(m)))&&(!cases.length||cases.includes(c.id)));
  if(!selected.length)throw Error('No formal cases match this selection');
  for(const id of cases)if(!selected.some(c=>c.id===id))throw Error('Case is outside the selected suite/module: '+id);
  return {suite,selective:!!(modules.length||cases.length),modules:[...new Set(selected.map(c=>c.module))],caseIds:selected.map(c=>c.id),files:[...new Set(selected.map(c=>c.file))].sort(),cases:selected,excluded:catalog.cases.length-selected.length};
}
export function assessCases(selection,results){
  const cases=selection.cases.map(c=>{const found=results.filter(r=>r.caseId===c.id);const r=found[0];return {id:c.id,module:c.module,file:c.file,name:c.name,status:found.length!==1?'missing-or-duplicate':r.file!==c.file||r.name!==c.name?'mismatched-identity':r.skip?'skipped':r.todo?'todo':r.event==='test:pass'?'passed':'failed'}});
  const unexpected=results.filter(r=>!selection.cases.some(c=>c.id===r.caseId&&c.file===r.file&&c.name===r.name));
  return {accepted:cases.every(c=>c.status==='passed')&&!unexpected.length,identitiesComplete:cases.every(c=>!['missing-or-duplicate','mismatched-identity'].includes(c.status))&&!unexpected.length,cases,unexpected};
}
export function moduleResults(selection,results){
  const assessed=assessCases(selection,results);
  return selection.modules.map(id=>{const cases=assessed.cases.filter(c=>c.module===id);return {id,status:cases.every(c=>c.status==='passed')?'passed':'failed',caseIds:cases.map(c=>c.id),checks:cases}});
}
export function requiredMeasurements(selection){return selection.cases.flatMap(c=>(c.artifacts??[]).map(pattern=>({caseId:c.id,testName:c.name,pathPattern:new RegExp(pattern)})))}

export function recordInput(item){
  const context=caseContext.getStore();
  const stack=context?null:new Error().stack;
  const relative=context?.file??stack?.match(/(?:\/|\\)(testing-tools(?:\/|\\)[^\s)]+\.test\.mjs)/)?.[1]?.replaceAll('\\','/');
  const consumers=context?[caseCatalog.cases.find(c=>c.id===context.id)]:caseCatalog.cases.filter(c=>c.file===relative);
  if(consumers.length&&consumers.every(c=>!c.inputs.includes(item.path)))throw Error('Undeclared fixed input: '+item.path+' for '+(context?.id??relative));
  return ()=>process.stdout.write('MEDIASCOPE_INPUT '+JSON.stringify({consumer:context?.id??relative??'explicit-tool',scope:context?'case':'shared-file-input',...item,role:roles.files.find(f=>f.path===item.path)?.role})+'\n');
}

export function selectionPath(file){const resolved=path.resolve(file),root=path.resolve(project,'.build');if(!resolved.startsWith(root+path.sep))throw Error('Selection manifest outside execution workspace');return resolved}
