import {mkdir,readFile,writeFile,rename,readdir,lstat,rm,open,unlink,copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const recentLimit=10, recentBytes=100*1024**2;
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
async function json(file,value){
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,file)}finally{await unlink(temp).catch(()=>{})}
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
  // Originals remain until the updated report has been saved successfully.
  return saved;
}

export class RuntimeData {
  constructor(root){this.root=path.resolve(root);this.settings={theme:'system',clearOnExit:false};this.pending=Promise.resolve();this.holds=new Map();this.clearAfterExport=new Set();this.warnings=[]}
  enqueue(work){const next=this.pending.then(work);this.pending=next.catch(()=>{});return next}
  async init(){
    await safeTree(this.root);await mkdir(this.root,{recursive:true});
    try{const saved=JSON.parse(await readFile(path.join(this.root,'settings.json'),'utf8'));if(['system','light','dark'].includes(saved.theme))this.settings.theme=saved.theme;if(typeof saved.clearOnExit==='boolean')this.settings.clearOnExit=saved.clearOnExit}catch(e){if(e.code!=='ENOENT')this.warnings.push('本地设置损坏，已使用默认设置')}
    await removeOwned(this.root,'.session');
    const records=[];
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!jobId.test(entry.name))continue;
      const folder=path.join(this.root,entry.name);await safeTree(folder);let keepMedia=false;
      try{
        const input=JSON.parse(await readFile(path.join(folder,'job-input.json'),'utf8'));
        keepMedia=input.keepFiles===true;
        let job;
        try{job=JSON.parse(await readFile(path.join(folder,'job.json'),'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
        const report=await lstat(path.join(folder,'report.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e});
        const failure=report?null:JSON.parse(await readFile(path.join(folder,'failure.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '{"status":"cancelled","error":"上次运行意外结束"}';throw e}));
        const stat=report||await lstat(folder);
        job={id:entry.name,type:input.type,status:report?'done':failure.status==='error'?'error':'cancelled',message:report?'完成':failure.error||'任务未完成',file:input.file,reference:input.reference,candidate:input.candidate,description:job?.description||'近期任务',queuedAt:job?.queuedAt||stat.mtime.toISOString(),startedAt:job?.startedAt,finishedAt:job?.finishedAt||stat.mtime.toISOString(),restored:true};
        if(!['inspect','analyze','compare','trial'].includes(job.type))throw Error('未知任务类型');
        if(report&&input.keepFiles){
          const media=(await readdir(folder)).filter(name=>name.endsWith('.mkv')).map(name=>path.join(folder,name));
          if(media.length){
            const destination=path.join(path.dirname(this.root),path.basename(this.root)+'-saved-media');
            const value=JSON.parse(await readFile(path.join(folder,'report.json'),'utf8'));
            const saved=await saveTrialVideos(this.root,entry.name,media,destination);
            if(value.experiment)value.experiment.retainedFiles=saved;
            await json(path.join(folder,'report.json'),value);
            this.warnings.push('旧版保留的实验视频已移至：'+path.join(destination,entry.name));
          }
        }
        if(job.status==='cancelled'){await removeOwned(this.root,entry.name);continue}
        if(!report)await json(path.join(folder,'failure.json'),failure);
        await this.trimWork(entry.name);
        if(report)job.reportPath=path.join(folder,'report.json');
        await json(path.join(folder,'job.json'),job);records.push({job,input});
      }catch(e){
        // A failed migration must never discard explicitly retained videos.
        if(keepMedia&&(await readdir(folder)).some(name=>name.endsWith('.mkv')))throw Error('旧实验视频迁移未完成，请另存后重试：'+e.message);
        this.warnings.push('已移除无法恢复的运行记录：'+entry.name);await removeOwned(this.root,entry.name);
      }
    }
    return records.sort((a,b)=>a.job.finishedAt.localeCompare(b.job.finishedAt));
  }
  async trimWork(id){
    const folder=path.join(this.root,id);
    await safeTree(folder);
    for(const name of await readdir(folder))if(!['report.json','job-input.json','failure.json','job.json'].includes(name))await rm(path.join(folder,name),{recursive:true,force:true});
  }
  async save(job,input){
    const folder=path.join(this.root,job.id);await mkdir(folder,{recursive:true});
    await json(path.join(folder,'job-input.json'),input);
    const {controller,result,reportPath,...metadata}=job;await json(path.join(folder,'job.json'),metadata);
    if(job.status!=='done'&&!await lstat(path.join(folder,'failure.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e}))await json(path.join(folder,'failure.json'),{status:job.status,error:job.message,commands:[]});
    await this.trimWork(job.id);
    const bytes=await safeTree(folder);
    if(bytes>recentBytes){
      const session=path.join(this.root,'.session');await mkdir(session,{recursive:true});
      const target=path.join(session,job.id);await rename(folder,target);
      if(job.reportPath)job.reportPath=path.join(target,'report.json');
      job.sessionOnly=true;job.retentionMessage='报告超过 100 MiB，仅在本次会话可用；请导出保存';
    }
  }
  pinned(id){for(const [key,hold]of this.holds){if(hold.expires<Date.now())this.holds.delete(key);else if(hold.ids.includes(id))return true}return false}
  hold(ids,jobs){if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>!jobs.get(id)?.reportPath))throw Error('导出结果已变化，请重新选择');const key=randomUUID();this.holds.set(key,{ids,expires:Date.now()+10*60*1000});return key}
  async remove(job,jobs,inputs){
    if(this.pinned(job.id)){job.removed=true;this.clearAfterExport.add(job.id);return}
    if(job.sessionOnly){const target=path.join(this.root,'.session',job.id);await safeTree(target);await rm(target,{recursive:true,force:true})}
    else await removeOwned(this.root,job.id);
    jobs.delete(job.id);inputs.delete(job.id);this.clearAfterExport.delete(job.id);
  }
  async prune(jobs,inputs,{clear=false}={}){
    for(const [key,hold]of this.holds)if(hold.expires<Date.now())this.holds.delete(key);
    const recent=[...jobs.values()].filter(j=>ended(j)).sort((a,b)=>(b.finishedAt||'').localeCompare(a.finishedAt||''));
    let count=0,bytes=0,exhausted=false;
    for(const job of recent){
      const size=job.sessionOnly?0:await safeTree(path.join(this.root,job.id));
      const discard=clear||job.status==='cancelled'||this.clearAfterExport.has(job.id);
      if(!discard&&(count>=recentLimit||bytes+size>recentBytes))exhausted=true;
      if(!discard&&!exhausted){count++;bytes+=size;continue}
      if(this.pinned(job.id)){if(clear)this.clearAfterExport.add(job.id);continue}
      if(job.sessionOnly){const target=path.join(this.root,'.session',job.id);await safeTree(target);await rm(target,{recursive:true,force:true})}
      else await removeOwned(this.root,job.id);
      jobs.delete(job.id);inputs.delete(job.id);this.clearAfterExport.delete(job.id);
    }
  }
  async updateSettings(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['theme','clearOnExit'].includes(k))||value.theme!==undefined&&!['system','light','dark'].includes(value.theme)||value.clearOnExit!==undefined&&typeof value.clearOnExit!=='boolean')throw Error('本地设置无效');
    const settings={...this.settings,...value};await json(path.join(this.root,'settings.json'),settings);this.settings=settings;
  }
  async usage(jobs){
    const profileBytes=await safeTree(path.join(this.root,'desktop-profile'));
    let recordBytes=0,count=0;
    for(const job of jobs.values())if(ended(job)&&!job.sessionOnly){count++;recordBytes+=await safeTree(path.join(this.root,job.id))}
    return {settings:this.settings,count,recordBytes,profileBytes,totalBytes:await safeTree(this.root),limit:recentLimit,maxBytes:recentBytes,warnings:this.warnings};
  }
}
