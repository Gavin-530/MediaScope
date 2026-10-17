import fs from 'node:fs/promises';
import path from 'node:path';

// This directory holds maintained programs and metadata, never execution output.
export async function checkToolSources(root){
  const allowedJson=new Set(['coverage.json','fixtures.lock.json']);
  async function visit(directory){
    for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const target=path.join(directory,item.name),relative=path.relative(root,target).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('Linked testing tool source: '+relative);
      if(item.isDirectory()){
        if(!['helpers','tools'].includes(relative))throw Error('Unexpected testing tool directory: '+relative);
        await visit(target);
      }else if(!['.mjs','.ps1','.py','.md'].includes(path.extname(item.name))&&!allowedJson.has(relative))throw Error('Material or output in testing tools: '+relative);
    }
  }
  await visit(root);
}
