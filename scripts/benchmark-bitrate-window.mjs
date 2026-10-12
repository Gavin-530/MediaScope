import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {FF, FP, run, probe} from '../engine.mjs';
import {allPackets} from '../analysis.mjs';
import {createBitrateAccumulator, bitrateView} from '../public/bitrate-model.js';

// Run with: node --expose-gc scripts/benchmark-bitrate-window.mjs [media-path]
const startedAt = new Date().toISOString();
await fs.mkdir(path.resolve('evidence-archive/pending'), {recursive:true});
const directory = await fs.mkdtemp(path.resolve('evidence-archive/pending/bitrate-performance-'));
const logLines = [];
async function log(message) {
  console.log(message); logLines.push(message);
  await fs.writeFile(path.join(directory,'output.log'), logLines.join('\n')+'\n');
}
const commands = [], ctx = {commands, update() {}};
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory, '1800s-60fps-two-audio.mp4');
if (!process.argv[2]) {
  await log('Generating 1800 s / 60 fps encoded fixture with two audio tracks…');
  await run(FF, ['-hide_banner','-nostdin','-v','error',
    '-f','lavfi','-i','testsrc2=size=96x64:rate=60:duration=1800',
    '-f','lavfi','-i','sine=frequency=440:duration=1800',
    '-f','lavfi','-i','sine=frequency=880:duration=1800',
    '-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-threads','2','-c:a','aac',file], ctx);
}
const info = await probe(file, ctx);
const packets = [];
await run(FP, ['-v','error','-show_packets','-show_entries','packet=stream_index,pts,duration,size','-of','compact=p=0:nk=0',file], ctx,
  line => { const p = Object.fromEntries(line.split('|').map(x => x.split('='))); if (p.stream_index !== undefined) packets.push({...p, stream_index:Number(p.stream_index)}); });
await fs.writeFile(path.join(directory,'probe.json'), JSON.stringify(info,null,2));
function calculate(windowMs) {
  const accumulators = new Map(info.raw.streams.filter(s => ['video','audio'].includes(s.codec_type)).map(s => [s.index, createBitrateAccumulator(s.time_base, windowMs)]));
  for (const packet of packets) accumulators.get(packet.stream_index)?.add(packet);
  return [...accumulators.values()].map(a => a.finish());
}
const curves = {100: calculate(100), 1000: calculate(1000)};
for (let i = 0; i < curves[100].length; i++) {
  assert.equal(curves[100][i].status, 'ok');
  assert.equal(curves[1000][i].status, 'ok');
  assert.deepEqual(bitrateView(curves[100][i], 1000), bitrateView(curves[1000][i], 1000));
}
const samples = {100: [], 1000: []};
for (let round = -2; round < 20; round++) {
  for (const windowMs of round % 2 === 0 ? [100,1000] : [1000,100]) {
    global.gc?.();
    let started = performance.now();
    const result = await allPackets(file, info.raw.streams, {...ctx, bitrateWindowMs: windowMs});
    const packetScanMs = performance.now() - started;
    assert.deepEqual(result.filter(t => t.bitrateCurve).map(t => t.bitrateCurve), curves[windowMs]);
    started = performance.now(); calculate(windowMs);
    const calculationMs = performance.now() - started;
    started = performance.now(); curves[windowMs].map(c => bitrateView(c, 1000));
    const defaultViewMs = performance.now() - started;
    started = performance.now(); const json = JSON.stringify(curves[windowMs]);
    const serializationMs = performance.now() - started;
    if (round >= 0) samples[windowMs].push({packetScanMs, calculationMs, defaultViewMs, serializationMs, curveJsonBytes: Buffer.byteLength(json)});
  }
  await fs.writeFile(path.join(directory,'samples.json'), JSON.stringify({samples,commands},null,2));
  await log(`Round ${round + 3}/22 complete${round >= 0 ? `: 100ms=${samples[100].at(-1).packetScanMs.toFixed(2)}ms, 1s=${samples[1000].at(-1).packetScanMs.toFixed(2)}ms` : ' (warmup)'}`);
}
const median = values => { const a = [...values].sort((a,b) => a-b); return (a[(a.length-1)>>1] + a[a.length>>1])/2; };
const summary = Object.fromEntries([100,1000].map(w => [w, {
  bins: curves[w].reduce((n,c) => n+c.bins.length,0),
  ...Object.fromEntries(Object.keys(samples[w][0]).map(k => [k, {
    median: median(samples[w].map(s => s[k])), min: Math.min(...samples[w].map(s => s[k])), max: Math.max(...samples[w].map(s => s[k]))
  }]))
}]));
const hashes = {};
for (const source of ['analysis.mjs','engine.mjs','public/bitrate-model.js','scripts/benchmark-bitrate-window.mjs']) hashes[source] = createHash('sha256').update(await fs.readFile(source)).digest('hex');
const differences = samples[100].map((s,i) => s.packetScanMs-samples[1000][i].packetScanMs);
const mean = differences.reduce((a,b) => a+b,0)/differences.length;
const standardError = Math.sqrt(differences.reduce((a,b) => a+(b-mean)**2,0)/(differences.length-1)/differences.length);
const pairedAnalysis = {differencesMs:differences,medianDifferenceMs:median(differences),meanDifferenceMs:mean,
  approximateMean95CI:[mean-2.093*standardError,mean+2.093*standardError],fineSlowerRounds:differences.filter(d => d>0).length,
  note:'Paired Student-t interval (19 df); timings can be correlated and affected by background activity.'};
const report = {createdAt: new Date().toISOString(), environment: {node: process.version, platform: process.platform, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length},
  input: {file, bytes: info.size, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), duration: info.raw.format.duration, packetCount: packets.length, streams: info.raw.streams.map(s => ({index:s.index,type:s.codec_type,codec:s.codec_name,timeBase:s.time_base}))},
  methodology: '2 warmup pairs, 20 measured pairs, alternating order, same cached file and packet list; default display is 1 s. packetScanMs includes FFprobe and existing packet analysis, excludes full-analysis decode and browser rendering. Pure calculation is separately timed and must not be added again to packetScanMs. No peak-memory measurement. Generated low-resolution fixture is not camera footage.',
  mediaRetention: 'Media is not archived; input size, SHA-256, probe metadata and generation commands are retained.',
  exactAggregationPassed: true, sourceHashes: hashes, summary, pairedAnalysis, samples, commands};
await fs.writeFile(path.join(directory,'results.json'), JSON.stringify(report,null,2)+'\n');
await fs.mkdir(path.join(directory,'source'));
for (const source of Object.keys(hashes)) await fs.copyFile(source,path.join(directory,'source',source.replaceAll('/','__')));
if (!process.argv[2]) await fs.unlink(file);
await log(JSON.stringify({summary,pairedAnalysis},null,2));
const logBytes = await fs.readFile(path.join(directory,'output.log'));
const version = JSON.parse(await fs.readFile('package.json','utf8')).version;
const manifest = {schema:2,evidenceRevision:2,kind:'Custom',label:'bitrate-window-performance',version,startedAt,endedAt:new Date().toISOString(),
  purpose:'30-minute bitrate-window timing comparison; not full regression or full-analysis timing',outcome:'passed',exitCode:0,
  tools:{ffmpeg:await run(FF,['-version']),ffprobe:await run(FP,['-version'])},
  invocation:{executable:process.execPath,args:process.execArgv.concat(process.argv.slice(1))},
  retention:'Independent retained measurement record; no automatic deletion',
  log:{file:'output.log',storedBytes:logBytes.length,sha256:createHash('sha256').update(logBytes).digest('hex')}};
const storage = path.resolve('scripts/test-storage.ps1');
const gate = spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',storage,'-Action','Lock'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
try {
  await new Promise((resolve,reject) => {
    let out=''; const timer=setTimeout(() => reject(Error('Evidence lock timeout')),30000);
    gate.stdout.on('data',b => {out+=b;if(out.includes('READY')){clearTimeout(timer);resolve();}});
    gate.once('error',e => {clearTimeout(timer);reject(e);});
    gate.once('exit',() => {clearTimeout(timer);reject(Error('Evidence lock exited before ready'));});
  });
  manifest.runId = execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',storage,'-Action','Allocate'],{encoding:'utf8',windowsHide:true}).trim();
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const archived = execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',storage,'-Action','Commit','-Source',directory,'-Destination',path.resolve('evidence-archive/runs',version,manifest.runId)],{encoding:'utf8',windowsHide:true}).trim();
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/verify-test-evidence.ps1'),'-Record',archived],{stdio:'pipe',windowsHide:true});
  console.log('Verified archive: '+archived);
  // Commit moves the measurement record into the retained archive.
} finally {gate.stdin.end('\n');}
