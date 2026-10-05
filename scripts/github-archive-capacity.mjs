import fs from 'node:fs/promises';
import path from 'node:path';
import {assertRoot,noLinks,now} from './github-archive-store.mjs';
export const capacityPolicy={version:1,minimumFreeBytes:1024**3,formalWarningBytes:1024**3,pendingWarningBytes:512*1024**2,action:'warn-only; never delete'};
export function capacityWarnings({freeBytes,formalBytes,pendingBytes}){
  const warnings=[];
  if(freeBytes<capacityPolicy.minimumFreeBytes)warnings.push('free-space-below-1-GiB');
  if(formalBytes>=capacityPolicy.formalWarningBytes)warnings.push('formal-archive-at-least-1-GiB');
  if(pendingBytes>=capacityPolicy.pendingWarningBytes)warnings.push('pending-at-least-512-MiB');
  return warnings;
}
export async function capacityReport(root){
  await assertRoot(root);const result={checkedAt:now(),policy:capacityPolicy,formalBytes:0,pendingBytes:0,cacheBytes:0};
  async function walk(dir,category){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Linked capacity entry forbidden');
    if(entry.isDirectory())await walk(file,category);else if(entry.isFile()){const info=await fs.stat(file);result[category]+=info.size;}
  }}
  await noLinks(root);for(const entry of await fs.readdir(root,{withFileTypes:true})){
    const file=path.join(root,entry.name),category=entry.name==='pending'?'pendingBytes':entry.name==='index'?'cacheBytes':'formalBytes';
    if(entry.isSymbolicLink())throw Error('Linked capacity entry forbidden');if(entry.isDirectory())await walk(file,category);else if(entry.isFile())result[category]+=(await fs.stat(file)).size;
  }
  const space=await fs.statfs(root);result.freeBytes=Number(space.bavail)*Number(space.bsize);result.warnings=capacityWarnings(result);result.atomicSnapshot=false;return result;
}
