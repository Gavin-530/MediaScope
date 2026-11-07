import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {caseCatalog} from './case-catalog.mjs';

const fileKey=file=>createHash('sha256').update(file).digest('hex').slice(0,8);
async function visit(root,{skipLinks=false}={}){
 const result=[];const stat=await fs.lstat(root).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!stat)return result;if(stat.isSymbolicLink())throw Error('TEST_INFRA: linked measurement root');
 for(const entry of await fs.readdir(root,{withFileTypes:true})){
  const file=path.join(root,entry.name);if(entry.isSymbolicLink()){if(skipLinks)continue;throw Error('TEST_INFRA: linked measurement entry');}
  if(entry.isDirectory())result.push(...(await visit(file,{skipLinks})));else result.push(file);
 }
 return result;
}
export async function saveObservedMeasurements(generated,evidence,{observationRoot,caseIds,requiredMeasurements=[],failed=false}){
 const selected=caseIds.map(id=>{const c=caseCatalog.cases.find(x=>x.id===id);if(!c)throw Error('Unknown observed case: '+id);return c;});
 const entries=[],checks=new Map();
 for(const file of await visit(observationRoot)){
  if(!file.endsWith('.json.gz'))throw Error('TEST_INFRA: undeclared observation format');
  const data=JSON.parse(gunzipSync(await fs.readFile(file)));
  if(data.schema!==1||typeof data.consumer!=='string'||!['case','shared-setup'].includes(data.scope))throw Error('TEST_INFRA: malformed observation');
  if(data.scope==='case'&&!caseIds.includes(data.consumer))throw Error('TEST_INFRA: observation outside selected scope');
  if(data.scope==='shared-setup'&&!selected.some(c=>data.consumer==='setup-'+fileKey(c.file)))throw Error('TEST_INFRA: setup observation outside selected files');
  const relative=path.relative(observationRoot,file).replaceAll('\\','/');
  entries.push({path:'observations/'+relative,caseId:data.scope==='case'?data.consumer:undefined,kind:data.kind,data});
  if(data.kind==='case-checks'){
   if(checks.has(data.consumer))throw Error('TEST_INFRA: duplicate assertion receipt');
   checks.set(data.consumer,data);
  }
 }
 // Only explicitly declared numeric output is collected. Protocol fixtures and
 // arbitrary .json files are never swept into the product measurement archive.
 const outputOwners=[...new Set(requiredMeasurements.map(r=>fileKey(selected.find(c=>c.id===r.caseId).file)))];
 for(const file of (await Promise.all(outputOwners.map(owner=>visit(path.join(generated,owner),{skipLinks:true})))).flat()){
  const relative=path.relative(generated,file).replaceAll('\\','/'),parts=relative.split('/'),owner=parts.shift(),logical=parts.join('/');
  const matched=requiredMeasurements.filter(r=>{const c=selected.find(x=>x.id===r.caseId);return c&&owner===fileKey(c.file)&&r.pathPattern.test(logical);});
  if(!matched.length)continue;
  const b=await fs.readFile(file),data=JSON.parse((file.endsWith('.gz')?gunzipSync(b):b).toString('utf8'));
  entries.push({path:logical,sourcePath:relative,caseIds:matched.map(r=>r.caseId),kind:'declared-measurement',data});
 }
 if(!failed){
  for(const c of selected)if(!checks.has(c.id)||checks.get(c.id).assertions<1)throw Error('TEST_INFRA: missing/nonexecuted assertion receipt: '+c.id);
  for(const r of requiredMeasurements)if(!entries.some(e=>e.caseIds?.includes(r.caseId)&&r.pathPattern.test(e.path)&&e.data?.outcome==='passed'))throw Error('TEST_INFRA: missing declared measurement: '+r.caseId);
 }
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 if(entries.length)await fs.writeFile(path.join(evidence,'measurements.json.gz'),gzipSync(Buffer.from(JSON.stringify({schema:2,entries})+'\n')));
 await fs.writeFile(path.join(evidence,'assertions.json'),JSON.stringify({schema:1,cases:selected.map(c=>({id:c.id,assertions:checks.get(c.id)?.assertions??0,productionObservations:checks.get(c.id)?.productionObservations??0}))},null,2)+'\n');
 return {measurements:entries.length,diagnostics:0,caseReceipts:checks.size,collection:'declared outputs and real production observations; no arbitrary fixture sweep'};
}
