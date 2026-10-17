import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const lockBytes=await fs.readFile(new URL('../fixtures.lock.json',import.meta.url));
export const fixtureLock=JSON.parse(lockBytes);
export const fixtureLockSha256=createHash('sha256').update(lockBytes).digest('hex');
export const fixtureCache=path.resolve(process.env.MEDIASCOPE_TEST_FIXTURES||fileURLToPath(new URL('../../.build/testing-fixtures/'+fixtureLockSha256,import.meta.url)));

// Only this reviewed manifest identifies reusable inputs; generated media never enters it.
export function createFixtureStore({root=fixtureCache,entries=fixtureLock.files,fetcher=fetch}={}){
  root=path.resolve(root);
  const items=new Map(),pending=new Map();
  for(const item of entries){
    if(!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(item.path)||item.path.split('/').some(p=>p==='.'||p==='..')||
      !/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<1||items.has(item.path)||new URL(item.url).protocol!=='https:')throw Error('Invalid fixture lock entry: '+item.path);
    items.set(item.path,item);
  }
  const file=name=>{
    if(!items.has(name))throw Error('Fixture is not locked: '+name);
    const target=path.resolve(root,name);
    if(!target.startsWith(root+path.sep))throw Error('Fixture outside cache');
    return target;
  };
  async function guard(target){
    for(let current=target;;current=path.dirname(current)){
      const stat=await fs.lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error});
      if(stat?.isSymbolicLink())throw Error('Linked fixture cache: '+current);
      if(current===path.dirname(current))break;
    }
  }
  const verify=(bytes,item)=>{
    if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Fixture checksum mismatch: '+item.path);
    return bytes;
  };
  async function prepare(name){
    const target=file(name),item=items.get(name);await guard(target);
    try{verify(await fs.readFile(target),item);return target}catch(error){if(error.code!=='ENOENT')throw error}
    let response;
    for(let attempt=0;attempt<3;attempt++){
      try{
        response=await fetcher(item.url,{signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw Error('HTTP '+response.status);
        break;
      }catch(error){if(attempt===2)throw Error('Cannot prepare fixture '+name+': '+error.message,{cause:error})}
    }
    const chunks=[];let length=0;
    for await(const chunk of response.body){length+=chunk.length;if(length>item.bytes)throw Error('Fixture exceeds locked size: '+name);chunks.push(chunk)}
    const bytes=verify(Buffer.concat(chunks),item);
    await fs.mkdir(path.dirname(target),{recursive:true});await guard(target);
    const partial=target+'.partial-'+randomUUID();
    try{
      await fs.writeFile(partial,bytes,{flag:'wx'});
      try{await fs.rename(partial,target)}catch(error){
        // A parallel test process may have completed the same immutable download.
        try{verify(await fs.readFile(target),item)}catch{throw error}
      }
    }finally{await fs.unlink(partial).catch(error=>{if(error.code!=='ENOENT')throw error})}
    return target;
  }
  const ensure=name=>{
    file(name);
    if(!pending.has(name))pending.set(name,prepare(name).finally(()=>pending.delete(name)));
    return pending.get(name);
  };
  return {root,file,ensure,async read(name){const target=await ensure(name);return verify(await fs.readFile(target),items.get(name))},
    async prepareAll(){for(const name of items.keys())await ensure(name);return {lockSha256:fixtureLockSha256,files:items.size,bytes:entries.reduce((sum,item)=>sum+item.bytes,0)}}};
}

export const fixtures=createFixtureStore();
export const readFixture=name=>fixtures.read('siti/'+name);
