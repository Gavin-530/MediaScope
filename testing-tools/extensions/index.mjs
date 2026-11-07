import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const project=fileURLToPath(new URL('../../',import.meta.url));
const integer={type:'integer',required:true},device={values:['cpu','gpu'],default:'cpu'};
const cancellation={values:['scan','compare']};
export const extensionTools=[
  {id:'siti-dimensions',module:'siti',description:'Analytic edge at an explicitly chosen size',parameters:{width:integer,height:integer,device},implementation:'siti',kind:'dimensions'},
  {id:'siti-frames',module:'siti',description:'Every measured point of an explicitly chosen frame count',parameters:{frames:integer,device},implementation:'siti',kind:'frames'},
  {id:'repeat-frames',module:'repeat',description:'Exact native repeat evidence at a chosen count',parameters:{frames:integer,'cancel-stage':cancellation},implementation:'repeat',kind:'frames'},
  {id:'repeat-native',module:'repeat',description:'Native frame bytes and final-sample difference at a chosen size',parameters:{width:integer,height:integer,'cancel-stage':cancellation},implementation:'repeat',kind:'native'},
  {id:'repeat-long',module:'repeat',description:'Static synthetic endurance input at chosen duration and rate',parameters:{width:integer,height:integer,seconds:integer,rate:integer,'cancel-stage':cancellation},implementation:'repeat',kind:'long'},
  {id:'repeat-changing',module:'repeat',description:'Changing integer ramp with known paired repeats; every decoded frame checked independently',parameters:{width:integer,height:integer,frames:integer,rate:integer,'cancel-stage':cancellation},implementation:'repeat',kind:'changing'},
  {id:'export-bytes',module:'reports',description:'CSV byte count and accepted/rejected serialization',parameters:{bytes:integer},implementation:'export'},
  {id:'probe-performance',module:'media-info',description:'Same-file probe timing and sampled memory observations',parameters:{file:{type:'string',required:true},repetitions:integer},implementation:'benchmark',kind:'probe'},
  {id:'bitrate-performance',module:'bitrate',description:'Same-file window calculation and serialization observations',parameters:{file:{type:'string',required:true},repetitions:integer},implementation:'benchmark',kind:'bitrate'},
  {id:'bitrate-diagnostic',module:'bitrate',description:'Fine/direct window equivalence for explicit caller media',parameters:{file:{type:'string',required:true}},implementation:'bitrate'},
  {id:'hash-research',module:'repeat',description:'Explicit phase of the independent hash research tool',parameters:{out:{type:'string',required:true},phase:{required:true,values:['prepare','gpu','performance','cpu-dispatch','masked','cpu-threads','ffmpeg-vectors','media','regressions','integration','report','all']}},implementation:'research',kind:'hash'},
  {id:'whole-file-research',module:'repeat',description:'Explicit phase of the independent complete-file GPU experiment',parameters:{out:{type:'string',required:true},phase:{required:true,values:['build','prepare','threshold','decode-baseline','decode','vectors','finalize','report','batch']},repetitions:{type:'integer'}},implementation:'research',kind:'whole'},
  {id:'cooperative-research',module:'repeat',description:'Explicit phase of the independent CPU/GPU cooperative experiment',parameters:{out:{type:'string',required:true},'input-audit':{type:'string',required:true},phase:{required:true,values:['build','qualify','matrix','report','finalize']},repetitions:{type:'integer'}},implementation:'research',kind:'cooperative'}
];

export function parseExtension(args){
  const [id,...tokens]=args;
  if(!id||id==='--list'){if(tokens.length)throw Error('List accepts no extension parameters');return {list:true};}
  const tool=extensionTools.find(t=>t.id===id);if(!tool)throw Error('Unknown extension tool: '+id);
  const values={};let config;
  while(tokens.length){const flag=tokens.shift(),key=flag?.slice(2);if(!flag?.startsWith('--')||!tokens.length||tokens[0].startsWith('--'))throw Error('Expected --parameter value');const value=tokens.shift();if(key==='config'){if(config)throw Error('Duplicate config');config=value;continue}if(!Object.hasOwn(tool.parameters,key)||Object.hasOwn(values,key))throw Error('Unknown/duplicate extension parameter: '+key);values[key]=value}
  return {tool,values,config};
}
export function validateParameters(tool,values){
  for(const key of Object.keys(values))if(!Object.hasOwn(tool.parameters,key))throw Error('Unknown extension parameter: '+key);
  const parameters={};
  for(const [key,schema]of Object.entries(tool.parameters)){
    const value=values[key]??schema.default;
    if(value===undefined){if(schema.required)throw Error('Explicit parameter required: --'+key);continue}
    if(schema.type==='integer'){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw Error('Positive safe integer required: '+key);parameters[key]=n}
    else{if(typeof value!=='string'||!value.length||schema.values&&!schema.values.includes(value))throw Error('Invalid extension parameter: '+key);parameters[key]=value}
  }
  return parameters;
}
export async function runExtension(args){
  const selection=parseExtension(args);
  if(selection.list){console.log(JSON.stringify({scope:'developer-extension',tools:extensionTools},null,2));return}
  const {tool,values,config}=selection;
  const supplied=config?JSON.parse(await fs.readFile(path.resolve(config),'utf8')):{};
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))throw Error('Extension config must be an object');
  const parameters=validateParameters(tool,{...supplied,...values});
  const parent=path.join(project,'.build','testing-extensions');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,tool.id+'-'));
  const previousTmp=process.env.TMP,previousTemp=process.env.TEMP;process.env.TMP=directory;process.env.TEMP=directory;
  const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const sha=b=>createHash('sha256').update(b).digest('hex'),git=(...a)=>execFileSync('git',['-C',project,...a],{encoding:'utf8',windowsHide:true}).trim();
  async function sourceIdentity(){
    const removed=new Set(git('ls-files','--deleted').split('\n').filter(Boolean)),files=[];
    for(const name of git('ls-files','--cached','--others','--exclude-standard').split('\n').filter(Boolean)){
      if(/^(local-notes|evidence-archive|github-archive)\//.test(name))continue;
      if(removed.has(name)){files.push({path:name,status:'deleted'});continue}
      const file=path.join(project,name);if((await fs.lstat(file)).isSymbolicLink())throw Error('Linked extension source: '+name);
      const data=await fs.readFile(file);files.push({path:name,bytes:data.length,sha256:sha(data)});
    }
    return {commit:git('rev-parse','HEAD'),workingTree:git('status','--porcelain=v1'),files,sha256:sha(JSON.stringify(files))};
  }
  const manifest={schema:1,id:randomUUID(),scope:'developer-extension',tool:tool.id,module:tool.module,parameters,startedAt:new Date().toISOString(),host:{platform:process.platform,release:os.release(),cpu:os.cpus()[0]?.model},outcome:'running'};
  const save=()=>fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await save();
  try{
    manifest.source=await sourceIdentity();
    const executables=[['node',process.execPath]];
    if(tool.implementation!=='export'){
      const {FF,FP}=await import('../../engine.mjs');
      for(const [name,exe]of [['ffmpeg',FF],['ffprobe',FP]])executables.push([name,path.isAbsolute(exe)?exe:execFileSync('where.exe',[exe],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]]);
    }
    manifest.executables=[];
    for(const [name,file]of executables)manifest.executables.push({name,path:file,sha256:sha(await fs.readFile(file))});
    await save();
    const implementation=await import('./'+tool.implementation+'.mjs');manifest.result=await implementation.measure({parameters,directory,signal:controller.signal},tool.kind);
    if(manifest.result?.outcome!=='passed')throw Error('Extension did not return a passing result');
    if((await sourceIdentity()).sha256!==manifest.source.sha256)throw Error('Source changed during extension execution; retained result cannot claim fixed-source verification');
    manifest.outcome='passed';
  }
  catch(error){manifest.outcome=controller.signal.aborted?'cancelled':'failed';manifest.error=error.stack;process.exitCode=1}
  finally{manifest.endedAt=new Date().toISOString();await save();if(previousTmp===undefined)delete process.env.TMP;else process.env.TMP=previousTmp;if(previousTemp===undefined)delete process.env.TEMP;else process.env.TEMP=previousTemp;process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);console.log(JSON.stringify({outcome:manifest.outcome,scope:manifest.scope,tool:tool.id,parameters,directory,error:manifest.error},null,2))}
}
