import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {FF,FP} from '../engine.mjs';

test('[environment-selection] manual components outside PATH validate without downloads; cancellation and invalid choices remain explicit',async()=>{
  const base=path.resolve('.build/testing-work/environment-selection');
  await mkdir(base,{recursive:true});
  const work=await mkdtemp(path.join(base,'case-'));
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/helpers/environment-selection.ps1'),'-App',path.resolve('.'),'-Work',work,'-NodePath',process.execPath,'-FFmpegPath',FF,'-FFprobePath',FP],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:8*1024*1024});
  for(const check of ['manual-validated','probe-picker','cancel-each-picker','cancel-prompt','missing-file','download-choice','noninteractive','invalid-declined','invalid-confirmed','detected-environment'])assert.ok(output.includes('PASS: '+check),output);
});

test('[environment-selection] first manual installation persists separate FFprobe and reuses the validated launch cache without downloads',async()=>{
  const base=path.resolve('.build/testing-work/environment-selection');
  await mkdir(base,{recursive:true});
  const work=await mkdtemp(path.join(base,'install-中文 [x] '));
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('testing-tools/helpers/environment-selection.ps1'),'-App',path.resolve('.'),'-Work',work,'-NodePath',process.execPath,'-FFmpegPath',FF,'-FFprobePath',FP,'-Case','Install'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:8*1024*1024});
  const json=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const result=await json(path.join(work,'installation-result.json'));
  const state=await json(path.join(result.root,'current.json'));
  assert.equal(state.current.version,result.version);
  assert.equal(state.current.environment.mode,'external');
  assert.equal(state.current.environment.validation.programs.node.path,process.execPath);
  assert.equal(state.current.environment.validation.programs.ffmpeg.path,result.mediaCopy);
  assert.equal(state.current.environment.validation.programs.ffprobe.path,result.paths.ffprobe);
  for(const name of ['node','ffmpeg','ffprobe'])assert.match(state.current.environment.validation.programs[name].sha256,/^[a-f0-9]{64}$/i);
  assert.deepEqual(result.picks,['node.exe','ffmpeg.exe','ffprobe.exe']);
  assert.equal(result.cacheReused,true);
  assert.equal(result.registrationIsolated,true);
  assert.deepEqual(await readdir(path.join(result.root,'runtimes')),[]);
  assert.equal((await json(path.join(result.root,'install.json'))).runtimeRoot,result.root);
});
