import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {createReadStream} from 'node:fs';
import { FF,FP,run,probe,video,scan,summarize,compare,normalizeMediaPath,decodeThreadCount } from './engine.mjs';
import {allPackets,structure,traceStructure,mapStructure,metadataSummary,complexity,trial,trialOptions} from './analysis.mjs';
import {makePortable,maxPortableBytes,utcNow} from './public/portable.js';
import {byteLimit} from './public/units.js';
import {vmafModel} from './public/vmaf.js';
import {RuntimeData,acquireDataLease,verifyDataLease,removeOwned,ended,trialDestination,saveTrialVideos,recentBytes} from './scripts/runtime-data.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),token=randomBytes(24).toString('hex'),jobs=new Map();
const dataRoot=path.resolve(process.env.MEDIASCOPE_DATA_DIR||path.join(root,'.mediascope'));
const dataLease=process.env.MEDIASCOPE_DATA_LEASE?null:await acquireDataLease(dataRoot);
if(process.env.MEDIASCOPE_DATA_LEASE)await verifyDataLease(dataRoot,process.env.MEDIASCOPE_DATA_LEASE);
else await removeOwned(dataRoot,'desktop-profile');
const localData=new RuntimeData(dataRoot);
const appVersion=JSON.parse((await readFile(path.join(root,'package.json'),'utf8')).replace(/^\uFEFF/,'')).version;
const port=Number(process.env.PORT||4317);let origin=`http://127.0.0.1:${port}`;
const execFileAsync=promisify(execFile);
let active=null,pickerActive=false,pickerProcess=null,queueRunning=false,closing=false;
const probes=new Set();
const inputs=new Map();
let dataCleaning=false;
for(const {job,input}of await localData.init()){
  try{normalizeInputPaths(input);jobs.set(job.id,{...job,controller:new AbortController()});inputs.set(job.id,input)}
  catch{await removeOwned(dataRoot,job.id)}
}
await localData.prune(jobs,inputs,{clear:localData.settings.clearOnExit});
const retentionTimer=setInterval(()=>{
  if([...localData.holds.values()].some(hold=>hold.expires<Date.now()))void localData.enqueue(()=>localData.prune(jobs,inputs)).catch(e=>console.error('近期记录清理未完成：'+e.message));
},10000);retentionTimer.unref();
function pump(){
 if(active||!queueRunning||closing||dataCleaning)return;
 const job=[...jobs.values()].find(j=>j.status==='queued');
 if(!job){queueRunning=false;return}
 active=job.id;job.status='running';job.startedAt=new Date().toISOString();job.message='准备分析';
 const input=inputs.get(job.id);
 execute(job,input).catch(async e=>{job.status=job.controller.signal.aborted?'cancelled':'error';job.message=e.message;job.finishedAt=new Date().toISOString();if(job.status==='cancelled')await localData.enqueue(()=>localData.remove(job,jobs,inputs))}).finally(()=>{active=null;pump()});
}
const versions={};
const startup={state:'checking',message:'正在检查运行环境，请稍候'};
const capabilities={appVersion,versions,metrics:[]};
let startupTimer;
async function loadStartup(){
  if(process.env.MEDIASCOPE_STARTUP_RESULT){
    try {
      const result=JSON.parse((await readFile(process.env.MEDIASCOPE_STARTUP_RESULT,'utf8')).replace(/^\uFEFF/,''));
      if(!['ready','checking','error'].includes(result.state))throw Error('环境检查结果无效');
      startup.state=result.state;startup.message=result.message||(result.state==='checking'?'正在后台检查运行环境，请稍候':result.state==='ready'?'运行环境已就绪':'运行环境检查失败');
      if(result.state==='ready'){
        for(const key of ['ffmpeg','ffprobe'])versions[key]=result.validation.programs[key].version;
        capabilities.metrics=['psnr','ssim','vmaf'];clearInterval(startupTimer);
      }else if(result.state==='error')clearInterval(startupTimer);
    }catch(e){if(e.code==='ENOENT'){startup.state='error';startup.message='启动检查记录丢失，请重启软件';clearInterval(startupTimer)}}
  }else{
    for(const [key,exe] of [['ffmpeg',FF],['ffprobe',FP]]){try{versions[key]=(await run(exe,['-version'])).split('\n')[0]}catch(e){versions[key]=`不可用：${e.message}`}}
    let filters='';try{filters=await run(FF,['-hide_banner','-filters'])}catch{}
    capabilities.metrics=['psnr','ssim','vmaf'].filter(m=>filters.includes(m==='vmaf'?'libvmaf':m));
    startup.state='ready';startup.message='运行环境已就绪';
  }
}
// Bare node/server and test callers retain their original ready-at-listen contract.
if(!process.env.MEDIASCOPE_STARTUP_RESULT)await loadStartup();
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
async function body(req,limit=16384){const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>limit)throw Error('请求过大');chunks.push(b)}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}
function normalizeInputPaths(input){
  if(input.type==='inspect'||input.type==='analyze'||input.type==='trial')input.file=normalizeMediaPath(input.file);
  if(input.type==='analyze'){
    if(input.sitiWorkers==null||input.sitiWorkers==='auto')input.sitiWorkers='auto';
    else{const value=Number(input.sitiWorkers);if(![1,2,4,6,8].includes(value))throw Error('SI/TI 并行上限无效');input.sitiWorkers=value}
  }
  if(input.type==='compare'){input.reference=normalizeMediaPath(input.reference);input.candidate=normalizeMediaPath(input.candidate)}
  return input;
}
function portableInput(input){const copy=structuredClone(input);delete copy.enqueue;return copy}
function validatePlanInput(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['inspect','analyze','compare','trial'].includes(value.type))throw Error('计划任务类型无效');
 const keys={inspect:['type','file'],analyze:['type','file','stream','complexity','sitiWorkers','bitrateWindowMs'],compare:['type','reference','candidate','refStream','candidateStream','comparisonMode','timingMode','metrics','vmafModel','confirm','timingConfirmed','playbackConfirmed','chromaConfirmed','chromaAssumptions'],trial:['type','file','stream','start','duration','encoder','depthMode','presets','cpuUsed','crfs','metrics','vmafModel','keepFiles','exportDirectory']}[value.type];
 if(Object.keys(value).some(key=>!keys.includes(key)))throw Error('计划任务包含未知参数');
 const input=structuredClone(value);normalizeInputPaths(input);
 const index=v=>Number.isSafeInteger(v)&&v>=0;
 if(input.type==='analyze'){
  if(input.stream!==undefined&&input.stream!==null&&!index(input.stream))throw Error('视频轨道索引无效');
  if(input.complexity!==undefined&&typeof input.complexity!=='boolean')throw Error('SI/TI 选项无效');
  if(input.bitrateWindowMs!==undefined&&![100,1000].includes(input.bitrateWindowMs))throw Error('码率窗口必须为 100 ms 或 1 秒');
 }else if(input.type==='compare'){
  if(!index(input.refStream)||!index(input.candidateStream))throw Error('比较轨道索引无效');
  if(!Array.isArray(input.metrics)||!input.metrics.length||new Set(input.metrics).size!==input.metrics.length||input.metrics.some(v=>!['psnr','ssim','vmaf'].includes(v)))throw Error('比较指标无效');
  if(input.vmafModel!==undefined)vmafModel(input.vmafModel);
  if(!['native','bt709-limited-8-10',undefined].includes(input.comparisonMode)||!['strict','ordinal-confirmed','playback-sample',undefined].includes(input.timingMode))throw Error('比较模式无效');
  if(input.confirm!==true||input.timingMode==='ordinal-confirmed'&&input.timingConfirmed!==true||input.timingMode==='playback-sample'&&input.playbackConfirmed!==true)throw Error('比较任务缺少原有确认');
  if(input.chromaAssumptions!==undefined){
   if(input.chromaConfirmed!==true||!input.chromaAssumptions||typeof input.chromaAssumptions!=='object'||Array.isArray(input.chromaAssumptions)||Object.keys(input.chromaAssumptions).some(k=>!['reference','candidate'].includes(k)||!['left','center','topleft','top','bottomleft','bottom'].includes(input.chromaAssumptions[k])))throw Error('色度位置确认无效');
  }
 }else if(input.type==='trial'){
  if(!index(input.stream)||!Number.isFinite(input.start)||input.start<0||!Number.isFinite(input.duration)||input.duration<1||input.duration>20||input.keepFiles!==undefined&&typeof input.keepFiles!=='boolean')throw Error('片段实验范围或轨道无效');
  trialOptions(input);
  if(input.exportDirectory!==undefined)trialDestination(dataRoot,'export-check',input.exportDirectory);
 }
 return input;
}
async function selectMediaFile(folder=false){
  if(process.platform!=='win32')throw Error('当前文件选择器仅支持 Windows，请输入绝对路径');
  if(pickerActive)throw Error('文件选择器已经打开，请先在 Windows 对话框中选择或取消');
  pickerActive=true;
  const script=`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\nAdd-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\nAdd-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class MediaScopeWindow {\n  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n}\n'@\n$owner=New-Object System.Windows.Forms.Form\n$owner.ShowInTaskbar=$false\n$owner.TopMost=$true\n$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual\n$owner.Location=New-Object System.Drawing.Point(-32000,-32000)\n$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow\n$owner.Size=New-Object System.Drawing.Size(1,1)\n$owner.Opacity=0.01\n$dialog=New-Object System.Windows.Forms.OpenFileDialog\n$dialog.Title='选择要分析的媒体文件'\n$dialog.Filter='媒体文件|*.mov;*.mp4;*.mkv;*.mxf;*.avi;*.webm;*.m4v;*.ts;*.mts;*.m2ts;*.wav;*.flac;*.aac;*.m4a;*.mp3;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.exr|视频文件|*.mov;*.mp4;*.mkv;*.mxf;*.avi;*.webm;*.m4v;*.ts;*.mts;*.m2ts|所有文件|*.*'\n$dialog.Multiselect=$false\n$dialog.CheckFileExists=$true\n$dialog.RestoreDirectory=$true\ntry{$owner.Show();$owner.Activate();[MediaScopeWindow]::SetForegroundWindow($owner.Handle)|Out-Null;if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.FileName)}}finally{$dialog.Dispose();$owner.Close();$owner.Dispose()}`;
  const pickerScript=folder?script.replace(/\$dialog=New-Object System.Windows.Forms.OpenFileDialog[\s\S]*?\$dialog.RestoreDirectory=\$true/,"$dialog=New-Object System.Windows.Forms.FolderBrowserDialog\n$dialog.Description='选择实验视频保存目录'\n$dialog.ShowNewFolderButton=$true").replace('$dialog.FileName','$dialog.SelectedPath'):script;
  const encoded=Buffer.from(pickerScript,'utf16le').toString('base64');
  let stdout;
  try{
    const operation=execFileAsync('powershell.exe',['-NoProfile','-STA','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:false,maxBuffer:1024*1024,timeout:600000});
    pickerProcess=operation.child;({stdout}=await operation);
  }
  catch(e){throw Error(`文件选择器未能完成：${e.stderr?.trim()||e.message}`)}
  finally{pickerActive=false;pickerProcess=null}
  return stdout?normalizeMediaPath(stdout):null;
}
function createJob(input){
  if(closing||dataCleaning)throw Error('软件正在退出或清理本地数据，无法提交新任务');
  const queuedAt=new Date().toISOString();
  const description=input.type==='analyze'?`视频轨道 ${input.stream==null?'自动':`#${input.stream}`}${input.complexity?' · SI/TI':''}`
    :input.type==='compare'?`轨道 #${input.refStream} → #${input.candidateStream} · ${(input.metrics||[]).join(' / ').toUpperCase()}`
    :input.type==='trial'?`${input.start??0}–${Number(input.start??0)+Number(input.duration??0)} 秒 · ${input.encoder} · CRF ${(input.crfs||[]).join(', ')}`
    :'容器与轨道信息';
  const job={id:randomUUID(),type:input.type,status:'queued',message:'等待运行',queuedAt,file:input.file,reference:input.reference,candidate:input.candidate,description,controller:new AbortController()};
  jobs.set(job.id,job);inputs.set(job.id,structuredClone(input));
  pump();return job;
}
async function execute(job,input){
  const cwd=path.join(dataRoot,job.id);await mkdir(cwd,{recursive:true});
  await writeFile(path.join(cwd,'job-input.json'),JSON.stringify(input,null,2));
  const started=performance.now(),stages=[];
  const publish=value=>{
    const next=typeof value==='string'?{detail:value}:value;
    if(!next||typeof next!=='object')return;
    const clean={};
    for(const key of ['stage','detail','unit'])if(typeof next[key]==='string')clean[key]=next[key];
    for(const key of ['phaseIndex','phaseCount','completed','total']){
      if(next[key]===null)clean[key]=null;
      else if(Number.isFinite(next[key])&&next[key]>=0)clean[key]=Number(next[key]);
    }
    const previous=job.progress||{},phaseChanged=clean.phaseIndex!=null&&clean.phaseIndex!==previous.phaseIndex;
    job.progress={...previous,...(phaseChanged?{subtasks:{},completed:null,total:null,unit:''}:{}),...clean,updatedAt:utcNow()};
    if(clean.detail||clean.stage)job.message=clean.detail||clean.stage;
    if(next.subtask&&typeof next.subtask.id==='string'){
      const previous=job.progress.subtasks||{},item={};
      for(const key of ['label','unit'])if(typeof next.subtask[key]==='string')item[key]=next.subtask[key];
      for(const key of ['completed','total'])if(Number.isFinite(next.subtask[key])&&next.subtask[key]>=0)item[key]=Number(next.subtask[key]);
      job.progress.subtasks={...previous,[next.subtask.id]:{...(previous[next.subtask.id]||{}),...item}};
    }
  };
  const ctx={cwd,signal:job.controller.signal,commands:[],separateMetrics:process.env.MEDIASCOPE_SEPARATE_METRICS==='1',decodeThreads:decodeThreadCount(Number(process.env.MEDIASCOPE_DECODE_THREADS)),sitiWorkers:input.type==='analyze'&&input.sitiWorkers!=='auto'?input.sitiWorkers:undefined,update:publish};
  const stage=async(name,work,{phaseIndex,phaseCount,concurrentGroup=null,subtask=null}={})=>{
    const base={stage:concurrentGroup||name,phaseIndex,phaseCount};
    const scoped={...ctx,update:value=>{
      const detail=typeof value==='string'?{detail:value}:value||{};
      publish(subtask?{...base,detail:detail.detail||name,subtask:{id:subtask,label:name,...detail}}:{...base,...detail});
    }};
    scoped.update({detail:name,completed:0,total:null});
    const start=performance.now();
    try{return await work(scoped)}finally{stages.push({name,elapsedSeconds:(performance.now()-start)/1000,...(concurrentGroup?{concurrentGroup}:{})})}
  };
  try{
    let result;
    if(job.type==='inspect'){
      result=await stage('读取容器与轨道',c=>probe(input.file,c),{phaseIndex:1,phaseCount:1});result.metadata=metadataSummary(result);
    }else if(job.type==='analyze'){
      const bitrateWindowMs=input.bitrateWindowMs??100;
      if(![100,1000].includes(bitrateWindowMs))throw Error('码率窗口必须为 100 ms 或 1 秒');
      const phaseCount=input.complexity===true?4:3;
      const info=await stage('读取文件',c=>probe(input.file,c),{phaseIndex:1,phaseCount});
      if(input.stream==null)input.stream=info.raw.streams.find(s=>s.codec_type==='video')?.index;
      const stream=video(info,input.stream);
      let frames,tracks,coding;
      frames=await stage('完整扫描视频帧',c=>scan(input.file,input.stream,c),{phaseIndex:2,phaseCount});
      if(process.env.MEDIASCOPE_SEQUENTIAL_ANALYSIS==='1'){
        tracks=await stage('统计全部轨道的压缩包',c=>allPackets(input.file,info.raw.streams,{...c,bitrateWindowMs,audioPacketDistribution:true}),{phaseIndex:3,phaseCount,subtask:'packets'});
        coding=await stage('解析全流编码帧头 / NAL / OBU',c=>structure(input.file,stream,frames,c),{phaseIndex:3,phaseCount,subtask:'headers'});
      }else{
        const group='包统计与码流头并行读取';publish({stage:group,detail:'两项并行执行',phaseIndex:3,phaseCount});
        const completed=await Promise.allSettled([
          stage('统计全部轨道的压缩包',c=>allPackets(input.file,info.raw.streams,{...c,bitrateWindowMs,audioPacketDistribution:true}),{phaseIndex:3,phaseCount,concurrentGroup:group,subtask:'packets'}),
          stage('解析全流编码帧头 / NAL / OBU',c=>traceStructure(input.file,stream,c),{phaseIndex:3,phaseCount,concurrentGroup:group,subtask:'headers'})
        ]);
        const failed=completed.find(x=>x.status==='rejected');if(failed)throw failed.reason;
        tracks=completed[0].value;coding=mapStructure(completed[1].value,stream,frames);
      }
      const packetStats=tracks.find(t=>t.index===stream.index);
      let content=null;if(input.complexity===true)content=await stage('测量 SI/TI 内容复杂度',c=>complexity(input.file,stream,c,frames),{phaseIndex:4,phaseCount});
      result={...info,metadata:metadataSummary(info),stream:Number(input.stream),summary:summarize(frames),frames,packets:packetStats,tracks,coding,content,overheadBytes:info.size-tracks.reduce((s,t)=>s+t.bytes,0),warnings:['码率曲线按绝对 PTS 的所选窗口统计包负载，首尾除以实际区间时长；缺失 PTS 或持续时间时明确不可计算。100 ms 可聚合显示为 1 秒。全程平均值沿用原有独立口径。','GOP 视图按显示顺序的随机访问/关键帧边界分组；不将 CRA 自动标为闭合 GOP，也不声称已验证所有跨组引用。','帧大小取解码器报告的 pkt_size；AV1 多编码帧可能共用一个包，不重复相加估计编码帧体积。','附加数据来自轨道报告，本次未执行帧级附加数据读取；码流头解析覆盖全流，但不等同于完整解释所有私有 SEI。',...coding.warnings]};
    }else if(job.type==='compare'){
      if(input.confirm!==true)throw Error('请确认两个视频包含同一剪辑与画面顺序');
      if(input.chromaAssumptions!==undefined&&input.chromaConfirmed!==true)throw Error('请明确确认未声明视频的色度位置；结果将依赖此假设');
      if(input.timingMode==='ordinal-confirmed'&&input.timingConfirmed!==true)throw Error('请确认两路解码显示帧逐一对应，且没有丢帧、重复帧或重排');
      if(input.timingMode==='playback-sample'&&input.playbackConfirmed!==true)throw Error('请确认两路首帧对应同一播放时刻，并接受 CFR 一侧作为采样网格的实验性解释');
      result=await compare(input.reference,input.candidate,input.refStream,input.candidateStream,input.metrics,{...ctx,progressPlan:'compare',vmafModel:input.vmafModel,chromaAssumptions:input.chromaAssumptions,timingMode:input.timingMode??'strict'},input.comparisonMode??'native');
      publish({stage:'统计两路视频包体积',detail:'统计参考文件压缩包',phaseIndex:6,phaseCount:6,completed:0,total:2,unit:'个文件'});
      const rTracks=await allPackets(input.reference,result.reference.raw.streams,{...ctx,update:v=>publish({stage:'统计两路视频包体积',detail:typeof v==='string'?v:v?.detail,phaseIndex:6,phaseCount:6,completed:0,total:2,unit:'个文件'})});
      publish({stage:'统计两路视频包体积',detail:'统计候选文件压缩包',phaseIndex:6,phaseCount:6,completed:1,total:2,unit:'个文件'});
      const cTracks=await allPackets(input.candidate,result.candidate.raw.streams,{...ctx,update:v=>publish({stage:'统计两路视频包体积',detail:typeof v==='string'?v:v?.detail,phaseIndex:6,phaseCount:6,completed:1,total:2,unit:'个文件'})});
      result.videoSize={reference:rTracks.find(s=>s.index===Number(input.refStream))?.bytes,candidate:cTracks.find(s=>s.index===Number(input.candidateStream))?.bytes};
    }else if(job.type==='trial'){
      if(input.keepFiles)trialDestination(dataRoot,job.id,input.exportDirectory);
      const options=trialOptions(input);result=await trial(input,{...ctx,progressPlan:'trial',trialPhaseCount:options.points+2});
      if(input.keepFiles)result.experiment.retainedFiles=await saveTrialVideos(dataRoot,job.id,result.experiment.retainedFiles,input.exportDirectory);
    }else throw Error('未知任务');
    if(job.controller.signal.aborted)throw Error('任务已取消');
    job.result={schema:'MediaScope/0.2',createdAt:utcNow(),type:job.type,tools:versions,commands:ctx.commands,timing:{computeSeconds:(performance.now()-started)/1000,decodeThreads:ctx.decodeThreads,stages,scope:'计算阶段，不含报告序列化、保存、传输及浏览器渲染；同一 concurrentGroup 的阶段时间相互重叠，不能相加；子进程耗时见 commands[].elapsedSeconds'},...result};
    await writeFile(path.join(cwd,'report.json'),JSON.stringify(job.result,null,2));
    job.reportPath=path.join(cwd,'report.json');delete job.result;
    job.status='done';job.message='完成';job.progress={...(job.progress||{}),stage:'完成',detail:'报告已保存',completed:1,total:1,unit:'份报告',updatedAt:utcNow()};
  }catch(e){const status=job.controller.signal.aborted?'cancelled':'error';job.message=e.message;job.progress={...(job.progress||{}),stage:status==='cancelled'?'已取消':'任务未完成',detail:e.message,updatedAt:utcNow()};await writeFile(path.join(cwd,'failure.json'),JSON.stringify({status,error:e.message,commands:ctx.commands},null,2)).catch(()=>{});job.status=status;}
  finally{job.finishedAt=new Date().toISOString();await localData.enqueue(async()=>{
    if(job.status==='cancelled')await localData.remove(job,jobs,inputs);
    else await localData.save(job,input);
    await localData.prune(jobs,inputs);
  }).catch(e=>{job.retentionMessage='本地数据清理未完成：'+e.message;console.error(job.retentionMessage)})}
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.headers.host!==new URL(origin).host){send(res,403,{error:'仅允许本机地址'});return}
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      if(req.headers['x-mediascope-token']!==token||(req.headers.origin&&req.headers.origin!==origin)){send(res,403,{error:'访问校验失败，请刷新本机页面'});return}
      await localData.pending;
      if(closing&&url.pathname!=='/api/status'&&url.pathname!=='/api/desktop/shutdown'){send(res,503,{error:'软件正在退出'});return}
      if(req.method==='GET'&&url.pathname==='/api/status'){send(res,200,{...capabilities,startup,settings:localData.settings,desktop:process.env.MEDIASCOPE_DESKTOP==='1',queueRunning,jobs:[...jobs.values()].filter(j=>!j.removed&&j.status!=='cancelled').map(({controller,result,...j})=>j)});return}
      if(req.method==='GET'&&url.pathname==='/api/local-data'){send(res,200,await localData.enqueue(()=>localData.usage(jobs)));return}
      if(req.method==='POST'&&url.pathname==='/api/local-data/settings'){const value=await body(req);await localData.enqueue(()=>localData.updateSettings(value));send(res,200,{settings:localData.settings});return}
      if(req.method==='POST'&&url.pathname==='/api/local-data/export-hold'){const {ids}=await body(req,maxPortableBytes);send(res,200,{key:await localData.enqueue(()=>localData.hold(ids,jobs))});return}
      if(req.method==='POST'&&url.pathname==='/api/local-data/export-release'){const {key}=await body(req);await localData.enqueue(async()=>{localData.holds.delete(key);await localData.prune(jobs,inputs)});send(res,200,{ok:true});return}
      if(req.method==='POST'&&url.pathname==='/api/local-data/clean'){
        const {category}=await body(req);if(!['records','cache'].includes(category))throw Error('无效清理范围');
        if(category==='cache'){
          if(process.env.MEDIASCOPE_DESKTOP==='1'){send(res,200,{message:'运行缓存将在关闭软件后清理'});return}
          await removeOwned(dataRoot,'desktop-profile');send(res,200,{message:'运行缓存已清理'});return;
        }
        if(dataCleaning)throw Error('本地数据正在清理');dataCleaning=true;
        try{await localData.enqueue(()=>localData.prune(jobs,inputs,{clear:true}));send(res,200,{message:[...jobs.values()].some(j=>ended(j))?'已清理近期记录；正在导出的记录暂时保留':'近期记录已清空'})}
        finally{dataCleaning=false;pump()}return;
      }
      if(req.method==='POST'&&url.pathname==='/api/desktop/shutdown'){
        send(res,200,{ok:true});void shutdown();return;
      }
      if(req.method==='POST'&&startup.state!=='ready'&&['/api/jobs','/api/probe','/api/queue','/api/plans/import'].includes(url.pathname)){
        send(res,503,{error:startup.message});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/plans'){
        const plans=[...jobs.values()].filter(j=>j.status==='queued').map(j=>{try{return {entryId:j.id,input:validatePlanInput(portableInput(inputs.get(j.id)))}}catch(e){throw Error(`待运行任务 ${j.id} 无法安全导出：${e.message}`)}});
        send(res,200,makePortable({plans}));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/plans/import'){
        const request=await body(req,maxPortableBytes);
        if(!['append','replace'].includes(request.mode)||typeof request.start!=='boolean'||!Array.isArray(request.plans)||request.plans.length>10000)throw Error('计划导入选项无效');
        makePortable({plans:request.plans});
        const imported=request.plans.map((entry,i)=>{if(!entry||typeof entry!=='object'||typeof entry.entryId!=='string')throw Error(`计划第 ${i+1} 项格式错误`);try{return validatePlanInput(entry.input)}catch(e){throw Error(`计划第 ${i+1} 项：${e.message}`)}});
        queueRunning=false;
        if(request.mode==='replace')for(const [id,j]of jobs)if(j.status==='queued'){jobs.delete(id);inputs.delete(id)}
        const ids=imported.map(input=>createJob(input).id);
        queueRunning=request.start;pump();send(res,200,{imported:ids.length,ids,queueRunning});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/queue'){
        const {action}=await body(req);if(!['start','pause'].includes(action))throw Error('无效队列操作');
        queueRunning=action==='start';pump();send(res,200,{queueRunning});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/jobs/clear'){
        const {scope}=await body(req);if(!['queued','history','results'].includes(scope))throw Error('无效清空范围');
        // Capture the target set before awaiting filesystem work; later jobs are unaffected.
        const targets=[...jobs.values()].filter(j=>scope==='queued'?j.status==='queued':scope==='results'?j.status==='done':ended(j));
        for(const job of targets)if(job.status==='queued')job.status='cancelled';
        await localData.enqueue(async()=>{for(const job of targets){
          if(job.status==='running')continue;
          await localData.remove(job,jobs,inputs);
        }});
        pump();send(res,200,{ok:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/select-file'){send(res,200,{file:await selectMediaFile()});return}
      if(req.method==='POST'&&url.pathname==='/api/select-directory'){send(res,200,{directory:await selectMediaFile(true)});return}
      if(req.method==='POST'&&url.pathname==='/api/probe'){
        const input=await body(req),file=normalizeMediaPath(input.file);
        if(closing){send(res,503,{error:'软件正在退出'});return}
        const controller=new AbortController();probes.add(controller);
        try{
          const commands=[],result=await probe(file,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]),commands,update:()=>{}});
          send(res,200,{schema:'MediaScope/0.2',createdAt:utcNow(),type:'inspect',tools:versions,commands,...result,metadata:metadataSummary(result)});
        }finally{probes.delete(controller)}
        return;
      }
      const retry=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/retry$/);
      if(req.method==='POST'&&retry){
        if(startup.state!=='ready'){send(res,503,{error:startup.message});return}
        const original=jobs.get(retry[1]);
        if(!original){send(res,404,{error:'任务不存在'});return}
        if(original.removed||!['done','error'].includes(original.status)){send(res,409,{error:'只能重新排队已完成或失败的任务'});return}
        const input=inputs.get(original.id);
        if(!input){send(res,409,{error:'原任务参数已丢失'});return}
        const job=createJob(input);pump();send(res,202,{id:job.id});return;
      }
      const match=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(\/report)?$/);
      if(match){const j=jobs.get(match[1]);if(!j){send(res,404,{error:'任务不存在'});return}
        if(req.method==='DELETE'&&!match[2]){
          if(j.status==='running')j.controller.abort();
          else {if(j.status==='queued')j.status='cancelled';await localData.enqueue(()=>localData.remove(j,jobs,inputs))}
          pump();send(res,200,{ok:true});return;
        }
        if(req.method==='GET'){if(match[2]){
          if(!j.reportPath){send(res,409,{error:'报告尚未完成'});return}
          const key=await localData.enqueue(()=>localData.hold([j.id],jobs));
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
          const stream=createReadStream(j.reportPath);
          stream.once('close',()=>void localData.enqueue(async()=>{localData.holds.delete(key);await localData.prune(jobs,inputs)}).catch(e=>console.error('报告读取后清理未完成：'+e.message)));
          res.once('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
        }else{const {controller,result,...meta}=j;send(res,200,meta)}return}
      }
      if(req.method==='POST'&&url.pathname==='/api/jobs'){
        const input=await body(req);if(!['inspect','analyze','compare','trial'].includes(input.type))throw Error('无效任务类型');normalizeInputPaths(input);
        if(input.enqueue!==true)queueRunning=true;
        const job=createJob(input);send(res,202,{id:job.id});return;
      }
      send(res,404,{error:'接口不存在'});return;
    }
    const files={'/':'index.html','/app.js':'app.js','/report.js':'report.js','/vmaf.js':'vmaf.js','/metric-summary.js':'metric-summary.js','/properties.js':'properties.js','/basic-info.js':'basic-info.js','/portable.js':'portable.js','/bitrate-model.js':'bitrate-model.js','/distribution-model.js':'distribution-model.js','/charts.js':'charts.js','/trial-model.js':'trial-model.js','/units.js':'units.js','/style.css':'style.css'};
    if(req.method!=='GET'||!files[url.pathname]){res.writeHead(404);res.end();return}
    const name=files[url.pathname];let data=await readFile(path.join(root,'public',name));if(name==='index.html')data=Buffer.from(data.toString().replace('__TOKEN__',token).replace('__APP_VERSION__',appVersion).replace('__LOCAL_THEME__',localData.settings.theme).replace('__PORTABLE_LIMIT__',byteLimit(maxPortableBytes)).replace('__RECENT_LIMIT__',byteLimit(recentBytes)));
    res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'"});res.end(data);
  }catch(e){send(res,400,{error:e.message})}
});
server.listen(port,'127.0.0.1',()=>{
  origin=`http://127.0.0.1:${server.address().port}`;
  console.log(`MediaScope 已启动：${origin}\n${process.env.MEDIASCOPE_DESKTOP==='1'?'关闭 MediaScope 应用窗口即可退出。':'浏览器打开以上地址。Ctrl+C 停止。'}`);
  if(process.env.MEDIASCOPE_STARTUP_RESULT){startupTimer=setInterval(()=>void loadStartup(),200);void loadStartup()}
});
server.on('error',e=>{console.error(e.message);void dataLease?.release();process.exitCode=1});
async function shutdown(){
  if(closing)return;closing=true;clearInterval(startupTimer);clearInterval(retentionTimer);queueRunning=false;
  for(const j of jobs.values())j.controller.abort();
  for(const controller of probes)controller.abort();pickerProcess?.kill();
  let drained=false;server.close(()=>{drained=true});server.closeIdleConnections();
  const deadline=Date.now()+8000;
  while((active||!drained)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  if(!drained){server.closeAllConnections();await new Promise(resolve=>setImmediate(resolve))}
  await localData.pending;
  if(!active){await localData.enqueue(async()=>{if(localData.settings.clearOnExit){localData.holds.clear();await localData.prune(jobs,inputs,{clear:true})}await removeOwned(dataRoot,'.session')}).catch(e=>console.error('退出清理未完成：'+e.message));}
  await dataLease?.release();
  process.exit(0);
}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
