import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {caseContext,project} from './case-catalog.mjs';
import {workspaceId} from './workspace.mjs';

const enabled=!!process.env.NODE_TEST_CONTEXT||!!process.env.MEDIASCOPE_TEST_SELECTION;
const cache=new Map(),invocation=randomUUID().slice(0,8);let serial=0;
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=(value)=>JSON.stringify(value,(key,item)=>typeof item==='bigint'?{$integer:item.toString()}:typeof item==='number'&&!Number.isFinite(item)?{$number:String(item)}:typeof item==='function'?undefined:item);
export const observationRoot=path.resolve(process.env.MEDIASCOPE_OBSERVATIONS||path.join(project,'.build','testing-observations'));
if(!observationRoot.startsWith(path.join(project,'.build')+path.sep))throw Error('TEST_INFRA: observations must stay in the execution workspace');
export const observationDirectory=id=>path.join(observationRoot,'case-'+sha(Buffer.from(id)).slice(0,16));
export async function fileIdentity(value){
 if(typeof value!=='string'||!value.length)return {value,exists:false};
 const file=path.resolve(value);
 try{
  const stat=await fs.stat(file,{bigint:true});if(!stat.isFile())return {file,exists:false};
  const signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  const cached=cache.get(file);if(cached?.signature===signature)return cached.identity;
  const bytes=await fs.readFile(file),identity={file,bytes:bytes.length,sha256:sha(bytes),mtimeNs:stat.mtimeNs.toString()};
  cache.set(file,{signature,identity});return identity;
 }catch(error){if(['ENOENT','ENOTDIR','EINVAL'].includes(error.code))return {file,exists:false};throw error;}
}
export async function recordObservation(kind,payload){
 if(!enabled)return;
 const active=caseContext.getStore(),consumer=active?.id??'setup-'+workspaceId;
 const directory=observationDirectory(consumer);await fs.mkdir(directory,{recursive:true});
 const record={schema:1,consumer,scope:active?'case':'shared-setup',file:active?.file??process.argv[1],kind,...payload};
 const data=gzipSync(Buffer.from(json(record)+'\n'));
 const name=invocation+'-'+String(++serial).padStart(6,'0')+'-'+kind.replace(/[^a-z0-9_-]/gi,'-')+'.json.gz';
 await fs.writeFile(path.join(directory,name),data,{flag:'wx'});
 process.stdout.write('MEDIASCOPE_OBSERVATION '+JSON.stringify({consumer,scope:record.scope,path:path.basename(directory)+'/'+name,kind,bytes:data.length,sha256:sha(data)})+'\n');
 if(active)active.observations=(active.observations??0)+1;
}
const optionKeys=['cwd','sitiDevice','sitiWorkers','sitiSettings','sitiSceneStarts','bitrateWindowMs','decodeThreads','comparisonMode','timingMode','vmafModel','separateMetrics','expectedCandidatePixelFormat'];
function argument(value){
 if(value===null||typeof value!=='object')return typeof value==='function'?'[callback]':value;
 if(Array.isArray(value))return value.length<=4096?value:'[array '+value.length+']';
 const keys=Object.hasOwn(value,'pix_fmt')?['index','pix_fmt','width','height','color_range','color_transfer','color_space','color_primaries','field_order','time_base']:optionKeys;
 return Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
}
export function observed(name,fn,{fileArguments=[],inputFiles}={}){
 return async function(...args){
  if(!enabled)return fn(...args);
  const inputs=await Promise.all((inputFiles?inputFiles(args):fileArguments.map(i=>args[i])).map(fileIdentity)),started=performance.now();
  try{
   const result=await fn(...args);
   await recordObservation(name,{outcome:'returned',arguments:args.map(argument),inputs,result,elapsedMs:performance.now()-started});
   return result;
  }catch(error){
   await recordObservation(name,{outcome:'rejected',arguments:args.map(argument),inputs,error:{name:error.name,message:error.message,code:error.code,phase:error.sitiPhase},elapsedMs:performance.now()-started});
   throw error;
  }
 };
}
