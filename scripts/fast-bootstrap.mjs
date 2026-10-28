import {readFile,mkdir,lstat,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Exit 75 is reserved for preflight rejection before desktop.mjs is imported.
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const absolute=value=>typeof value==='string'&&/^[a-z]:[\\/]/i.test(value)&&path.isAbsolute(value)&&!/[\0\r\n"]/.test(value);
const fail=message=>{throw Error(message)};
async function noLinks(file){
  for(let current=path.resolve(file);;current=path.dirname(current)){
    const stat=await lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error});
    if(stat?.isSymbolicLink())fail('linked-path');
    if(path.dirname(current)===current)break;
  }
}
function decode(bytes){
  if(bytes.length<40||bytes.length>4*1024*1024||bytes.subarray(0,8).toString('ascii')!=='MSFAST03'||sha(bytes.subarray(40))!==bytes.subarray(8,40).toString('hex'))fail('invalid-hint');
  const fields=[];let offset=40;const decoder=new TextDecoder('utf-8',{fatal:true});
  for(let i=0;i<13;i++){
    if(offset+4>bytes.length)fail('truncated-hint');const length=bytes.readInt32LE(offset);offset+=4;
    if(length<0||length>1024*1024||offset+length>bytes.length)fail('invalid-field-length');
    fields.push(decoder.decode(bytes.subarray(offset,offset+length)));offset+=length;
  }
  if(offset!==bytes.length)fail('extra-hint-data');
  const [mode,application,home,runtime,node,cache,cacheHash,state,stateHash,marker,markerHash,build,bootstrapHash]=fields;
  return {mode,app:application,home,runtime,node,cache,cacheHash,state,stateHash,marker,markerHash,build,bootstrapHash};
}
async function validate(hintFile){
  if(!absolute(hintFile))fail('hint-path');await noLinks(hintFile);
  const hint=decode(await readFile(hintFile));
  if(!same(hint.app,app)||![hint.home,hint.runtime,hint.node,hint.cache].every(absolute)||!['source','installed'].includes(hint.mode))fail('hint-scope');
  const key=sha(Buffer.from(app.toLowerCase(),'utf8'));
  // A Unicode case-folding difference with Framework is a legacy fallback, never a guessed path.
  if(!same(hint.cache,path.join(hint.home,'launch-cache',key+'.json'))||!same(hintFile,path.join(hint.home,'launch-cache',key+'.fast')))fail('hint-location');
  if(!/^[a-f0-9]{64}$/.test(hint.build)||sha(await readFile(fileURLToPath(import.meta.url)))!==hint.bootstrapHash)fail('bootstrap-changed');
  for(const file of [app,hint.home,hint.runtime,hint.cache])await noLinks(file);
  const cacheBytes=await readFile(hint.cache);if(sha(cacheBytes)!==hint.cacheHash)fail('launch-record-changed');
  const cache=JSON.parse(cacheBytes.toString('utf8').replace(/^\uFEFF/,''));
  if(cache.schema!==1||!same(cache.app,app)||!['private','external'].includes(cache.mode)||!cache.validation?.checkedAt)fail('invalid-launch-record');
  const paths={};
  for(const name of ['node','ffmpeg','ffprobe']){
    const program=cache.validation.programs?.[name];
    if(!program||!absolute(program.path)||!/^[a-f0-9]{64}$/i.test(program.sha256)||!program.version)fail('invalid-program-record');
    paths[name]=program.path;
  }
  if(!same(paths.node,hint.node)||!same(process.execPath,hint.node))fail('node-selection');
  let statePath=null;
  if(hint.mode==='installed'){
    statePath=path.join(hint.home,'current.json');
    if(!same(hint.state,statePath)||!same(hint.marker,path.join(hint.home,'install.json')))fail('installation-record-location');
    await noLinks(statePath);await noLinks(hint.marker);
    const stateBytes=await readFile(statePath),markerBytes=await readFile(hint.marker);
    if(sha(stateBytes)!==hint.stateHash||sha(markerBytes)!==hint.markerHash)fail('installation-record-changed');
    const state=JSON.parse(stateBytes.toString('utf8').replace(/^\uFEFF/,'')),marker=JSON.parse(markerBytes.toString('utf8').replace(/^\uFEFF/,''));
    if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc)(\.(0|[1-9]\d*))?)?$/.test(state.current?.version)||!same(app,path.join(hint.home,'apps',state.current.version)))fail('active-version');
    const selection=state.current.environment;
    if(!same(cache.mode,selection?.mode)||Object.keys(paths).some(name=>!same(paths[name],selection.validation?.programs?.[name]?.path)))fail('selected-environment');
    if(marker.schema!==1||marker.product!=='MediaScope'||!absolute(marker.runtimeRoot)||!same(path.resolve(marker.runtimeRoot),hint.runtime))fail('runtime-marker');
    if(process.env.MEDIASCOPE_RUNTIME_HOME&&!same(path.resolve(process.env.MEDIASCOPE_RUNTIME_HOME),hint.runtime))fail('runtime-override');
  }else if(hint.state||hint.marker||!same(hint.runtime,hint.home)||same(hint.home,app))fail('source-scope');
  return {hint,config:{app,paths,mode:cache.mode,validation:cache.validation,installRoot:hint.home,runtimeRoot:hint.runtime,statePath,needsValidation:false,desktop:process.env.MEDIASCOPE_NO_BROWSER!=='1'}};
}
let prepared;
try{prepared=await validate(process.argv[2]);}catch(error){if(process.env.MEDIASCOPE_LAUNCH_TRACE==='1')console.log('MS_LAUNCH:legacy:'+error.message);process.exitCode=75;}
if(prepared){
  const {hint,config}=prepared;let request,started=false,nativeRequest=false;
  try{
    const roots=hint.mode==='installed'?[[hint.home,['apps','data','staging']],[hint.runtime,['runtimes','staging']]]:[[hint.home,['runtimes','staging']]];
    for(const [root,names]of roots)for(const name of names){const directory=path.join(root,name);await noLinks(directory);await mkdir(directory,{recursive:true});}
    if(hint.mode==='installed')process.env.MEDIASCOPE_DATA_DIR=path.join(hint.home,'data');
    else process.env.MEDIASCOPE_DATA_DIR ||= path.join(app,'.mediascope');
    await noLinks(path.resolve(process.env.MEDIASCOPE_DATA_DIR));
    const handoff=process.argv[3];
    if(process.argv[4]){
      const sequence=path.basename(handoff||'').match(/^handoff-([a-f0-9]{32})\.tmp$/)?.[1];
      if(!sequence||!absolute(process.argv[4])||!same(process.argv[4],path.join(hint.home,'staging','launch-'+sequence+'.json')))fail('request-location');
      request=process.argv[4];nativeRequest=true;await noLinks(request);
    }else request=path.join(hint.home,'staging','launch-'+randomUUID().replaceAll('-','')+'.json');
    const handle=await open(request,nativeRequest?'r+':'wx');try{await handle.writeFile(JSON.stringify(config));}finally{await handle.close();}
    if(handoff){
      if(!absolute(handoff)||!same(path.dirname(handoff),path.join(hint.home,'staging'))||!/^handoff-[a-f0-9]{32}\.tmp$/.test(path.basename(handoff)))fail('handoff-location');
      await noLinks(handoff);
      const ticket=await open(handoff,'r+');try{await ticket.write(Buffer.from([1]),0,1,0);}finally{await ticket.close();}
    }
    process.argv[2]=request;started=true;
    // Windows console-close and Ctrl+Break use SIGHUP/SIGBREAK. Reuse desktop's stop path.
    const consoleStop=()=>{
      if(process.listenerCount('SIGTERM'))process.emit('SIGTERM');
      else{const timer=setInterval(()=>{if(process.listenerCount('SIGTERM')){clearInterval(timer);process.emit('SIGTERM')}},20);timer.unref();}
    };
    process.once('SIGHUP',consoleStop);process.once('SIGBREAK',consoleStop);
    await import('./desktop.mjs');
    // Application failures cannot ask start.cmd to open a second instance.
    if(process.exitCode)process.exitCode=1;
  }catch(error){
    process.exitCode=started?1:75;
    if(started)console.error('[MediaScope] '+error.message);
    else if(process.env.MEDIASCOPE_LAUNCH_TRACE==='1')console.log('MS_LAUNCH:legacy:'+error.message);
  }finally{if(request&&!nativeRequest)await unlink(request).catch(error=>{if(error.code!=='ENOENT')console.error('[MediaScope] Launch request cleanup: '+error.message)});}
}
