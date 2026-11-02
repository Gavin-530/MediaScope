import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Record the executable used through either an explicit path or normal PATH lookup.
export async function repeatTestToolIdentity(name,executable){
  const directories=path.isAbsolute(executable)?['']:executable.includes(path.sep)?[process.cwd()]:(process.env.PATH??'').split(path.delimiter);
  for(const directory of directories)for(const suffix of process.platform==='win32'&&!path.extname(executable)?['.exe','']:['']){
    const candidate=path.resolve(directory,executable+suffix);
    if(!(await stat(candidate).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;}))?.isFile())continue;
    const resolved=await realpath(candidate);
    return {name,path:resolved,sha256:createHash('sha256').update(await readFile(resolved)).digest('hex')};
  }
  throw Error('Test executable is unavailable: '+executable);
}
