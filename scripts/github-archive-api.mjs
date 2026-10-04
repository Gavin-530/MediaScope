import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {TARGET,hash,exists,readJson,writeJson,noLinks,now} from './github-archive-store.mjs';

const base='https://api.github.com/repos/'+TARGET.repository;
export class ArchiveHttpError extends Error{
  constructor(status,resource){super('GitHub HTTP '+status+' for '+resource.split('?')[0]);this.status=status;this.state=status===403?'no-permission':status===404?'not-found-unconfirmed':status===410?'expired':'error'}
}
function redactResponse(resource,data){
  if(!apiUrl(resource).pathname.endsWith('/hooks'))return data;
  return data.map(h=>{const copy=structuredClone(h);if(copy.config){delete copy.config.secret;for(const k of Object.keys(copy.config)){if(/token|password|authorization/i.test(k))delete copy.config[k];else if(k==='url'){try{const u=new URL(copy.config[k]);u.username='';u.password='';u.search='';copy.config[k]=u.href}catch{copy.config[k]='unavailable'}}}}return copy});
}
export function credential(){
  if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)return process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  try{const output=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\npath='+TARGET.repository+'.git\n\n',encoding:'utf8',windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'},stdio:['pipe','pipe','pipe'],timeout:10000});return output.split(/\r?\n/).find(x=>x.startsWith('password='))?.slice(9)}catch{return undefined}
}
export function apiUrl(resource){
  const url=new URL(resource.startsWith('https:')?resource:base+(resource?'/'+resource:''));
  let decoded;try{decoded=decodeURIComponent(url.pathname)}catch{throw Error('Out-of-scope API URL refused')}
  const repoPath=new URL(base).pathname;
  if(url.origin!=='https://api.github.com'||url.username||url.password||url.hash||!(url.pathname===repoPath||url.pathname.startsWith(repoPath+'/'))||!(decoded===repoPath||decoded.startsWith(repoPath+'/'))||decoded.includes('\\')||decoded.split('/').some(part=>part==='.'||part==='..')||/%2f|%5c|%2e/i.test(decoded))throw Error('Out-of-scope API URL refused');
  return url;
}
export function downloadUrl(value){
  const u=new URL(value);
  const allowed=u.hostname==='release-assets.githubusercontent.com'||u.hostname==='results-receiver.actions.githubusercontent.com'||u.hostname.endsWith('.actions.githubusercontent.com')||u.hostname.endsWith('.blob.core.windows.net');
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!allowed)throw Error('Unapproved download redirect host');
  return u;
}
export class GitHubReader{
  constructor({root,budgetMs=30*60*1000,maxBytes=3*1024**3,fetchImpl=fetch,token=credential()}={}){this.root=root;this.deadline=Date.now()+budgetMs;this.maxBytes=maxBytes;this.fetch=fetchImpl;this.token=token;this.pages=[];this.startedAt=now();this.downloadBytes=0;this.peakTemporaryBytes=0}
  remaining(){const left=this.deadline-Date.now();if(left<=0)throw Error('Total archive time budget reached; incomplete queue retained');return left}
  headers(extra={}){return {'User-Agent':'MediaScope-local-archive','Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(this.token?{Authorization:'Bearer '+this.token}:{}),...extra}}
  async response(resource,{accept,etag}={}){
    const url=apiUrl(resource);
    for(let attempt=0;attempt<4;attempt++){
      let response;
      try{response=await this.fetch(url,{method:'GET',headers:this.headers({...accept?{Accept:accept}:{},...etag?{'If-None-Match':etag}:{}}),redirect:'manual',signal:AbortSignal.timeout(Math.min(30000,this.remaining()))})}
      catch{if(attempt===3||this.remaining()<2000)throw Error('Network request failed after bounded retries');await new Promise(resolve=>setTimeout(resolve,1000));continue}
      if(response.status===429||(response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.get('retry-after')))||response.status>=500){
        await response.body?.cancel();const retry=response.headers.get('retry-after'),reset=response.headers.get('x-ratelimit-reset');
        const delay=retry?Number(retry)*1000:reset?Math.max(1000,Number(reset)*1000-Date.now()):1000*2**attempt;
        if(attempt===3||!Number.isFinite(delay)||delay>30000||delay>=this.remaining())throw Error('GitHub rate limit or retry budget reached');
        await new Promise(resolve=>setTimeout(resolve,delay));continue;
      }
      return response;
    }
  }
  async get(resource){
    const url=apiUrl(resource),key=hash(url.href),file=this.root&&path.join(this.root,'index','http',key+'.json');let cached;
    if(file&&await exists(file)){try{cached=await readJson(file);if(cached.url!==url.href||hash(JSON.stringify(cached.data))!==cached.sha256)cached=undefined}catch{cached=undefined}}
    const response=await this.response(resource,{etag:cached?.etag});
    if(response.status===304){if(!cached)throw Error('304 without valid cache');return {data:cached.data,link:cached.link,checkedAt:now()}}
    if(!response.ok)throw new ArchiveHttpError(response.status,resource);
    if(response.status===202){const error=Error('GitHub resource still being generated; retry later');error.state='waiting';throw error}
    const data=redactResponse(resource,await response.json());this.remaining();const link=response.headers.get('link');
    if(file)await writeJson(file,{url:url.href,etag:response.headers.get('etag'),link,data,sha256:hash(JSON.stringify(data)),lastCheckedAt:now()});
    return {data,link,checkedAt:now()};
  }
  async list(resource,key,{boundary=true}={}){
    const initial=apiUrl(resource),all=[],seen=new Set(),visited=new Set();initial.searchParams.set('per_page','100');let next=initial.href,page=0,firstIds;
    while(next){
      if(visited.has(next))throw Error('Pagination link cycle');visited.add(next);const {data,link}=await this.get(next);const rows=key?data[key]:data;
      if(!Array.isArray(rows))throw Error('Unexpected paginated response shape');
      page++;this.pages.push({resource:initial.pathname,page,items:rows.length,total:typeof data.total_count==='number'?data.total_count:null});
      const rowId=item=>String(item.id??item.name??item.sha??hash(JSON.stringify(item)));
      if(page===1)firstIds=rows.map(rowId);
      for(const item of rows){const id=rowId(item);if(!seen.has(id)){seen.add(id);all.push(item)}}
      const match=link?.match(/<([^>]+)>;\s*rel="next"/);next=match?apiUrl(match[1]).href:null;
      if(!next&&typeof data.total_count==='number'&&all.length<data.total_count)throw Error('Pagination total exceeds retrieved records; truncated or changing scan');
    }
    if(boundary){const first=key?(await this.get(initial.href)).data[key]:(await this.get(initial.href)).data;const ids=first.map(x=>String(x.id??x.name??x.sha??hash(JSON.stringify(x))));if(JSON.stringify(ids)!==JSON.stringify(firstIds))throw Error('Pagination boundary moved; repeat full scan with overlap')}
    return all;
  }
  async download(resource,destination,{digest,size}={}){
    await noLinks(destination);if(await exists(destination))throw Error('Download destination exists');
    const space=await fs.statfs(path.dirname(destination));if(Number(space.bavail)*Number(space.bsize)<Math.max(size??0,64*1024**2))throw Error('Insufficient download space');
    // Release asset content negotiates octet-stream; Actions download APIs use the REST JSON media type and then redirect.
    let response=await this.response(resource,{accept:apiUrl(resource).pathname.includes('/releases/assets/')?'application/octet-stream':undefined});
    if(response.status===302||response.status===307){
      const redirect=downloadUrl(response.headers.get('location'));await response.body?.cancel();
      // Never forward API credentials to the signed storage host.
      response=await this.fetch(redirect,{method:'GET',headers:{'User-Agent':'MediaScope-local-archive'},redirect:'manual',signal:AbortSignal.timeout(Math.min(120000,this.remaining()))});
    }
    if(!response.ok)throw new ArchiveHttpError(response.status,resource);
    const contentLength=Number(response.headers.get('content-length'));if(contentLength>this.maxBytes)throw Error('Download exceeds size limit');
    let bytes=0;const h=createHash('sha256'),reader=this;
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback){try{reader.remaining();bytes+=chunk.length;if(bytes>reader.maxBytes)throw Error('Download exceeds size limit');h.update(chunk);callback(null,chunk)}catch(e){callback(e)}}}),createWriteStream(destination,{flags:'wx'}));
    this.remaining();const sha256=h.digest('hex');if(size!=null&&size!==bytes)throw Error('Download length mismatch');if(digest&&digest!=='sha256:'+sha256)throw Error('Platform digest mismatch');
    this.downloadBytes+=bytes;this.peakTemporaryBytes=Math.max(this.peakTemporaryBytes,bytes);return {bytes,sha256,platformDigest:digest??null,validation:digest?'platform-digest-and-local-sha256':'local-sha256-only'};
  }
}
