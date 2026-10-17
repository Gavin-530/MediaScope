import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {sitiInput} from '../../public/siti.js';
import {sitiGpuRequest} from '../../siti.mjs';

// One owned bridge process; raw requests have no CPU fallback path.
export async function withRawSitiGpu(exe,signal,body){
  const child=spawn(exe,['serve'],{windowsHide:true}),lines=createInterface({input:child.stdout});
  let current,sequence=0,stderr='',readyResolve,readyReject,closedResolve;
  const closed=new Promise(resolve=>{closedResolve=resolve}),ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
  const fail=e=>{readyReject(e);current?.reject(e);child.kill()};
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000)});
  child.on('error',fail);child.stdin.on('error',fail);
  child.on('close',code=>{closedResolve();if(code!==0)fail(Error(`Raw SI/TI GPU exited ${code}: ${stderr}`))});
  lines.on('line',line=>{try{
    const p=JSON.parse(line);
    if(p.event==='ready'){if(p.protocol!==1)throw Error('GPU protocol mismatch');readyResolve(p);return}
    if(!current||p.id!==current.id)throw Error('GPU request identity mismatch');
    if(p.event==='error')throw Error(p.message);
    if(p.event==='configured')current.info=p;
    else if(p.event==='done'){
      if(current.points.length!==current.count||p.frames!==current.count||!current.info)throw Error('GPU frame/configuration count mismatch');
      current.resolve({points:current.points,info:current.info});
    }else{if(p.frame!==current.points.length)throw Error('GPU frame order mismatch');current.points.push(p)}
  }catch(e){fail(e)}});
  const abort=()=>fail(signal.reason??Error('Raw GPU audit cancelled'));signal?.addEventListener('abort',abort,{once:true});
  const startup=setTimeout(()=>fail(Error('Raw GPU startup timeout')),30000);
  try{
    if(signal?.aborted)abort();await ready;clearTimeout(startup);
    return await body(async c=>{
      const input=sitiInput({pix_fmt:c.format,color_range:c.range,color_transfer:'smpte2084'},c.settings),prepared=sitiGpuRequest(input,c.width,c.height,c.frames.length);
      const pending=new Promise((resolve,reject)=>{current={id:++sequence,resolve,reject,points:[],count:c.frames.length}});
      const timer=setTimeout(()=>fail(Error('Raw GPU request timeout')),15000);
      try{child.stdin.write(Buffer.concat([Buffer.from(`M\t${sequence}\t${prepared.header.join('\t')}\n`),prepared.payload,...c.frames.map(b=>Buffer.from(b,'base64'))]));return await pending}
      finally{clearTimeout(timer);current=null}
    });
  }finally{clearTimeout(startup);signal?.removeEventListener('abort',abort);child.stdin.end();child.kill();await closed;lines.close()}
}
