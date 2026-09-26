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
const root=path.dirname(fileURLToPath(import.meta.url)),token=randomBytes(24).toString('hex'),jobs=new Map();
const port=Number(process.env.PORT||4317),origin=`http://127.0.0.1:${port}`;
const execFileAsync=promisify(execFile);
let active=null,pickerActive=false,queueRunning=false;
const inputs=new Map();
function pump(){
 if(active||!queueRunning)return;
 const job=[...jobs.values()].find(j=>j.status==='queued');
 if(!job){queueRunning=false;return}
 active=job.id;job.status='running';job.startedAt=new Date().toISOString();job.message='准备分析';
 const input=inputs.get(job.id);
 execute(job,input).catch(e=>{job.status=job.controller.signal.aborted?'cancelled':'error';job.message=e.message;job.finishedAt=new Date().toISOString()}).finally(()=>{active=null;pump()});
}
const versions={};
for(const [key,exe] of [['ffmpeg',FF],['ffprobe',FP]]){try{versions[key]=(await run(exe,['-version'])).split('\n')[0]}catch(e){versions[key]=`不可用：${e.message}`}}
let filters='';try{filters=await run(FF,['-hide_banner','-filters'])}catch{}
const capabilities={versions,metrics:['psnr','ssim','vmaf'].filter(m=>filters.includes(m==='vmaf'?'libvmaf':m))};
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
async function body(req){let s='';for await(const b of req){s+=b;if(s.length>16384)throw Error('请求过大')}return JSON.parse(s||'{}')}
function normalizeInputPaths(input){
  if(input.type==='inspect'||input.type==='analyze'||input.type==='trial')input.file=normalizeMediaPath(input.file);
  if(input.type==='analyze'){
    if(input.sitiWorkers==null||input.sitiWorkers==='auto')input.sitiWorkers='auto';
    else{const value=Number(input.sitiWorkers);if(![1,2,4,6,8].includes(value))throw Error('SI/TI 并行上限无效');input.sitiWorkers=value}
  }
  if(input.type==='compare'){input.reference=normalizeMediaPath(input.reference);input.candidate=normalizeMediaPath(input.candidate)}
  return input;
}
async function selectMediaFile(){
  if(process.platform!=='win32')throw Error('当前文件选择器仅支持 Windows，请输入绝对路径');
  if(pickerActive)throw Error('文件选择器已经打开，请先在 Windows 对话框中选择或取消');
  pickerActive=true;
  const script=`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\nAdd-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\nAdd-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class MediaScopeWindow {\n  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n}\n'@\n$owner=New-Object System.Windows.Forms.Form\n$owner.ShowInTaskbar=$false\n$owner.TopMost=$true\n$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::Manual\n$owner.Location=New-Object System.Drawing.Point(-32000,-32000)\n$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow\n$owner.Size=New-Object System.Drawing.Size(1,1)\n$owner.Opacity=0.01\n$dialog=New-Object System.Windows.Forms.OpenFileDialog\n$dialog.Title='选择要分析的媒体文件'\n$dialog.Filter='媒体文件|*.mov;*.mp4;*.mkv;*.mxf;*.avi;*.webm;*.m4v;*.ts;*.mts;*.m2ts;*.wav;*.flac;*.aac;*.m4a;*.mp3;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.exr|视频文件|*.mov;*.mp4;*.mkv;*.mxf;*.avi;*.webm;*.m4v;*.ts;*.mts;*.m2ts|所有文件|*.*'\n$dialog.Multiselect=$false\n$dialog.CheckFileExists=$true\n$dialog.RestoreDirectory=$true\ntry{$owner.Show();$owner.Activate();[MediaScopeWindow]::SetForegroundWindow($owner.Handle)|Out-Null;if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($dialog.FileName)}}finally{$dialog.Dispose();$owner.Close();$owner.Dispose()}`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  let stdout;
  try{({stdout}=await execFileAsync('powershell.exe',['-NoProfile','-STA','-EncodedCommand',encoded],{encoding:'utf8',windowsHide:false,maxBuffer:1024*1024,timeout:600000}))}
  catch(e){throw Error(`文件选择器未能完成：${e.stderr?.trim()||e.message}`)}
  finally{pickerActive=false}
  return stdout?normalizeMediaPath(stdout):null;
}
function createJob(input){
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
  const cwd=path.join(root,'.mediascope',job.id);await mkdir(cwd,{recursive:true});
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
    job.progress={...previous,...(phaseChanged?{subtasks:{},completed:null,total:null,unit:''}:{}),...clean,updatedAt:new Date().toISOString()};
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
      const phaseCount=input.complexity===true?4:3;
      const info=await stage('读取文件',c=>probe(input.file,c),{phaseIndex:1,phaseCount});
      if(input.stream==null)input.stream=info.raw.streams.find(s=>s.codec_type==='video')?.index;
      const stream=video(info,input.stream);
      let frames,tracks,coding;
      frames=await stage('完整扫描视频帧',c=>scan(input.file,input.stream,c),{phaseIndex:2,phaseCount});
      if(process.env.MEDIASCOPE_SEQUENTIAL_ANALYSIS==='1'){
        tracks=await stage('统计全部轨道的压缩包',c=>allPackets(input.file,info.raw.streams,c),{phaseIndex:3,phaseCount,subtask:'packets'});
        coding=await stage('解析全流编码帧头 / NAL / OBU',c=>structure(input.file,stream,frames,c),{phaseIndex:3,phaseCount,subtask:'headers'});
      }else{
        const group='包统计与码流头并行读取';publish({stage:group,detail:'两项并行执行',phaseIndex:3,phaseCount});
        const completed=await Promise.allSettled([
          stage('统计全部轨道的压缩包',c=>allPackets(input.file,info.raw.streams,c),{phaseIndex:3,phaseCount,concurrentGroup:group,subtask:'packets'}),
          stage('解析全流编码帧头 / NAL / OBU',c=>traceStructure(input.file,stream,c),{phaseIndex:3,phaseCount,concurrentGroup:group,subtask:'headers'})
        ]);
        const failed=completed.find(x=>x.status==='rejected');if(failed)throw failed.reason;
        tracks=completed[0].value;coding=mapStructure(completed[1].value,stream,frames);
      }
      const packetStats=tracks.find(t=>t.index===stream.index);
      let content=null;if(input.complexity===true)content=await stage('测量 SI/TI 内容复杂度',c=>complexity(input.file,stream,c,frames),{phaseIndex:4,phaseCount});
      result={...info,metadata:metadataSummary(info),stream:Number(input.stream),summary:summarize(frames),frames,packets:packetStats,tracks,coding,content,overheadBytes:info.size-tracks.reduce((s,t)=>s+t.bytes,0),warnings:['码率按绝对 PTS 的 1 秒窗口统计；缺失 PTS 时回退 DTS，首尾窗口可能不足 1 秒。缩放不会改变测量窗口。','GOP 视图按显示顺序的随机访问/关键帧边界分组；不将 CRA 自动标为闭合 GOP，也不声称已验证所有跨组引用。','帧大小取解码器报告的 pkt_size；AV1 多编码帧可能共用一个包，不重复相加估计编码帧体积。','元数据去重来自轨道与开头抽样；码流头解析覆盖全流，但不等同于完整解释所有私有 SEI。',...coding.warnings]};
    }else if(job.type==='compare'){
      if(input.confirm!==true)throw Error('请确认两个视频包含同一剪辑与画面顺序');
      if(input.chromaAssumptions!==undefined&&input.chromaConfirmed!==true)throw Error('请明确确认未声明视频的色度位置；结果将依赖此假设');
      if(input.timingMode==='ordinal-confirmed'&&input.timingConfirmed!==true)throw Error('请确认两路解码显示帧逐一对应，且没有丢帧、重复帧或重排');
      if(input.timingMode==='playback-sample'&&input.playbackConfirmed!==true)throw Error('请确认两路首帧对应同一播放时刻，并接受 CFR 一侧作为采样网格的实验性解释');
      result=await compare(input.reference,input.candidate,input.refStream,input.candidateStream,input.metrics,{...ctx,progressPlan:'compare',chromaAssumptions:input.chromaAssumptions,timingMode:input.timingMode??'strict'},input.comparisonMode??'native');
      publish({stage:'统计两路视频包体积',detail:'统计参考文件压缩包',phaseIndex:6,phaseCount:6,completed:0,total:2,unit:'个文件'});
      const rTracks=await allPackets(input.reference,result.reference.raw.streams,{...ctx,update:v=>publish({stage:'统计两路视频包体积',detail:typeof v==='string'?v:v?.detail,phaseIndex:6,phaseCount:6,completed:0,total:2,unit:'个文件'})});
      publish({stage:'统计两路视频包体积',detail:'统计候选文件压缩包',phaseIndex:6,phaseCount:6,completed:1,total:2,unit:'个文件'});
      const cTracks=await allPackets(input.candidate,result.candidate.raw.streams,{...ctx,update:v=>publish({stage:'统计两路视频包体积',detail:typeof v==='string'?v:v?.detail,phaseIndex:6,phaseCount:6,completed:1,total:2,unit:'个文件'})});
      result.videoSize={reference:rTracks.find(s=>s.index===Number(input.refStream))?.bytes,candidate:cTracks.find(s=>s.index===Number(input.candidateStream))?.bytes};
    }else if(job.type==='trial'){
      const options=trialOptions(input);result=await trial(input,{...ctx,progressPlan:'trial',trialPhaseCount:options.points+2});
    }else throw Error('未知任务');
    if(job.controller.signal.aborted)throw Error('任务已取消');
    job.result={schema:'MediaScope/0.2',createdAt:new Date().toISOString(),type:job.type,tools:versions,commands:ctx.commands,timing:{computeSeconds:(performance.now()-started)/1000,decodeThreads:ctx.decodeThreads,stages,scope:'计算阶段，不含报告序列化、保存、传输及浏览器渲染；同一 concurrentGroup 的阶段时间相互重叠，不能相加；子进程耗时见 commands[].elapsedSeconds'},...result};
    await writeFile(path.join(cwd,'report.json'),JSON.stringify(job.result,null,2));
    job.reportPath=path.join(cwd,'report.json');delete job.result;
    job.status='done';job.message='完成';job.progress={...(job.progress||{}),stage:'完成',detail:'报告已保存',completed:1,total:1,unit:'份报告',updatedAt:new Date().toISOString()};
  }catch(e){job.status=job.controller.signal.aborted?'cancelled':'error';job.message=e.message;job.progress={...(job.progress||{}),stage:job.status==='cancelled'?'已取消':'任务未完成',detail:e.message,updatedAt:new Date().toISOString()};await writeFile(path.join(cwd,'failure.json'),JSON.stringify({status:job.status,error:e.message,commands:ctx.commands},null,2)).catch(()=>{});}
  finally{job.finishedAt=new Date().toISOString();}
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}`){send(res,403,{error:'仅允许本机地址'});return}
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      if(req.headers['x-mediascope-token']!==token||(req.headers.origin&&req.headers.origin!==origin)){send(res,403,{error:'访问校验失败，请刷新本机页面'});return}
      if(req.method==='GET'&&url.pathname==='/api/status'){send(res,200,{...capabilities,queueRunning,jobs:[...jobs.values()].map(({controller,result,...j})=>j)});return}
      if(req.method==='POST'&&url.pathname==='/api/queue'){
        const {action}=await body(req);if(!['start','pause'].includes(action))throw Error('无效队列操作');
        queueRunning=action==='start';pump();send(res,200,{queueRunning});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/select-file'){send(res,200,{file:await selectMediaFile()});return}
      if(req.method==='POST'&&url.pathname==='/api/probe'){
        const input=await body(req),file=normalizeMediaPath(input.file);
        const commands=[],result=await probe(file,{signal:AbortSignal.timeout(30000),commands,update:()=>{}});
        send(res,200,{schema:'MediaScope/0.2',createdAt:new Date().toISOString(),type:'inspect',tools:versions,commands,...result,metadata:metadataSummary(result)});return;
      }
      const retry=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/retry$/);
      if(req.method==='POST'&&retry){
        const original=jobs.get(retry[1]);
        if(!original){send(res,404,{error:'任务不存在'});return}
        if(!['cancelled','error'].includes(original.status)){send(res,409,{error:'只能重新排队已取消或失败的任务'});return}
        const input=inputs.get(original.id);
        if(!input){send(res,409,{error:'原任务参数已丢失'});return}
        const job=createJob(input);send(res,202,{id:job.id});return;
      }
      const match=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(\/report)?$/);
      if(match){const j=jobs.get(match[1]);if(!j){send(res,404,{error:'任务不存在'});return}
        if(req.method==='DELETE'){if(j.status==='queued'){j.status='cancelled';j.message='已从队列取消';j.finishedAt=new Date().toISOString()}else if(j.status==='running')j.controller.abort();send(res,200,{ok:true});return}
        if(req.method==='GET'){if(match[2]){if(!j.reportPath){send(res,409,{error:'报告尚未完成'});return}res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});const stream=createReadStream(j.reportPath);stream.on('error',()=>res.destroy());stream.pipe(res)}else{const {controller,result,...meta}=j;send(res,200,meta)}return}
      }
      if(req.method==='POST'&&url.pathname==='/api/jobs'){
        const input=await body(req);if(!['inspect','analyze','compare','trial'].includes(input.type))throw Error('无效任务类型');normalizeInputPaths(input);
        if(input.enqueue!==true)queueRunning=true;
        const job=createJob(input);send(res,202,{id:job.id});return;
      }
      send(res,404,{error:'接口不存在'});return;
    }
    const files={'/':'index.html','/app.js':'app.js','/report.js':'report.js','/charts.js':'charts.js','/trial-model.js':'trial-model.js','/style.css':'style.css'};
    if(req.method!=='GET'||!files[url.pathname]){res.writeHead(404);res.end();return}
    const name=files[url.pathname];let data=await readFile(path.join(root,'public',name));if(name==='index.html')data=Buffer.from(data.toString().replace('__TOKEN__',token));
    res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'"});res.end(data);
  }catch(e){send(res,400,{error:e.message})}
});
server.listen(port,'127.0.0.1',()=>console.log(`MediaScope 已启动：${origin}\n保持窗口运行，浏览器打开以上地址。Ctrl+C 停止。\n${versions.ffmpeg}`));
server.on('error',e=>{console.error(e.message);process.exitCode=1});
process.on('SIGINT',()=>{queueRunning=false;for(const j of jobs.values())j.controller.abort();server.close(()=>process.exit())});
