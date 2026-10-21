import {mkdir,readFile,writeFile,rename,readdir,lstat,rm,open,unlink,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const jobId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ended=job=>['done','error','cancelled'].includes(job.status);
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}};
export async function safeTree(file){
  const absolute=path.resolve(file);
  for(let part=absolute;;part=path.dirname(part)){
    const stat=await lstat(part).catch(e=>{if(e.code==='ENOENT')return null;throw e});
    if(stat?.isSymbolicLink())throw Error('运行数据路径含目录链接，拒绝清理：'+part);
    if(path.dirname(part)===part)break;
  }
  const stat=await lstat(absolute).catch(e=>{if(e.code==='ENOENT')return null;throw e});
  if(!stat)return 0;
  if(!stat.isDirectory())return stat.size;
  let bytes=0;
  const entries=await readdir(absolute).catch(e=>{if(e.code==='ENOENT')return [];throw e});
  for(const entry of entries)bytes+=await safeTree(path.join(absolute,entry));
  return bytes;
}
export async function removeOwned(root,name){
  if(!jobId.test(name)&&!['desktop-profile','.session'].includes(name))throw Error('未知运行数据目录');
  const target=path.resolve(root,name);
  if(path.dirname(target)!==path.resolve(root))throw Error('运行数据超出目录边界');
  await safeTree(target);await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
async function json(file,value,{compact=false,signal}={}){
  const temp=file+'.'+randomUUID()+'.tmp';
  try{signal?.throwIfAborted();await writeFile(temp,JSON.stringify(value,null,compact?undefined:2),{signal});signal?.throwIfAborted();await rename(temp,file)}finally{await unlink(temp).catch(()=>{})}
}
const windowRect=value=>value&&['left','top','width','height'].every(key=>Number.isInteger(value[key])&&Math.abs(value[key])<=2147483647)&&value.width>0&&value.height>0;
const rectValues=value=>Object.fromEntries(['left','top','width','height'].map(key=>[key,value[key]]));
export function desktopWindowBounds(area,saved){
  if(!windowRect(area))throw Error('无法读取显示器可用区域');
  const width=Math.min(area.width,windowRect(saved)?saved.width:Math.round(area.width*.75));
  const height=Math.min(area.height,windowRect(saved)?saved.height:Math.round(area.height*.75));
  const visible=windowRect(saved)&&saved.left+saved.width>area.left&&saved.left<area.left+area.width&&saved.top+saved.height>area.top&&saved.top<area.top+area.height;
  return {left:visible?Math.max(area.left,Math.min(saved.left,area.left+area.width-width)):area.left+Math.round((area.width-width)/2),
    top:visible?Math.max(area.top,Math.min(saved.top,area.top+area.height-height)):area.top+Math.round((area.height-height)/2),width,height};
}
export class DesktopWindowData {
  constructor(root){this.file=path.join(root,'desktop-window.json');this.state=null;this.serialized=''}
  async init(){
    try{
      const saved=JSON.parse((await readFile(this.file,'utf8')).replace(/^\uFEFF/,''));
      if(saved?.schema===1&&windowRect(saved.normal)&&typeof saved.maximized==='boolean')this.state={schema:1,normal:rectValues(saved.normal),maximized:saved.maximized,...(windowRect(saved.area)?{area:rectValues(saved.area)}:{})};
    }catch(e){if(e.code!=='ENOENT')console.error('窗口设置读取失败，使用默认窗口：'+e.message)}
  }
  async save(normal,maximized,area){
    if(!windowRect(normal)||!windowRect(area))return;
    const state={schema:1,normal,maximized,area},serialized=JSON.stringify(state);
    if(serialized===this.serialized)return;
    await json(this.file,state);this.state=state;this.serialized=serialized;
  }
}
export async function acquireDataLease(root){
  root=path.resolve(root);await safeTree(root);await mkdir(root,{recursive:true});
  const file=path.join(root,'runtime.lock'),token=randomUUID();
  for(let attempt=0;attempt<2;attempt++){
    try{
      const handle=await open(file,'wx');
      await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.close();
      return {token,async browser(pid){await json(file,{pid:process.pid,browserPid:pid,token})},async release(){
        const saved=JSON.parse(await readFile(file,'utf8'));
        if(saved.token===token)await unlink(file);
      }};
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      let saved;try{saved=JSON.parse(await readFile(file,'utf8'))}catch{throw Error('运行数据锁损坏，请在软件退出后手动清理运行目录')}
      if(alive(saved.pid)||alive(saved.browserPid))throw Error('此运行数据目录正在使用，请先关闭上次的 MediaScope 窗口');
      await unlink(file);
    }
  }
  throw Error('无法取得运行数据锁');
}
export async function verifyDataLease(root,token){
  await safeTree(root);
  const saved=JSON.parse(await readFile(path.join(root,'runtime.lock'),'utf8'));
  if(saved.token!==token||!alive(saved.pid))throw Error('运行数据锁无效');
}
export function trialDestination(root,id,destination){
  if(typeof destination!=='string'||!path.isAbsolute(destination))throw Error('请选择保存实验视频的绝对目录路径');
  const target=path.resolve(destination,id),relative=path.relative(path.resolve(root),target);
  if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('实验视频必须保存在运行数据目录之外');
  return target;
}
export async function saveTrialVideos(root,id,files,destination){
  const target=trialDestination(root,id,destination);await safeTree(target);await mkdir(target,{recursive:true});
  const saved=[];
  try{for(const file of files){
    if(path.dirname(path.resolve(file))!==path.resolve(root,id))throw Error('实验文件不属于当前任务');
    const output=path.join(target,path.basename(file));
    await copyFile(file,output,constants.COPYFILE_EXCL);saved.push(output);
  }}catch(e){for(const file of saved)await unlink(file).catch(()=>{});throw e}
  // Explicitly copied media survive cleanup of this task workspace.
  return saved;
}

export class RuntimeData {
  constructor(root){
    this.root=path.resolve(root);this.workRoot=path.join(this.root,'.work',randomUUID());
    this.settings={theme:'system'};this.pending=Promise.resolve();this.holds=new Map();this.clearAfterExport=new Set();this.warnings=[];
  }
  enqueue(work){const next=this.pending.then(work);this.pending=next.catch(()=>{});return next}
  async init(){
    await safeTree(this.root);await mkdir(this.root,{recursive:true});
    try{const saved=JSON.parse(await readFile(path.join(this.root,'settings.json'),'utf8'));if(['system','light','dark'].includes(saved.theme))this.settings.theme=saved.theme}
    catch(e){if(e.code!=='ENOENT')this.warnings.push('本地设置损坏，已使用默认设置')}
    // Only this process owns this fresh workspace. Existing reports are neither loaded nor removed.
    await mkdir(path.dirname(this.workRoot),{recursive:true});await mkdir(this.workRoot);
  }
  async finish(job){await removeOwned(this.workRoot,job.id)}
  async close(){await removeOwned(path.dirname(this.workRoot),path.basename(this.workRoot))}
  pinned(id){for(const [key,hold]of this.holds){if(hold.expires<Date.now())this.holds.delete(key);else if(hold.ids.includes(id))return true}return false}
  hold(ids,jobs){
    if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>!jobs.get(id)?.result))throw Error('导出结果已变化，请重新选择');
    const key=randomUUID();this.holds.set(key,{ids,expires:Date.now()+10*60*1000});return key;
  }
  async remove(job,jobs,inputs){
    if(this.pinned(job.id)){job.removed=true;this.clearAfterExport.add(job.id);return}
    await this.finish(job);jobs.delete(job.id);inputs.delete(job.id);this.clearAfterExport.delete(job.id);
  }
  async prune(jobs,inputs,{clear=false}={}){
    for(const [key,hold]of this.holds)if(hold.expires<Date.now())this.holds.delete(key);
    for(const job of [...jobs.values()]){
      if(!ended(job)||!(clear||job.status==='cancelled'||this.clearAfterExport.has(job.id)))continue;
      await this.remove(job,jobs,inputs);
    }
  }
  async updateSettings(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='theme')||value.theme!==undefined&&!['system','light','dark'].includes(value.theme))throw Error('本地设置无效');
    const settings={...this.settings,...value};await json(path.join(this.root,'settings.json'),settings);this.settings=settings;
  }
  async usage(jobs){
    const workBytes=await safeTree(this.workRoot),profileBytes=await safeTree(path.join(this.root,'desktop-profile'));
    return {settings:this.settings,count:[...jobs.values()].filter(job=>job.status==='done'&&!job.removed).length,workBytes,profileBytes,totalBytes:workBytes+profileBytes,warnings:this.warnings};
  }
}
