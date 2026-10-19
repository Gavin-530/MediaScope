import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {sitiInput} from '../../public/siti.js';
import {sitiGpuRequest} from '../../siti.mjs';

export async function auditGpuInputs(cases,signal,{deviceIndex=0,onProgress}={}){
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./siti-input-audit.ps1',import.meta.url)),'-SourcePath',fileURLToPath(new URL('../../gpu/SitiOpenCl.cs',import.meta.url)),'-DeviceIndex',String(deviceIndex)],{windowsHide:true,signal});
  const lines=createInterface({input:child.stdout});let current,stderr='';
  const next=()=>new Promise((resolve,reject)=>{current={resolve,reject}}),ready=next();
  const done=new Promise(resolve=>child.once('close',code=>{if(code)current?.reject(Error(stderr));resolve(code)}));
  child.on('error',e=>current?.reject(e));child.stdin.on('error',e=>current?.reject(e));child.stderr.on('data',b=>stderr+=b);
  lines.on('line',line=>{try{current?.resolve(JSON.parse(line))}catch(e){current?.reject(e)}});
  const evidence={cases:0,samples:0,maxRgbError:0,maxHlgPqError:0,exactLumaSamples:0,deviceIndex};
  try{
    assert.equal((await ready).ready,true);
    for(const c of cases){
      const input=sitiInput({pix_fmt:c.format,color_range:c.range,color_transfer:'smpte2084'},c.settings),p=sitiGpuRequest(input,c.width,c.height,1);
      for(let frame=0;frame<c.frames.length;frame++){
        const waiting=next(),header=Buffer.from(JSON.stringify({header:p.header})),length=Buffer.alloc(4);length.writeInt32LE(header.length);
        child.stdin.write(Buffer.concat([length,header,p.payload,Buffer.from(c.frames[frame],'base64')]));
        const raw=Buffer.from((await waiting).samples,'base64');assert.equal(raw.length,c.width*c.height*4);
        for(let i=0;i<c.normalized[frame].length;i++){
          const actual=raw.readFloatLE(i*4),reference=c.normalized[frame][i];
          if(input.domain==='hlg'){
            // Complete FP64 HLG conversion must reach the real FP32 workplane.
            // For a PQ value in [0,1], 2^-24 covers single-precision rounding
            // plus the much smaller binary64 transfer error; a wrong branch fails.
            const error=Math.abs(actual-reference);assert.ok(error<=2**-24,c.name+' actual HLG PQ sample '+i);
            evidence.maxHlgPqError=Math.max(evidence.maxHlgPqError,error);
          }else if(input.format.family==='luma'){
            // The affine PQ representation must recover every integer exactly.
            assert.equal(actual,Math.round(reference/p.header[16]),c.name+' actual GPU code '+i);evidence.exactLumaSamples++;
          }else{
            // Convex RGB weights, three divisions/multiplies and two additions:
            // gamma(12) bounds FP32 roundoff; no nonlinear curve in this PQ oracle.
            const error=Math.abs(actual-reference),u=2**-24,bound=12*u/(1-12*u);
            assert.ok(error<=bound,c.name+' actual GPU RGB sample '+i);evidence.maxRgbError=Math.max(evidence.maxRgbError,error);
          }
          evidence.samples++;
        }
      }
      evidence.cases++;
      onProgress?.(evidence.cases);
    }
    child.stdin.end();assert.equal(await done,0,stderr);return evidence;
  }finally{child.kill();await done;lines.close()}
}
