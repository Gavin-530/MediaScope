import {engineControl,hdrControl} from '../../helpers/encoded-controls.mjs';
import {workRoot} from '../../helpers/workspace.mjs';
import {before} from 'node:test';
import {projectTest} from '../../helpers/case-test.mjs';
const test=projectTest(import.meta.url);
import assert from '../../helpers/assert.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

import {trial} from '../../helpers/subject.mjs';
import {readdir} from 'node:fs/promises';



const dir=workRoot,source=path.join(dir,'参考 多音轨.mp4'),candidate=path.join(dir,'candidate.mp4');
const context=()=>({cwd:dir,commands:[],update:()=>{}});
before(async()=>{await engineControl(dir);});
test('trial produces a measured curve and removes temporary media',async()=>{
 const cwd=path.join(dir,'trial');await mkdir(cwd,{recursive:true});const r=await trial({file:source,stream:0,start:0,duration:1,encoder:'libx264',crfs:[20,38],metrics:['psnr','ssim']},{...context(),cwd});assert.equal(r.rows.length,2);assert.ok(r.rows[0].videoBytes>r.rows[1].videoBytes);assert.ok(r.rows[0].metrics.psnr.pooled>r.rows[1].metrics.psnr.pooled);assert.ok(!(await readdir(cwd)).some(f=>/\.(nut|mkv)$/.test(f)));
});
test('H.265 HDR and AV1 trials preserve comparable sample formats',async()=>{
 for(const [encoder,file]of [['libx265',await hdrControl(dir)],['libaom-av1',source]]){
  const cwd=path.join(dir,'trial-'+encoder);await mkdir(cwd,{recursive:true});const r=await trial({file,stream:0,start:0,duration:1,encoder,crfs:[24,36],metrics:['psnr','ssim']},{...context(),cwd});assert.equal(r.rows.length,2);assert.ok(r.rows.every(x=>Number.isFinite(x.metrics.psnr.pooled)));assert.ok(!(await readdir(cwd)).some(f=>f.endsWith('.mkv')));
 }
});
