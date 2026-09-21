import {availableParallelism,freemem} from 'node:os';
import {FF,run} from './engine.mjs';

export function sitiWorkerCount(stream,count,requested=4){
  if(!Number.isSafeInteger(count)||count<60)return 1;
  const pixels=Number(stream.width)*Number(stream.height);
  if(!(pixels>0))return 1;
  const memoryLimit=Math.floor(freemem()*.25/(pixels*80+64*1024*1024));
  return Math.max(1,Math.min(8,availableParallelism(),memoryLimit,Math.floor(count/30),Number.isInteger(requested)&&requested>0?requested:4));
}

async function measure(file,stream,ctx,from=0,end=null){
  const points=[];let point=null;
  const finish=()=>{
    if(point){
      if(!Number.isFinite(point.si)||!Number.isFinite(point.ti)||point.frame!==points.length)throw Error('SI/TI 帧结果不完整');
      points.push(point);if(points.length>500000)throw Error('复杂度帧数超过上限');
    }
    point=null;
  };
  const select=end===null?(from?`select='gte(n,${from})',`:''):`select='between(n,${from},${end})',`;
  await run(FF,['-hide_banner','-nostdin','-v','error','-xerror','-noauto_conversion_filters','-noautorotate','-i',file,'-map',`0:${stream.index}`,'-vf',select+'siti,metadata=mode=print:file=-','-an','-fps_mode','passthrough','-f','null','-'],ctx,line=>{
    let m=line.match(/^frame:(\d+)\s+pts:.*?pts_time:([^\s]+)/);
    if(m){finish();point={frame:Number(m[1]),t:Number(m[2])};return}
    m=line.match(/^lavfi.siti.(si|ti)=(.+)/);if(m&&point)point[m[1]]=Number(m[2]);
  });
  finish();return points;
}

export async function measureSiti(file,stream,ctx={},frames=null){
  const configured=ctx.sitiWorkers??Number(process.env.MEDIASCOPE_SITI_WORKERS??4);
  const requestedWorkers=Number.isInteger(configured)&&configured>0?Math.min(8,configured):4;
  const setting=ctx.sitiWorkers==null?'auto':'manual';
  const workers=sitiWorkerCount(stream,frames?.length,requestedWorkers);
  let points,execution={mode:'serial',workers:1,requestedWorkers,setting,implementation:'FFmpeg siti'};
  if(workers>1){
    ctx.update?.(`测量 SI/TI 内容复杂度（${workers} 路帧级并行）`);
    const size=Math.ceil(frames.length/workers);
    // No seeking: decode in display order. Include the preceding frame for TI.
    // The final range is unbounded to detect a stale/incorrect scanned count.
    const results=await Promise.allSettled(Array.from({length:workers},(_,i)=>{
      const start=i*size,from=Math.max(0,start-1),end=i===workers-1?null:start+size-1;
      return measure(file,stream,ctx,from,end).then(points=>({start,points}));
    }));
    if(ctx.signal?.aborted)throw Error('任务已取消');
    try{
      points=[];
      for(const result of results){
        if(result.status==='rejected')throw result.reason;
        const part=result.value,expected=Math.min(size,frames.length-part.start)+(part.start?1:0);
        if(part.points.length!==expected)throw Error('并行分段帧数不一致');
        if(part.start){
          const overlap=part.points[0],previous=points.at(-1);
          if(!previous||!Number.isFinite(overlap.t)||overlap.t!==previous.t||overlap.si!==previous.si)throw Error('并行重叠帧校验失败');
        }
        for(const p of part.points.slice(part.start?1:0)){
          if(!Number.isFinite(p.t))throw Error('并行帧时间戳无效');
          points.push({...p,frame:points.length});
        }
      }
      if(points.length!==frames.length)throw Error('并行总帧数不一致');
      execution={mode:'frame-parallel',workers,requestedWorkers,setting,implementation:'FFmpeg siti',overlapFrames:1};
    }catch(e){
      execution.fallbackReason=e.message;
      ctx.update?.('SI/TI 并行校验未通过，回退串行计算');
      points=await measure(file,stream,ctx);
    }
  }else points=await measure(file,stream,ctx);
  return {points,execution};
}
