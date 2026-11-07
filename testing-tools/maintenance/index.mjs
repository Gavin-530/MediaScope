import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {maintenanceFixtures} from '../helpers/fixtures.mjs';
const project=fileURLToPath(new URL('../../',import.meta.url));
const tools=[{id:'siti-reference',script:'generate-siti-reference.py',required:['python'],purpose:'Pinned VQEG compatibility vectors'},{id:'controlled-siti',script:'generate-controlled-siti.py',required:['python'],purpose:'Self-authored SDR/PQ controls with independent upstream math'},{id:'layout-reference',script:'generate-layout-reference.py',required:['python','ffmpeg'],purpose:'Native integer layouts from independent descriptors and scalar Sobel/std'}];
export async function runMaintenance(args){
 if(!args.length||args[0]==='--list'){console.log(JSON.stringify({scope:'reference-maintenance',automaticFormalInputUpdates:false,tools},null,2));return;}
 const id=args.shift(),tool=tools.find(t=>t.id===id);if(!tool)throw Error('Unknown reference maintenance tool');
 const values={};while(args.length){const flag=args.shift(),key=flag?.slice(2),value=args.shift();if(!['python','ffmpeg'].includes(key)||values[key]||!value||!path.isAbsolute(value))throw Error('Explicit absolute --python/--ffmpeg paths required');values[key]=value;}
 if(tool.required.some(k=>!values[k])||Object.keys(values).some(k=>!tool.required.includes(k)))throw Error('Required explicit tools: '+tool.required.join(', '));
 const parent=path.join(project,'.build/reference-maintenance');await fs.mkdir(parent,{recursive:true});const directory=await fs.mkdtemp(path.join(parent,tool.id+'-')),output=path.join(directory,'candidate.json');
 const sha=b=>createHash('sha256').update(b).digest('hex'),script=fileURLToPath(new URL('./'+tool.script,import.meta.url));
 const manifest={scope:'reference-maintenance',tool:tool.id,outcome:'running',startedAt:new Date().toISOString(),output};
 async function run(exe,argv){const result=await new Promise((resolve,reject)=>{const child=spawn(exe,argv,{cwd:project,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',MEDIASCOPE_REFERENCE_OUTPUT:output,MEDIASCOPE_REFERENCE_NODE:process.execPath}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}))});if(result.code!==0)throw Error('Independent reference process failed: '+result.stderr.slice(-3000));return result;}
 try{
  manifest.executables=[];for(const [name,file]of [['node',process.execPath],...Object.entries(values)])manifest.executables.push({name,path:file,sha256:sha(await fs.readFile(file))});
  manifest.scriptSha256=sha(await fs.readFile(script));manifest.sourceCommit=execFileSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  manifest.environmentSha256=sha(await fs.readFile(new URL('./environment.lock.json',import.meta.url)));
  let argv=[];
  if(tool.id==='controlled-siti')argv=[await maintenanceFixtures.ensure('siti/vqeg-reference.py'),output];
  if(tool.id==='layout-reference'){
   const wheel=await maintenanceFixtures.ensure('descriptor/av-15.1.0.whl'),extract=fileURLToPath(new URL('./extract-descriptor.py',import.meta.url));manifest.extractorSha256=sha(await fs.readFile(extract));
   const result=await run(values.python,['-B',extract,wheel,path.join(directory,'descriptor')]);const {dll}=JSON.parse(result.stdout);
   argv=[fileURLToPath(new URL('./layout-spec.json',import.meta.url)),dll,values.ffmpeg,output];
  }
  manifest.process=await run(values.python,['-B',script,...argv]);manifest.outputSha256=sha(await fs.readFile(output));manifest.outcome='generated-awaiting-review';
 }catch(error){manifest.outcome='blocked';manifest.error=error.stack;process.exitCode=2;}
 finally{manifest.endedAt=new Date().toISOString();await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({scope:manifest.scope,outcome:manifest.outcome,directory,error:manifest.error},null,2));}
}
