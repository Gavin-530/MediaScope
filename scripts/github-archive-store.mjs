import fs from 'node:fs/promises';
import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';
import {evidenceNameAliases} from './github-archive-evidence-names.mjs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const FORMAT=1;
export const TARGET={host:'github.com',repository:'Gavin-530/MediaScope',repositoryId:'1377031380'};
export const now=({milliseconds=false}={})=>{const value=new Date().toISOString();return milliseconds?value:value.replace(/\.\d{3}Z$/,'Z')};
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function safeRelative(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe relative archive path');
  return name;
}
// Only current archive locations are normalized. Embedded original paths remain evidence.
export function canonicalTimePath(name){
  safeRelative(name);
  const parts=name.split('/');
  for(let i=0;i<parts.length;i++){
    if(parts[i]==='original'||parts[i]==='received'&&parts.slice(0,i).includes('revisions'))break;
    if(!(i===0&&parts.length===1&&/^(inventory|prune-plan)-/.test(parts[0]))&&!(i===1&&['records','sync-reports','migration-reports'].includes(parts[0]))&&parts[i-1]!=='revisions')continue;
    parts[i]=parts[i].replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z/g,(whole,y,m,d,h,min,s,fraction='')=>{
      const base=`${y}-${m}-${d}T${h}:${min}:${s}`;
      if(!Number.isFinite(Date.parse(base+'Z'))||new Date(base+'Z').toISOString().slice(0,19)!==base)throw Error('Invalid UTC archive timestamp: '+whole);
      return `${y}${m}${d}T${h}${min}${s}${fraction}Z`;
    });
  }
  return parts.join('/');
}
export function evidenceLocationAliases(root){
  const aliases=new Map(),records=path.join(root,'records');
  if(!existsSync(records))return aliases;
  if(lstatSync(records).isSymbolicLink())throw Error('Linked evidence records');
  for(const entry of readdirSync(records,{withFileTypes:true})){
    const dir=inside(root,path.join(records,entry.name));
    if(entry.isSymbolicLink())throw Error('Linked evidence record');
    if(!entry.isDirectory())continue;
    const rp=path.join(dir,'record.json'),mp=path.join(dir,existsSync(rp)?'original/manifest.json':'manifest.json');
    if(!existsSync(mp))continue;
    if(lstatSync(mp).isSymbolicLink()||existsSync(rp)&&lstatSync(rp).isSymbolicLink()||existsSync(rp)&&lstatSync(path.join(dir,'original')).isSymbolicLink())throw Error('Linked evidence manifest');
    const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
    const envelope=existsSync(rp)?read(rp):null,manifest=read(mp);
    for(const alias of new Set([entry.name,...evidenceNameAliases(manifest,envelope)])){
      aliases.set(alias,[...(aliases.get(alias)??[]),dir]);
    }
  }
  return aliases;
}
export function resolveArchivePath(root,relative,{aliases}={}){
  safeRelative(relative);
  const old=inside(root,path.join(root,relative)),current=inside(root,path.join(root,canonicalTimePath(relative)));
  if(old!==current&&existsSync(old)&&existsSync(current))throw Error('Ambiguous old and current archive locations');
  // Old sealed receipts keep their original paths. Resolve only the record
  // component, using each record's own complete identity, never a short token.
  if(relative.startsWith('records/')&&existsSync(path.join(root,'records'))){
    const parts=relative.split('/'),matches=(aliases??evidenceLocationAliases(root)).get(parts[1])??[];
    if(matches.length>1)throw Error('Ambiguous evidence identity locations');
    if(matches.length===1)return inside(root,path.join(matches[0],...parts.slice(2)));
  }
  return existsSync(old)?old:current;
}
export function archiveObject(name){
  safeRelative(name);
  if(!/^(releases|actions|issues|pull-requests|discussions|repository|supplements|migration-reports|sync-reports)\/.+$/.test(name))throw Error('Object outside archive categories');
  if(name.startsWith('actions/')&&!/^actions\/[1-9]\d*(\/attempts\/[1-9]\d*\/(jobs\/[1-9]\d*|artifacts\/[1-9]\d*|evidence\/[a-f0-9]{20,64}))?$/.test(name))throw Error('Actions layout differs from original plan');
  return name;
}
export function inside(root,target,{equal=false}={}){
  const rel=path.relative(path.resolve(root),path.resolve(target));
  if((!rel&&!equal)||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Path outside owned root');
  return path.resolve(target);
}
export async function noLinks(target){
  let current=path.resolve(target);
  for(;;){
    try{if((await fs.lstat(current)).isSymbolicLink())throw Error('Linked archive path forbidden')}catch(e){if(e.code!=='ENOENT')throw e}
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
}
export async function tree(root){
  await noLinks(root);
  const files=[],seen=new Set();
  async function walk(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),rel=path.relative(root,file).replaceAll('\\','/');safeRelative(rel);
      if(seen.has(rel.toLowerCase()))throw Error('Case-conflicting archive paths');seen.add(rel.toLowerCase());
      const st=await fs.lstat(file);if(st.isSymbolicLink())throw Error('Linked archive entry forbidden');
      if(st.isDirectory())await walk(file);else if(st.isFile())files.push({path:rel,bytes:st.size,sha256:await fileHash(file)});else throw Error('Special archive file forbidden');
    }
  }
  await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
export async function fileHash(file){
  await noLinks(file);const h=createHash('sha256'),handle=await fs.open(file,'r');
  try{for await(const b of handle.createReadStream())h.update(b);return h.digest('hex')}finally{await handle.close()}
}
export async function readJson(file){await noLinks(file);return JSON.parse(await fs.readFile(file,'utf8'))}
export async function exists(file){try{await fs.lstat(file);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
export async function writeJson(file,value){
  await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,jsonBytes(value),{flag:'wx'});await fs.rename(temp,file);
}
export function assertIdentity(value){
  if(value.host!==TARGET.host||value.repository!==TARGET.repository||String(value.repositoryId)!==TARGET.repositoryId)throw Error('Repository identity mismatch');
}
export async function initialize(root,repository){
  await noLinks(root);assertIdentity(repository);
  const file=path.join(root,'repository.json');
  if(await exists(file)){const old=await readJson(file);assertIdentity(old);if(old.format!==FORMAT)throw Error('Unsupported archive format')}
  else{await fs.mkdir(root,{recursive:true});await writeJson(file,{format:FORMAT,...TARGET,boundAt:now(),validator:'github-archive-store/v1'})}
}
export async function assertRoot(root){const identity=await readJson(path.join(root,'repository.json'));assertIdentity(identity);if(identity.format!==FORMAT)throw Error('Unsupported archive format');return identity}
export async function lock(root,command){
  await assertRoot(root);const file=path.join(root,'pending','archive.lock');await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});
  let handle;try{handle=await fs.open(file,'wx')}catch(e){if(e.code==='EEXIST')throw Error('Archive lock exists: active or interrupted operation; inspect it before recovery');throw e}
  const identity={owner:'mediascope-github-archive',taskId:randomUUID(),pid:process.pid,command,startedAt:now()};await handle.writeFile(jsonBytes(identity));
  return {identity,async release(){await handle.close();const current=await readJson(file);if(current.taskId!==identity.taskId)throw Error('Archive lock ownership changed');await fs.unlink(file)}};
}
export async function verifySnapshot(dir){
  const files=await tree(dir),manifest=await readJson(path.join(dir,'archive-manifest.json'));
  if(manifest.format!==FORMAT||manifest.kind!=='github-platform-snapshot'||manifest.comparisonVersion!==1)throw Error('Unsupported sealed manifest');assertIdentity(manifest);
  archiveObject(manifest.object);
  const declared=manifest.files;if(!Array.isArray(declared))throw Error('Manifest file list missing');
  const actual=files.filter(f=>!['archive-manifest.json','SHA256SUMS.txt'].includes(f.path));
  if(JSON.stringify(canonical(actual))!==JSON.stringify(canonical(declared)))throw Error('Sealed content missing, undeclared, or damaged');
  const lines=(await fs.readFile(path.join(dir,'SHA256SUMS.txt'),'utf8')).trim().split(/\r?\n/),expected=new Map(files.filter(f=>f.path!=='SHA256SUMS.txt').map(f=>[f.path,f.sha256]));
  if(lines.length!==expected.size)throw Error('Checksum file coverage mismatch');
  for(const line of lines){const m=line.match(/^([a-f0-9]{64})  (.+)$/);if(!m||expected.get(m[2])!==m[1])throw Error('Checksum mismatch');expected.delete(m[2])}
  if(expected.size)throw Error('Missing checksum');
  if(manifest.contentSha256!==hash(JSON.stringify(canonical(actual))))throw Error('Content identity mismatch');
  return manifest;
}
export function verifySnapshotLocation(root,dir,manifest){
  const relative=canonicalTimePath(path.relative(root,dir).replaceAll('\\','/')),prefix=canonicalTimePath(archiveObject(manifest.object))+'/revisions/';
  if(!relative.startsWith(prefix)||!relative.slice(prefix.length)||relative.slice(prefix.length).includes('/'))throw Error('Snapshot directory does not match declared object path');
}
export async function snapshots(root){
  await assertRoot(root);const result=[];
  const categories=['releases','actions','issues','pull-requests','discussions','repository','supplements','migration-reports','sync-reports'];
  for(const entry of await fs.readdir(root,{withFileTypes:true})){if(entry.isSymbolicLink()||!(entry.isDirectory()?[...categories,'index','pending'].includes(entry.name):['README.md','repository.json','coverage.json'].includes(entry.name)))throw Error('Unsealed or unexpected archive root content')}
  async function walk(dir){
    if(await exists(path.join(dir,'archive-manifest.json'))){result.push(dir);return}
    for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Linked archive tree');if(e.isDirectory())await walk(path.join(dir,e.name));else if(e.name!=='latest.json')throw Error('Unsealed content in formal archive tree')}
  }
  for(const category of categories){const dir=path.join(root,category);if(await exists(dir))await walk(dir)}
  return result.sort();
}
export async function seal(root,relative,content,metadata={}){
  relative=canonicalTimePath(relative);
  await assertRoot(root);archiveObject(relative);const object=inside(root,path.join(root,relative));await noLinks(object);
  const pairs=Object.entries(content).sort(([a],[b])=>a.localeCompare(b,'en'));
  const files=[];
  for(const [name,value] of pairs){
    safeRelative(name);if(['archive-manifest.json','SHA256SUMS.txt'].includes(name))throw Error('Reserved manifest filename');
    if(value?.archiveSourceFile){await noLinks(value.archiveSourceFile);const st=await fs.stat(value.archiveSourceFile);if(!st.isFile())throw Error('Not a source file');files.push({path:name,bytes:st.size,sha256:await fileHash(value.archiveSourceFile),source:value.archiveSourceFile})}
    else{const bytes=Buffer.isBuffer(value)?value:jsonBytes(value);files.push({path:name,bytes:bytes.length,sha256:hash(bytes),data:bytes})}
  }
  if(new Set(files.map(x=>x.path.toLowerCase())).size!==files.length)throw Error('Case-conflicting content');
  const list=files.map(({data,source,...rest})=>rest),digest=hash(JSON.stringify(canonical(list))),revisions=path.join(object,'revisions');
  await fs.mkdir(revisions,{recursive:true});
  for(const e of await fs.readdir(revisions,{withFileTypes:true})){
    if(!e.isDirectory()||e.isSymbolicLink())throw Error('Invalid revision entry');const prior=await verifySnapshot(path.join(revisions,e.name));
    if(prior.contentSha256===digest){await writeJson(path.join(object,'latest.json'),{format:FORMAT,revision:'revisions/'+e.name,lastCheckedAt:now(),contentSha256:digest});return {state:'unchanged',path:relative+'/revisions/'+e.name,bytes:0}}
  }
  const pending=path.join(root,'pending','seal-'+randomUUID());await noLinks(pending);await fs.mkdir(path.dirname(pending),{recursive:true});await fs.mkdir(pending);await writeJson(path.join(pending,'owner.json'),{owner:'mediascope-github-archive',state:'writing'});
  const candidate=path.join(pending,'record');await fs.mkdir(candidate);
  for(const f of files){const dest=path.join(candidate,f.path);await fs.mkdir(path.dirname(dest),{recursive:true});if(f.source)await fs.copyFile(f.source,dest,fs.constants?.COPYFILE_EXCL??1);else await fs.writeFile(dest,f.data,{flag:'wx'})}
  const manifest={...metadata,format:FORMAT,kind:'github-platform-snapshot',...TARGET,object:relative,comparisonVersion:1,contentSha256:digest,captureStartedAt:metadata.captureStartedAt??now(),captureCompletedAt:now(),fetchedAt:metadata.fetchedAt??now(),files:list};
  await fs.writeFile(path.join(candidate,'archive-manifest.json'),jsonBytes(manifest),{flag:'wx'});
  const checks=await tree(candidate);await fs.writeFile(path.join(candidate,'SHA256SUMS.txt'),checks.map(f=>f.sha256+'  '+f.path).join('\n')+'\n',{flag:'wx'});
  await verifySnapshot(candidate);const name=now().replace(/[-:]/g,'')+'-'+digest.slice(0,16),destination=path.join(revisions,name);
  await fs.rename(candidate,destination);await verifySnapshot(destination);
  await writeJson(path.join(object,'latest.json'),{format:FORMAT,revision:'revisions/'+name,lastCheckedAt:now(),contentSha256:digest});
  await insideCleanup(root,pending);return {state:'saved',path:relative+'/revisions/'+name,bytes:checks.reduce((n,f)=>n+f.bytes,0)+Buffer.byteLength(checks.map(f=>f.sha256+'  '+f.path).join('\n')+'\n')};
}
export async function insideCleanup(root,dir){
  const pending=path.join(root,'pending');inside(pending,dir);await noLinks(dir);const owner=await readJson(path.join(dir,'owner.json'));
  if(owner.owner!=='mediascope-github-archive')throw Error('Unowned pending cleanup refused');await tree(dir);
  await fs.rm(dir,{recursive:true});
}
export async function verifyArchive(root){
  const records=await snapshots(root),errors=[],dependencies=[];let bytes=0;
  for(const dir of records){try{const m=await verifySnapshot(dir);verifySnapshotLocation(root,dir,m);bytes+=m.files.reduce((n,f)=>n+f.bytes,0);for(const f of m.files.filter(f=>f.path==='release.json')){const data=await readJson(path.join(dir,f.path));for(const a of data.assets??[]){if(a.localPackage){if(!/^\.\.\/releases\/[^/]+$/.test(a.localPackage.path))throw Error('Unsafe external package association');safeRelative(a.localPackage.path.slice('../releases/'.length));const external=path.resolve(root,a.localPackage.path);if(!await exists(external))dependencies.push({object:m.object,assetId:a.id,status:'external-package-missing'});else if(await fileHash(external)!==a.localPackage.sha256)dependencies.push({object:m.object,assetId:a.id,status:'external-package-digest-mismatch'})}}}}catch(e){errors.push({path:path.relative(root,dir),reason:e.message})}}
  return {format:FORMAT,checkedAt:now(),records:records.length,bytes,errors,externalDependencies:dependencies,integrity:errors.length?'failed':'verified'};
}
// Keep noisy counters out of sealed semantic content. Their omission is versioned.
export function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['download_count'].includes(k)).map(([k,v])=>[k,stable(v)]));
  return value;
}
