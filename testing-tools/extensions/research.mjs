import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project=fileURLToPath(new URL('../../',import.meta.url));

export async function measure({parameters:p,directory,signal},kind){
  const root=path.resolve(project,'.build'),out=path.resolve(p.out);
  if(!out.startsWith(root+path.sep))throw Error('Research output must be inside this project .build');
  for(let current=out;current!==root;current=path.dirname(current)){
    const info=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e});
    if(info?.isSymbolicLink())throw Error('Linked research output');
  }
  const scripts={hash:'hash-audit.mjs',whole:['decode','vectors'].includes(p.phase)?'whole-file-gpu-qualification.mjs':'whole-file-gpu-audit.mjs',cooperative:'cooperative-gpu-audit.mjs'};
  const args=[path.join(project,'testing-tools','extensions','repeat',scripts[kind]),'--out',out,'--phase',p.phase];
  if(p.repetitions!==undefined)args.push('--repetitions',String(p.repetitions));
  if(p['input-audit'])args.push('--input-audit',path.resolve(p['input-audit']));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:project,windowsHide:true,signal});let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  await fs.writeFile(path.join(directory,'process.json'),JSON.stringify({executable:process.execPath,args,...result},null,2));
  if(result.code!==0)throw Error('Research phase failed: '+result.stderr.slice(-2000));
  return {outcome:'passed',phase:p.phase,researchDirectory:out,scope:'Only the explicitly selected research phase completed; not production capability or complete multi-phase acceptance'};
}
