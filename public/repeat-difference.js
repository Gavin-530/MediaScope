// Exact integer code-domain evidence. This is not a perceptual or source-origin classifier.
export const DIFFERENCE_FIELDS=['sad','changed','maxAbs','blockSad','blockSamples','blockX','blockY'];
export const SOURCE_CLASSIFICATION={status:'not-qualified',defaultEnabled:false,reason:'Source origin is not inferred from code differences; no source-disjoint holdout qualification.'};
export function differenceConfiguration(format){
  const name=format.pixelFormat;
  let channels;
  if(/^yuva?/.test(name))channels=format.alpha?['Y','U','V','A']:['Y','U','V'];
  else if(/^gbr/.test(name))channels=format.alpha?['G','B','R','A']:['G','B','R'];
  else if(/^gray/.test(name))channels=['Gray'];
  else if(['nv12','nv21'].includes(name)||/^p0/.test(name))channels=name==='nv21'?['Y','V','U']:['Y','U','V'];
  else channels=name.replace('24','').toUpperCase().split('');
  const components=[];let index=0;
  format.planes.forEach((p,plane)=>{for(let channel=0;channel<p.components;channel++)components.push({name:channels[index++],plane,channel,width:p.width,height:p.height,samples:p.width*p.height});});
  return {method:'native-integer-difference-v1',domain:'full-representable-integer-code-values',blockSize:16,blockGrid:'non-overlapping-component-grid-with-complete-edge-blocks',peak:2**format.depth-1,fields:[...DIFFERENCE_FIELDS],components};
}
export function differenceBand(frame){
  if(frame.equalPrevious===null)return 'no-predecessor';
  if(frame.equalPrevious)return 'equal';
  let max=0;for(const row of frame.difference)max=Math.max(max,row[2]);
  return max===1?'one-code':max===2?'two-codes':'larger';
}
export function differenceSummary(frames){
  const counts={equal:0,'one-code':0,'two-codes':0,larger:0};
  for(let i=1;i<frames.length;i++)counts[differenceBand(frames[i])]++;
  return {comparisons:Math.max(0,frames.length-1),counts,sourceAttribution:'not-inferred'};
}
export function validateDifferenceFrame(frame,configuration,index){
  const fail=()=>{throw Error(`原生差异证据无效：帧${index}`);};
  if(index===0){if(frame.equalPrevious!==null||frame.difference!==null)fail();return;}
  if(typeof frame.equalPrevious!=='boolean')fail();
  if(frame.equalPrevious){if(frame.difference!==null)fail();return;}
  if(!Array.isArray(frame.difference)||frame.difference.length!==configuration.components.length)fail();
  let totalChanged=0;
  for(const [i,row]of frame.difference.entries()){
    const c=configuration.components[i],b=configuration.blockSize,peak=configuration.peak;
    if(!Array.isArray(row)||row.length!==7||row.some(n=>!Number.isSafeInteger(n)||n<0))fail();
    const [sad,changed,max,blockSum,count,x,y]=row;
    if(changed>c.samples||max>peak||max>sad||sad<changed||sad>changed*max||blockSum>sad||count!==Math.min(b,c.width-x)*Math.min(b,c.height-y)||x>=c.width||y>=c.height||x%b||y%b||blockSum>count*max||(!changed)!==(!max)||(!changed)!==(!sad)||(!sad)!==(!blockSum))fail();
    totalChanged+=changed;
  }
  if(!totalChanged)fail();
}
export function differenceDisplay(frame,configuration){
  if(frame.equalPrevious===null)return null;
  if(frame.equalPrevious)return {sad:0,changed:0,maxAbs:0,mean:0,maxBlockMean:0};
  let sad=0,changed=0,maxAbs=0,samples=0,maxBlockMean=0;
  frame.difference.forEach((row,i)=>{sad+=row[0];changed+=row[1];maxAbs=Math.max(maxAbs,row[2]);samples+=configuration.components[i].samples;maxBlockMean=Math.max(maxBlockMean,row[3]/(row[4]*configuration.peak));});
  return {sad,changed,maxAbs,mean:sad/(samples*configuration.peak),maxBlockMean};
}
