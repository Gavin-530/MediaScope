// Independent qualification for whole-file-gpu-audit.mjs. Excluded from timings.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {zipMembers} from '../helpers/jvet-reference.mjs';
import {fixtures} from '../helpers/fixtures.mjs';
import {FF as ff} from '../../engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2),arg=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
assert.ok(arg('--out'),'Qualification requires the explicit existing audit --out directory');const out=path.resolve(arg('--out'));
assert.ok(out.startsWith(path.join(root,'.build')+path.sep));
const json=async(n,x)=>fs.writeFile(path.join(out,n),JSON.stringify(x,null,2)),read=async n=>JSON.parse(await fs.readFile(path.join(out,n),'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
async function command(exe,argv){const t=performance.now();return new Promise((resolve,reject)=>{const p=spawn(exe,argv,{cwd:root,windowsHide:true});let stdout='',stderr='',failure;p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',e=>failure=e);p.once('close',exitCode=>failure?reject(failure):resolve({exe,args:argv,exitCode,stdout,stderr,seconds:(performance.now()-t)/1000}));});}
function fromHardware(b,w,h,depth){
 const luma=w*h,chroma=luma/4,st=depth===8?1:2;assert.equal(b.length,(luma+2*chroma)*st);const o=Buffer.alloc(b.length);
 if(st===1){b.copy(o,0,0,luma);for(let i=0;i<chroma;i++){o[luma+i]=b[luma+2*i];o[luma+chroma+i]=b[luma+2*i+1];}}
 else{const get=p=>{const v=b.readUInt16LE(p);assert.equal(v&63,0,'P010 discarded bits must be zero');return v>>>6;};for(let i=0;i<luma;i++)o.writeUInt16LE(get(i*2),i*2);for(let i=0;i<chroma;i++){o.writeUInt16LE(get(luma*2+i*4),(luma+i)*2);o.writeUInt16LE(get(luma*2+i*4+2),(luma+chroma+i)*2);}}
 return o;
}
function decoder(file,pix,w,h,gpu){const argv=['-hide_banner','-nostdin','-v','error','-xerror','-copyts','-noautorotate','-noauto_conversion_filters','-reinit_filter','0',...(gpu?['-hwaccel','cuda','-hwaccel_output_format','cuda']:['-hwaccel','none']),'-i',file,'-map','0:v:0','-an','-sn',...(gpu?['-vf','hwdownload,format='+pix]:[]),'-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+pix,'-fps_mode','passthrough','-f','rawvideo','pipe:1'];
 const child=spawn(ff,argv,{windowsHide:true}),size=w*h*3/2*(pix==='p010le'||pix==='yuv420p10le'?2:1);let stderr='',failure;child.stderr.on('data',b=>stderr+=b);const closed=new Promise(resolve=>{child.once('error',e=>{failure=e;});child.once('close',code=>resolve(code));});
 async function* frames(){let b=Buffer.allocUnsafe(size),offset=0;for await(const part of child.stdout){let at=0;while(at<part.length){const n=Math.min(size-offset,part.length-at);part.copy(b,offset,at,at+n);offset+=n;at+=n;if(offset===size){yield b;b=Buffer.allocUnsafe(size);offset=0;}}}assert.equal(offset,0,'Truncated decoder raw frame');const code=await closed;if(failure)throw failure;assert.equal(code,0,stderr);assert.equal(stderr.trim(),'');}
 return {child,frames:frames(),command:{exe:ff,args:argv},closed};
}
async function directDecode(){
 const manifest=await read('inputs.json'),records=[];
 // Independent inverse adapter on known exhaustive 10-bit values and all 8-bit values.
 for(const depth of [8,10]){const w=64,h=32,luma=w*h,chroma=luma/4,st=depth===8?1:2,b=Buffer.alloc((luma+2*chroma)*st),packed=Buffer.alloc(b.length);for(let i=0;i<luma+2*chroma;i++){const v=i%(2**depth);if(st===1)b[i]=v;else b.writeUInt16LE(v,i*2);}for(let i=0;i<luma+2*chroma;i++){const j=i<luma?i:i<luma+chroma?luma+2*(i-luma):luma+2*(i-luma-chroma)+1;if(st===1)packed[j]=b[i];else packed.writeUInt16LE(b.readUInt16LE(i*2)<<6,j*2);}assert.ok(fromHardware(packed,w,h,depth).equals(b));}
 for(const input of manifest.files){const r=await read(input.id+'-production-0.result.json'),s=r.result.sampleFormat,depth=s.depth;assert.ok(['yuv420p','yuv420p10le'].includes(s.pixelFormat));const a=decoder(input.file,s.pixelFormat,s.width,s.height,false),b=decoder(input.file,depth===8?'nv12':'p010le',s.width,s.height,true);let frames=0,bytes=0;const start=performance.now();
  try{for(;;){const [x,y]=await Promise.all([a.frames.next(),b.frames.next()]);assert.equal(x.done,y.done,'Decoder frame counts differ');if(x.done)break;const canonical=fromHardware(y.value,s.width,s.height,depth);if(!x.value.equals(canonical)){let offset=0;while(x.value[offset]===canonical[offset])offset++;throw Error(`Direct decoded byte mismatch ${input.id}, frame ${frames}, byte ${offset}`);}frames++;bytes+=x.value.length;}assert.equal(frames,r.result.frames.length);records.push({input:input.id,frames,validSampleBytesCompared:bytes,outcome:'passed',comparison:'Buffer.equals on every complete software frame and independently unpacked hardware frame; no hash equality assumption',cpuFallbackAllowed:false,seconds:(performance.now()-start)/1000,commands:[a.command,b.command]});console.log(input.id+': direct software/NVDEC comparison passed, '+frames+' frames / '+bytes+' bytes');}
  finally{if(a.child.exitCode===null)a.child.kill();if(b.child.exitCode===null)b.child.kill();await Promise.all([a.closed,b.closed]);await json('direct-decode-qualification.json',{outcome:records.length===manifest.files.length?'passed':'incomplete',records});}
 }
}
async function vectors(){
 const dir=path.join(out,'vectors');await fs.mkdir(dir,{recursive:true});const members=zipMembers(await fixtures.read('repeat/nist-shabytetestvectors.zip')),cases=[];
 for(const name of ['SHA256ShortMsg.rsp','SHA256LongMsg.rsp']){const key=[...members.keys()].find(k=>k.endsWith(name)),all=[...members.get(key).toString().matchAll(/Len = (\d+)\s+Msg = ([a-f\d]+)\s+MD = ([a-f\d]{64})/gi)];for(let i=0;i<all.length;i++){const [,bits,msg,expected]=all[i],n=Number(bits)/8;if(name.includes('Short')?[1,55,56,63,64].includes(n):i===0||i===all.length-1)cases.push({id:name+'-'+bits,bytes:Buffer.from(msg,'hex'),expected,kind:'NIST original byte-oriented response vector'});}}
 for(const n of [65,127,128,129,131071,131072,131073]){let x=17;const bytes=Buffer.alloc(n);for(let i=0;i<n;i++){x^=x<<13;x^=x>>>17;x^=x<<5;bytes[i]=x&255;}cases.push({id:'control-'+n,bytes,expected:hash(bytes),kind:'project SHA padding / 2048-block state-carry boundary, not official vector'});}
 const records=[];
 for(const c of cases){const raw=path.join(dir,c.id+'.raw'),file=path.join(dir,c.id+'.nut');await fs.writeFile(raw,Buffer.concat([c.bytes,c.bytes]));assert.equal(hash(c.bytes),c.expected);const encode=await command(ff,['-v','error','-y','-noauto_conversion_filters','-f','rawvideo','-pixel_format','gray','-video_size',`${c.bytes.length}x1`,'-framerate','1','-i',raw,'-c:v','rawvideo','-threads:v','1','-pix_fmt','+gray',file]);assert.equal(encode.exitCode,0,encode.stderr);
  for(const device of [0,1]){const id='qualification-'+c.id+'-device'+device,job={id,file,mode:'gpu-sw',device},jp=path.join(dir,id+'.json');await fs.writeFile(jp,JSON.stringify(job));const p=await command(process.execPath,[path.join(root,'testing-tools/tools/whole-file-gpu-audit.mjs'),'--out',out,'--phase','one','--job',jp]);assert.equal(p.exitCode,0,p.stderr);const r=await read(id+'.result.json');assert.equal(r.outcome,'passed',r.error);assert.deepEqual(r.result.frames.map(f=>f.sha256),[c.expected,c.expected]);assert.deepEqual(r.result.frames.map(f=>f.equalPrevious),[null,true]);records.push({id:c.id,device:r.metrics.device,bytes:c.bytes.length,expected:c.expected,kind:c.kind,outcome:'passed'});await json('sha-qualification.json',{outcome:'running',records});}
 }
 await json('sha-qualification.json',{outcome:'passed',officialCases:cases.filter(c=>c.kind.startsWith('NIST')).length,customBoundaryCases:cases.filter(c=>c.kind.startsWith('project')).length,scope:'New unrolled/word-major GPU SHA-256 backend on both actual GPUs. Selected original NIST messages and explicit new launch boundaries; no empty video frame or GPU Monte Carlo claim, no certification.',records});console.log('New SHA backend vectors and launch boundaries passed on both GPUs.');
}
const phase=arg('--phase','decode');if(phase==='decode')await directDecode();else if(phase==='vectors')await vectors();else throw Error('Unknown phase '+phase);
