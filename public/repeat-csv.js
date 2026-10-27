import {maxPortableBytes} from './portable.js';

// Yield complete records; callers publish only after the whole iterator succeeds.
export function* repeatCsvParts(r,name){
  const data={runs:r.exact.runs,intervals:r.timeline.intervals,segments:r.freeze.segments??[],freeze:r.freeze.events??[],frames:r.frames};
  if(!Object.hasOwn(data,name))throw Error('未知重复分析CSV类型');
  const rows=data[name],columns=name==='frames'?['frame','pts','bestEffortPts','duration','durationSource','sha256','hashPts','hashDuration','hashBytes','interpretation']:Object.keys(rows[0]??(name==='runs'?{startFrame:0,endFrame:0,frameCount:0,extraFrames:0,startPts:null,endPts:null,endSource:null}:name==='intervals'?{ticks:null,count:0}:name==='segments'?{start:null,end:null,duration:null,detectedAtFrame:0,endDetectedAtFrame:null}:{kind:null,value:null,frame:0,filterPts:null}));
  const quote=v=>'"'+String(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):v).replaceAll('"','""')+'"';
  const context={configurationVersion:r.configurationVersion,timeBase:r.timeBase,hashTimeBase:r.hashTimeBase,pixelFormat:r.source.pixelFormat,sourceSignature:r.source.signature};
  const keys=[...Object.keys(context),...columns],encoder=new TextEncoder();
  let bytes=0;
  const checked=line=>{
    bytes+=encoder.encode(line).length;
    if(bytes>maxPortableBytes)throw Error('CSV 超过256MB边界，未导出；请缩小分析范围。');
    return line;
  };
  yield checked('\uFEFF'+keys.map(quote).join(',')+'\r\n');
  for(const value of rows){const row={...context,...value};yield checked(keys.map(k=>quote(row[k])).join(',')+'\r\n');}
}
