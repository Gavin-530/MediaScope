import fs from 'node:fs/promises';
import path from 'node:path';

// This directory holds maintained programs and metadata, never execution output.
export async function checkToolSources(root){
  const allowedJson=new Set(['coverage.json','fixtures.lock.json','modules/catalog.json','product.json','maintenance/environment.lock.json','maintenance/inputs.lock.json','maintenance/layout-spec.json']);
  const lock=await fs.readFile(path.join(root,'fixtures.lock.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {files:[]};throw e;});
  for(const f of lock.files)if(f.sourceFile?.startsWith('testing-tools/data/'))allowedJson.add(f.sourceFile.slice('testing-tools/'.length));
  const catalog=await fs.readFile(path.join(root,'modules','catalog.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {modules:[]};throw error});
  const modules=new Set(catalog.modules.map(module=>module.id));
  async function visit(directory){
    for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const target=path.join(directory,item.name),relative=path.relative(root,target).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('Linked testing tool source: '+relative);
      if(item.isDirectory()){
        const owned=/^(?:modules|tooling|extensions)\/([a-z][a-z0-9-]*)(?:\/(?:tools|tests))?$/.exec(relative);
        if(!['helpers','modules','tooling','extensions','maintenance','data'].includes(relative)&&!(owned&&modules.has(owned[1])))throw Error('Unexpected testing tool directory: '+relative);
        await visit(target);
      }else if(!['.mjs','.ps1','.py','.md'].includes(path.extname(item.name))&&!allowedJson.has(relative))throw Error('Material or output in testing tools: '+relative);
    }
  }
  await visit(root);
}
