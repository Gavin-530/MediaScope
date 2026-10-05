import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {get} from 'node:http';

// Invoked by the bootstrap only after archive/file integrity verification.
const [app, ffmpeg, ffprobe, output] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(path.join(app, 'runtime-lock.json'), 'utf8').replace(/^\uFEFF/, ''));
if(process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 runtime required');
if(!lock.nodeMajors.includes(Number(process.versions.node.split('.')[0]))) throw Error('Unsupported Node.js version: '+process.version);
const run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
const versions={node:process.version};
for(const [name,exe] of [['ffmpeg',ffmpeg],['ffprobe',ffprobe]]) {
  const line=run(exe,['-version']).split(/\r?\n/)[0];
  const match=line.match(/version (?:n)?(\d+)\./);
  // Git snapshots lack a comparable release number: require an explicit stable release.
  if(!match || Number(match[1])<lock.ffmpegMinMajor) throw Error('Unsupported '+name+' version: '+line);
  versions[name]=line;
}
const required={filters:['libvmaf','siti','psnr','ssim','zscale'],encoders:['libx264','libx265','libaom-av1','ffv1'],bsfs:['trace_headers']};
for(const [kind,names] of Object.entries(required)) {
  const list=run(ffmpeg,['-hide_banner','-'+kind]);
  for(const name of names) if(!new RegExp('\\b'+name+'\\b').test(list)) throw Error('FFmpeg missing '+name);
}
const temp=mkdtempSync(path.join(tmpdir(),'mediascope-check-'));
try {
  for(const encoder of ['libx264','libx265','libaom-av1','ffv1']) {
    const file=path.join(temp,encoder+'.mkv');
    run(ffmpeg,['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=64x64:rate=4:duration=0.5','-c:v',encoder,...(encoder==='libaom-av1'?['-cpu-used','8']:[]),file]);
    const info=JSON.parse(run(ffprobe,['-v','error','-show_streams','-of','json',file]));
    if(info.streams[0]?.width!==64) throw Error('FFprobe smoke test failed');
    run(ffmpeg,['-v','error','-i',file,'-vf','siti,zscale,format=yuv420p','-f','null','-']);
    if(encoder!=='ffv1') run(ffmpeg,['-v','error','-i',file,'-c','copy','-bsf:v','trace_headers','-f','null','-']);
  }
  for(const metric of ['psnr','ssim','libvmaf=model=version=vmaf_v0.6.1'])
    run(ffmpeg,['-v','error','-i',path.join(temp,'libx264.mkv'),'-filter_complex',`split[a][b];[a][b]${metric}`,'-f','null','-']);
  // Probe an actual HTTP response before allowing the application pointer to change.
  const child=spawn(process.execPath,[path.join(app,'server.mjs')],{cwd:app,windowsHide:true,env:{...process.env,MEDIASCOPE_STARTUP_RESULT:'',MEDIASCOPE_DESKTOP:'0',PORT:'0',MEDIASCOPE_DATA_DIR:temp,FFMPEG_PATH:ffmpeg,FFPROBE_PATH:ffprobe}});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(Error('Application startup timed out'))},30000);
      let text='';
      child.on('error',e=>{clearTimeout(timer);reject(e)});
      child.on('exit',code=>{clearTimeout(timer);reject(Error('Application exited: '+code))});
      child.stdout.on('data',async b=>{
        text+=b;const match=text.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(!match)return;
        // This probes HTTP startup, including OS-selected ports that browser Fetch may block.
        try{
          await new Promise((done,fail)=>{
            const request=get(match[0],response=>{
              let html='';response.setEncoding('utf8');response.on('data',chunk=>html+=chunk);response.on('error',fail);
              response.on('end',()=>response.statusCode===200&&html.includes('MediaScope')?done():fail(Error('Application HTTP smoke failed')));
            });
            request.setTimeout(10000,()=>request.destroy(Error('Application HTTP smoke timed out')));request.on('error',fail);
          });
          clearTimeout(timer);resolve();
        }catch(e){clearTimeout(timer);reject(e)}
      });
    });
  } finally { child.kill(); await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve)); }
  writeFileSync(output,JSON.stringify({compatibility:lock.compatibility,versions,checkedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')},null,2));
} finally {rmSync(temp,{recursive:true,force:true})}
